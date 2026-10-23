import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";
import { useMember, isSuperAdmin } from "./access";
import {
  BS_SECTIONS, BS_LINES, BS_INPUT_LINES, PL_LINES, PL_SUBTOTALS, buildModel, bsTotals, sumPl, signedPl, nextPeriodId, prevPeriodId, parseAmount,
} from "./consolidationEngine";

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MONTH_NAMES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const periodLabel = (id) => (id ? `${MONTH_NAMES[+id.slice(5) - 1]} ${id.slice(0, 4)}` : "");
const fmt = (n, decimals = 0) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const money = (n) => { const v = Number(n) || 0; const s = fmt(Math.abs(v)); return v < 0 ? `(${s})` : s; };

function downloadCsv(filename, rows) {
  const csv = rows.map((r) => r.map((c) => { const s = c == null ? "" : String(c); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** Amount field: accepts 1.234.567,89 or 1,234,567.89 (paste from the PDFs/Excel), shows thousands separators. */
function AmountInput({ value, onCommit, disabled, placeholder }) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState("");
  const shown = focused ? text : value == null || value === "" ? "" : fmt(Number(value), 2);
  return (
    <input className="cons-amount" inputMode="decimal" value={shown} placeholder={placeholder || "0"} disabled={disabled}
      onFocus={() => { setFocused(true); setText(value == null || value === "" ? "" : String(value)); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false);
        if (text.trim() === "") { if (value != null && value !== "") onCommit(null); return; }
        const n = parseAmount(text);
        if (Number.isFinite(n) && n !== Number(value)) onCommit(n);
      }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
  );
}

function useConsolidationData() {
  const [state, setState] = useState({ entities: [], periods: [], entries: [], docs: [], loading: true, error: null });
  const reload = async () => {
    const [e, p, x, d] = await Promise.all([
      supabase.from("consolidation_entities").select("*").order("sort_order"),
      supabase.from("consolidation_periods").select("*").order("id"),
      supabase.from("consolidation_entries").select("*"),
      supabase.from("board_entity_documents").select("*").eq("entity", "group").order("name"),
    ]);
    const err = e.error || p.error || x.error || d.error;
    setState({ entities: e.data || [], periods: p.data || [], entries: x.data || [], docs: d.data || [], loading: false, error: err?.message || null });
  };
  useEffect(() => { reload(); }, []);
  return { ...state, reload, setState };
}

/* ---------------- tabs ---------------- */

function SummaryTab({ model, periodId, onGo }) {
  const pl = model.consolidatedMonth(periodId);
  const bs = model.consolidatedBalance(periodId);
  const prev = model.consolidatedMonth(prevPeriodId(periodId));
  const draft = model.periodById[periodId]?.status === "draft";
  const items = draft ? model.checklist(periodId) : [];
  const delta = (a, b) => (b ? ((a - b) / Math.abs(b)) * 100 : null);
  const tiles = [
    ["Ingresos del mes", pl?.lines.revenue, prev?.lines.revenue],
    ["Utilidad bruta", pl ? sumPl(pl.lines, PL_SUBTOTALS.gross_profit.keys) : null, prev ? sumPl(prev.lines, PL_SUBTOTALS.gross_profit.keys) : null],
    ["Utilidad neta del mes", pl?.net, prev?.net],
    ["Efectivo consolidado", bs?.total.cash, null],
  ];
  return (
    <div>
      <div className="cons-tiles">
        {tiles.map(([label, v, p]) => {
          const d = v != null && p != null ? delta(v, p) : null;
          return (
            <div key={label} className="cons-tile">
              <span>{label}</span>
              <b>{v == null ? "—" : `$${money(v)}`}</b>
              {d != null && <small className={d >= 0 ? "is-up" : "is-down"}>{d >= 0 ? "▲" : "▼"} {Math.abs(d).toFixed(1)}% vs {periodLabel(prevPeriodId(periodId))}</small>}
            </div>
          );
        })}
      </div>
      {draft ? (
        <section className="cons-card">
          <h3>Lista de cierre de {periodLabel(periodId)}</h3>
          <ul className="cons-checklist">
            {items.map((i) => <li key={i.label} className={i.ok ? "is-ok" : "is-pending"}><span aria-hidden="true">{i.ok ? "✓" : "○"}</span>{i.label}</li>)}
          </ul>
          <p className="admin-note">Pasos: 1) tasas del mes, 2) estados de cada entidad en moneda local, 3) eliminaciones intercompañía, 4) revisar balance y resultados, 5) cerrar el mes.</p>
          <div className="cons-steps">
            <button className="people-secondary-button" onClick={() => onGo("fx")}>1. Tasas</button>
            <button className="people-secondary-button" onClick={() => onGo("entities")}>2. Entidades</button>
            <button className="people-secondary-button" onClick={() => onGo("eliminations")}>3. Eliminaciones</button>
            <button className="people-secondary-button" onClick={() => onGo("bs")}>4. Balance</button>
            <button className="people-secondary-button" onClick={() => onGo("pl")}>Resultados</button>
          </div>
        </section>
      ) : (
        <section className="cons-card">
          <h3>{periodLabel(periodId)} · cerrado</h3>
          <p className="admin-note">{pl?.source === "history" ? "Cifras importadas de la consolidación en Excel (ya en USD)." : "Mes consolidado en la herramienta."} Las cifras no se pueden editar mientras el mes esté cerrado.</p>
        </section>
      )}
      {[...(pl?.source === "computed" ? Object.values(model.included).map((e) => model.entityMonth(periodId, e.id)?.warnings.map((w) => `${e.name}: ${w}`) || []).flat() : []), ...(bs?.warnings || [])].map((w) => (
        <div key={w} className="cons-warning" role="alert">⚠ {w}</div>
      ))}
    </div>
  );
}

function FxTab({ period, currencies, editable, onSave }) {
  const fx = period.fx || {};
  const set = (c, type, v) => onSave({ ...fx, [c]: { ...(fx[c] || {}), [type]: v } });
  return (
    <section className="cons-card">
      <h3>Tasas de {periodLabel(period.id)}</h3>
      <p className="admin-note">Moneda local por 1 USD. Promedio del mes para el estado de resultados; cierre del último día del mes para el balance.</p>
      <table className="admin-table cons-table">
        <thead><tr><th>Moneda</th><th className="num">Promedio del mes</th><th className="num">Cierre del mes</th></tr></thead>
        <tbody>
          {currencies.map((c) => (
            <tr key={c}>
              <td><b>{c}</b> / USD</td>
              <td className="num"><AmountInput value={fx[c]?.avg} disabled={!editable} onCommit={(v) => set(c, "avg", v)} /></td>
              <td className="num"><AmountInput value={fx[c]?.close} disabled={!editable} onCommit={(v) => set(c, "close", v)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function EntityTab({ model, periodId, entity, editable, onSave }) {
  const e = model.entry(periodId, entity.id);
  const values = e?.values || {};
  const prevYtdAuto = periodId.endsWith("-01") ? null : model.entry(prevPeriodId(periodId), entity.id)?.values?.pl_ytd;
  const month = model.entityMonth(periodId, entity.id);
  const bal = model.entityBalance(periodId, entity.id);
  const save = (patch, status) => onSave(entity.id, { ...values, ...patch }, status ?? e?.status ?? "pending");
  const setBs = (k, v) => save({ bs: { ...(values.bs || {}), [k]: v } });
  const setPl = (group, k, v) => save({ [group]: { ...(values[group] || {}), [k]: v } });
  const c = entity.currency;

  return (
    <div>
      <div className="cons-entity-head">
        <div>
          <h3>{entity.name}</h3>
          <span className="people-muted">{entity.country} · cifras en {c}{c !== "USD" ? " (se convierten a USD con las tasas del mes)" : ""}</span>
        </div>
        <div className="cons-entity-status">
          <span className={`people-chip is-${e?.status === "loaded" ? "good" : "wait"}`}>{e?.status === "loaded" ? "Cargada" : "Pendiente"}</span>
          {editable && (e?.status === "loaded"
            ? <button className="admin-link-button" onClick={() => save({}, "pending")}>Marcar pendiente</button>
            : <button className="admin-primary-button" onClick={() => save({}, "loaded")}>Marcar como cargada</button>)}
        </div>
      </div>

      <div className="cons-entity-grid">
        <section className="cons-card">
          <h3>Balance general al cierre del mes <span className="people-muted">({c})</span></h3>
          <table className="cons-form">
            <tbody>
              {BS_SECTIONS.map((s) => (
                <React.Fragment key={s.key}>
                  <tr className="cons-form-section"><td colSpan={3}>{s.label}</td></tr>
                  {BS_INPUT_LINES.filter((l) => l.section === s.key).map((l) => (
                    <tr key={l.key}>
                      <td>{l.label}</td>
                      <td className="num"><AmountInput value={values.bs?.[l.key]} disabled={!editable} onCommit={(v) => setBs(l.key, v)} /></td>
                      <td className="num people-muted">{bal ? money(bal.usd[l.key]) : ""}</td>
                    </tr>
                  ))}
                  {s.key === "equity" && (
                    <>
                      <tr className="is-derived"><td>Resultado del ejercicio <small>(del estado de resultados)</small></td><td className="num">{bal ? fmt(bal.local.net_income, 2) : "—"}</td><td className="num people-muted">{bal ? money(bal.usd.net_income) : ""}</td></tr>
                      <tr className="is-derived"><td>Ajuste por conversión (CTA)</td><td className="num">—</td><td className="num people-muted">{bal ? money(bal.usd.cta) : ""}</td></tr>
                    </>
                  )}
                </React.Fragment>
              ))}
            </tbody>
            {bal && (
              <tfoot>
                <tr><td>Total activos</td><td className="num">{fmt(bal.localTotals.assets, 2)}</td><td className="num">{money(bal.usdTotals.assets)}</td></tr>
                <tr><td>Total pasivos + patrimonio</td><td className="num">{fmt(bal.localTotals.liabilities_equity, 2)}</td><td className="num">{money(bal.usdTotals.liabilities_equity)}</td></tr>
                <tr className={Math.abs(bal.localTotals.difference) > 1 ? "is-bad" : "is-good"}>
                  <td>Diferencia</td><td className="num">{fmt(bal.localTotals.difference, 2)}</td><td className="num">{Math.abs(bal.localTotals.difference) > 1 ? "No cuadra" : "Cuadra ✓"}</td>
                </tr>
              </tfoot>
            )}
          </table>
          <p className="admin-note">Columna gris: USD a tasa de cierre. Ingresa los saldos como aparecen en el balance (en positivo).</p>
        </section>

        <section className="cons-card">
          <h3>Estado de resultados acumulado <span className="people-muted">({c})</span></h3>
          <table className="cons-form">
            <thead><tr><th /><th className="num">Acumulado a {MONTHS[+periodId.slice(5) - 1]}</th><th className="num">Acumulado mes anterior</th><th className="num">Mes</th><th className="num">Mes USD</th></tr></thead>
            <tbody>
              {PL_LINES.map((l) => (
                <tr key={l.key}>
                  <td>{l.label}{l.signed && <small> (+ ingreso / − gasto)</small>}</td>
                  <td className="num"><AmountInput value={values.pl_ytd?.[l.key]} disabled={!editable} onCommit={(v) => setPl("pl_ytd", l.key, v)} /></td>
                  <td className="num">
                    {periodId.endsWith("-01") ? <span className="people-muted">— (enero)</span>
                      : prevYtdAuto ? <span className="people-muted" title="Tomado del mes anterior cargado en la herramienta">{fmt(Number(prevYtdAuto[l.key] || 0), 2)}</span>
                        : <AmountInput value={values.pl_prev_ytd?.[l.key]} disabled={!editable} placeholder="del EEFF anterior" onCommit={(v) => setPl("pl_prev_ytd", l.key, v)} />}
                  </td>
                  <td className="num">{month ? money(month.local[l.key]) : ""}</td>
                  <td className="num people-muted">{month ? money(month.lines[l.key]) : ""}</td>
                </tr>
              ))}
            </tbody>
            {month && (
              <tfoot><tr><td>Utilidad (pérdida) neta</td><td className="num">{fmt(sumPl(signedPl(values.pl_ytd || {})), 2)}</td><td /><td className="num">{money(sumPl(month.local))}</td><td className="num">{money(month.net)}</td></tr></tfoot>
            )}
          </table>
          <p className="admin-note">
            Copia el estado de resultados acumulado del año tal como lo entrega el contador (costos y gastos en positivo). El mes se calcula restando el acumulado del mes anterior
            {prevYtdAuto ? ", que se toma del mes anterior cargado aquí." : "; si el mes anterior no está cargado en la herramienta, escríbelo en la columna del medio (del estado financiero del mes anterior)."}
          </p>
          {month?.warnings.map((w) => <div key={w} className="cons-warning">⚠ {w}</div>)}
        </section>
      </div>
      {bal?.warnings.map((w) => <div key={w} className="cons-warning">⚠ {w}</div>)}
    </div>
  );
}

function EliminationsTab({ model, periodId, editable, onSave }) {
  const e = model.entry(periodId, "eliminations");
  const values = e?.values || {};
  const prev = model.entry(prevPeriodId(periodId), "eliminations");
  const bsT = bsTotals(values.bs || {});
  const plNet = sumPl(values.pl || {});
  const save = (patch) => onSave("eliminations", { ...values, ...patch }, "loaded");
  return (
    <div className="cons-entity-grid">
      <section className="cons-card">
        <h3>Eliminaciones de balance <span className="people-muted">(USD)</span></h3>
        <p className="admin-note">Ajustes con signo sobre el consolidado. Ej.: cuenta por cobrar de Celes a Biai por 50.000 → Cuentas por cobrar −50.000 y Cuentas por pagar −50.000.</p>
        <table className="cons-form">
          <tbody>
            {BS_INPUT_LINES.map((l) => (
              <tr key={l.key}><td>{l.label}</td><td className="num"><AmountInput value={values.bs?.[l.key]} disabled={!editable} onCommit={(v) => save({ bs: { ...(values.bs || {}), [l.key]: v } })} /></td></tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td>Activos</td><td className="num">{money(bsT.assets)}</td></tr>
            <tr><td>Pasivos + patrimonio</td><td className="num">{money(bsT.liabilities_equity)}</td></tr>
            <tr className={Math.abs(bsT.difference) > 0.5 ? "is-bad" : "is-good"}><td>Diferencia</td><td className="num">{Math.abs(bsT.difference) > 0.5 ? money(bsT.difference) : "Cuadra ✓"}</td></tr>
          </tfoot>
        </table>
      </section>
      <section className="cons-card">
        <h3>Eliminaciones de resultados del mes <span className="people-muted">(USD)</span></h3>
        <p className="admin-note">Ingresos y gastos entre compañías del grupo. Ej.: Celes factura 10.000 a Xeles → Ingresos −10.000 y Gastos operacionales +10.000 (debe netear en cero).</p>
        <table className="cons-form">
          <tbody>
            {PL_LINES.map((l) => (
              <tr key={l.key}><td>{l.label}</td><td className="num"><AmountInput value={values.pl?.[l.key]} disabled={!editable} onCommit={(v) => save({ pl: { ...(values.pl || {}), [l.key]: v } })} /></td></tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={Math.abs(plNet) > 0.5 ? "is-bad" : "is-good"}><td>Efecto neto en la utilidad</td><td className="num">{Math.abs(plNet) > 0.5 ? money(plNet) : "0 ✓"}</td></tr>
          </tfoot>
        </table>
        {editable && prev?.values && (
          <button className="people-secondary-button" onClick={() => save({ bs: { ...(prev.values.bs || {}) }, pl: { ...(prev.values.pl || {}) } })}>Copiar eliminaciones de {periodLabel(prevPeriodId(periodId))}</button>
        )}
      </section>
    </div>
  );
}

function BalanceTab({ model, periodId, entities }) {
  const [compare, setCompare] = useState("prev-dec");
  const bs = model.consolidatedBalance(periodId);
  const compareId = compare === "prev-dec" ? `${+periodId.slice(0, 4) - 1}-12` : prevPeriodId(periodId);
  const cmp = model.consolidatedBalance(compareId);
  if (!bs) return <div className="board-empty-state">Aún no hay balances cargados para {periodLabel(periodId)}.</div>;
  const cols = [...entities.filter((e) => bs.columns[e.id]).map((e) => ({ id: e.id, label: e.name.split(" ")[0], sub: e.currency === "USD" ? "USD" : `${e.currency} → USD` })), ...(bs.columns.eliminations ? [{ id: "eliminations", label: "Eliminaciones", sub: "Intercompañía" }] : [])];
  const rows = [];
  for (const s of BS_SECTIONS) {
    rows.push({ type: "section", label: s.label });
    for (const l of BS_LINES.filter((x) => x.section === s.key)) rows.push({ type: "line", key: l.key, label: l.label });
    rows.push({ type: "total", key: s.key, label: s.total });
    if (s.key === "noncurrent_assets") rows.push({ type: "grand", key: "assets", label: "TOTAL ACTIVOS" });
    if (s.key === "noncurrent_liabilities") rows.push({ type: "grand", key: "liabilities", label: "TOTAL PASIVOS" });
  }
  rows.push({ type: "grand", key: "liabilities_equity", label: "TOTAL PASIVOS + PATRIMONIO" });
  const cell = (obj, r) => (r.type === "line" ? obj?.[r.key] : r.type === "total" || r.type === "grand" ? (obj ? bsTotals(obj)[r.key] : null) : null);
  const exportCsv = () => downloadCsv(`balance-consolidado-${periodId}.csv`, [
    ["Celes Group — Balance consolidado (USD)", periodLabel(periodId)], [],
    ["", ...cols.map((c) => c.label), `Consolidado ${periodLabel(periodId)}`, cmp ? `Consolidado ${periodLabel(compareId)}` : ""],
    ...rows.filter((r) => r.type !== "section").map((r) => [r.label, ...cols.map((c) => cell(bs.columns[c.id], r)?.toFixed(2) ?? ""), cell(bs.total, r)?.toFixed(2) ?? "", cmp ? cell(cmp.total, r)?.toFixed(2) ?? "" : ""]),
  ]);
  return (
    <section className="cons-card">
      <div className="cons-card-head">
        <h3>Balance consolidado al cierre de {periodLabel(periodId)} <span className="people-muted">(USD)</span></h3>
        <div className="cons-card-actions">
          <label className="people-muted">Comparar con&nbsp;
            <select value={compare} onChange={(e) => setCompare(e.target.value)}>
              <option value="prev-dec">Diciembre {+periodId.slice(0, 4) - 1}</option>
              <option value="prev-month">{periodLabel(prevPeriodId(periodId))}</option>
            </select>
          </label>
          <button className="people-secondary-button" onClick={exportCsv}>Descargar CSV</button>
        </div>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table cons-table cons-statement">
          <thead>
            <tr><th />{cols.map((c) => <th key={c.id} className="num">{c.label}<small>{c.sub}</small></th>)}<th className="num is-total">Consolidado<small>{periodLabel(periodId)}</small></th><th className="num">Consolidado<small>{periodLabel(compareId)}</small></th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (r.type === "section"
              ? <tr key={i} className="cons-row-section"><td colSpan={cols.length + 3}>{r.label}</td></tr>
              : (
                <tr key={i} className={`cons-row-${r.type}`}>
                  <td>{r.label}</td>
                  {cols.map((c) => <td key={c.id} className="num">{money(cell(bs.columns[c.id], r))}</td>)}
                  <td className="num is-total">{money(cell(bs.total, r))}</td>
                  <td className="num">{cmp ? money(cell(cmp.total, r)) : "—"}</td>
                </tr>
              )))}
          </tbody>
        </table>
      </div>
      <p className="admin-note">
        {bs.source === "history" ? "Mes importado de la consolidación en Excel." : "Activos y pasivos a tasa de cierre; resultado del ejercicio = suma de los resultados mensuales en USD; la diferencia por conversión se muestra en el CTA."}
        {" "}Los valores entre paréntesis son negativos.
      </p>
      {bs.warnings.map((w) => <div key={w} className="cons-warning">⚠ {w}</div>)}
    </section>
  );
}

function ResultsTab({ model, periods, entities, periodId }) {
  const years = [...new Set(periods.map((p) => p.id.slice(0, 4)))].sort().reverse();
  const [year, setYear] = useState(periodId.slice(0, 4));
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const data = months.map((m) => (model.periodById[m] ? model.consolidatedMonth(m) : null));
  const rows = [];
  for (const l of PL_LINES) {
    rows.push({ key: l.key, label: l.label, value: (d) => d?.lines[l.key] });
    const sub = Object.values(PL_SUBTOTALS).find((s) => s.after === l.key);
    if (sub) rows.push({ key: sub.label, label: sub.label, subtotal: true, value: (d) => (d ? sumPl(d.lines, sub.keys) : null) });
  }
  const included = entities.filter((e) => e.included);
  const ytd = (fn) => data.reduce((s, d) => s + (fn(d) || 0), 0);
  const exportCsv = () => downloadCsv(`resultados-consolidados-${year}.csv`, [
    ["Celes Group — Estado de resultados consolidado (USD)", year], [],
    ["", ...MONTHS, `Acumulado ${year}`],
    ...rows.map((r) => [r.label, ...data.map((d) => (r.value(d) == null ? "" : r.value(d).toFixed(2))), ytd(r.value).toFixed(2)]),
    [], ["Utilidad neta por entidad"],
    ...included.map((e) => [e.name, ...data.map((d) => (d?.byEntity?.[e.id] == null ? "" : Number(d.byEntity[e.id]).toFixed(2))), ytd((d) => d?.byEntity?.[e.id]).toFixed(2)]),
  ]);
  return (
    <section className="cons-card">
      <div className="cons-card-head">
        <h3>Estado de resultados consolidado <span className="people-muted">(USD, mensual)</span></h3>
        <div className="cons-card-actions">
          <select value={year} onChange={(e) => setYear(e.target.value)}>{years.map((y) => <option key={y}>{y}</option>)}</select>
          <button className="people-secondary-button" onClick={exportCsv}>Descargar CSV</button>
        </div>
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table cons-table cons-statement cons-monthly">
          <thead><tr><th />{MONTHS.map((m, i) => <th key={m} className={`num${data[i]?.source === "history" ? " is-history" : ""}`}>{m}</th>)}<th className="num is-total">Acum. {year}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.subtotal ? "cons-row-total" : "cons-row-line"}>
                <td>{r.label}</td>
                {data.map((d, i) => <td key={i} className="num">{d ? money(r.value(d)) : ""}</td>)}
                <td className="num is-total">{money(ytd(r.value))}</td>
              </tr>
            ))}
            <tr className="cons-row-section"><td colSpan={14}>Utilidad neta por entidad</td></tr>
            {included.map((e) => (
              <tr key={e.id} className="cons-row-line">
                <td>{e.name}</td>
                {data.map((d, i) => <td key={i} className="num">{d?.byEntity?.[e.id] == null ? "" : money(d.byEntity[e.id])}</td>)}
                <td className="num is-total">{money(ytd((d) => d?.byEntity?.[e.id]))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="admin-note">Meses en gris: importados de la consolidación en Excel. La utilidad por entidad no incluye eliminaciones.</p>
    </section>
  );
}

/* ---------------- main ---------------- */

const TABS = [
  { id: "summary", label: "Resumen" }, { id: "fx", label: "Tasas" }, { id: "entities", label: "Entidades" },
  { id: "eliminations", label: "Eliminaciones" }, { id: "bs", label: "Balance" }, { id: "pl", label: "Resultados" },
];

export default function FinancialsTool({ editable }) {
  const member = useMember();
  const { entities, periods, entries, docs, loading, error, reload, setState } = useConsolidationData();
  const [periodId, setPeriodId] = useState(null);
  const [tab, setTab] = useState("summary");
  const [entityId, setEntityId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const model = useMemo(() => buildModel({ periods, entries, entities }), [periods, entries, entities]);

  useEffect(() => {
    if (!periodId && periods.length) setPeriodId((periods.find((p) => p.status === "draft") || periods[periods.length - 1]).id);
    if (!entityId && entities.length) setEntityId(entities.find((e) => e.included)?.id);
  }, [periods, entities]);

  const period = periods.find((p) => p.id === periodId);
  const canEdit = editable && period?.status === "draft";
  const included = entities.filter((e) => e.included);
  const currencies = [...new Set(included.map((e) => e.currency).filter((c) => c !== "USD"))];

  const saveEntry = async (eid, values, status) => {
    setMessage(null);
    const { data, error: err } = await supabase.from("consolidation_entries")
      .upsert({ period_id: periodId, entity_id: eid, kind: "input", values, status }, { onConflict: "period_id,entity_id,kind" }).select().single();
    if (err) { setMessage({ type: "error", text: err.message }); reload(); return; }
    setState((s) => ({ ...s, entries: [...s.entries.filter((x) => !(x.period_id === periodId && x.entity_id === eid && x.kind === "input")), data] }));
  };

  const saveFx = async (fx) => {
    const { data, error: err } = await supabase.from("consolidation_periods").update({ fx }).eq("id", periodId).select().single();
    if (err) { setMessage({ type: "error", text: err.message }); return; }
    setState((s) => ({ ...s, periods: s.periods.map((p) => (p.id === periodId ? data : p)) }));
  };

  const newMonth = async () => {
    const last = periods[periods.length - 1];
    const id = last ? nextPeriodId(last.id) : new Date().toISOString().slice(0, 7);
    if (!window.confirm(`¿Crear el mes de ${periodLabel(id)} para consolidar?`)) return;
    setBusy(true);
    const { error: err } = await supabase.from("consolidation_periods").insert({ id, status: "draft", fx: {} });
    if (err) setMessage({ type: "error", text: err.message });
    else { await reload(); setPeriodId(id); setTab("summary"); }
    setBusy(false);
  };

  const closeMonth = async () => {
    const pending = model.checklist(periodId).filter((i) => !i.ok);
    const warning = pending.length ? `\n\nHay ${pending.length} pendientes:\n• ${pending.map((i) => i.label).join("\n• ")}\n` : "";
    if (!window.confirm(`¿Cerrar ${periodLabel(periodId)}?${warning}\nUna vez cerrado no se puede editar (solo un Super Admin puede reabrirlo).`)) return;
    const { error: err } = await supabase.from("consolidation_periods").update({ status: "closed" }).eq("id", periodId);
    if (err) setMessage({ type: "error", text: err.message }); else { await reload(); setMessage({ type: "ok", text: `${periodLabel(periodId)} quedó cerrado.` }); }
  };

  const reopen = async () => {
    if (!window.confirm(`¿Reabrir ${periodLabel(periodId)}?`)) return;
    const { error: err } = await supabase.from("consolidation_periods").update({ status: "draft" }).eq("id", periodId);
    if (err) setMessage({ type: "error", text: err.message }); else reload();
  };

  const openDoc = async (doc) => {
    const tabRef = window.open("about:blank", "_blank");
    const { data } = await supabase.storage.from("board-entity-docs").createSignedUrl(doc.path, 300, doc.content_type === "application/pdf" ? undefined : { download: doc.name });
    if (data?.signedUrl && tabRef) { tabRef.opener = null; tabRef.location.href = data.signedUrl; } else tabRef?.close();
  };

  if (loading) return <div className="board-empty-state">Cargando…</div>;
  const isHistory = Boolean(model.history(periodId));

  return (
    <div className="board-docs cons">
      <div className="board-docs-heading">
        <div>
          <div className="board-eyebrow">BOARD · CONSOLIDATED DATA</div>
          <h1>Financials</h1>
          <p>Consolidación mensual de las entidades locales en USD: tasas, estados por entidad, eliminaciones y estados consolidados.</p>
        </div>
        <div className="cons-period">
          <select value={periodId || ""} onChange={(e) => setPeriodId(e.target.value)} aria-label="Mes">
            {[...periods].reverse().map((p) => <option key={p.id} value={p.id}>{periodLabel(p.id)}{p.status === "draft" ? " · borrador" : ""}</option>)}
          </select>
          {period && <span className={`people-status is-${period.status}`}>{period.status === "draft" ? "Borrador" : "Cerrado"}</span>}
          {editable && <button className="people-secondary-button" disabled={busy} onClick={newMonth}>+ Nuevo mes</button>}
          {canEdit && <button className="admin-primary-button" onClick={closeMonth}>Cerrar mes</button>}
          {period?.status === "closed" && !isHistory && isSuperAdmin(member) && <button className="admin-link-button" onClick={reopen}>Reabrir</button>}
        </div>
      </div>

      {error && <div className="board-doc-error" role="alert">{error}</div>}
      {message && <div className={message.type === "error" ? "board-doc-error" : "admin-notice"} role="status">{message.text}</div>}

      {period && (
        <>
          <nav className="cons-tabs" aria-label="Pasos de la consolidación">
            {TABS.filter((t) => !isHistory || ["summary", "bs", "pl"].includes(t.id)).map((t) => (
              <button key={t.id} className={tab === t.id ? "is-active" : ""} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </nav>

          {tab === "summary" && <SummaryTab model={model} periodId={periodId} onGo={setTab} />}
          {tab === "fx" && !isHistory && <FxTab period={period} currencies={currencies} editable={canEdit} onSave={saveFx} />}
          {tab === "entities" && !isHistory && (
            <>
              <div className="cons-entity-picker">
                {included.map((e) => {
                  const st = model.entry(periodId, e.id)?.status;
                  return (
                    <button key={e.id} className={entityId === e.id ? "is-active" : ""} onClick={() => setEntityId(e.id)}>
                      <b>{e.name}</b><span>{e.currency} · {st === "loaded" ? "cargada ✓" : "pendiente"}</span>
                    </button>
                  );
                })}
              </div>
              {entityId && <EntityTab key={`${periodId}-${entityId}`} model={model} periodId={periodId} entity={entities.find((e) => e.id === entityId)} editable={canEdit} onSave={saveEntry} />}
            </>
          )}
          {tab === "eliminations" && !isHistory && <EliminationsTab model={model} periodId={periodId} editable={canEdit} onSave={saveEntry} />}
          {tab === "bs" && <BalanceTab model={model} periodId={periodId} entities={included} />}
          {tab === "pl" && <ResultsTab model={model} periods={periods} entities={entities} periodId={periodId} />}
        </>
      )}
      {!periods.length && <div className="board-empty-state">No hay meses. {editable ? "Crea el primero con + Nuevo mes." : ""}</div>}

      {docs.length > 0 && (
        <section className="cons-card cons-docs">
          <h3>Documentos del grupo</h3>
          <ul className="people-docs">
            {docs.map((d) => (
              <li key={d.id}>
                <span className="people-doc-kind is-other">{d.category}</span>
                <button className="people-doc-name" onClick={() => openDoc(d)}>{d.name}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
