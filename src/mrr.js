// Contract MRR (USD) per client and month: the file history (src/mrrHistory.js) up to its last month, then the
// Cashflow master clients with the same rule: the ARR of the contract year the month falls in, divided by 12, from
// the start month on; the end month prorated by days and nothing after it.
import { MRR_HISTORY, MRR_HISTORY_LAST } from "./mrrHistory";

export const ENTITIES = [
  { id: "celes", label: "Celes Technologies", color: "#2a78d6" },
  { id: "biai", label: "BIAI Technologies", color: "#1baf7a" },
  { id: "xeles", label: "Xeles", color: "#eb6834" },
];
export const entityOf = (razonCeles) => (/biai/i.test(razonCeles || "") ? "biai" : /xeles/i.test(razonCeles || "") ? "xeles" : "celes");

const round2 = (n) => Math.round(n * 100) / 100;
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const nextMonth = (id) => { const [y, m] = id.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; };
export const monthRange = (from, to) => { const out = []; for (let id = from; id <= to; id = nextMonth(id)) out.push(id); return out; };

/** Contract year (1, 2, 3…) a month falls in, or 0 before the start month. */
export function contractYear(client, id) {
  if (!client.start) return 0;
  const [y, m] = id.split("-").map(Number);
  const [sy, sm] = client.start.split("-").map(Number);
  const idx = (y - sy) * 12 + (m - sm);
  return idx < 0 ? 0 : Math.floor(idx / 12) + 1;
}

/** MRR of a master client in a month (USD). */
export function clientMrr(client, id) {
  const year = contractYear(client, id);
  if (!year) return 0;
  const arr = Number([client.arr1, client.arr2, client.arr3][Math.min(year, 3) - 1]) || 0;
  let value = arr / 12;
  if (client.end) {
    const [y, m] = id.split("-").map(Number);
    const [ey, em, ed] = client.end.split("-").map(Number);
    const after = (ey - y) * 12 + (em - m);
    if (after < 0) return 0;
    if (after === 0) value *= Math.min(ed, daysIn(y, m)) / daysIn(y, m);
  }
  return round2(value);
}

const key = (name) => String(name || "").trim().toLowerCase();

/**
 * Monthly MRR from `from` to `to`: file history up to MRR_HISTORY_LAST, master clients after it (when available).
 * Each row: { id, source, mrr, byEntity, clients: [{ client, entity, country, mrr }] }.
 */
export function buildMrrSeries(masterClients, to) {
  const first = Object.keys(MRR_HISTORY.reduce((all, c) => Object.assign(all, c.months), {})).sort()[0];
  const masterByKey = new Map((masterClients || []).map((c) => [key(c.name), c]));
  const rows = [];
  for (const id of monthRange(first, to)) {
    const fromFile = id <= MRR_HISTORY_LAST;
    if (!fromFile && !masterClients) break;
    const list = fromFile
      ? MRR_HISTORY.map((c) => {
          const master = masterByKey.get(key(c.client));
          return { client: c.client, entity: entityOf(master?.razonCeles || c.razonCeles), country: master?.country || c.country, mrr: c.months[id] || 0 };
        })
      : masterClients.map((c) => ({ client: c.name.trim(), entity: entityOf(c.razonCeles), country: c.country, mrr: clientMrr(c, id), year: contractYear(c, id) }));
    const clients = list.filter((c) => c.mrr);
    const byEntity = Object.fromEntries(ENTITIES.map((e) => [e.id, round2(clients.filter((c) => c.entity === e.id).reduce((s, c) => s + c.mrr, 0))]));
    rows.push({ id, source: fromFile ? "file" : "master", mrr: round2(clients.reduce((s, c) => s + c.mrr, 0)), byEntity, clients });
  }
  return rows;
}

/** File history against the master clients for the months of the file: totals and client-level differences. */
export function compareHistoryWithMaster(masterClients) {
  const masterByKey = new Map(masterClients.map((c) => [key(c.name), c]));
  const months = Object.keys(MRR_HISTORY.reduce((all, c) => Object.assign(all, c.months), {})).sort();
  const lastFileMonth = MRR_HISTORY_LAST;
  const allMonths = monthRange(months[0], lastFileMonth);
  const diffs = [];
  const totals = allMonths.map((id) => ({ id, file: 0, master: 0 }));
  const seen = new Set();
  for (const c of MRR_HISTORY) {
    const master = masterByKey.get(key(c.client));
    seen.add(key(c.client));
    allMonths.forEach((id, i) => {
      const f = c.months[id] || 0, m = master ? clientMrr(master, id) : 0;
      totals[i].file += f; totals[i].master += m;
      if (Math.abs(f - m) > 0.5) diffs.push({ id, client: c.client, file: f, master: master ? m : null, diff: round2(m - f) });
    });
  }
  for (const master of masterClients.filter((c) => !seen.has(key(c.name)))) {
    allMonths.forEach((id, i) => {
      const m = clientMrr(master, id);
      totals[i].master += m;
      if (m) diffs.push({ id, client: master.name.trim(), file: null, master: m, diff: m });
    });
  }
  return { totals: totals.map((t) => ({ ...t, file: round2(t.file), master: round2(t.master), diff: round2(t.master - t.file) })), diffs };
}
