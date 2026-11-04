// ERP import for the consolidation (Board → Consolidated Data → Financials). Pure functions, no I/O.
//
// Reads the sheets of a trial balance (balanza de comprobación) or a general-ledger detail report
// exported by any ERP and returns its accounts with a debit-positive balance:
//   - "table":  one row per account with columns detected from the header (code, name, opening,
//               debits, credits, closing — single signed column or debit/credit pair).
//   - "ledger": general-ledger detail (e.g. CONTPAQi "Auxiliar del Libro Mayor"): account header rows
//               with "Saldo inicial" and a "Total" row with debits, credits and balance per account.
// Only leaf accounts are consolidated (parents are detected from the codes) so nothing is counted twice.
// Each leaf account is mapped to a consolidation line (consolidationEngine BS_INPUT_LINES / PL_LINES),
// to "ni_control" (current-year result posted in equity, used only as a control) or to "ignore"
// (memorandum accounts). Suggestions come from the chart of accounts (PUC Colombia, SAT México,
// or names/first digit for the rest) and are confirmed and saved per entity by the user.

import { BS_INPUT_LINES, PL_LINES, parseAmount } from "./consolidationEngine.js";

export const CHARTS = [
  { id: "puc", label: "PUC Colombia" },
  { id: "sat", label: "Código agrupador SAT (México)" },
  { id: "generic", label: "Genérico (nombres de cuenta)" },
];
export const defaultChart = (entity) => (entity?.country === "Colombia" ? "puc" : entity?.country === "México" ? "sat" : "generic");

export const SPECIAL_LINES = [
  { key: "ni_control", label: "Resultado del ejercicio según ERP (control, no suma)" },
  { key: "ignore", label: "No consolidar (cuentas de orden)" },
];
const BS_SIDE = Object.fromEntries(BS_INPUT_LINES.map((l) => [l.key, l.section.endsWith("assets") ? "asset" : "credit"]));
export const lineLabel = (key) => BS_INPUT_LINES.find((l) => l.key === key)?.label || PL_LINES.find((l) => l.key === key)?.label || SPECIAL_LINES.find((l) => l.key === key)?.label || key;
export const isBsLine = (key) => key in BS_SIDE;
export const isPlLine = (key) => PL_LINES.some((l) => l.key === key);
export const isAssetLine = (key) => BS_SIDE[key] === "asset";

/** Amount of an account as it enters its line (positive = natural side of the line). */
export function lineAmount(line, dp) {
  if (isAssetLine(line)) return dp;
  if (isBsLine(line) || line === "ni_control") return -dp;
  if (line === "revenue" || line === "other_income") return -dp;
  return dp; // cost_of_sales, opex, income_tax
}
/** Signed effect on profit (P&L lines only). */
export const profitEffect = (line, dp) => -dp;

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const compact = (s) => norm(s).replace(/[^a-z0-9]/g, "");
const isCode = (v) => typeof v === "number" ? Number.isInteger(v) && v > 0 : /^\s*\d[\d.\-\s]*$/.test(String(v ?? "")) && /\d/.test(String(v));
const toNum = (v) => (typeof v === "number" ? v : v == null || String(v).trim() === "" ? 0 : parseAmount(v));
const isNumericCell = (v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && Number.isFinite(parseAmount(v)) && /\d/.test(v) && !/[a-z]{2,}/i.test(v));
const close = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

/* ---------------- header metadata ---------------- */

const MONTHS = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };
const FULL_MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12, january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const iso = (y, m, d) => (y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null);

function findDates(text) {
  const t = norm(text);
  const out = [];
  const re = /(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[\/\-. ]([a-z]{3,}|\d{1,2})[\/\-. ](\d{2,4})|(\d{1,2}) de ([a-z]+) de(?:l)? (\d{4})|([a-z]+) (\d{1,2}),? (\d{4})/g;
  for (const m of t.matchAll(re)) {
    let date = null;
    if (m[1]) date = iso(+m[1], +m[2], +m[3]);
    else if (m[4]) {
      const mon = /^\d+$/.test(m[5]) ? +m[5] : MONTHS[m[5].slice(0, 3)];
      const y = m[6].length === 2 ? 2000 + +m[6] : +m[6];
      date = iso(y, mon, +m[4]);
    } else if (m[7]) date = iso(+m[9], FULL_MONTHS[m[8]], +m[7]);
    else if (m[10] && (FULL_MONTHS[m[10]] || (m[10].length === 3 && MONTHS[m[10]]))) date = iso(+m[12], FULL_MONTHS[m[10]] || MONTHS[m[10]], +m[11]);
    if (date) out.push({ date, index: m.index });
  }
  return out;
}

const CURRENCIES = [["COP", /pesos? colombianos?|\bcop\b/], ["MXN", /pesos? mexicanos?|\bmxn\b|moneda nacional/], ["CLP", /pesos? chilenos?|\bclp\b/], ["USD", /dolar|dollar|\busd\b|us\$/], ["EUR", /\beuro|\beur\b/]];

/** Company, date range and currency from the report header. */
export function readMeta(rows) {
  const meta = { company: null, from: null, to: null, currency: null };
  const firstData = rows.findIndex((r) => r.some((c) => typeof c === "number"));
  for (const row of rows.slice(0, Math.min(15, firstData < 0 ? 15 : firstData))) {
    const texts = row.filter((c) => typeof c === "string" && c.trim());
    // Also the whole row joined: unquoted CSV headers ("As of May 31, 2026") get split at the comma.
    for (const cell of texts.length > 1 ? [...row, texts.join(", ")] : row) {
      if (typeof cell !== "string" || !cell.trim()) continue;
      const t = norm(cell).trim();
      if (/^(fecha|hoja|pagina|page|impreso|printed|hora|usuario)\b/.test(t)) continue;
      const dates = findDates(cell);
      if (dates.length >= 2 && !meta.to) { meta.from = dates[0].date; meta.to = dates[dates.length - 1].date; continue; }
      if (dates.length === 1 && !meta.to && /\b(al|a|corte|hasta|to|as of|ended|cierre)\b/.test(t)) { meta.to = dates[0].date; continue; }
      // Month range without days, as in Siigo's API reports: "De septiembre 2026 a septiembre 2026".
      const range = !dates.length && !meta.to && t.match(/^de ([a-z]+) (\d{4}) a ([a-z]+) (\d{4})$/);
      if (range && FULL_MONTHS[range[1]] && FULL_MONTHS[range[3]]) {
        const startId = `${range[2]}-${String(FULL_MONTHS[range[1]]).padStart(2, "0")}`;
        const endId = `${range[4]}-${String(FULL_MONTHS[range[3]]).padStart(2, "0")}`;
        meta.from = `${startId}-01`; meta.to = lastDayOf(endId); continue;
      }
      if (!meta.currency) for (const [code, re] of CURRENCIES) if (/moneda|currency|expresad|cifras|amounts/.test(t) && re.test(t)) { meta.currency = code; break; }
      if (!meta.company && /\b(s\.?a\.?s|s\.?a\.? de c\.?v|sapi|inc|llc|ltda|spa|s\.?a\.?|corp|technologies)\b/.test(t) && t.length < 80) meta.company = cell.trim();
    }
  }
  return meta;
}

/* ---------------- parsers ---------------- */

function parseLedger(rows) {
  const accounts = [];
  const controls = [];
  const stack = [];
  for (const row of rows) {
    const cells = row.map((c) => (typeof c === "string" ? c.trim() : c));
    const totalAt = cells.findIndex((c) => typeof c === "string" && /^t\s*o\s*t\s*a\s*l\s*(es)?\s*:?$/i.test(c));
    if (totalAt >= 0) {
      const nums = cells.slice(totalAt + 1).filter((c) => c !== "" && c != null).map(toNum);
      const [debit = 0, credit = 0, saldo] = nums;
      const acc = stack.pop();
      if (!acc) { controls.push({ debit, credit }); continue; }
      acc.debit = debit; acc.credit = credit;
      const op = acc.opening || 0;
      if (saldo == null || !Number.isFinite(saldo)) acc.balance = op + debit - credit;
      else if (close(saldo, op + debit - credit)) acc.balance = saldo;
      else if (close(saldo, op - debit + credit)) acc.balance = -saldo;
      else { acc.balance = op + debit - credit; acc.ambiguous = true; }
      continue;
    }
    if (isCode(cells[0]) && cells.some((c) => typeof c === "string" && /saldo\s*(inicial|anterior)/i.test(c))) {
      const nums = cells.slice(2).filter(isNumericCell).map(toNum);
      const acc = { code: String(cells[0]).trim(), name: String(cells[1] || "").trim(), opening: nums.length ? nums[nums.length - 1] : 0, debit: 0, credit: 0, balance: null };
      accounts.push(acc);
      stack.push(acc);
    }
  }
  for (const a of accounts) if (a.balance == null) { a.balance = a.opening; a.openingOnly = a.opening !== 0; }
  return { format: "ledger", accounts, controls };
}

const COLUMN_RULES = [
  ["opening", /(saldo)?(inicial|anterior)|opening|beginning|previous/],
  ["closing", /(saldo)?(final|actual|nuevo)|ending|closing|saldoalcorte/],
];
function classifyColumn(label) {
  const t = compact(label);
  if (!t) return null;
  let when = null;
  for (const [k, re] of COLUMN_RULES) if (re.test(t)) when = k;
  const debit = /debito|debitos|debe|cargo|deudor|debit|^dr$/.test(t);
  const credit = /credito|creditos|haber|abono|acreedor|credit|^cr$/.test(t);
  if (!when && /^saldos?$|^balance$|saldototal|netbalance/.test(t)) when = "closing";
  if (when && debit) return `${when}_d`;
  if (when && credit) return `${when}_c`;
  if (when) return when;
  if (debit) return "debit";
  if (credit) return "credit";
  if (/codigo|cuenta|account|^cta|^cod|numero|^no$|^num/.test(t)) return /nombre|descrip|name/.test(t) ? "name" : "code";
  if (/nombre|descrip|name|concepto|detalle/.test(t)) return "name";
  return null;
}

function parseTable(rows) {
  let best = { index: -1, score: 0, cols: [] };
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const above = rows[i - 1] || [];
    let carry = "";
    const labels = rows[i].map((c, j) => {
      if (above[j] != null && String(above[j]).trim()) carry = String(above[j]);
      const up = /saldo|movimiento|inicial|final|actual|anterior|balance|period/i.test(carry) ? carry : "";
      return `${up} ${c ?? ""}`.trim();
    });
    const cols = labels.map(classifyColumn);
    const amountCols = cols.filter((c) => c && c !== "code" && c !== "name").length;
    const score = amountCols + (cols.includes("code") ? 1 : 0) + (cols.includes("name") ? 1 : 0);
    if (amountCols >= 1 && score > best.score) best = { index: i, score, cols };
  }
  if (best.index < 0) throw new Error("No se encontró la fila de encabezados (cuenta, débitos/créditos o saldo). Revisa que el archivo sea una balanza de comprobación.");
  const data = rows.slice(best.index + 1).filter((r) => r.some((c) => c !== "" && c != null));
  const cols = [...best.cols];
  const width = Math.max(...data.slice(0, 200).map((r) => r.length), cols.length);
  // Code column: the one whose values look like account codes; name: the first mostly-text column.
  const share = (j, test) => { const vals = data.slice(0, 300).map((r) => r[j]).filter((v) => v !== "" && v != null); return vals.length ? vals.filter(test).length / vals.length : 0; };
  let codeCol = cols.indexOf("code");
  const codeShare = [...Array(width).keys()].map((j) => share(j, isCode));
  if (codeCol < 0 || codeShare[codeCol] < 0.5) { const j = codeShare.findIndex((s) => s >= 0.6); codeCol = j >= 0 && !["opening", "closing", "debit", "credit"].some((k) => String(cols[j] || "").startsWith(k)) ? j : -1; }
  let nameCol = cols.indexOf("name");
  if (nameCol < 0 || nameCol === codeCol) nameCol = [...Array(width).keys()].find((j) => j !== codeCol && !cols[j]?.match(/^(opening|closing|debit|credit)/) && share(j, (v) => typeof v === "string" && /[a-z]/i.test(v)) >= 0.6) ?? -1;
  const at = (r, key) => { const j = cols.indexOf(key); return j >= 0 ? toNum(r[j]) : null; };
  const has = (key) => cols.includes(key);
  let signed = false;
  const accounts = [];
  const controls = [];
  for (const r of data) {
    let code = codeCol >= 0 ? String(r[codeCol] ?? "").trim() : "";
    let name = nameCol >= 0 ? String(r[nameCol] ?? "").trim() : "";
    if (!code && name) { const m = name.match(/^(\d[\d.\-]*)\s+[-–]?\s*(.+)$/); if (m) { code = m[1]; name = m[2]; } }
    if (!code && !name) continue;
    const n = norm(name);
    const isTotal = /^(total|totales|suma|sumas|gran total)\b/.test(n) || (!code && /^total/.test(norm(r.find((c) => typeof c === "string" && c.trim()) || "")));
    const opening = has("opening_d") || has("opening_c") ? (at(r, "opening_d") || 0) - (at(r, "opening_c") || 0) : has("opening") ? at(r, "opening") : null;
    const debit = at(r, "debit") || 0, credit = at(r, "credit") || 0;
    let balance;
    if (has("closing_d") || has("closing_c")) balance = (at(r, "closing_d") || 0) - (at(r, "closing_c") || 0);
    else if (has("closing")) { balance = at(r, "closing"); signed = true; }
    else if (opening != null) balance = opening + debit - credit;
    else balance = debit - credit; // e.g. QuickBooks trial balance: the Debit/Credit columns are balances
    if ([opening, debit, credit, balance].some((v) => v != null && !Number.isFinite(v))) continue;
    if (isTotal) { if (/^(total|totales|sumas?( iguales)?|gran total)\s*:?$/.test(n) || !name) controls.push({ debit, credit, balance }); continue; }
    if (!code && !/[a-z]/i.test(name)) continue;
    accounts.push({ code: code || name, name, opening: opening ?? 0, debit, credit, balance: balance ?? 0 });
  }
  const movementsAreBalances = !has("opening") && !has("opening_d") && !has("closing") && !has("closing_d") && !has("closing_c");
  return { format: "table", accounts, controls, signedClosing: signed, movementsAreBalances, columnTypes: cols.filter(Boolean), headerScore: best.score, headerNumeric: rows[best.index].some((c) => typeof c === "number") };
}

/* ---------------- presented statements ---------------- */
// Balance sheets and income statements as the ERP presents them, not trial balances:
// QuickBooks "Balance Sheet" / "Profit and Loss by Month", CONTPAQi "Balance General" (assets on the left,
// liabilities and equity on the right) and income statements with one column per month.
// Rows are label + amount; headings have no amount and are closed by "Total …" / "Suma del …" rows.
// Accounts have no codes: the code is the heading path + name (stable from month to month).
// Amounts are presented by nature (assets, liabilities, income and expenses positive) and are turned into
// debit-positive balances from the section they sit in (or, without headings, from the account name).

const TOTAL_BS = /^(total|totales|suma|sumas|gran total)\b/;
const TOTAL_PL = /^(total|totales|suma|sumas|gran total|utilidad|perdida|resultado|gross (profit|margin)|net (earnings|income|operating|other|profit|loss|revenue)|operating (income|profit)|ebitda|margen)\b/;
const EXPENSE_NAME = /gasto|expense|loss|perdida|costo|cost\b|egreso/;
const spacedLetters = (s) => (/^([a-zà-ÿ] )+[a-zà-ÿ]$/i.test(s.trim()) ? s.replace(/ /g, "") : s);
const cleanLabel = (s) => spacedLetters(String(s ?? "").trim()).replace(/\s+/g, " ");

function headingSection(label) {
  const t = norm(cleanLabel(label));
  const out = {};
  if (findDates(label).length || /posicion financiera|situacion financiera|balance general|balance sheet|estado de resultados|profit and loss|income statement/.test(t)) return out;
  if (/pasivo|liabilit/.test(t)) out.side = "liabilities";
  else if (/activo|assets?\b/.test(t)) out.side = "assets";
  else if (/^capital$|capital contable|patrimonio|equity|stockholders|shareholders/.test(t)) out.side = "equity";
  if (/largo plazo|non.?current|no corriente|no circulante|long.?term|fijo/.test(t)) out.term = "noncurrent";
  else if (/corto plazo|current|corriente|circulante/.test(t)) out.term = "current";
  if (/other income|otros ingresos|other expense|otros gastos|no operacional|financier|other income\(loss\)/.test(t)) out.pl = "other_income";
  else if (/income tax|impuesto|isr\b/.test(t)) out.pl = "income_tax";
  else if (/^(income|ingresos?|revenues?|ventas|sales)\b/.test(t)) out.pl = "revenue";
  else if (/cost of|costos?\b/.test(t)) out.pl = "cost_of_sales";
  else if (/expense|gastos?\b/.test(t)) out.pl = "opex";
  return out;
}

const MONTH_WORDS = { ...MONTHS, ...FULL_MONTHS };
/** Month (and year, if present) of a column header: "Jan 2026", "ENERO", "2026-01". */
function headerMonth(v) {
  if (typeof v !== "string") return null;
  const t = norm(v).trim().replace(/\./g, "");
  let m = t.match(/^([a-z]+)[\s\-/]*(\d{4})?$/);
  if (m && MONTH_WORDS[m[1]] && (m[1].length === 3 || FULL_MONTHS[m[1]])) return { month: MONTH_WORDS[m[1]], year: m[2] ? +m[2] : null };
  m = t.match(/^(\d{4})-(\d{1,2})$/);
  return m ? { month: +m[2], year: +m[1] } : null;
}

/** Splits the sheet into label/amount sequences: one per month-column table, or one per label column. */
function statementLayout(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const months = rows[i].map((c, j) => ({ j, h: headerMonth(c) })).filter((x) => x.h);
    if (months.length >= 2) return { header: i, months };
  }
  // Label columns: text followed by an amount in the next one or two cells.
  const counts = {};
  for (const r of rows) {
    for (let j = 0; j < r.length; j++) {
      if (typeof r[j] !== "string" || !/[a-z]/i.test(r[j])) continue;
      const k = [j + 1, j + 2].find((x) => typeof r[x] === "number");
      if (k != null) { const key = `${j}|${k}`; counts[key] = (counts[key] || 0) + 1; }
    }
  }
  const pairs = Object.entries(counts).filter(([, n]) => n >= 3).map(([k]) => k.split("|").map(Number)).sort((a, b) => a[0] - b[0]);
  const byLabel = new Map();
  for (const [j, k] of pairs) if (!byLabel.has(j) || counts[`${j}|${k}`] > counts[`${j}|${byLabel.get(j)}`]) byLabel.set(j, k);
  return { pairs: [...byLabel.entries()] };
}

function parseStatement(rows, { periodId } = {}) {
  const meta = readMeta(rows);
  const title = norm(rows.slice(0, 8).flat().filter((c) => typeof c === "string").join(" "));
  const layout = statementLayout(rows);
  const year = +(periodId || meta.to || "").slice(0, 4) || null;
  const target = periodId ? +periodId.slice(5) : null;
  const sequences = []; // [{ label, values: number[] | null }]
  let columns = null;
  if (layout.months) {
    const cols = layout.months.filter((x) => !x.h.year || !year || x.h.year === year);
    if (target && !cols.some((x) => x.h.month === target)) throw new Error(`El archivo no tiene la columna de ${Object.keys(FULL_MONTHS)[target - 1]} ${year || ""}.`);
    columns = cols.map((x) => ({ j: x.j, month: x.h.month }));
    const first = Math.min(...columns.map((c) => c.j));
    const seq = [];
    for (const r of rows.slice(layout.header + 1)) {
      const label = r.slice(0, first).find((c) => typeof c === "string" && c.trim());
      if (!label) continue;
      const nums = columns.map((c) => (typeof r[c.j] === "number" ? r[c.j] : isNumericCell(r[c.j]) ? toNum(r[c.j]) : null));
      seq.push({ label, values: nums.some((v) => v != null) ? nums.map((v) => v || 0) : null });
    }
    sequences.push(seq);
  } else {
    if (!layout.pairs.length) throw new Error("No se reconoció el formato del estado financiero.");
    for (const [j, k] of layout.pairs) {
      const seq = [];
      for (const r of rows) {
        const label = r[j];
        if (typeof label !== "string" || !/[a-z]/i.test(label)) continue;
        const v = typeof r[k] === "number" ? r[k] : isNumericCell(r[k]) ? toNum(r[k]) : null;
        seq.push({ label, values: v == null ? null : [v] });
      }
      sequences.push(seq);
    }
  }
  const isBs = sequences.some((s) => s.some((x) => !x.values && headingSection(x.label).side)) || /balance|posicion financiera|situacion financiera|financial position/.test(title) && !/resultados|profit and loss|income statement|perdidas y ganancias/.test(title);
  const kind = isBs ? "bs" : "pl";
  // Amount of each account for the period: balance sheet = the month's column; P&L = sum of the year up to the month.
  const pick = (values) => {
    if (!columns) return values[0];
    if (kind === "bs") return values[columns.findIndex((c) => c.month === target)] ?? values[values.length - 1];
    return columns.reduce((s, c, i) => s + (!target || c.month <= target ? values[i] : 0), 0);
  };

  const accounts = [];
  const controls = [];
  const codes = new Set();
  for (const seq of sequences) {
    const stack = [];
    let started = false;
    let seg = 0;
    const items = [];
    for (const x of seq) {
      const label = cleanLabel(x.label);
      const n = norm(label);
      if (!x.values) {
        const sec = headingSection(label);
        if (sec.side || sec.pl) started = true;
        if (started) stack.push({ label, ...sec });
        continue;
      }
      if ((kind === "bs" ? TOTAL_BS : TOTAL_PL).test(n) || /^total/.test(n)) {
        const c = compact(label).replace(/^(totales|total|sumas|suma)(for|del|de|of)?/, "");
        const at = stack.map((h) => compact(h.label)).findLastIndex((h) => h && h === c);
        if (at >= 0) stack.length = at;
        controls.push({ label, amount: pick(x.values) });
        seg++;
        continue;
      }
      if (!started && kind === "pl") started = true;
      items.push({ label, values: x.values, stack: [...stack], seg });
    }
    // Rows that carry the sum of the rows below them (income statements without headings).
    const parentOf = new Array(items.length).fill(-1);
    for (let i = 0; i < items.length; i++) {
      if (!items[i].values.some((v) => Math.abs(v) > 0.005)) continue;
      const acc = items[i].values.map(() => 0);
      for (let k = i + 1; k < items.length && items[k].seg === items[i].seg && items[k].stack.length === items[i].stack.length; k++) {
        items[k].values.forEach((v, c) => { acc[c] += v; });
        if (k - i >= 2 && acc.every((v, c) => close(v, items[i].values[c], 0.02))) { items[i].parent = true; for (let q = i + 1; q <= k; q++) parentOf[q] = i; break; }
      }
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const chain = [];
      for (let p = parentOf[i]; p >= 0; p = parentOf[p]) chain.unshift(items[p]);
      const side = [...it.stack].reverse().find((h) => h.side)?.side;
      const term = [...it.stack].reverse().find((h) => h.term)?.term;
      const plHead = it.stack.find((h) => h.pl)?.pl || chain.map((c) => headingSection(c.label).pl || suggestGeneric("", norm(c.label))).find((l) => isPlLine(l || ""));
      const path = [...it.stack.map((h) => h.label), ...chain.map((c) => c.label)];
      let code = [...path, it.label].join(" › ");
      for (let d = 2; codes.has(code); d++) code = `${[...path, it.label].join(" › ")} (${d})`;
      codes.add(code);
      const amount = pick(it.values);
      const acc = { code, name: it.label, group: path.join(" › "), opening: 0, debit: 0, credit: 0, kind, leaf: !it.parent };
      if (kind === "bs") {
        const s = side || "assets";
        acc.section = s === "equity" ? "equity" : `${term === "noncurrent" ? "noncurrent" : "current"}_${s}`;
        acc.balance = s === "assets" ? amount : -amount;
      } else {
        const n = norm(it.label);
        acc.section = plHead || null;
        const line = acc.section || suggestGeneric("", n) || "opex";
        const contra = CONTRA_NAME.test(n);
        if (line === "revenue") acc.balance = contra ? Math.abs(amount) : -amount;
        else if (line === "cost_of_sales" && /devoluc|descuento|desc|rebaja|bonificac/.test(n)) acc.balance = -Math.abs(amount);
        else if (line === "other_income") acc.balance = EXPENSE_NAME.test(n) || (!plHead && EXPENSE_NAME.test(norm(path.join(" ")))) ? amount : -amount;
        else acc.balance = amount;
        if (!acc.section) acc.section = isPlLine(line) ? line : null;
      }
      acc.balance = Math.round(acc.balance * 100) / 100;
      if (columns && kind === "pl") acc.months = Object.fromEntries(columns.map((c, q) => [c.month, Math.round(it.values[q] * 100) / 100]));
      accounts.push(acc);
    }
  }
  if (columns && kind === "pl") { meta.from = year && `${year}-01-01`; if (target && year) meta.to = `${year}-${String(target).padStart(2, "0")}-${String(new Date(Date.UTC(year, target, 0)).getUTCDate()).padStart(2, "0")}`; }
  return { format: "statement", kind, accounts, controls, meta, basis: kind === "pl" ? "ytd" : null, columns: columns ? columns.map((c) => c.month) : null };
}
const CONTRA_NAME = /devoluc|descuento|rebaja|bonificac|discount|return|refund/;

/* ---------------- hierarchy ---------------- */

const segments = (code) => code.split(/[.\-\s:]+/).filter(Boolean);
function isAncestor(a, b) {
  if (a === b) return false;
  if (/[.\-\s:]/.test(a) || /[.\-\s:]/.test(b)) {
    const sa = segments(a), sb = segments(b);
    let k = sa.length;
    if (sa.length === sb.length) while (k > 0 && /^0+$/.test(sa[k - 1])) k--;
    if (k === 0 || k >= sb.length) return false;
    for (let i = 0; i < k; i++) if (sa[i] !== sb[i]) return false;
    return sb.slice(k).some((s) => !/^0+$/.test(s)) || sa.length !== sb.length;
  }
  return /^\d+$/.test(a) && /^\d+$/.test(b) && b.length > a.length && b.startsWith(a);
}

function markLeaves(accounts) {
  const parentMismatches = [];
  const sorted = [...accounts].sort((x, y) => (x.code < y.code ? -1 : 1));
  for (const a of accounts) a.leaf = true;
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const desc = [];
    for (let j = 0; j < sorted.length; j++) if (i !== j && isAncestor(a.code, sorted[j].code)) desc.push(sorted[j]);
    if (!desc.length) continue;
    a.leaf = false;
    a.descendants = desc;
  }
  for (const a of accounts) {
    if (a.leaf) continue;
    const leafSum = a.descendants.filter((d) => d.leaf).reduce((s, d) => s + d.balance, 0);
    if (!close(leafSum, a.balance, Math.max(1, Math.abs(a.balance) * 1e-6))) parentMismatches.push({ code: a.code, name: a.name, balance: a.balance, children: leafSum });
    delete a.descendants;
  }
  return parentMismatches;
}

/* ---------------- mapping suggestions ---------------- */

const digits = (code) => String(code).replace(/\D/g, "");
const wordRe = new Map();
// Words match at the start of a word ("rent" matches "rental", not "current").
const has = (name, ...words) => words.some((w) => {
  if (w instanceof RegExp) return w.test(name);
  if (!wordRe.has(w)) wordRe.set(w, new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`));
  return wordRe.get(w).test(name);
});
const NAME_EXCLUDE = {
  cash: /fee|charge|comision|gasto|expense|interes|commission|cargo|credit card|tarjeta/,
  revenue: /tax|impuesto|deferred|diferid|anticipad/,
};

const TAX_EXPENSE = [/\bisr\b/, "impuesto sobre la renta", "impuesto de renta", "renta y complementarios", "income tax"];
const INTANGIBLE = ["intangible", "software", "licencia", "license", "patent", "patente", "marca", "trademark", "goodwill", "plusvalia", "desarrollo"];

function suggestPuc(code, name) {
  const d = digits(code);
  const c1 = d[0], c2 = d.slice(0, 2), c4 = d.slice(0, 4);
  if (c1 === "1") {
    if (c2 === "11") return "cash";
    if (c2 === "12" || c2 === "14") return "other_current_assets";
    if (c2 === "13") return c4 === "1355" ? "tax_assets" : c4 === "1330" ? "other_current_assets" : "receivables";
    if (c2 === "15") return "fixed_assets";
    if (c2 === "16") return "intangibles";
    return "other_noncurrent_assets";
  }
  if (c1 === "2") {
    if (c2 === "22" || c2 === "23" || c2 === "25" || c2 === "26") return "payables";
    if (c2 === "24") return "tax_liabilities";
    if (c2 === "29") return "lt_liabilities";
    return "other_current_liabilities";
  }
  if (c1 === "3") {
    if (c2 === "31" || c2 === "32" || c2 === "35") return "capital";
    if (c2 === "34" || c2 === "38") return "oci";
    if (c2 === "36") return "ni_control";
    return "retained_earnings";
  }
  if (c1 === "4") return c2 === "41" ? "revenue" : "other_income";
  if (c1 === "5") return c2 === "53" ? "other_income" : c2 === "54" ? "income_tax" : c2 === "59" ? "ignore" : "opex";
  if (c1 === "6" || c1 === "7") return "cost_of_sales";
  if (c1 === "8" || c1 === "9") return "ignore";
  return null;
}

function suggestSat(code, name) {
  const g = +digits(code).slice(0, 3);
  if (!g) return null;
  if (g >= 101 && g <= 103) return "cash";
  if (g >= 105 && g <= 108) return "receivables";
  if ((g >= 110 && g <= 114) || g === 118 || g === 119) return "tax_assets";
  if (g >= 104 && g <= 121) return "other_current_assets";
  if (g >= 151 && g <= 172) return has(name, ...INTANGIBLE) ? "intangibles" : "fixed_assets";
  if (g >= 173 && g <= 199) return has(name, ...INTANGIBLE) ? "intangibles" : "other_noncurrent_assets";
  if (g === 201 || g === 202 || g === 210 || g === 211 || g === 215) return "payables";
  if ([207, 208, 209, 212, 213, 216].includes(g)) return "tax_liabilities";
  if (g >= 203 && g <= 250) return "other_current_liabilities";
  if (g >= 251 && g <= 299) return "lt_liabilities";
  if (g === 301 || g === 302) return "capital";
  if (g === 303 || g === 304) return "retained_earnings";
  if (g === 305) return "ni_control";
  if (g >= 306 && g <= 399) return "oci";
  if (g === 401 || g === 402) return "revenue";
  if (g >= 403 && g <= 499) return "other_income";
  if (g >= 501 && g <= 599) return "cost_of_sales";
  if (g === 611) return "income_tax";
  if (g >= 600 && g <= 699) return has(name, ...TAX_EXPENSE) ? "income_tax" : "opex";
  if (g >= 700 && g <= 799) return "other_income";
  if (g >= 800) return "ignore";
  return null;
}

// Ordered: the first rule whose words appear in the (accent-free, lower-case) name wins.
const NAME_RULES = [
  ["ignore", ["cuentas de orden", "memorandum", "deudoras de control", "acreedoras de control"]],
  ["ni_control", ["net income", "resultado del ejercicio", "utilidad del ejercicio", "perdida del ejercicio", "resultado del periodo", "utilidad del periodo"]],
  ["retained_earnings", ["retained earnings", "resultados acumulados", "utilidades acumuladas", "ejercicios anteriores", "utilidades retenidas", "reserva", "opening balance equity", "accumulated deficit"]],
  ["oci", ["other comprehensive", "otro resultado integral", "translation adjustment", "conversion acumulad"]],
  ["capital", ["common stock", "preferred stock", "paid in", "paid-in", "apic", "capital social", "capital suscrito", "capital pagado", "capital stock", "share capital", "prima en colocacion", "aportes de socios", /\bsafe\b/]],
  ["income_tax", ["income tax expense", "provision for income tax", "impuesto de renta y", "gasto por impuesto", "renta y complementarios", "impuesto sobre la renta", /\bisr\b(?!.*pagar)/, /i\.s\.r\.|p\.t\.u\.|\bptu\b/]],
  ["tax_liabilities", ["tax payable", "taxes payable", "impuestos por pagar", "iva por pagar", "iva trasladado", "retencion en la fuente por pagar", "retenciones por pagar", "sales tax", "isr por pagar", "impuesto de renta por pagar", "industria y comercio"]],
  ["tax_assets", ["iva a favor", "impuestos a favor", "saldo a favor", "anticipo de impuesto", "anticipo de renta", "pagos provisionales", "tax receivable", "prepaid tax", "iva acreditable", "autorretencion", "retencion en la fuente a favor"]],
  ["cash", ["cash", "bank", "checking", "savings", "banco", "caja", "efectivo", "cuenta corriente", "cuenta de ahorro", "undeposited", "petty", "money market", "mercury", "brex"]],
  ["receivables", ["receivable", "a/r", "cuentas por cobrar", "clientes", "deudores", "customers", "due from"]],
  ["cost_of_sales", ["cost of", "cogs", "compras", "hosting", "aws", "cloud infrastructure", "infraestructura cloud", "costo de venta", "costos de venta", "costo del servicio", "costos de servicio", "costo de ventas"]],
  ["other_income", ["interest", "interes", "financier", "exchange", "cambiari", "diferencia en cambio", "gain", "loss on", "otros ingresos", "other income", "other expense", "otros gastos", "no operacional", "dividend", "rendimientos"]],
  ["fixed_assets", ["equipment", "furniture", "computer", "property", "equipo", "muebles", "maquinaria", "vehiculo", "depreciation", "depreciacion", "leasehold", "mejoras en"]],
  ["intangibles", INTANGIBLE.filter((w) => w !== "software" && w !== "desarrollo").concat(["capitalized software"])],
  ["other_noncurrent_assets", ["investment in", "inversion en", "inversiones en", "subsidiar", "security deposit", "deposito en garantia", "deferred tax asset"]],
  ["other_current_assets", ["prepaid", "anticipad", "anticipo", "inventory", "inventario", "advances", "short-term investment", "inversiones temporales", "deposit"]],
  ["lt_liabilities", ["long-term", "long term", "largo plazo", "note payable", "notes payable", "loan", "prestamo", "obligaciones financieras", "convertible", "deferred tax liab"]],
  ["payables", ["payable", "a/p", "proveedores", "cuentas por pagar", "credit card", "tarjeta de credito", "accrued", "acumulad", "nomina por pagar", "payroll liabilit", "salarios por pagar", "prestaciones", "cesantias", "vacaciones", "costos y gastos por pagar"]],
  ["other_current_liabilities", ["deferred revenue", "ingresos diferidos", "recibidos por anticipado", "customer deposit", "anticipo de clientes", "due to", "acreedores", "pasivo"]],
  ["revenue", ["revenue", "sales", "ventas", "ingresos operacionales", "ingresos por servicios", "subscription", "income"]],
  ["opex", ["expense", "gasto", "salar", "payroll", "wages", "rent", "arriendo", "honorarios", "fees", "software", "marketing", "travel", "viaje", "seguro", "insurance", "office", "oficina", "servicios", "professional", "legal", "contractor", "nomina", "cost", "costo"]],
];
const GENERIC_DIGIT = { 1: "other_current_assets", 2: "other_current_liabilities", 3: "capital", 4: "revenue", 5: "cost_of_sales", 6: "opex", 7: "opex", 8: "other_income", 9: "income_tax" };
const SIDE_OF = (line) => (isAssetLine(line) ? "1" : isBsLine(line) ? (["capital", "oci", "retained_earnings"].includes(line) ? "3" : "2") : line === "ni_control" ? "3" : line === "revenue" ? "4" : isPlLine(line) ? "5" : null);

function suggestGeneric(code, name) {
  const d = digits(code);
  const first = d.length >= 3 ? d[0] : null;
  for (const [line, words] of NAME_RULES) {
    if (!has(name, ...words) || NAME_EXCLUDE[line]?.test(name)) continue;
    // With numeric codes, only accept a name rule on the same side of the statements as the code.
    if (first && line !== "ignore") {
      const side = SIDE_OF(line);
      const codeSide = first === "1" ? "1" : first === "2" ? "2" : first === "3" ? "3" : first === "4" ? "4" : "5";
      if (side && side !== codeSide && !(side === "4" && line === "other_income") && !(codeSide === "4" && line === "other_income")) continue;
    }
    return line;
  }
  return first ? GENERIC_DIGIT[first] || null : null;
}

const SUFFIXES = /\b(s\.?a\.?s\.?|s\.?a\.?|de c\.?v\.?|sapi|inc\.?|llc|ltda\.?|spa|corp\.?|technologies|tecnologia)\b/g;
/** Other group entity named in an account (intercompany counterparty), or null. */
export function detectCounterparty(name, entity, entities) {
  const n = ` ${norm(name).replace(/[^a-z0-9 ]/g, " ")} `;
  let best = null;
  for (const e of entities) {
    if (e.id === entity.id) continue;
    const full = norm(e.name).replace(/\(.*?\)/g, " ").replace(SUFFIXES, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    const first = full.split(" ")[0];
    const country = norm(e.country || "").split(" ")[0];
    const keys = [full, first && country ? `${first} ${country}` : null, first].filter((k) => k && k.length >= 4);
    for (const k of keys) {
      if (n.includes(` ${k} `) || n.includes(` ${k}`)) {
        const score = k.length + (e.is_holding ? 0.5 : 0);
        if (!best || score > best.score) best = { id: e.id, score };
        break;
      }
    }
  }
  if (best) return best.id;
  return /intercompan|vinculad|relacionad|related part|casa matriz|afiliad/.test(norm(name)) ? "unknown" : null;
}

// Lines allowed in each section of a presented statement, and the default when no name rule fits.
const SECTION_LINES = {
  current_assets: ["cash", "receivables", "tax_assets", "other_current_assets", "fixed_assets", "intangibles", "other_noncurrent_assets"],
  noncurrent_assets: ["fixed_assets", "intangibles", "other_noncurrent_assets", "receivables", "tax_assets", "other_current_assets"],
  current_liabilities: ["payables", "tax_liabilities", "other_current_liabilities", "lt_liabilities"],
  noncurrent_liabilities: ["lt_liabilities", "payables", "tax_liabilities", "other_current_liabilities"],
  equity: ["capital", "oci", "retained_earnings", "ni_control"],
};
const SECTION_DEFAULT = { current_assets: "other_current_assets", noncurrent_assets: "other_noncurrent_assets", current_liabilities: "other_current_liabilities", noncurrent_liabilities: "lt_liabilities", equity: "capital" };

function suggestInSection(account) {
  const sec = account.section;
  if (isPlLine(sec)) {
    const own = suggestGeneric("", norm(account.name));
    return own === "income_tax" && (sec === "opex" || sec === "cost_of_sales") ? own : sec;
  }
  const allowed = SECTION_LINES[sec];
  if (!allowed) return null;
  const rule = (text) => { const n = norm(text); return NAME_RULES.find(([line, words]) => allowed.includes(line) && has(n, ...words) && !NAME_EXCLUDE[line]?.test(n))?.[0]; };
  const n = norm(account.name);
  // The account name first, then tax words, then the name with its headings ("Accounts Receivable › Clients").
  return rule(account.name)
    || (/assets$/.test(sec) && /impuesto|acreditable|\btax|\bvat\b|\biva\b/.test(n) ? "tax_assets" : null)
    || (/liabilities$/.test(sec) && /impuesto|\btax|\bvat\b|\biva\b/.test(n) ? "tax_liabilities" : null)
    || rule(`${account.group || ""} ${account.name}`)
    || SECTION_DEFAULT[sec];
}

/** Suggested consolidation line for an account. */
export function suggestLine(account, chart, periodYear) {
  const name = norm(account.name);
  if (account.section) return suggestInSection(account);
  let line = chart === "puc" ? suggestPuc(account.code, name) : chart === "sat" ? suggestSat(account.code, name) : null;
  // Codes made up from the name (e.g. QuickBooks exports without account numbers) are not used as codes.
  if (!line) line = suggestGeneric(chart === "generic" && isCode(account.code) ? account.code : "", name);
  if (line === "ni_control") {
    const year = name.match(/\b(19|20)\d{2}\b/);
    if (year && +year[0] < periodYear) line = "retained_earnings";
  }
  return line;
}

/* ---------------- entry point ---------------- */

const lastDayOf = (pid) => { const [y, m] = pid.split("-").map(Number); return `${pid}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };

function parseSheet(rows, periodId) {
  const isLedger = rows.some((r) => r.some((c) => typeof c === "string" && /saldo\s*inicial\s*:/i.test(c))) && rows.some((r) => r.some((c) => typeof c === "string" && /^\s*t\s*o\s*t\s*a\s*l/i.test(c)));
  if (isLedger) return { ...parseLedger(rows), meta: readMeta(rows) };
  // A trial balance has a header row of column titles (code, name, debits/credits, balances);
  // anything else (balance sheet, income statement, one column per month) is a presented statement.
  let table = null;
  try { table = parseTable(rows); } catch { /* not a trial balance */ }
  if (table && table.headerScore >= 2 && !table.headerNumeric && !statementLayout(rows).months) return { ...table, meta: readMeta(rows) };
  return parseStatement(rows, { periodId });
}

/**
 * Parses the sheets of an ERP export. With several sheets, picks the one of the period (an income statement
 * with that month's column, a sheet dated at the month end or named after the month), else the one with the most accounts.
 */
export function parseErpExport(sheets, fileName = "", { periodId } = {}) {
  const errors = [];
  const candidates = [];
  for (const sheet of sheets) {
    const rows = sheet.rows || [];
    if (!rows.length) continue;
    try {
      const parsed = parseSheet(rows, periodId);
      parsed.sheet = sheet.name;
      if (parsed.accounts.length) candidates.push(parsed);
    } catch (e) { errors.push(`${sheet.name}: ${e.message}`); }
  }
  if (!candidates.length) throw new Error(errors[0] || "No se encontraron cuentas en el archivo.");
  const monthName = periodId ? Object.keys(FULL_MONTHS)[+periodId.slice(5) - 1] : null;
  const score = (p) => (!periodId ? 0
    : (p.columns ? 4 : 0) + (p.meta?.to === lastDayOf(periodId) ? 2 : 0) + (norm(p.sheet).trim().startsWith(monthName) ? 1 : 0));
  candidates.sort((a, b) => score(b) - score(a) || b.accounts.length - a.accounts.length);
  const best = candidates[0];
  if (periodId && candidates.length > 1 && !score(best)) throw new Error(`Ninguna hoja del archivo corresponde a ${monthName} ${periodId.slice(0, 4)}.`);
  best.parentMismatches = best.format === "statement" ? [] : markLeaves(best.accounts);
  best.file = fileName;
  return best;
}

/** Combines the files of one month (a balance sheet and an income statement presented separately). */
export function mergeExports(parsedList) {
  if (parsedList.length === 1) return parsedList[0];
  if (parsedList.some((p) => p.format !== "statement")) throw new Error("Una balanza de comprobación ya trae balance y resultados: súbela sola.");
  const bs = parsedList.filter((p) => p.kind === "bs");
  const pl = parsedList.filter((p) => p.kind === "pl");
  if (bs.length !== 1 || pl.length !== 1) throw new Error("Sube un balance general y un estado de resultados (uno de cada uno).");
  const [b, p] = [bs[0], pl[0]];
  return {
    format: "statement", kind: "both",
    accounts: [...b.accounts, ...p.accounts], controls: [...b.controls, ...p.controls],
    meta: { company: b.meta?.company || p.meta?.company || null, from: p.meta?.from || b.meta?.from || null, to: b.meta?.to || p.meta?.to || null, currency: b.meta?.currency || p.meta?.currency || null },
    basis: p.basis, columns: p.columns, parentMismatches: [],
    file: [b.file, p.file].join(" + "), sheet: [b.sheet, p.sheet].join(" + "),
  };
}

/** "ytd" when the P&L balances accumulate the year, "month" when they hold only the month's movements. */
export function detectBasis(parsed, periodId, chart) {
  if (parsed.basis) return parsed.basis;
  if (periodId.endsWith("-01") || parsed.meta?.from !== `${periodId}-01`) return "ytd";
  // A monthly trial balance with opening balances on income/expense accounts carries the year in its closing balance.
  const year = +periodId.slice(0, 4);
  const plOpening = parsed.accounts.some((a) => a.leaf && Math.abs(a.opening || 0) > 0.005 && isPlLine(suggestLine(a, chart, year) || ""));
  return plOpening ? "ytd" : "month";
}

/** True when the account normally carries a credit balance (liabilities, equity, income). */
export function creditNature(account, line, chart) {
  const d = digits(account.code);
  if (chart === "sat" && d.length >= 3) { const g = +d.slice(0, 3); return (g >= 200 && g < 500) || g === 702 || g === 704; }
  if (chart === "puc" && d) return ["2", "3", "4"].includes(d[0]);
  if (!line || line === "ignore") return false;
  if (line === "other_income") return /income|ingreso|gain|ganancia|utilidad|producto|rendimiento/.test(norm(account.name));
  return !isAssetLine(line) && !["cost_of_sales", "opex", "income_tax"].includes(line);
}

/** Resolves the sign convention of a single signed closing column once lines are known. */
export function resolveSign(parsed, lineOf, chart) {
  if (!parsed.signedClosing) return parsed;
  const leaves = parsed.accounts.filter((a) => a.leaf);
  const credit = (a) => creditNature(a, lineOf(a), chart);
  const sumDp = leaves.reduce((s, a) => s + a.balance, 0);
  const sumNat = leaves.reduce((s, a) => s + (credit(a) ? -a.balance : a.balance), 0);
  if (Math.abs(sumNat) + 0.01 < Math.abs(sumDp)) {
    for (const a of parsed.accounts) if (credit(a)) a.balance = -a.balance;
    parsed.sign = "natural";
  } else parsed.sign = "debit-positive";
  parsed.signedClosing = false;
  return parsed;
}

/** Plain JSON to keep in consolidation_entries.values.import. */
export function toStoredImport(parsed, { chart, basis, by }) {
  return {
    file: parsed.file, sheet: parsed.sheet, format: parsed.format, chart, basis, sign: parsed.sign || "debit-positive",
    meta: parsed.meta, controls: parsed.controls, parentMismatches: parsed.parentMismatches.slice(0, 50),
    movementsAreBalances: Boolean(parsed.movementsAreBalances),
    ...(parsed.format === "statement" ? { kind: parsed.kind, columns: parsed.columns || null } : {}),
    imported_at: new Date().toISOString(), imported_by: by || null,
    accounts: parsed.accounts.map((a) => ({ code: a.code, name: a.name, opening: a.opening || 0, debit: a.debit || 0, credit: a.credit || 0, balance: Math.round(a.balance * 100) / 100, leaf: a.leaf, ...(a.ambiguous ? { ambiguous: true } : {}), ...(a.openingOnly ? { openingOnly: true } : {}), ...(a.section ? { section: a.section, kind: a.kind } : {}), ...(a.group ? { group: a.group } : {}), ...(a.months ? { months: a.months } : {}) })),
  };
}

/**
 * Applies the mapping to a stored import.
 * maps: { [code]: { line, ic_entity } } saved for the entity. Returns per-account resolution and line totals
 * (local currency, as the engine expects: balance sheet presented positive, P&L costs positive).
 */
export function applyMapping(imp, maps, { entity, entities, periodYear }) {
  const rows = [];
  const bs = Object.fromEntries(BS_INPUT_LINES.map((l) => [l.key, 0]));
  const pl = Object.fromEntries(PL_LINES.map((l) => [l.key, 0]));
  let niControl = null;
  let check = 0;
  const leaves = imp.accounts.filter((a) => a.leaf);
  const suggestions = new Map(leaves.map((a) => [a, suggestLine(a, imp.chart, periodYear)]));
  // The ERP's "result for the year" account is only a control when it holds this year's result:
  // without movements during the period it is last year's result not yet closed into retained earnings,
  // and with two such accounts in a statement (CONTPAQi "Resultado del ejercicio" + "Utilidad o Pérdida del Ejercicio")
  // the one that is not the profit/loss of the year is accumulated results.
  const niCandidates = leaves.filter((a) => suggestions.get(a) === "ni_control");
  for (const a of niCandidates) {
    const stale = imp.format === "table" && !imp.movementsAreBalances && Math.abs(a.opening || 0) > 0.005 && !a.debit && !a.credit && close(a.opening, a.balance);
    const secondary = niCandidates.length > 1 && !/utilidad|perdida|net income|profit|loss/.test(norm(a.name));
    if (stale || secondary) suggestions.set(a, "retained_earnings");
  }
  for (const a of leaves) {
    const saved = maps?.[a.code];
    const suggested = suggestions.get(a);
    const line = saved?.line || suggested || null;
    const ic = saved ? saved.ic_entity || null : detectCounterparty(a.name, entity, entities);
    const status = saved?.line ? "saved" : suggested ? "suggested" : "unmapped";
    const amount = line ? lineAmount(line, a.balance) : null;
    if (imp.format !== "statement" || a.kind === "bs") check += a.balance;
    rows.push({ ...a, line, ic, status, amount, suggested });
    if (!line || line === "ignore") continue;
    if (line === "ni_control") niControl = (niControl || 0) + amount;
    else if (isBsLine(line)) bs[line] += amount;
    else pl[line] += amount;
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return { rows, bs: round(bs), pl: round(pl), niControl: niControl == null ? null : Math.round(niControl * 100) / 100, trialDifference: Math.round(check * 100) / 100 };
}
