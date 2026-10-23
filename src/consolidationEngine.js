// Consolidation engine (Board → Consolidated Data → Financials). Pure functions, no I/O.
//
// Inputs per entity and month (local currency, as delivered by the accountants):
//   values.bs           balance sheet at month end (all amounts positive as presented)
//   values.pl_ytd       P&L accumulated year-to-date (costs, expenses and taxes as positive amounts)
//   values.pl_prev_ytd  optional: YTD of the previous month (used when that month was not loaded here)
// Translation to USD (rates are local currency per 1 USD):
//   P&L: month amount (YTD − previous YTD) ÷ month average rate.
//   Balance sheet: closing rate. Net income for the year = sum of the monthly USD results.
//   Translation adjustment (CTA) = assets − liabilities − equity (in USD), shown inside equity.
// Eliminations (USD) are signed adjustments per line; balance-sheet eliminations must net to zero
// between assets and liabilities + equity, and P&L eliminations must net to zero.
// History periods (imported from the Excel consolidation) already hold USD figures.

export const BS_SECTIONS = [
  { key: "current_assets", label: "Activos corrientes", total: "Total activos corrientes", side: "assets" },
  { key: "noncurrent_assets", label: "Activos no corrientes", total: "Total activos no corrientes", side: "assets" },
  { key: "current_liabilities", label: "Pasivos corrientes", total: "Total pasivos corrientes", side: "liabilities" },
  { key: "noncurrent_liabilities", label: "Pasivos no corrientes", total: "Total pasivos no corrientes", side: "liabilities" },
  { key: "equity", label: "Patrimonio", total: "Total patrimonio", side: "equity" },
];

export const BS_LINES = [
  { key: "cash", label: "Efectivo y equivalentes", section: "current_assets" },
  { key: "receivables", label: "Cuentas por cobrar", section: "current_assets" },
  { key: "tax_assets", label: "Impuestos a favor y anticipos", section: "current_assets" },
  { key: "intangibles", label: "Intangibles", section: "noncurrent_assets" },
  { key: "payables", label: "Cuentas por pagar y gastos acumulados", section: "current_liabilities" },
  { key: "tax_liabilities", label: "Impuestos por pagar", section: "current_liabilities" },
  { key: "other_current_liabilities", label: "Otros pasivos corrientes", section: "current_liabilities" },
  { key: "lt_liabilities", label: "Pasivos de largo plazo", section: "noncurrent_liabilities" },
  { key: "capital", label: "Capital pagado", section: "equity" },
  { key: "oci", label: "Otro resultado integral", section: "equity" },
  { key: "retained_earnings", label: "Resultados acumulados", section: "equity" },
  { key: "net_income", label: "Resultado del ejercicio", section: "equity", derived: true },
  { key: "cta", label: "Ajuste por conversión (CTA)", section: "equity", derived: true },
];
export const BS_INPUT_LINES = BS_LINES.filter((l) => !l.derived);

// sign: how the entered (positive) amount affects profit.
export const PL_LINES = [
  { key: "revenue", label: "Ingresos", sign: 1 },
  { key: "cost_of_sales", label: "Costo de ventas", sign: -1 },
  { key: "opex", label: "Gastos operacionales", sign: -1 },
  { key: "other_income", label: "Otros ingresos / (gastos), neto", sign: 1, signed: true },
  { key: "income_tax", label: "Impuesto de renta", sign: -1 },
];

export const PL_SUBTOTALS = {
  gross_profit: { label: "Utilidad bruta", after: "cost_of_sales", keys: ["revenue", "cost_of_sales"] },
  operating_income: { label: "Utilidad operacional", after: "opex", keys: ["revenue", "cost_of_sales", "opex"] },
  pre_tax: { label: "Utilidad antes de impuestos", after: "other_income", keys: ["revenue", "cost_of_sales", "opex", "other_income"] },
  net_income: { label: "Utilidad (pérdida) neta", after: "income_tax", keys: ["revenue", "cost_of_sales", "opex", "other_income", "income_tax"] },
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;
export const prevPeriodId = (id) => {
  const [y, m] = id.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
export const nextPeriodId = (id) => {
  const [y, m] = id.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};

/** Signed P&L from entered (positive) amounts. */
export const signedPl = (values = {}) => Object.fromEntries(PL_LINES.map((l) => [l.key, l.signed ? num(values[l.key]) : l.sign * Math.abs(num(values[l.key]))]));
export const sumPl = (pl, keys = PL_LINES.map((l) => l.key)) => keys.reduce((s, k) => s + num(pl[k]), 0);

export function bsTotals(bs) {
  const by = (section) => BS_LINES.filter((l) => l.section === section).reduce((s, l) => s + num(bs[l.key]), 0);
  const t = Object.fromEntries(BS_SECTIONS.map((s) => [s.key, by(s.key)]));
  t.assets = t.current_assets + t.noncurrent_assets;
  t.liabilities = t.current_liabilities + t.noncurrent_liabilities;
  t.liabilities_equity = t.liabilities + t.equity;
  t.difference = round2(t.assets - t.liabilities_equity);
  return t;
}

/**
 * Builds the whole model from periods, entries and entities.
 * Returns helpers to read any period: monthly P&L (by entity and consolidated), balance sheets, checks.
 */
export function buildModel({ periods, entries, entities }) {
  const periodById = Object.fromEntries(periods.map((p) => [p.id, p]));
  const entry = (pid, eid, kind = "input") => entries.find((e) => e.period_id === pid && e.entity_id === eid && e.kind === kind);
  const history = (pid) => entry(pid, "consolidated", "history");
  const included = entities.filter((e) => e.included).sort((a, b) => a.sort_order - b.sort_order);
  const rate = (pid, currency, type) => (currency === "USD" ? 1 : num(periodById[pid]?.fx?.[currency]?.[type]));

  /** Local YTD P&L (signed) for an entity at a period, or null when not loaded. */
  const ytdLocal = (pid, eid) => {
    const e = entry(pid, eid);
    if (!e || !e.values?.pl_ytd) return null;
    return signedPl(e.values.pl_ytd);
  };

  const memoMonth = new Map();
  /** Monthly P&L of one entity in USD: { lines, net, local, warnings } or null when not loaded. */
  function entityMonth(pid, eid) {
    const key = `${pid}|${eid}`;
    if (memoMonth.has(key)) return memoMonth.get(key);
    const ent = entities.find((x) => x.id === eid);
    const e = entry(pid, eid);
    let result = null;
    if (e && e.values?.pl_ytd) {
      const warnings = [];
      const ytd = signedPl(e.values.pl_ytd);
      let prev = null;
      if (pid.endsWith("-01")) prev = signedPl({});
      else if (e.values.pl_prev_ytd && Object.keys(e.values.pl_prev_ytd).length) prev = signedPl(e.values.pl_prev_ytd);
      else prev = ytdLocal(prevPeriodId(pid), eid);
      if (!prev) { warnings.push("Falta el acumulado del mes anterior: se tomó el acumulado completo como resultado del mes."); prev = signedPl({}); }
      const local = Object.fromEntries(PL_LINES.map((l) => [l.key, ytd[l.key] - prev[l.key]]));
      const avg = rate(pid, ent.currency, "avg");
      if (!avg) warnings.push(`Falta la tasa promedio ${ent.currency}/USD del mes.`);
      const lines = Object.fromEntries(PL_LINES.map((l) => [l.key, avg ? round2(local[l.key] / avg) : 0]));
      result = { lines, net: round2(sumPl(lines)), local, warnings };
    }
    memoMonth.set(key, result);
    return result;
  }

  /** Consolidated monthly P&L in USD. */
  function consolidatedMonth(pid) {
    const h = history(pid);
    if (h?.values?.pl) {
      return { source: "history", lines: { ...h.values.pl }, net: round2(sumPl(h.values.pl)), byEntity: { ...(h.values.ni_by_entity || {}) }, eliminations: null, icGross: h.values.ic_eliminations_gross || 0 };
    }
    const byEntity = {};
    const lines = Object.fromEntries(PL_LINES.map((l) => [l.key, 0]));
    let any = false;
    for (const ent of included) {
      const m = entityMonth(pid, ent.id);
      if (!m) continue;
      any = true;
      byEntity[ent.id] = m.net;
      for (const l of PL_LINES) lines[l.key] += m.lines[l.key];
    }
    const elim = entry(pid, "eliminations")?.values?.pl || {};
    for (const l of PL_LINES) lines[l.key] = round2(lines[l.key] + num(elim[l.key]));
    if (!any && !Object.keys(elim).length) return null;
    return { source: "computed", lines, net: round2(sumPl(lines)), byEntity, eliminations: elim, eliminationNet: round2(sumPl(elim)) };
  }

  /** Year-to-date net income in USD for an entity (sum of monthly results, history or computed). */
  function ytdNetUsd(pid, eid) {
    const [y, m] = pid.split("-").map(Number);
    let total = 0;
    for (let i = 1; i <= m; i++) {
      const p = `${y}-${String(i).padStart(2, "0")}`;
      const h = history(p);
      if (h?.values?.ni_by_entity && eid in h.values.ni_by_entity) total += num(h.values.ni_by_entity[eid]);
      else total += entityMonth(p, eid)?.net || 0;
    }
    return round2(total);
  }

  /** Balance sheet of one entity: local (as entered + net income) and USD (closing rate + CTA). */
  function entityBalance(pid, eid) {
    const ent = entities.find((x) => x.id === eid);
    const e = entry(pid, eid);
    if (!e?.values?.bs) return null;
    const warnings = [];
    const local = Object.fromEntries(BS_INPUT_LINES.map((l) => [l.key, num(e.values.bs[l.key])]));
    const ytd = ytdLocal(pid, eid);
    local.net_income = ytd ? sumPl(ytd) : 0;
    local.cta = 0;
    const localTotals = bsTotals(local);
    if (Math.abs(localTotals.difference) > 1) warnings.push(`El balance en ${ent.currency} no cuadra: activos − (pasivos + patrimonio) = ${localTotals.difference.toLocaleString("en-US")}.`);
    const close = rate(pid, ent.currency, "close");
    if (!close) warnings.push(`Falta la tasa de cierre ${ent.currency}/USD del mes.`);
    const usd = Object.fromEntries(BS_INPUT_LINES.map((l) => [l.key, close ? round2(local[l.key] / close) : 0]));
    usd.net_income = ytdNetUsd(pid, eid);
    usd.cta = 0;
    const pre = bsTotals(usd);
    usd.cta = round2(pre.assets - pre.liabilities_equity);
    return { local, localTotals, usd, usdTotals: bsTotals(usd), warnings };
  }

  /** Consolidated balance sheet: columns per entity (USD), eliminations and total. */
  function consolidatedBalance(pid) {
    const h = history(pid);
    if (h?.values?.bs) {
      const columns = {};
      if (h.values.bs_by_entity) for (const [k, v] of Object.entries(h.values.bs_by_entity)) columns[k] = { ...v, cta: 0 };
      const total = { ...h.values.bs, cta: 0 };
      return { source: "history", columns, total, totals: bsTotals(total), warnings: [] };
    }
    const columns = {};
    const warnings = [];
    let any = false;
    for (const ent of included) {
      const b = entityBalance(pid, ent.id);
      if (!b) continue;
      any = true;
      columns[ent.id] = b.usd;
      warnings.push(...b.warnings.map((w) => `${ent.name}: ${w}`));
    }
    const elim = Object.fromEntries(BS_LINES.map((l) => [l.key, num(entry(pid, "eliminations")?.values?.bs?.[l.key])]));
    const elimTotals = bsTotals(elim);
    if (Math.abs(elimTotals.difference) > 0.5) warnings.push(`Las eliminaciones del balance no cuadran: activos ${elimTotals.assets.toLocaleString("en-US")} vs pasivos + patrimonio ${elimTotals.liabilities_equity.toLocaleString("en-US")}.`);
    columns.eliminations = elim;
    if (!any) return null;
    const total = Object.fromEntries(BS_LINES.map((l) => [l.key, round2(Object.values(columns).reduce((s, c) => s + num(c[l.key]), 0))]));
    const totals = bsTotals(total);
    if (Math.abs(totals.difference) > 1) warnings.push(`El balance consolidado no cuadra por ${totals.difference.toLocaleString("en-US")}.`);
    return { source: "computed", columns, total, totals, warnings };
  }

  /** Readiness of a draft period for closing. */
  function checklist(pid) {
    const p = periodById[pid];
    const items = [];
    const currencies = [...new Set(included.map((e) => e.currency).filter((c) => c !== "USD"))];
    for (const c of currencies) items.push({ label: `Tasas ${c}/USD (promedio y cierre)`, ok: Boolean(num(p?.fx?.[c]?.avg) && num(p?.fx?.[c]?.close)) });
    for (const ent of included) {
      const e = entry(pid, ent.id);
      const b = entityBalance(pid, ent.id);
      items.push({ label: `${ent.name}: estados cargados`, ok: e?.status === "loaded" });
      if (b) items.push({ label: `${ent.name}: balance cuadra en ${ent.currency}`, ok: Math.abs(b.localTotals.difference) <= 1 });
    }
    const pl = consolidatedMonth(pid);
    const bs = consolidatedBalance(pid);
    items.push({ label: "Eliminaciones de resultados netean en cero", ok: !pl || Math.abs(pl.eliminationNet || 0) <= 0.5 });
    items.push({ label: "Eliminaciones de balance cuadran", ok: !bs || Math.abs(bsTotals(bs.columns.eliminations || {}).difference) <= 0.5 });
    items.push({ label: "Balance consolidado cuadra", ok: Boolean(bs) && Math.abs(bs.totals.difference) <= 1 });
    return items;
  }

  return { periodById, entry, history, included, rate, entityMonth, consolidatedMonth, ytdNetUsd, entityBalance, consolidatedBalance, checklist };
}

/** Parses amounts typed or pasted in US (1,234.56) or Latin (1.234,56) format. */
export function parseAmount(text) {
  if (text == null) return 0;
  let s = String(text).trim().replace(/[$\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (!s || s === "-") return 0;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    s = s.replace(dec === "." ? /,/g : /\./g, "").replace(",", ".");
  } else if (lastComma >= 0 || lastDot >= 0) {
    const sep = lastComma >= 0 ? "," : ".";
    const parts = s.split(sep);
    const thousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3);
    s = thousands ? parts.join("") : parts.join(".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
