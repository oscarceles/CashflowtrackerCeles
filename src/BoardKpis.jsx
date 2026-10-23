import React, { useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { useConsolidationData } from "./Consolidation";
import { buildModel } from "./consolidationEngine";

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MONTH_NAMES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const label = (id) => `${MONTHS[+id.slice(5) - 1]} ${id.slice(2, 4)}`;
const longLabel = (id) => `${MONTH_NAMES[+id.slice(5) - 1]} ${id.slice(0, 4)}`;
const usd = (n) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usdK = (n) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1000 ? `$${Math.round(n / 1000)}k` : usd(n));
const pct = (n) => (n == null || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`);
const SERIES = "#2a78d6";

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
      <div className="people-tooltip-row"><span className="people-swatch" style={{ background: SERIES }} />MRR<b>{usd(d.mrr)}</b></div>
      <div className="people-tooltip-row">ARR<b>{usd(d.mrr * 12)}</b></div>
      <div className="people-tooltip-row">vs mes anterior<b>{pct(d.mom)}</b></div>
    </div>
  );
}

function downloadCsv(rows) {
  const csv = rows.map((r) => r.join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = `kpis-mrr-arr-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

/** MRR / ARR derived from consolidated revenue of closed consolidation months. */
export default function KpisView() {
  const { entities, periods, entries, loading, error } = useConsolidationData();
  const [range, setRange] = useState("12");
  const model = useMemo(() => buildModel({ periods, entries, entities }), [periods, entries, entities]);

  const series = useMemo(() => {
    const closed = periods.filter((p) => p.status === "closed").map((p) => p.id).sort();
    const rows = closed.map((id) => ({ id, mrr: model.consolidatedMonth(id)?.lines.revenue })).filter((r) => Number.isFinite(r.mrr));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.mrr]));
    return rows.map((r, i) => {
      const prev = rows[i - 1];
      const yoyId = `${+r.id.slice(0, 4) - 1}-${r.id.slice(5)}`;
      return {
        ...r,
        arr: r.mrr * 12,
        netNew: prev ? r.mrr - prev.mrr : null,
        mom: prev && prev.mrr ? r.mrr / prev.mrr - 1 : null,
        yoy: byId[yoyId] ? r.mrr / byId[yoyId] - 1 : null,
      };
    });
  }, [periods, model]);

  if (loading) return <div className="board-empty-state">Cargando…</div>;
  const last = series[series.length - 1];
  const cmgr = (months) => {
    const base = series[series.length - 1 - months];
    return last && base && base.mrr > 0 ? (last.mrr / base.mrr) ** (1 / months) - 1 : null;
  };
  const shown = range === "all" ? series : series.slice(-Number(range));
  const ytd = last ? series.filter((r) => r.id.startsWith(last.id.slice(0, 4))) : [];

  return (
    <div className="board-docs">
      <div className="board-docs-heading">
        <div>
          <div className="board-eyebrow">BOARD · CONSOLIDATED DATA</div>
          <h1>KPIs</h1>
          <p>MRR y ARR según los estados financieros consolidados (ingresos del mes en USD, después de eliminaciones intercompañía).</p>
        </div>
        {last && <div className="board-doc-count">Último mes cerrado: {longLabel(last.id)}</div>}
      </div>
      {error && <div className="board-doc-error" role="alert">{error}</div>}

      {!last ? <div className="board-empty-state">Todavía no hay meses cerrados en Financials.</div> : (
        <>
          <div className="cons-tiles kpi-tiles">
            <div className="cons-tile kpi-hero"><span>MRR · {longLabel(last.id)}</span><b>{usd(last.mrr)}</b><Delta value={last.mom} /><small>vs {series.length > 1 ? longLabel(series[series.length - 2].id) : "—"}</small></div>
            <div className="cons-tile kpi-hero"><span>ARR (MRR × 12)</span><b>{usd(last.arr)}</b><Delta value={last.yoy} /><small>vs {MONTH_NAMES[+last.id.slice(5) - 1].toLowerCase()} {+last.id.slice(0, 4) - 1}</small></div>
            <div className="cons-tile"><span>MRR neto nuevo del mes</span><b>{last.netNew == null ? "—" : usd(last.netNew)}</b><small>Cambio de MRR vs mes anterior</small></div>
            <div className="cons-tile"><span>Crecimiento mensual compuesto</span><b>{pct(cmgr(6))}</b><small>Últimos 6 meses · 12 meses: {pct(cmgr(12))}</small></div>
            <div className="cons-tile"><span>Ingresos {last.id.slice(0, 4)} acumulados</span><b>{usd(ytd.reduce((s, r) => s + r.mrr, 0))}</b><small>{ytd.length} meses cerrados</small></div>
          </div>

          <section className="cons-card">
            <div className="cons-card-head">
              <h3>MRR mensual <span className="people-muted">(USD)</span></h3>
              <div className="cons-card-actions">
                <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Periodo">
                  <option value="12">Últimos 12 meses</option>
                  <option value="24">Últimos 24 meses</option>
                  <option value="all">Todo</option>
                </select>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={shown} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="24%">
                <CartesianGrid vertical={false} stroke="#eef1f5" />
                <XAxis dataKey="id" tickFormatter={label} tickLine={false} axisLine={{ stroke: "#dce3ed" }} tick={{ fill: "#647084", fontSize: 11 }} />
                <YAxis tickFormatter={usdK} tickLine={false} axisLine={false} tick={{ fill: "#647084", fontSize: 11 }} width={56} />
                <Tooltip content={<ChartTip />} cursor={{ fill: "#f4f7fc" }} />
                <Bar dataKey="mrr" name="MRR" fill={SERIES} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </section>

          <section className="cons-card">
            <div className="cons-card-head">
              <h3>Detalle mensual</h3>
              <button className="people-secondary-button" onClick={() => downloadCsv([
                ["Mes", "MRR (USD)", "MRR neto nuevo", "Crecimiento mensual %", "ARR (USD)", "Crecimiento anual %"],
                ...series.map((r) => [r.id, r.mrr.toFixed(2), r.netNew == null ? "" : r.netNew.toFixed(2), r.mom == null ? "" : (r.mom * 100).toFixed(2), r.arr.toFixed(2), r.yoy == null ? "" : (r.yoy * 100).toFixed(2)]),
              ])}>Descargar CSV</button>
            </div>
            <div className="admin-table-wrap">
              <table className="admin-table cons-table">
                <thead><tr><th>Mes</th><th className="num">MRR</th><th className="num">MRR neto nuevo</th><th className="num">vs mes anterior</th><th className="num">ARR</th><th className="num">vs mismo mes año anterior</th></tr></thead>
                <tbody>
                  {[...shown].reverse().map((r) => (
                    <tr key={r.id}>
                      <td>{longLabel(r.id)}</td>
                      <td className="num"><b>{usd(r.mrr)}</b></td>
                      <td className="num">{r.netNew == null ? "—" : usd(r.netNew)}</td>
                      <td className="num"><Delta value={r.mom} /></td>
                      <td className="num">{usd(r.arr)}</td>
                      <td className="num"><Delta value={r.yoy} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <p className="admin-note">
            Calculado con los meses cerrados de Financials. Los estados financieros no separan ingresos recurrentes de no recurrentes (implementaciones, servicios puntuales),
            así que este MRR puede diferir del MRR por contratos de Cashflow → Reports, que se calcula con el calendario de facturas.
          </p>
        </>
      )}
    </div>
  );
}
