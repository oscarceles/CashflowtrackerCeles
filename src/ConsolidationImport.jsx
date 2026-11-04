import React, { useMemo, useRef, useState } from "react";
import { BS_INPUT_LINES, PL_LINES, prevPeriodId } from "./consolidationEngine";
import { readSpreadsheet } from "./sheetReader";
import { CHARTS, SPECIAL_LINES, applyMapping, defaultChart, detectBasis, mergeExports, parseErpExport, resolveSign, suggestLine, toStoredImport } from "./erpImport";

const fmt = (n, decimals = 2) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const FORMAT_LABELS = { table: "Balanza de comprobación", ledger: "Auxiliar del libro mayor", statement: "Estados financieros presentados" };
const CONTENT_LABELS = { bs: "Solo balance general", pl: "Solo estado de resultados", both: "Balance general + estado de resultados" };

/** Values to store for an entity after applying the mapping to its import. */
export function importToValues({ values, imp, maps, entity, entities, model, periodId }) {
  const r = applyMapping(imp, maps || {}, { entity, entities, periodYear: +periodId.slice(0, 4) });
  let pl = r.pl;
  if (imp.basis === "month" && !periodId.endsWith("-01")) {
    const prev = model.entry(prevPeriodId(periodId), entity.id)?.values?.pl_ytd || {};
    pl = Object.fromEntries(PL_LINES.map((l) => [l.key, Math.round(((Number(prev[l.key]) || 0) + r.pl[l.key]) * 100) / 100]));
  }
  return { ...values, import: imp, bs: r.bs, pl_ytd: pl };
}

/** Stored import from the parsed files of one month (sign, results basis and accounts as JSON). */
export function prepareImport(parsedList, { periodId, chart, basis = "auto", by }) {
  const parsed = mergeExports(parsedList);
  const year = +periodId.slice(0, 4);
  resolveSign(parsed, (a) => suggestLine(a, chart, year), chart);
  const chosen = basis !== "auto" && parsed.format !== "statement" ? basis : detectBasis(parsed, periodId, chart);
  return toStoredImport(parsed, { chart, basis: chosen, by });
}

function LineSelect({ value, onChange, disabled }) {
  return (
    <select className="cons-map-select" value={value || ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">— Sin asignar —</option>
      <optgroup label="Balance">{BS_INPUT_LINES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</optgroup>
      <optgroup label="Estado de resultados">{PL_LINES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</optgroup>
      <optgroup label="Otros">{SPECIAL_LINES.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}</optgroup>
    </select>
  );
}

export default function ImportPanel({ entity, entities, periodId, model, values, resolved, editable, member, onImport, onRemove, onMap }) {
  const imp = values?.import;
  const [chart, setChart] = useState(imp?.chart || defaultChart(entity));
  const [basis, setBasis] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("attention");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(!imp);
  const fileRef = useRef(null);
  const others = entities.filter((e) => e.id !== entity.id);

  const handleFiles = async (files) => {
    if (!files?.length) return;
    setBusy(true); setError(null);
    try {
      const list = [];
      for (const file of files) list.push(parseErpExport(await readSpreadsheet(file), file.name, { periodId }));
      await onImport(prepareImport(list, { periodId, chart, basis, by: member?.email }));
      setFilter("attention");
      setOpen(true);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const rows = resolved?.rows || [];
  const counts = useMemo(() => ({
    attention: rows.filter((r) => r.status !== "saved" && Math.abs(r.balance) > 0.005).length,
    unmapped: rows.filter((r) => !r.line).length,
    ic: rows.filter((r) => r.ic).length,
    all: rows.length,
  }), [rows]);
  const shown = rows.filter((r) => {
    if (filter === "attention" && !(r.status !== "saved" && Math.abs(r.balance) > 0.005)) return false;
    if (filter === "unmapped" && r.line) return false;
    if (filter === "ic" && !r.ic) return false;
    if (query && !`${r.code} ${r.name}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const confirmable = rows.filter((r) => r.status === "suggested");

  return (
    <section className="cons-card cons-import">
      <div className="cons-card-head">
        <h3>Importar desde el ERP <span className="people-muted">({entity.currency})</span></h3>
        {imp && <button className="admin-link-button" onClick={() => setOpen(!open)}>{open ? "Ocultar cuentas" : `Ver cuentas (${rows.length})`}</button>}
      </div>

      {imp ? (
        <div className="cons-import-summary">
          <div><span>Archivo</span><b title={imp.file}>{imp.file}</b></div>
          <div><span>Formato</span><b>{FORMAT_LABELS[imp.format] || imp.format}</b></div>
          {imp.format === "statement" && <div><span>Contenido</span><b className={imp.kind === "both" ? "" : "is-bad"}>{CONTENT_LABELS[imp.kind]}</b></div>}
          {imp.sheet && imp.sheet !== "CSV" && <div><span>Hoja</span><b title={imp.sheet}>{imp.sheet}</b></div>}
          <div><span>Período del archivo</span><b>{imp.meta?.from ? `${imp.meta.from} → ` : ""}{imp.meta?.to || "no indicado"}</b></div>
          <div><span>Resultados</span><b>{imp.basis === "month" ? "Movimientos del mes" : "Acumulados del año"}</b></div>
          <div><span>Plan de cuentas</span><b>{CHARTS.find((c) => c.id === imp.chart)?.label}</b></div>
          <div><span>Cuentas</span><b>{rows.length} de detalle · {imp.accounts.length} total</b></div>
          <div><span>{imp.format === "statement" ? "Activos − (pasivos + patrimonio)" : "Débitos − créditos"}</span><b className={Math.abs(resolved?.trialDifference || 0) > 1 ? "is-bad" : "is-good"}>{Math.abs(resolved?.trialDifference || 0) > 1 ? fmt(resolved.trialDifference) : "0 ✓"}</b></div>
          <div><span>Importado</span><b>{new Date(imp.imported_at).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" })}{imp.imported_by ? ` · ${imp.imported_by}` : ""}</b></div>
        </div>
      ) : (
        <p className="admin-note">
          Sube la balanza de comprobación (o el auxiliar del libro mayor) exportada del ERP en Excel (.xlsx) o CSV, con corte al último día del mes,
          o los estados financieros presentados: el balance general y el estado de resultados juntos (selecciona los dos archivos a la vez; el estado de resultados puede traer una columna por mes).
          Si el libro trae una hoja por mes, se usa la del mes. Se detectan las columnas, la jerarquía de cuentas (solo se suman las cuentas de detalle), la fecha y la moneda del reporte; cada cuenta se asigna a una línea del consolidado
          según el plan de cuentas o la sección del estado, y la asignación se recuerda para los meses siguientes.
        </p>
      )}

      {editable && (
        <div className="cons-import-controls">
          <label>Plan de cuentas
            <select value={chart} onChange={(e) => setChart(e.target.value)}>{CHARTS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
          </label>
          <label>Resultados en el archivo
            <select value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="auto">Detectar por fechas</option>
              <option value="ytd">Acumulados del año</option>
              <option value="month">Solo movimientos del mes</option>
            </select>
          </label>
          <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.csv,.tsv,.txt" multiple hidden onChange={(e) => handleFiles([...(e.target.files || [])])} />
          <button className="admin-primary-button" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? "Leyendo…" : imp ? "Reemplazar archivos" : "Subir archivos"}</button>
          {imp && <button className="admin-link-button" onClick={onRemove}>Quitar importación</button>}
        </div>
      )}
      {error && <div className="board-doc-error" role="alert">{error}</div>}

      {imp && open && (
        <div className="cons-map">
          <div className="cons-map-toolbar">
            <div className="cons-map-filters" role="tablist">
              {[["attention", "Por revisar"], ["unmapped", "Sin asignar"], ["ic", "Intercompañía"], ["all", "Todas"]].map(([id, label]) => (
                <button key={id} className={filter === id ? "is-active" : ""} onClick={() => setFilter(id)}>{label} <span>{counts[id]}</span></button>
              ))}
            </div>
            <input className="cons-map-search" placeholder="Buscar cuenta" value={query} onChange={(e) => setQuery(e.target.value)} />
            {editable && confirmable.length > 0 && (
              <button className="people-secondary-button" onClick={() => onMap(confirmable.map((r) => ({ code: r.code, name: r.name, line: r.line, ic_entity: r.ic === "unknown" ? null : r.ic })))}>Confirmar {confirmable.length} sugeridas</button>
            )}
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table cons-table cons-map-table">
              <thead><tr><th>{imp.format === "statement" ? "Sección" : "Código"}</th><th>Cuenta</th><th className="num">Saldo</th><th>Línea del consolidado</th><th>Intercompañía</th><th>Estado</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.code} className={!r.line ? "is-unmapped" : ""}>
                    <td className="cons-map-code">{imp.format === "statement" ? r.group || "—" : r.code === r.name ? "—" : r.code}</td>
                    <td>{r.name}</td>
                    <td className="num">{fmt(Math.abs(r.balance))} <small>{r.balance >= 0 ? "D" : "C"}</small></td>
                    <td><LineSelect value={r.line} disabled={!editable} onChange={(line) => onMap([{ code: r.code, name: r.name, line, ic_entity: r.ic === "unknown" ? null : r.ic }])} /></td>
                    <td>
                      <select className="cons-map-select is-small" value={r.ic || ""} disabled={!editable || !r.line} onChange={(e) => onMap([{ code: r.code, name: r.name, line: r.line, ic_entity: e.target.value || null }])}>
                        <option value="">—</option>
                        {others.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                        {r.ic === "unknown" && <option value="unknown">Sin definir</option>}
                      </select>
                    </td>
                    <td><span className={`people-chip is-${r.status === "saved" ? "good" : r.status === "suggested" ? "wait" : "bad"}`}>{r.status === "saved" ? "Confirmada" : r.status === "suggested" ? "Sugerida" : "Sin asignar"}</span></td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={6} className="people-muted">{filter === "attention" ? "Todas las cuentas con saldo están confirmadas ✓" : "Sin cuentas en este filtro."}</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="admin-note">D = saldo débito, C = saldo crédito. Las cuentas padre no se muestran: solo se consolidan las de detalle. Al cambiar una línea se recalculan el balance y el estado de resultados de la entidad; la asignación queda guardada para {entity.name} en los meses siguientes.{imp.basis === "month" ? " Los resultados del archivo son del mes: el acumulado del año se calcula sumando el acumulado del mes anterior." : ""}</p>
        </div>
      )}
      {imp && !rows.length && <p className="admin-note">El archivo no tiene cuentas de detalle.</p>}
    </section>
  );
}
