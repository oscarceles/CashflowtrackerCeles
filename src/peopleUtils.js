// Shared helpers for the People module (payroll, directory, exports).

export const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
export const MONTH_NAMES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
// Fixed categorical order (validated with the dataviz palette checker); color follows the area.
export const AREA_COLORS = {
  Data: "#2a78d6", Product: "#eb6834", Sales: "#1baf7a", CS: "#eda100",
  Growth: "#e87ba4", Implementacion: "#008300", "P&A": "#4a3aa7", "Sin área": "#e34948",
};
export const OTHER_COLOR = "#8a94a5";
export const areaColor = (area) => AREA_COLORS[area] || OTHER_COLOR;

export const ADJ_TYPES = [
  { id: "Bono", sign: 1 },
  { id: "Comisión", sign: 1 },
  { id: "Reembolso", sign: 1 },
  { id: "Deducción", sign: -1 },
  { id: "Prepagada", sign: -1 },
  { id: "Otro", sign: 0 }, // amount keeps the sign typed by the user
];

export const usd = (n, decimals = 0) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: decimals, maximumFractionDigits: decimals,
});
export const usdK = (n) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(Math.abs(n) >= 100000 ? 0 : 1)}k` : usd(n));
export const pct = (n) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—");
export const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const periodLabel = (p) => (p ? `${MONTH_NAMES[p.month - 1]} ${p.year}` : "");

// Mirrors public.payroll_line_compute() in supabase/people.sql.
export const adjustmentsTotal = (line) => (line.adjustments || []).reduce((s, a) => s + num(a.usd), 0);
export const lineTotal = (line) => line.source === "import"
  ? num(line.total)
  : Math.round(((num(line.base_salary) + num(line.allowance)) / 30 * num(line.days)
    + num(line.prima) + num(line.platform_fee) + adjustmentsTotal(line) + num(line.liquidation?.total)) * 100) / 100;

// Excel DAYS360 (US method), mirrors public.days360().
export function days360(startIso, endIso) {
  const s = new Date(`${startIso}T00:00:00`), e = new Date(`${endIso}T00:00:00`);
  const lastDay = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() === d.getDate();
  let d1 = s.getDate(), d2 = e.getDate();
  if (s.getMonth() === 1 && lastDay(s)) { if (e.getMonth() === 1 && lastDay(e)) d2 = 30; d1 = 30; }
  if (d2 === 31 && d1 >= 30) d2 = 30;
  if (d1 === 31) d1 = 30;
  return (e.getFullYear() - s.getFullYear()) * 360 + (e.getMonth() - s.getMonth()) * 30 + (d2 - d1);
}

/** Semester bonus paid in June and December: base × days / 180 since the previous payday. */
export function suggestedPrima(period, employee) {
  if (!period || ![6, 12].includes(period.month) || !period.pay_date) return 0;
  const pay = new Date(`${period.pay_date}T00:00:00`);
  const from = new Date(pay); from.setMonth(from.getMonth() - 6);
  const fromIso = from.toISOString().slice(0, 10);
  const start = employee.start_date && employee.start_date > fromIso ? employee.start_date : fromIso;
  const days = Math.max(0, Math.min(180, days360(start, period.pay_date)));
  return Math.round(num(employee.base_salary) * days / 180 * 100) / 100;
}

/** Days worked in the period month for someone who joined during it (30-day months). */
export function suggestedDays(period, startDate) {
  if (!period || !startDate) return 30;
  const [y, m, d] = startDate.split("-").map(Number);
  if (y !== period.year || m !== period.month) return 30;
  return Math.max(0, 30 - Math.min(d, 30) + 1);
}

export function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => {
    const s = c == null ? "" : String(c);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ---------- exits & settlement (liquidación) ---------- */

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (from, to) => (from && to ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) : 0);

/** Same rule as the Excel "Liquidaciones" sheet: salary / 365 × (end − start) per salary period. */
export const segmentAmount = (s) => Math.round(num(s.salary) / 365 * Math.max(0, daysBetween(s.from, s.to)) * 100) / 100;

/**
 * Salary periods from the start date to the exit date, split where the base salary changed
 * (a change in month M starts a new period on day 1 of M), built from the payroll history.
 */
export function buildLiquidationSegments(employee, lines, exitDate, currentBase) {
  const history = lines
    .filter((l) => l.employee_id === employee.id && num(l.base_salary) > 0 && l.period_id <= exitDate.slice(0, 7))
    .sort((a, b) => a.period_id.localeCompare(b.period_id));
  const segments = [];
  for (const h of history) {
    const salary = num(h.base_salary);
    if (segments.length && segments[segments.length - 1].salary === salary) continue;
    const monthStart = `${h.period_id}-01`;
    const from = !segments.length && employee.start_date && employee.start_date < addDays(monthStart, 31) ? employee.start_date : monthStart;
    segments.push({ from, salary });
  }
  if (!segments.length) segments.push({ from: employee.start_date || `${exitDate.slice(0, 7)}-01`, salary: num(currentBase ?? employee.base_salary) });
  return segments.map((seg, i) => {
    const to = i < segments.length - 1 ? addDays(segments[i + 1].from, -1) : exitDate;
    const s = { from: seg.from, to, salary: seg.salary };
    return { ...s, days: Math.max(0, daysBetween(s.from, s.to)), amount: segmentAmount(s) };
  });
}

/** Days worked in the exit month (30-day months), or the line's days if the exit is another month. */
export function exitMonthDays(period, exitDate, fallback) {
  if (!period || !exitDate) return fallback;
  const [y, m, d] = exitDate.split("-").map(Number);
  if (y !== period.year || m !== period.month) return fallback;
  return Math.min(d, 30);
}

/* ---------- Deel bulk adjustments file ---------- */

// Header of Deel's "bulk_advanced" template (Contractors → bulk adjustments).
export const DEEL_HEADER = [
  "Contractor full name", "Contractor email", "Contract ID", "Contract name", "Group", "Currency", "Contract type", "Date", "Project",
  "Bonus", "Bonus description", "Bonus category", "Bonus recurring",
  "Commission", "Commission description", "Commission category", "Commission recurring",
  "Deduction", "Deduction description", "Deduction category", "Deduction recurring",
  "Other", "Other description", "Other category", "Other recurring",
  "Overtime", "Overtime description", "Overtime category", "Overtime recurring",
];

/**
 * One row per person in the payroll with a Deel contract. Novedades map to Deel columns:
 * Bono and prima → Bonus; Comisión → Commission; Deducción, Prepagada and negative "Otro" → Deduction;
 * Reembolso, positive "Otro" and liquidación → Other.
 */
export function buildDeelRows(period, lines, employees, date) {
  const byId = Object.fromEntries(employees.map((e) => [e.id, e]));
  const rows = [];
  const missing = [];
  for (const line of [...lines].sort((a, b) => a.name.localeCompare(b.name))) {
    const e = byId[line.employee_id];
    const buckets = { Bonus: [], Commission: [], Deduction: [], Other: [] };
    const add = (bucket, amount, text) => { if (Math.abs(amount) >= 0.005) buckets[bucket].push({ amount, text }); };
    if (num(line.prima)) add("Bonus", num(line.prima), "Prima semestral");
    for (const a of line.adjustments || []) {
      const usdValue = num(a.usd);
      const label = a.note ? `${a.type}: ${a.note}` : a.type;
      if (a.type === "Bono") add("Bonus", usdValue, label);
      else if (a.type === "Comisión") add("Commission", usdValue, label);
      else if (usdValue < 0) add("Deduction", -usdValue, label);
      else add("Other", usdValue, label);
    }
    if (num(line.liquidation?.total)) add("Other", num(line.liquidation.total), `Liquidación (retiro ${line.exit_date || ""})`.trim());
    const hasAmounts = Object.values(buckets).some((b) => b.length);
    if (!e?.deel_contract_id) { if (hasAmounts) missing.push(line.name); continue; }
    const cell = (bucket) => {
      const items = buckets[bucket];
      if (!items.length) return ["", "", "", "No"];
      const total = items.reduce((s, x) => s + x.amount, 0);
      return [total.toFixed(2), items.map((x) => x.text).join("; ").slice(0, 250), "", "No"];
    };
    rows.push([
      e.deel_name || e.legal_name || e.name, e.deel_email || "", e.deel_contract_id, e.deel_contract_name || "", e.deel_group || "",
      "USD", "Fixed", date, "",
      ...cell("Bonus"), ...cell("Commission"), ...cell("Deduction"), ...cell("Other"), "", "", "", "No",
    ]);
  }
  return { rows, missing };
}
