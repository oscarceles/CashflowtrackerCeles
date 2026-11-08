import React, { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { useConsolidationData } from "./Consolidation";
import { buildModel } from "./consolidationEngine";
import { loadState } from "./storage";
import { ENTITIES, buildMrrSeries, compareHistoryWithMaster } from "./mrr";
import { MRR_HISTORY_LAST, MRR_HISTORY_SOURCE } from "./mrrHistory";

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MONTH_NAMES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const label = (id) => `${MONTHS[+id.slice(5) - 1]} ${id.slice(2, 4)}`;
const longLabel = (id) => `${MONTH_NAMES[+id.slice(5) - 1]} ${id.slice(0, 4)}`;
const usd = (n) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = (n) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdK = (n) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1000 ? `$${Math.round(n / 1000)}k` : usd(n));
const pct = (n) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`);
const entityLabel = (id) => ENTITIES.find((e) => e.id === id)?.label || id;
const SOURCE = { file: "Archivo", master: "Master de clientes" };

function Delta({ value }) {
  if (value == null || !Number.isFinite(value)) return <span className="kpi-delta">—</span>;
  return <span className={`kpi-delta ${value >= 0 ? "is-up" : "is-down"}`}>{value >= 0 ? "▲" : "▼"} {pct(value).replace("+", "")}</span>;
}

function ChartTip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="people-tooltip">
      <div className="people-tooltip-title">{longLabel(d.id)}</div>
      {ENTITIES.map((e) => d.byEntity[e.id] ? <div key={e.id} className="people-tooltip-row"><span className="people-swatch" style={{ background: e.color }} />{e.label}<b>{usd(d.byEntity[e.id])}</b></div> : null)}
      <div className="people-tooltip-row">MRR total<b>{usd(d.mrr)}</b></div>
      <div className="people-tooltip-row">ARR<b>{usd(d.arr)}</b></div>
      <div className="people-tooltip-row">vs mes anterior<b>{pct(d.mom)}</b></div>
    </div>
  );
}

function downloadCsv(rows) {
  const csv = rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = `kpis-mrr-arr-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

/** Last month to show: the latest Financials period, or the last complete calendar month when there is none. */
function lastMonth(periods) {
  const latest = periods.map((p) => p.id).sort().pop();
  if (latest) return latest;
  const d = new Date(); d.setDate(0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Contract MRR / ARR: file history, then the Cashflow master clients; accounting revenue from Financials alongside. */
export default function KpisView() {
  const { entities, periods, entries, loading, error } = useConsolidationData();
  const [master, setMaster] = useState({ loading: true, clients: null, error: null });
  const [range, setRange] = useState("12");
  const [selected, setSelected] = useState(null);
  const model = useMemo(() => buildModel({ periods, entries, entities }), [periods, entries, entities]);

  useEffect(() => {
    loadState()
      .then((state) => setMaster({ loading: false, clients: Array.isArray(state?.clients) ? state.clients : null, error: null }))
      .catch((e) => setMaster({ loading: false, clients: null, error: e.message || String(e) }));
  }, []);

  const to = lastMonth(periods);
  const series = useMemo(() => {
    if (master.loading || loading) return [];
    const rows = buildMrrSeries(master.clients, to);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.mrr]));
    const status = Object.fromEntries(periods.map((p) => [p.id, p.status]));
    return rows.map((r, i) => {
      const prev = rows[i - 1];
      const yoyId = `${+r.id.slice(0, 4) - 1}-${r.id.slice(5)}`;
      const revenue = status[r.id] ? model.consolidatedMonth(r.id)?.lines.revenue : null;
      return {
        ...r,
        arr: r.mrr * 12,
        netNew: prev ? r.mrr - prev.mrr : null,
        mom: prev && prev.mrr ? r.mrr / prev.mrr - 1 : null,
        yoy: byId[yoyId] ? r.mrr / byId[yoyId] - 1 : null,
        revenue: Number.isFinite(revenue) ? revenue : null,
        periodStatus: status[r.id] || null,
        ...Object.fromEntries(ENTITIES.map((e) => [e.id, r.byEntity[e.id]])),
      };
    });
  }, [master, loading, to, periods, model]);
  const comparison = useMemo(() => (master.clients ? compareHistoryWithMaster(master.clients) : null), [master.clients]);

  if (loading || master.loading) return <div className="board-empty-state">Cargando…</div>;
  const last = series[series.length - 1];
  const cmgr = (months) => {
    const base = series[series.length - 1 - months];
    return last && base && base.mrr > 0 ? (last.mrr / base.mrr) ** (1 / months) - 1 : null;
  };
  const shown = range === "all" ? series : series.slice(-Number(range));
  const monthId = selected && series.some((r) => r.id === selected) ? selected : last?.id;
  const detailIndex = series.findIndex((r) => r.id === monthId);
  const detail = series[detailIndex];
  const prevDetail = series[detailIndex - 1];
  const prevByClient = Object.fromEntries((prevDetail?.clients || []).map((c) => [c.client, c.mrr]));
  const departed = prevDetail ? prevDetail.clients.filter((c) => !detail.clients.some((x) => x.client === c.client)) : [];
  const diffMonths = comparison ? comparison.totals.filter((t) => Math.abs(t.diff) > 0.5) : [];

  return (
    <div className="board-docs">
      <div className="board-docs-heading">
        <div>
          <div className="board-eyebrow">BOARD · CONSOLIDATED DATA</div>
          <h1>KPIs</h1>
          <p>MRR y ARR por contratos (USD): el ARR de cada año de contrato repartido en sus 12 meses. Hasta {longLabel(MRR_HISTORY_LAST)} según el archivo de devengo; desde ahí, calculado con el master de clientes del Cashflow.</p>
        </div>
        {last && <div className="board-doc-count">Último mes: {longLabel(last.id)}</div>}
      </div>
      {error && <div className="board-doc-error" role="alert">{error}</div>}
      {master.error && <div className="board-doc-error" role="alert">No se pudo leer el master de clientes: {master.error}</div>}
      {!master.error && !master.clients && (
        <div className="board-doc-error" role="alert">Sin acceso al master de clientes del Cashflow: se muestran solo los meses del archivo (hasta {longLabel(MRR_HISTORY_LAST)}).</div>
      )}

      {!last ? <div className="board-empty-state">Todavía no hay datos de MRR.</div> : (
        <>
          <div className="cons-tiles kpi-tiles">
            <div className="cons-tile kpi-hero"><span>MRR · {longLabel(last.id)}</span><b>{usd(last.mrr)}</b><Delta value={last.mom} /><small>vs {series.length > 1 ? longLabel(series[series.length - 2].id) : "—"}</small></div>
            <div className="cons-tile kpi-hero"><span>ARR (MRR × 12)</span><b>{usd(last.arr)}</b><Delta value={last.yoy} /><small>vs {MONTH_NAMES[+last.id.slice(5) - 1].toLowerCase()} {+last.id.slice(0, 4) - 1}</small></div>
            <div className="cons-tile"><span>MRR neto nuevo del mes</span><b>{last.netNew == null ? "—" : usd(last.netNew)}</b><small>Cambio de MRR vs mes anterior</small></div>
            <div className="cons-tile"><span>Clientes con MRR</span><b>{last.clients.length}</b><small>{ENTITIES.map((e) => `${e.label.split(" ")[0]} ${last.clients.filter((c) => c.entity === e.id).length}`).join(" · ")}</small></div>
            <div className="cons-tile"><span>Crecimiento mensual compuesto</span><b>{pct(cmgr(6))}</b><small>Últimos 6 meses · 12 meses: {pct(cmgr(12))}</small></div>
          </div>

          <section className="cons-card">
            <div className="cons-card-head">
              <h3>MRR mensual por entidad <span className="people-muted">(USD)</span></h3>
              <div className="cons-card-actions">
                <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Periodo">
                  <option value="12">Últimos 12 meses</option>
                  <option value="24">Últimos 24 meses</option>
                  <option value="all">Todo</option>
                </select>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={shown} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="24%">
                <CartesianGrid vertical={false} stroke="#eef1f5" />
                <XAxis dataKey="id" tickFormatter={label} tickLine={false} axisLine={{ stroke: "#dce3ed" }} tick={{ fill: "#647084", fontSize: 11 }} />
                <YAxis tickFormatter={usdK} tickLine={false} axisLine={false} tick={{ fill: "#647084", fontSize: 11 }} width={56} />
                <Tooltip content={<ChartTip />} cursor={{ fill: "#f4f7fc" }} />
                <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 11 }} formatter={(value) => <span style={{ color: "#40516a" }}>{value}</span>} />
                {ENTITIES.map((e, i) => (
                  <Bar key={e.id} dataKey={e.id} name={e.label} stackId="mrr" fill={e.color} stroke="#fff" strokeWidth={1}
                    radius={i === ENTITIES.length - 1 ? [4, 4, 0, 0] : 0} onClick={(d) => setSelected(d.id)} cursor="pointer" />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </section>

          <section className="cons-card">
            <div className="cons-card-head">
              <h3>Detalle mensual</h3>
              <button className="people-secondary-button" onClick={() => downloadCsv([
                ["Mes", "MRR (USD)", ...ENTITIES.map((e) => `MRR ${e.label}`), "MRR neto nuevo", "Crecimiento mensual %", "ARR (USD)", "Crecimiento anual %", "Clientes", "Ingresos Financials (USD)", "Fuente"],
                ...series.map((r) => [r.id, r.mrr.toFixed(2), ...ENTITIES.map((e) => r.byEntity[e.id].toFixed(2)), r.netNew == null ? "" : r.netNew.toFixed(2), r.mom == null ? "" : (r.mom * 100).toFixed(2), r.arr.toFixed(2), r.yoy == null ? "" : (r.yoy * 100).toFixed(2), r.clients.length, r.revenue == null ? "" : r.revenue.toFixed(2), SOURCE[r.source]]),
              ])}>Descargar CSV</button>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table cons-table">
                <thead>
                  <tr>
                    <th>Mes</th><th className="num">MRR</th>{ENTITIES.map((e) => <th key={e.id} className="num">{e.label.split(" ")[0]}</th>)}
                    <th className="num">Neto nuevo</th><th className="num">vs mes ant.</th><th className="num">ARR</th><th className="num">vs año ant.</th>
                    <th className="num">Ingresos Financials</th><th>Fuente</th>
                  </tr>
                </thead>
                <tbody>
                  {[...shown].reverse().map((r) => (
                    <tr key={r.id} className={r.id === monthId ? "kpi-selected" : undefined}>
                      <td><button className="kpi-month-link" onClick={() => setSelected(r.id)}>{longLabel(r.id)}</button></td>
                      <td className="num"><b>{usd(r.mrr)}</b></td>
                      {ENTITIES.map((e) => <td key={e.id} className="num">{r.byEntity[e.id] ? usd(r.byEntity[e.id]) : "—"}</td>)}
                      <td className="num">{r.netNew == null ? "—" : usd(r.netNew)}</td>
                      <td className="num"><Delta value={r.mom} /></td>
                      <td className="num">{usd(r.arr)}</td>
                      <td className="num"><Delta value={r.yoy} /></td>
                      <td className="num">{r.revenue == null ? "—" : usd(r.revenue)}{r.revenue != null && r.periodStatus !== "closed" ? <span className="people-muted"> (borrador)</span> : null}</td>
                      <td>{SOURCE[r.source]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {detail && (
            <section className="cons-card">
              <div className="cons-card-head">
                <h3>Clientes · {longLabel(detail.id)} <span className="people-muted">({SOURCE[detail.source].toLowerCase()})</span></h3>
                <div className="cons-card-actions">
                  <select value={detail.id} onChange={(e) => setSelected(e.target.value)} aria-label="Mes">
                    {[...series].reverse().map((r) => <option key={r.id} value={r.id}>{longLabel(r.id)}</option>)}
                  </select>
                </div>
              </div>
              <div className="admin-table-wrap">
                <table className="admin-table cons-table">
                  <thead><tr><th>Cliente</th><th>Entidad</th><th>País</th><th className="num">MRR</th><th className="num">ARR</th><th className="num">vs mes ant.</th>{detail.source === "master" && <th className="num">Año de contrato</th>}</tr></thead>
                  <tbody>
                    {[...detail.clients].sort((a, b) => b.mrr - a.mrr).map((c) => {
                      const before = prevByClient[c.client];
                      const change = before == null ? null : c.mrr - before;
                      return (
                        <tr key={c.client}>
                          <td>{c.client}{before == null && prevDetail ? <span className="people-muted"> · nuevo</span> : null}</td>
                          <td>{entityLabel(c.entity)}</td>
                          <td>{c.country}</td>
                          <td className="num"><b>{usd2(c.mrr)}</b></td>
                          <td className="num">{usd(c.mrr * 12)}</td>
                          <td className="num">{change == null ? "—" : Math.abs(change) < 0.005 ? "=" : usd2(change)}</td>
                          {detail.source === "master" && <td className="num">{c.year || "—"}</td>}
                        </tr>
                      );
                    })}
                    {departed.map((c) => (
                      <tr key={`out-${c.client}`}>
                        <td>{c.client}<span className="people-muted"> · sin MRR este mes</span></td>
                        <td>{entityLabel(c.entity)}</td><td>{c.country}</td><td className="num">—</td><td className="num">—</td>
                        <td className="num">{usd2(-c.mrr)}</td>{detail.source === "master" && <td className="num">—</td>}
                      </tr>
                    ))}
                    <tr><td colSpan={3}><b>Total</b></td><td className="num"><b>{usd2(detail.mrr)}</b></td><td className="num"><b>{usd(detail.arr)}</b></td><td className="num">{detail.netNew == null ? "—" : usd2(detail.netNew)}</td>{detail.source === "master" && <td />}</tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {comparison && (
            <section className="cons-card">
              <div className="cons-card-head">
                <h3>Archivo vs master de clientes <span className="people-muted">(hasta {longLabel(MRR_HISTORY_LAST)})</span></h3>
              </div>
              <p className="admin-note">
                Confirma el historial de {MRR_HISTORY_SOURCE} con el master de clientes del Cashflow (misma regla: ARR del año de contrato ÷ 12, mes de inicio completo y mes de fin prorrateado por días).
                {diffMonths.length ? ` ${diffMonths.length} de ${comparison.totals.length} meses tienen diferencia; el KPI usa el archivo para esos meses.` : " Todos los meses coinciden."}
              </p>
              {comparison.diffs.length > 0 && (
                <div className="admin-table-wrap">
                  <table className="admin-table cons-table">
                    <thead><tr><th>Mes</th><th>Cliente</th><th className="num">Archivo</th><th className="num">Master</th><th className="num">Diferencia</th></tr></thead>
                    <tbody>
                      {[...comparison.diffs].sort((a, b) => b.id.localeCompare(a.id) || Math.abs(b.diff) - Math.abs(a.diff)).map((d) => (
                        <tr key={`${d.id}-${d.client}`}>
                          <td>{longLabel(d.id)}</td><td>{d.client}</td>
                          <td className="num">{d.file == null ? "No está" : usd2(d.file)}</td>
                          <td className="num">{d.master == null ? "No está" : usd2(d.master)}</td>
                          <td className="num">{usd2(d.diff)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          <p className="admin-note">
            MRR por contratos, no por facturación ni por contabilidad. Hasta {longLabel(MRR_HISTORY_LAST)} viene del archivo {MRR_HISTORY_SOURCE}; desde el mes siguiente se calcula con el master de clientes del Cashflow
            (ARR del año de contrato ÷ 12 desde el mes de inicio; el mes de fin se prorratea por días). Los meses llegan hasta el último periodo creado en Financials.
            «Ingresos Financials» son los ingresos contables consolidados del mes: pueden diferir del MRR por ingresos no recurrentes (implementaciones, servicios), diferidos y cortes de facturación.
          </p>
        </>
      )}
    </div>
  );
}
