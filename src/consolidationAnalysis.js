// Review of a consolidation month (Board → Consolidated Data → Financials → Alertas). Pure functions, no I/O.
//
// Produces alerts { id, severity: "error" | "warning" | "info", scope, title, detail, fix, actions[] } from:
//   - each entity's ERP import (trial balance integrity, period and currency of the file, unmapped accounts,
//     balances on the unexpected side, suspense accounts, parent/child totals, ERP current-year result,
//     opening balances vs the previous month's closing),
//   - each entity's statements (balance check, negative monthly revenue, retained earnings and capital movements),
//   - the group (FX rates, intercompany reconciliation by pair, eliminations, month-over-month variances).
// Also computes the suggested intercompany eliminations from the accounts marked as intercompany.
// Thresholds follow common close practice: line variances flagged above 20% MoM and above materiality
// (larger of USD 1,000 or 1% of the month's consolidated revenue).

import { BS_INPUT_LINES, PL_LINES, PL_SUBTOTALS, prevPeriodId, sumPl, bsTotals } from "./consolidationEngine.js";
import { applyMapping, isAssetLine, isBsLine, isPlLine, lineLabel, profitEffect } from "./erpImport.js";

const MONTH_NAMES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const periodLabel = (id) => `${MONTH_NAMES[+id.slice(5) - 1]} ${id.slice(0, 4)}`;
const lastDay = (pid) => { const [y, m] = pid.split("-").map(Number); return `${pid}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };
const fmt = (n, d = 0) => (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (n) => `${n < 0 ? "−" : ""}$${fmt(Math.abs(n))}`;
const round2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : null);

// Typical local-currency-per-USD ranges used to spot inverted or mistyped rates.
const FX_RANGES = { COP: [2500, 6000], MXN: [12, 30], CLP: [600, 1300] };
const SUSPENSE = /suspens|transitori|por clasificar|por identificar|uncategorized|ask my accountant|opening balance equity|partidas pendientes|cuenta puente|sin identificar/;
const CONTRA_REVENUE = /devoluc|descuento|rebaja|bonificac|return|discount|refund|diferid|deferr|unearned/;
// Accounts whose normal balance is opposite to their line: subscribed capital not yet paid, deductible VAT inside VAT payable.
const CONTRA_BS = /deprecia|amortiza|deterioro|estimacion|allowance|provision|por suscribir|suscrito no pagado|descontable|a favor/;
const acct = (a) => (a.code === a.name ? a.name : `${a.code} ${a.name}`);
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Shared access to the resolved imports (mapping applied) of a period. */
export function makeResolver({ model, entities, maps }) {
  const memo = new Map();
  return function resolve(pid, eid) {
    const key = `${pid}|${eid}`;
    if (memo.has(key)) return memo.get(key);
    const entity = entities.find((e) => e.id === eid);
    const imp = model.entry(pid, eid)?.values?.import;
    const result = imp && entity ? { imp, ...applyMapping(imp, maps[eid] || {}, { entity, entities, periodYear: +pid.slice(0, 4) }) } : null;
    memo.set(key, result);
    return result;
  };
}

/** Monthly local amount of one P&L account (YTD − previous YTD, or the month itself for "month" imports). */
function accountMonth(resolve, pid, eid, row) {
  const cur = resolve(pid, eid);
  if (cur.imp.basis === "month") return { value: row.balance, exact: true };
  if (pid.endsWith("-01")) return { value: row.balance, exact: true };
  const prev = resolve(prevPeriodId(pid), eid);
  if (!prev) return { value: row.balance, exact: false };
  const p = prev.rows.find((r) => r.code === row.code);
  return { value: row.balance - (p ? p.balance : 0), exact: true };
}

/**
 * Suggested eliminations (USD) from the intercompany accounts of the period:
 * every intercompany balance and monthly P&L amount is reversed on its line.
 */
export function suggestEliminations({ model, entities, resolve, periodId }) {
  const bs = Object.fromEntries(BS_INPUT_LINES.map((l) => [l.key, 0]));
  const pl = Object.fromEntries(PL_LINES.map((l) => [l.key, 0]));
  const items = [];
  const pairs = {};
  const notes = [];
  for (const ent of model.included) {
    const r = resolve(periodId, ent.id);
    if (!r) continue;
    const closeRate = model.rate(periodId, ent.currency, "close");
    const avgRate = model.rate(periodId, ent.currency, "avg");
    for (const row of r.rows) {
      if (!row.ic || !row.line || row.line === "ignore" || row.line === "ni_control" || !row.balance) continue;
      const pairKey = row.ic === "unknown" ? null : [ent.id, row.ic].sort().join("|");
      if (isBsLine(row.line)) {
        if (!closeRate) continue;
        const amount = round2(row.amount / closeRate);
        bs[row.line] -= amount;
        items.push({ entity: ent, row, kind: "bs", amount });
        if (pairKey) { pairs[pairKey] ||= { bsAssets: 0, bsCredit: 0, pl: 0, entities: pairKey.split("|") }; pairs[pairKey][isAssetLine(row.line) ? "bsAssets" : "bsCredit"] += amount; }
      } else if (isPlLine(row.line)) {
        if (!avgRate) continue;
        const m = accountMonth(resolve, periodId, ent.id, row);
        if (!m.exact) { notes.push(ent.name); continue; } // YTD includes earlier months: not suggested
        const effect = round2(profitEffect(row.line, m.value) / avgRate);
        if (!effect) continue; // no intercompany movement this month
        pl[row.line] -= effect;
        items.push({ entity: ent, row, kind: "pl", amount: effect });
        if (pairKey) { pairs[pairKey] ||= { bsAssets: 0, bsCredit: 0, pl: 0, entities: pairKey.split("|") }; pairs[pairKey].pl += effect; }
      }
    }
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round2(v)]));
  return { bs: round(bs), pl: round(pl), items, pairs, notes: [...new Set(notes)] };
}

/** All alerts of a period. */
export function analysePeriod({ model, entities, maps, periodId }) {
  const resolve = makeResolver({ model, entities, maps });
  const alerts = [];
  const add = (a) => alerts.push({ id: `${a.scope}|${a.title}`, actions: [], ...a });
  const period = model.periodById[periodId];
  if (!period || model.history(periodId)) return { alerts, resolve, eliminations: null };
  const year = +periodId.slice(0, 4);
  const prevId = prevPeriodId(periodId);

  /* ---------- FX ---------- */
  const currencies = [...new Set(model.included.map((e) => e.currency).filter((c) => c !== "USD"))];
  for (const c of currencies) {
    for (const type of ["avg", "close"]) {
      const v = Number(period.fx?.[c]?.[type]);
      const label = type === "avg" ? "promedio" : "de cierre";
      if (!v) { add({ severity: "error", scope: "Tasas", title: `Falta la tasa ${label} ${c}/USD`, detail: `Sin la tasa ${label} no se pueden convertir ${type === "avg" ? "los resultados" : "los saldos del balance"} de las entidades en ${c}.`, fix: `Ingresa la tasa ${label} del mes en moneda local por 1 USD (por ejemplo, la publicada por el banco central).`, actions: [{ type: "goto", tab: "fx", label: "Ir a Tasas" }] }); continue; }
      const range = FX_RANGES[c];
      if (range && (v < range[0] / 3 || v > range[1] * 3)) {
        const inv = 1 / v;
        const inverted = inv >= range[0] / 3 && inv <= range[1] * 3;
        add({ severity: "error", scope: "Tasas", title: `La tasa ${label} ${c}/USD parece ${inverted ? "invertida" : "fuera de rango"}`, detail: `Se ingresó ${fmt(v, 4)}; el rango habitual es ${fmt(range[0])}–${fmt(range[1])} ${c} por 1 USD.`, fix: inverted ? `Usa ${fmt(inv, 2)} (${c} por 1 USD) en lugar de USD por ${c}.` : "Revisa los dígitos y separadores decimales de la tasa.", actions: inverted ? [{ type: "fx", currency: c, rateType: type, value: round2(inv), label: `Usar ${fmt(inv, 2)}` }] : [{ type: "goto", tab: "fx", label: "Ir a Tasas" }] });
      }
      const pv = Number(model.periodById[prevId]?.fx?.[c]?.[type]);
      const ch = pv ? pct(v, pv) : null;
      if (ch != null && Math.abs(ch) > 10) add({ severity: "warning", scope: "Tasas", title: `La tasa ${label} ${c}/USD cambió ${ch.toFixed(1)}% vs ${periodLabel(prevId)}`, detail: `${fmt(pv, 2)} → ${fmt(v, 2)}. Una variación mayor al 10% en un mes es inusual.`, fix: "Confirma la tasa con la fuente oficial; si es correcta, explica el efecto cambiario en la revisión del mes.", actions: [{ type: "goto", tab: "fx", label: "Ir a Tasas" }] });
    }
    const avg = Number(period.fx?.[c]?.avg), cl = Number(period.fx?.[c]?.close);
    if (avg && cl && Math.abs(pct(cl, avg)) > 10) add({ severity: "warning", scope: "Tasas", title: `Promedio y cierre ${c}/USD difieren más de 10%`, detail: `Promedio ${fmt(avg, 2)} vs cierre ${fmt(cl, 2)}.`, fix: "Revisa que no estén intercambiadas o que una corresponda a otro mes.", actions: [{ type: "goto", tab: "fx", label: "Ir a Tasas" }] });
  }

  /* ---------- per entity ---------- */
  for (const ent of model.included) {
    const scope = ent.name;
    const goto = (label = "Revisar entidad") => ({ type: "goto", tab: "entities", entityId: ent.id, label });
    const entry = model.entry(periodId, ent.id);
    if (!entry?.values?.bs && !entry?.values?.pl_ytd) {
      add({ severity: "error", scope, title: "Sin estados financieros cargados", detail: `No hay balance ni estado de resultados de ${periodLabel(periodId)}.`, fix: "Importa la balanza de comprobación del ERP (Excel o CSV) o ingresa las cifras a mano.", actions: [goto("Importar balanza")] });
      continue;
    }
    const closeRate = model.rate(periodId, ent.currency, "close");
    const materialLocal = Math.max(1, 500 * (closeRate || 1));
    const r = resolve(periodId, ent.id);

    if (r) {
      const imp = r.imp;
      const leaves = r.rows;
      const absTotal = leaves.reduce((s, a) => s + Math.abs(a.balance), 0);
      const statement = imp.format === "statement";
      if (statement && imp.kind !== "both") add({ severity: "error", scope, title: imp.kind === "bs" ? "Falta el estado de resultados" : "Falta el balance general", detail: `Se importaron solo los estados ${imp.kind === "bs" ? "de situación financiera" : "de resultados"}: ${imp.kind === "bs" ? "los resultados del mes quedan en cero" : "el balance queda en cero"}.`, fix: "Vuelve a importar seleccionando a la vez el balance general y el estado de resultados del mes.", actions: [goto("Volver a importar")] });
      if (Math.abs(r.trialDifference) > Math.max(1, absTotal * 1e-6)) add({ severity: "error", scope, title: statement ? "El balance importado no cuadra" : "La balanza importada no cuadra", detail: statement ? `Activos − (pasivos + patrimonio) del balance presentado = ${fmt(r.trialDifference, 2)} ${ent.currency}.` : `Débitos − créditos de las cuentas de detalle = ${fmt(r.trialDifference, 2)} ${ent.currency}.`, fix: statement ? "Revisa que el reporte traiga todas las cuentas (sin filtros ni cuentas ocultas) o que no falte una sección." : "Exporta la balanza con todas las cuentas y niveles (incluidas las de resultados), sin filtros de 'solo cuentas con movimiento', y vuelve a importarla.", actions: [goto("Volver a importar")] });
      for (const c of imp.controls || []) if (c.debit && c.credit && Math.abs(c.debit - c.credit) > 1) { add({ severity: "error", scope, title: "Los totales del archivo no cuadran", detail: `Total débitos ${fmt(c.debit, 2)} vs total créditos ${fmt(c.credit, 2)} en el propio reporte del ERP.`, fix: "El ERP tiene pólizas/comprobantes descuadrados en el período: corrígelos en el ERP antes de consolidar.", actions: [] }); break; }
      if (imp.meta?.to && imp.meta.to !== lastDay(periodId)) add({ severity: "warning", scope, title: "La fecha del archivo no corresponde al mes", detail: `El reporte es al ${imp.meta.to} y el mes que se consolida termina el ${lastDay(periodId)}.`, fix: `Exporta la balanza con corte al ${lastDay(periodId)} o importa este archivo en el mes que corresponde.`, actions: [goto("Volver a importar")] });
      if (imp.meta?.from && imp.basis !== "month" && imp.meta.from < `${year}-01-01`) add({ severity: "error", scope, title: "Los resultados incluyen movimientos de años anteriores", detail: `El archivo cubre desde ${imp.meta.from}: las cuentas de resultados acumulan más de un año y el resultado del ejercicio ${year} queda sobrestimado.`, fix: `Exporta el reporte desde el 01/01/${year} (resultados del año) o una balanza con saldos iniciales al inicio del año. Si el ERP ya cerró el año anterior, verifica que los resultados de ${year - 1} estén en resultados acumulados.`, actions: [goto("Volver a importar")] });
      if (imp.meta?.currency && imp.meta.currency !== ent.currency) add({ severity: "error", scope, title: `El archivo está en ${imp.meta.currency}, la entidad en ${ent.currency}`, detail: "Las cifras se convertirían con la tasa equivocada.", fix: `Exporta el reporte en ${ent.currency} (moneda funcional de la entidad).`, actions: [goto()] });

      const unmapped = leaves.filter((a) => !a.line && Math.abs(a.balance) > 0.005);
      if (unmapped.length) add({ severity: "error", scope, title: `${unmapped.length} cuenta${unmapped.length > 1 ? "s" : ""} sin asignar`, detail: `Saldo sin asignar: ${fmt(unmapped.reduce((s, a) => s + a.balance, 0), 2)} ${ent.currency}. Ej.: ${unmapped.slice(0, 4).map(acct).join("; ")}.`, fix: "Asigna cada cuenta a una línea del balance o del estado de resultados en la tabla de cuentas; la asignación se recuerda para los meses siguientes.", actions: [goto("Asignar cuentas")] });
      const suggested = leaves.filter((a) => a.status === "suggested" && Math.abs(a.balance) > 0.005);
      if (suggested.length) add({ severity: "info", scope, title: `${suggested.length} asignaci${suggested.length > 1 ? "ones sugeridas" : "ón sugerida"} sin confirmar`, detail: "Las líneas sugeridas por el plan de cuentas ya se usan en los estados, pero conviene revisarlas una vez.", fix: "Revisa la tabla de cuentas y confirma las sugeridas.", actions: [{ type: "confirm", entityId: ent.id, label: "Confirmar sugeridas" }, goto("Ver cuentas")] });

      const unknownIc = leaves.filter((a) => a.ic === "unknown" && a.balance);
      if (unknownIc.length) add({ severity: "warning", scope, title: "Cuentas intercompañía sin contraparte", detail: unknownIc.slice(0, 4).map(acct).join("; "), fix: "Indica con qué entidad del grupo es cada cuenta para poder conciliarla y eliminarla.", actions: [goto("Asignar contraparte")] });

      // Balances on the unexpected side.
      const prevRows = resolve(prevId, ent.id)?.rows || [];
      const unchanged = (a) => prevRows.some((x) => x.code === a.code && Math.abs(x.amount - a.amount) < 0.01);
      const odd = [];
      for (const a of leaves) {
        if (!a.line || a.line === "ignore" || Math.abs(a.amount) < materialLocal || a.amount >= 0) continue;
        const name = norm(a.name);
        if (a.line === "cash") odd.push(unchanged(a)
          ? { a, why: "Cuenta de efectivo con saldo crédito y sin movimiento", note: ` Mismo saldo que en ${periodLabel(prevId)}.`, fix: "Un banco congelado en negativo no suele ser un sobregiro: puede ser una cuenta antigua o duplicada tras un cambio de cuenta bancaria, o transferencias registradas de un solo lado. Concíliala con el extracto y corrígela en el ERP; reclasifícala a pasivo solo si el banco confirma el sobregiro.", to: "other_current_liabilities" }
          : { a, why: "Efectivo con saldo crédito (sobregiro)", fix: "Confirma con el extracto: si es un sobregiro, reclasifícalo a otros pasivos corrientes; si no, revisa transferencias o pagos registrados en la cuenta equivocada.", to: "other_current_liabilities" });
        else if (a.line === "receivables") odd.push({ a, why: "Cuenta por cobrar con saldo crédito (anticipos o pagos sin aplicar)", fix: "Aplica los pagos a sus facturas en el ERP o reclasifica el saldo a otros pasivos corrientes (anticipos de clientes).", to: "other_current_liabilities" });
        else if (a.line === "payables") odd.push({ a, why: "Cuenta por pagar con saldo débito (anticipo a proveedor o pago duplicado)", fix: "Revisa pagos duplicados; si es un anticipo, reclasifícalo a otros activos corrientes.", to: "other_current_assets" });
        else if (a.line === "revenue" && !CONTRA_REVENUE.test(name)) odd.push({ a, why: "Ingreso con saldo débito", fix: "Puede ser una reversión o una factura anulada contabilizada al revés; revisa el auxiliar de la cuenta." });
        else if (["opex", "cost_of_sales"].includes(a.line)) odd.push({ a, why: "Gasto/costo con saldo crédito", fix: "Suele ser una reversión de provisión o un reintegro; si es un ingreso, reclasifícalo a otros ingresos.", to: "other_income" });
        else if (isBsLine(a.line) && !["retained_earnings", "oci", "fixed_assets", "intangibles"].includes(a.line) && !CONTRA_BS.test(name)) odd.push({ a, why: `${lineLabel(a.line)} con saldo contrario a su naturaleza`, fix: "Verifica la asignación de la cuenta o el registro en el ERP." });
      }
      for (const o of odd.sort((x, y) => Math.abs(y.a.amount) - Math.abs(x.a.amount)).slice(0, 8)) {
        add({ severity: "warning", scope, title: `${acct(o.a)}: ${o.why}`, detail: `Saldo ${fmt(o.a.amount, 2)} ${ent.currency} en ${lineLabel(o.a.line)}.${o.note || ""}`, fix: o.fix, actions: [...(o.to ? [{ type: "map", entityId: ent.id, code: o.a.code, name: o.a.name, line: o.to, label: `Mover a ${lineLabel(o.to)}` }] : []), goto("Ver cuenta")] });
      }
      for (const a of leaves.filter((x) => SUSPENSE.test(norm(x.name)) && Math.abs(x.balance) >= materialLocal).slice(0, 5)) add({ severity: "warning", scope, title: `Cuenta transitoria con saldo: ${acct(a)}`, detail: `${fmt(a.balance, 2)} ${ent.currency}. Las cuentas puente/por clasificar deberían quedar en cero al cierre.`, fix: "Reclasifica las partidas a su cuenta definitiva en el ERP antes de consolidar.", actions: [goto("Ver cuenta")] });
      for (const pm of (imp.parentMismatches || []).slice(0, 3)) add({ severity: "warning", scope, title: `La cuenta ${pm.code} no coincide con sus subcuentas`, detail: `Saldo de la cuenta ${fmt(pm.balance, 2)} vs suma de subcuentas ${fmt(pm.children, 2)}.`, fix: "Puede faltar una subcuenta en el reporte (filtro de niveles o cuentas sin movimiento): exporta todas las subcuentas.", actions: [goto("Volver a importar")] });
      for (const a of leaves.filter((x) => x.ambiguous).slice(0, 3)) add({ severity: "info", scope, title: `Saldo de ${a.code} recalculado`, detail: "El saldo del reporte no coincide con saldo inicial + cargos − abonos; se usó el cálculo.", fix: "Revisa el auxiliar de la cuenta en el ERP.", actions: [] });

      // Current-year result posted in equity by the ERP vs the P&L.
      if (r.niControl != null) {
        const ni = sumPl({ revenue: r.pl.revenue, cost_of_sales: -r.pl.cost_of_sales, opex: -r.pl.opex, other_income: r.pl.other_income, income_tax: -r.pl.income_tax });
        if (Math.abs(r.niControl) > 1 && Math.abs(r.niControl - ni) > Math.max(1, Math.abs(ni) * 0.001)) add({ severity: "warning", scope, title: "El resultado del ejercicio del ERP no coincide con el estado de resultados", detail: `Cuenta de resultado del ejercicio: ${fmt(r.niControl, 2)}; estado de resultados del año: ${fmt(ni, 2)} ${ent.currency}.`, fix: imp.format === "statement" ? "El balance y el estado de resultados no salen del mismo corte: revisa que ambos sean al último día del mes y que los ajustes del estado de resultados también estén registrados en el balance. La diferencia queda en el CTA del consolidado hasta corregirla." : "Si la cuenta contiene el resultado de un año anterior, asígnala a Resultados acumulados; si no, revisa asientos de cierre parciales en el ERP.", actions: [goto("Ver cuentas")] });
      }

      // Opening balances vs previous month's closing (when the file brings opening balances).
      const prev = resolve(prevId, ent.id);
      if (prev && leaves.some((a) => a.opening) && imp.basis === "month") {
        const prevBy = Object.fromEntries(prev.rows.map((p) => [p.code, p.balance]));
        const diffs = leaves.filter((a) => isBsLine(a.line || "") || a.line == null).map((a) => ({ a, d: round2(a.opening - (prevBy[a.code] || 0)) })).filter((x) => Math.abs(x.d) > 1).sort((x, y) => Math.abs(y.d) - Math.abs(x.d));
        if (diffs.length) add({ severity: "warning", scope, title: "Saldos iniciales distintos al cierre del mes anterior", detail: diffs.slice(0, 3).map((x) => `${x.a.code}: ${fmt(x.d, 2)}`).join("; "), fix: `Hubo asientos en ${periodLabel(prevId)} después de importarlo: vuelve a importar la balanza de ${periodLabel(prevId)} (si sigue en borrador) o regístralo como ajuste.`, actions: [] });
      }

      // Negative P&L line totals (the engine treats costs and revenue as positive amounts).
      for (const l of PL_LINES) if (!l.signed && r.pl[l.key] < -0.5) add({ severity: "error", scope, title: `${l.label} suma negativo en la balanza`, detail: `${fmt(r.pl[l.key], 2)} ${ent.currency}: la herramienta lo tomaría como positivo.`, fix: "Revisa la asignación: probablemente hay cuentas de la naturaleza contraria asignadas a esta línea.", actions: [goto("Ver cuentas")] });
    }

    // Statement-level checks (imported or typed).
    const bal = model.entityBalance(periodId, ent.id);
    if (bal && Math.abs(bal.localTotals.difference) > 1) add({ severity: "error", scope, title: `El balance no cuadra en ${ent.currency}`, detail: `Activos − (pasivos + patrimonio + resultado del ejercicio) = ${fmt(bal.localTotals.difference, 2)}.`, fix: r ? "Revisa cuentas sin asignar, la cuenta de resultado del ejercicio (si el ERP ya registró el resultado en patrimonio, asígnala como 'control') y que el archivo traiga todas las cuentas." : "Revisa que el resultado del ejercicio no esté incluido también en Resultados acumulados y que los saldos estén en positivo.", actions: [goto()] });
    const month = model.entityMonth(periodId, ent.id);
    if (month && month.local.revenue < -0.5) add({ severity: "warning", scope, title: "Ingresos del mes negativos", detail: `Ingresos acumulados menores que el mes anterior: ${fmt(month.local.revenue, 2)} ${ent.currency} en el mes.`, fix: "Revisa notas crédito/reversiones o si el acumulado del mes anterior se cargó con otro corte.", actions: [goto()] });
    for (const k of ["cost_of_sales", "opex"]) if (month && month.local[k] > materialLocal) add({ severity: "warning", scope, title: `${k === "opex" ? "Gastos operacionales" : "Costo de ventas"} del mes con saldo a favor`, detail: `El acumulado del año bajó ${fmt(month.local[k], 2)} ${ent.currency} frente al mes anterior: el mes resta ${k === "opex" ? "gastos" : "costos"} en lugar de sumarlos.`, fix: "Suele ser una reversión de provisiones, una reclasificación a otra línea o un acumulado del mes anterior cargado con otro corte. Revisa el auxiliar y que la misma cuenta no esté asignada a líneas distintas entre meses.", actions: [goto("Ver cuentas")] });
    if (month?.warnings?.length) for (const w of month.warnings) add({ severity: "warning", scope, title: w, detail: "", fix: w.startsWith("Falta el acumulado") ? "Carga el mes anterior en la herramienta o escribe su acumulado en la columna 'Acumulado mes anterior'." : "Completa las tasas del mes.", actions: [goto()] });
    if (bal && bal.local.cash < -materialLocal) add({ severity: "error", scope, title: "Efectivo negativo", detail: `${fmt(bal.local.cash, 2)} ${ent.currency}.`, fix: "Un saldo de caja negativo no es posible: revisa sobregiros (reclasificar a pasivo) o movimientos bancarios mal registrados.", actions: [goto()] });
    const prevBal = model.entityBalance(prevId, ent.id);
    if (bal && prevBal && !periodId.endsWith("-01")) {
      const dRe = round2(bal.local.retained_earnings - prevBal.local.retained_earnings);
      if (Math.abs(dRe) > materialLocal) add({ severity: "warning", scope, title: "Resultados acumulados cambiaron durante el año", detail: `${fmt(dRe, 2)} ${ent.currency} vs ${periodLabel(prevId)}.`, fix: "Fuera del cierre anual solo cambian por dividendos o ajustes de años anteriores: documenta el movimiento o revisa la asignación de la cuenta de resultado del ejercicio.", actions: [goto()] });
      const dCap = round2(bal.local.capital - prevBal.local.capital);
      if (Math.abs(dCap) > materialLocal) add({ severity: "info", scope, title: "Movimiento de capital", detail: `${fmt(dCap, 2)} ${ent.currency} vs ${periodLabel(prevId)}.`, fix: "Si el aporte viene de otra entidad del grupo, marca la cuenta de capital como intercompañía para eliminarla contra la inversión.", actions: [goto()] });
    }
  }

  /* ---------- intercompany ---------- */
  const elim = suggestEliminations({ model, entities, resolve, periodId });
  const nameOf = (id) => entities.find((e) => e.id === id)?.name || id;
  for (const p of Object.values(elim.pairs)) {
    const [a, b] = p.entities;
    const label = `${nameOf(a)} ↔ ${nameOf(b)}`;
    const both = p.entities.every((id) => resolve(periodId, id));
    if (!both) {
      const missing = p.entities.find((id) => !resolve(periodId, id));
      add({ severity: "info", scope: "Intercompañía", title: `Falta la contraparte de ${label}`, detail: `${nameOf(missing)} no tiene balanza importada este mes; no se puede conciliar.`, fix: `Importa la balanza de ${nameOf(missing)} y marca sus cuentas con ${nameOf(p.entities.find((x) => x !== missing))} como intercompañía.`, actions: [{ type: "goto", tab: "entities", entityId: missing, label: "Importar contraparte" }] });
      continue;
    }
    const tol = Math.max(100, 0.005 * Math.max(Math.abs(p.bsAssets), Math.abs(p.bsCredit)));
    const dBs = round2(p.bsAssets - p.bsCredit);
    if (Math.abs(dBs) > tol) add({ severity: "error", scope: "Intercompañía", title: `Saldos intercompañía no concilian: ${label}`, detail: `Por cobrar/activos ${usd(p.bsAssets)} vs por pagar/pasivos ${usd(p.bsCredit)} → diferencia ${usd(dBs)}.`, fix: "Causas típicas: una entidad registró una factura o pago que la otra no (corte), tasas de cambio distintas, o una cuenta intercompañía clasificada como tercero. Concilia ambos auxiliares y registra el ajuste en la entidad que falta.", actions: [{ type: "goto", tab: "eliminations", label: "Ver eliminaciones" }] });
    const plTol = Math.max(100, 0.005 * Math.abs(elim.items.filter((i) => i.kind === "pl" && [a, b].includes(i.entity.id)).reduce((s, i) => s + Math.abs(i.amount), 0)));
    if (Math.abs(p.pl) > plTol) add({ severity: "warning", scope: "Intercompañía", title: `Ingresos y gastos intercompañía no netean: ${label}`, detail: `Efecto neto en la utilidad ${usd(p.pl)} en el mes.`, fix: "La factura intercompañía debe estar como ingreso en una entidad y como costo/gasto en la otra, en el mismo mes y por el mismo valor. Revisa el corte, la tasa usada y si la contrapartida quedó en una cuenta que no está marcada como intercompañía.", actions: [{ type: "goto", tab: "eliminations", label: "Ver eliminaciones" }] });
  }
  const current = model.entry(periodId, "eliminations")?.values || {};
  const gaps = (a = {}, b = {}, labelOf) => Object.keys({ ...a, ...b }).map((k) => ({ label: labelOf(k), applied: Number(a[k]) || 0, suggested: Number(b[k]) || 0 })).filter((g) => Math.abs(g.applied - g.suggested) > 0.5);
  const elimGaps = [...gaps(current.bs, elim.bs, lineLabel), ...gaps(current.pl, elim.pl, (k) => PL_LINES.find((l) => l.key === k)?.label || k)].sort((x, y) => Math.abs(y.applied - y.suggested) - Math.abs(x.applied - x.suggested));
  const hasApplied = Boolean(current.bs || current.pl);
  if ((elim.items.length || hasApplied) && elimGaps.length) {
    const top = elimGaps[0];
    add({ severity: !hasApplied || Math.abs(top.applied - top.suggested) >= 1000 ? "warning" : "info", scope: "Intercompañía", title: hasApplied ? "Las eliminaciones difieren de las sugeridas" : "Hay saldos intercompañía sin eliminar", detail: `${elim.items.length ? `${elim.items.length} partida${elim.items.length === 1 ? "" : "s"} intercompañía del mes en las balanzas.` : "Las balanzas no tienen movimientos intercompañía que eliminar este mes."}${hasApplied ? ` Mayor diferencia: ${top.label}, aplicado ${usd(top.applied)} vs sugerido ${usd(top.suggested)}.` : ""}`, fix: "Aplica las eliminaciones sugeridas (reversan cada saldo y movimiento intercompañía del mes) y revisa las diferencias de conciliación; si mantienes un ajuste manual, documéntalo.", actions: [{ type: "apply-eliminations", label: "Aplicar sugeridas" }, { type: "goto", tab: "eliminations", label: "Ver detalle" }] });
  }
  const holding = model.included.find((e) => e.is_holding);
  if (holding) {
    const rh = resolve(periodId, holding.id);
    for (const sub of model.included.filter((e) => !e.is_holding)) {
      const rs = resolve(periodId, sub.id);
      if (!rh || !rs) continue;
      const investment = rh.rows.some((x) => x.ic === sub.id && ["other_noncurrent_assets", "other_current_assets"].includes(x.line) && x.balance);
      const capitalIc = rs.rows.some((x) => x.ic === holding.id && x.line === "capital");
      if (investment && !capitalIc) add({ severity: "warning", scope: "Intercompañía", title: `Inversión en ${sub.name} sin eliminar contra su capital`, detail: `${holding.name} registra una inversión en ${sub.name}, pero el capital de ${sub.name} no está marcado como intercompañía.`, fix: `En las cuentas de ${sub.name}, marca el capital social como intercompañía con ${holding.name} de contraparte. La diferencia entre inversión y capital convertido se explica normalmente por tipo de cambio (CTA).`, actions: [{ type: "goto", tab: "entities", entityId: sub.id, label: "Marcar capital" }] });
    }
  }
  for (const n of elim.notes) add({ severity: "warning", scope: "Intercompañía", title: `${n}: sin eliminaciones de resultados sugeridas`, detail: `Falta la balanza de ${periodLabel(prevId)}: el saldo de sus cuentas intercompañía de resultados es el acumulado del año e incluye meses anteriores, así que no se sugiere eliminarlo en ${periodLabel(periodId)}.`, fix: `Importa la balanza de ${periodLabel(prevId)} para calcular el movimiento del mes, o ingresa a mano en Eliminaciones solo lo facturado entre entidades en ${periodLabel(periodId)}.`, actions: [{ type: "goto", tab: "eliminations", label: "Ver eliminaciones" }] });

  /* ---------- group: variances and consolidated checks ---------- */
  const cur = model.consolidatedMonth(periodId);
  const prv = model.consolidatedMonth(prevId);
  if (cur && prv) {
    const materiality = Math.max(1000, 0.01 * Math.abs(cur.lines.revenue || 0));
    for (const l of PL_LINES) {
      const a = cur.lines[l.key] || 0, b = prv.lines[l.key] || 0, d = a - b, p = pct(a, b);
      if (Math.abs(d) < materiality || (p != null && Math.abs(p) < 20)) continue;
      const drivers = cur.source === "computed" && prv.source === "computed"
        ? model.included.map((e) => ({ e, d: (model.entityMonth(periodId, e.id)?.lines[l.key] || 0) - (model.entityMonth(prevId, e.id)?.lines[l.key] || 0) })).filter((x) => Math.abs(x.d) >= 1).sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
        : [];
      const favorable = d > 0; // lines are profit-signed (costs negative): an increase always helps profit
      const shown = (v) => (l.signed ? v : Math.abs(v));
      const move = shown(a) - shown(b);
      const movePct = l.signed && (b < 0) !== (a < 0) ? null : pct(shown(a), shown(b));
      const signedUsd = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${usd(Math.abs(v))}`;
      const driverMove = (x) => (l.signed || l.sign > 0 ? x.d : -x.d);
      add({ severity: "info", scope: "Variaciones", title: `${l.label}: ${favorable ? "favorable" : "desfavorable"} ${usd(Math.abs(d))} vs ${periodLabel(prevId)}`, detail: `${usd(shown(b))} → ${usd(shown(a))} (${signedUsd(move)}${movePct != null && Math.abs(movePct) < 1000 ? `, ${movePct > 0 ? "+" : ""}${movePct.toFixed(0)}%` : ""}).${drivers.length ? ` Por entidad: ${drivers.slice(0, 3).map((x) => `${x.e.name.split(" ")[0]} ${signedUsd(driverMove(x))}`).join(", ")}.` : ""}`, fix: "Documenta la causa (nuevo cliente, contratación, gasto puntual, cambio de tasa o error de corte) antes de cerrar.", actions: [] });
    }
    const gm = (x) => (x.lines.revenue ? sumPl(x.lines, PL_SUBTOTALS.gross_profit.keys) / x.lines.revenue : null);
    const g1 = gm(cur), g0 = gm(prv);
    if (g1 != null && g0 != null && Math.abs(g1 - g0) > 0.1) add({ severity: "warning", scope: "Variaciones", title: `Margen bruto cambió ${((g1 - g0) * 100).toFixed(1)} pp`, detail: `${(g0 * 100).toFixed(1)}% → ${(g1 * 100).toFixed(1)}%.`, fix: "Revisa costos intercompañía sin eliminar, costos registrados en otro mes o reclasificaciones entre costo y gasto.", actions: [] });
  }
  const bs = model.consolidatedBalance(periodId);
  if (bs && bs.total.cash < 0) add({ severity: "error", scope: "Grupo", title: "Efectivo consolidado negativo", detail: usd(bs.total.cash), fix: "Revisa sobregiros y eliminaciones sobre la línea de efectivo (el efectivo no debería eliminarse).", actions: [] });
  if (bs && Math.abs(bs.totals.difference) > 1) add({ severity: "error", scope: "Grupo", title: "El balance consolidado no cuadra", detail: `Diferencia ${usd(bs.totals.difference)}.`, fix: "Normalmente viene de una entidad que no cuadra en moneda local o de eliminaciones de balance que no cuadran entre activos y pasivos.", actions: [{ type: "goto", tab: "bs", label: "Ver balance" }] });
  const elimBs = bsTotals(current.bs || {});
  if (Math.abs(elimBs.difference) > 0.5) add({ severity: "error", scope: "Intercompañía", title: "Las eliminaciones de balance no cuadran", detail: `Activos ${usd(elimBs.assets)} vs pasivos + patrimonio ${usd(elimBs.liabilities_equity)}.`, fix: "Cada eliminación afecta ambos lados por el mismo valor; si la diferencia viene de una conciliación pendiente, resuélvela en las entidades.", actions: [{ type: "goto", tab: "eliminations", label: "Ver eliminaciones" }] });

  const order = { error: 0, warning: 1, info: 2 };
  const seen = new Set();
  const unique = alerts.filter((a) => (seen.has(a.id) ? false : seen.add(a.id)));
  unique.sort((x, y) => order[x.severity] - order[y.severity]);
  return { alerts: unique, resolve, eliminations: elim };
}
