import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { supabase } from "./supabaseClient";
import { useMember, isSuperAdmin } from "./access";
import "./people.css";
import {
  MONTHS, MONTH_NAMES, areaColor, ADJ_TYPES, usd, usdK, pct, num, periodLabel, adjustmentsTotal, lineTotal, suggestedPrima, suggestedDays, downloadCsv,
  daysBetween, segmentAmount, buildLiquidationSegments, exitMonthDays, DEEL_HEADER, buildDeelRows,
} from "./peopleUtils";
import DirectoryView, { PersonAvatar } from "./PeopleDirectory";

/* ============================ data ============================ */

async function fetchAll(table, order) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select("*").order(order).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

/** Signed URLs (1 h) for photos uploaded to the private people-photos bucket. */
async function signedPhotoUrls(employees) {
  const withPhoto = employees.filter((e) => e.photo_path);
  if (!withPhoto.length) return {};
  const { data, error } = await supabase.storage.from("people-photos").createSignedUrls(withPhoto.map((e) => e.photo_path), 3600);
  if (error || !data) return {};
  const byPath = Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
  return Object.fromEntries(withPhoto.filter((e) => byPath[e.photo_path]).map((e) => [e.id, byPath[e.photo_path]]));
}

function usePeopleData() {
  const [data, setData] = useState({ periods: [], lines: [], employees: [], grants: [], privates: [], documents: [], photos: {}, loading: true, error: null });
  const reload = async () => {
    try {
      // people_private only returns rows for People editors (RLS); viewers get an empty list.
      // people_private and people_documents only return rows for People editors (RLS).
      const [periods, lines, employees, grants, privates, documents] = await Promise.all([
        fetchAll("payroll_periods", "id"), fetchAll("payroll_lines", "name"), fetchAll("people_employees", "name"),
        fetchAll("people_equity_grants", "vesting_start"), fetchAll("people_private", "employee_id"), fetchAll("people_documents", "name"),
      ]);
      const photos = await signedPhotoUrls(employees);
      setData({ periods, lines, employees, grants, privates, documents, photos, loading: false, error: null });
    } catch (err) {
      setData((d) => ({ ...d, loading: false, error: err.message || "No se pudo cargar la información de People." }));
    }
  };
  useEffect(() => { reload(); }, []);
  const patchLocal = (fn) => setData((d) => ({ ...d, ...fn(d) }));
  return { ...data, reload, patchLocal };
}

/* ============================ shared UI ============================ */

function Filters({ years, year, setYear, areas, area, setArea, type, setType, children }) {
  return (
    <div className="people-filters">
      <label>Año
        <select value={year} onChange={(e) => setYear(+e.target.value)}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>
      <label>Área
        <select value={area} onChange={(e) => setArea(e.target.value)}>
          <option value="">Todas</option>
          {areas.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </label>
      <label>Tipo
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">CAPEX y OPEX</option>
          <option value="CAPEX">CAPEX</option>
          <option value="OPEX">OPEX</option>
        </select>
      </label>
      {children}
    </div>
  );
}

const Kpi = ({ label, value, sub, tone }) => (
  <div className="people-kpi">
    <div className="people-kpi-label">{label}</div>
    <div className="people-kpi-value">{value}</div>
    {sub && <div className={`people-kpi-sub${tone ? ` is-${tone}` : ""}`}>{sub}</div>}
  </div>
);

const ChartTooltip = ({ active, payload, label, formatter = usd }) => {
  if (!active || !payload?.length) return null;
  const items = payload.filter((p) => num(p.value) !== 0);
  const total = items.reduce((s, p) => s + num(p.value), 0);
  return (
    <div className="people-tooltip">
      <div className="people-tooltip-title">{label}</div>
      {items.map((p) => (
        <div key={p.dataKey} className="people-tooltip-row">
          <span className="people-swatch" style={{ background: p.color }} />{p.name}<b>{formatter(p.value)}</b>
        </div>
      ))}
      {items.length > 1 && <div className="people-tooltip-row is-total">Total<b>{formatter(total)}</b></div>}
    </div>
  );
};

/* ============================ Reportes ============================ */

function ReportsView({ periods, lines, employees }) {
  const closed = useMemo(() => new Set(periods.filter((p) => p.status === "closed").map((p) => p.id)), [periods]);
  const years = useMemo(() => [...new Set(periods.filter((p) => closed.has(p.id)).map((p) => p.year))].sort((a, b) => b - a), [periods, closed]);
  const [year, setYear] = useState(years[0]);
  const [area, setArea] = useState("");
  const [type, setType] = useState("");
  useEffect(() => { if (!years.includes(year)) setYear(years[0]); }, [years]);

  const areas = useMemo(() => [...new Set(lines.map((l) => l.area || "Sin área"))].sort(), [lines]);
  const filtered = useMemo(() => lines.filter((l) => closed.has(l.period_id)
    && (!area || (l.area || "Sin área") === area) && (!type || l.cost_type === type)), [lines, closed, area, type]);

  const byPeriod = useMemo(() => {
    const map = {};
    for (const l of filtered) {
      const p = (map[l.period_id] ||= { total: 0, people: new Set(), capex: 0, byArea: {} });
      const t = lineTotal(l);
      p.total += t;
      p.people.add(l.employee_id || l.name);
      if (l.cost_type === "CAPEX") p.capex += t;
      const a = l.area || "Sin área";
      p.byArea[a] = (p.byArea[a] || 0) + t;
    }
    return map;
  }, [filtered]);

  const closedIds = [...closed].sort();
  const yearIds = closedIds.filter((id) => id.startsWith(`${year}-`) && byPeriod[id]);
  const lastId = yearIds[yearIds.length - 1];
  const prevId = lastId ? closedIds.filter((id) => id < lastId && byPeriod[id]).pop() : null;
  const last = byPeriod[lastId] || { total: 0, people: new Set(), capex: 0, byArea: {} };
  const prev = byPeriod[prevId];
  const lastMonth = lastId ? +lastId.slice(5) : 0;

  const ytd = yearIds.reduce((s, id) => s + byPeriod[id].total, 0);
  const ytdCapex = yearIds.reduce((s, id) => s + byPeriod[id].capex, 0);
  const prevYtdIds = closedIds.filter((id) => id.startsWith(`${year - 1}-`) && +id.slice(5) <= lastMonth && byPeriod[id]);
  const prevYtd = prevYtdIds.reduce((s, id) => s + byPeriod[id].total, 0);
  const avgHeadcount = yearIds.length ? yearIds.reduce((s, id) => s + byPeriod[id].people.size, 0) / yearIds.length : 0;

  // Hires and exits: first / last closed month each person appears in (within the filters).
  const movements = useMemo(() => {
    const first = {}, lastSeen = {}, names = {};
    for (const l of filtered) {
      const k = l.employee_id || l.name;
      names[k] = l.name;
      if (!first[k] || l.period_id < first[k]) first[k] = l.period_id;
      if (!lastSeen[k] || l.period_id > lastSeen[k]) lastSeen[k] = l.period_id;
    }
    const latestClosed = closedIds[closedIds.length - 1];
    const hires = [], exits = [];
    for (const k of Object.keys(first)) {
      if (first[k].startsWith(`${year}-`) && first[k] !== closedIds[0]) hires.push({ name: names[k], period: first[k] });
      if (lastSeen[k].startsWith(`${year}-`) && lastSeen[k] < latestClosed) exits.push({ name: names[k], period: lastSeen[k] });
    }
    const sort = (a, b) => a.period.localeCompare(b.period) || a.name.localeCompare(b.name);
    return { hires: hires.sort(sort), exits: exits.sort(sort) };
  }, [filtered, year, closedIds.join()]);

  const draft = periods.filter((p) => p.status === "draft").sort((a, b) => a.id.localeCompare(b.id))[0];
  const draftLines = draft ? lines.filter((l) => l.period_id === draft.id
    && (!area || (l.area || "Sin área") === area) && (!type || l.cost_type === type)) : [];
  const draftTotal = draftLines.reduce((s, l) => s + lineTotal(l), 0);

  const chartAreas = areas.filter((a) => yearIds.some((id) => byPeriod[id].byArea[a]));
  const chartData = Array.from({ length: 12 }, (_, i) => {
    const id = `${year}-${String(i + 1).padStart(2, "0")}`;
    const p = byPeriod[id];
    const row = { month: MONTHS[i], headcount: p ? p.people.size : null };
    for (const a of chartAreas) row[a] = p?.byArea[a] || 0;
    return row;
  });

  const areaRows = chartAreas.map((a) => {
    const ytdArea = yearIds.reduce((s, id) => s + (byPeriod[id].byArea[a] || 0), 0);
    const lastPeople = new Set(filtered.filter((l) => l.period_id === lastId && (l.area || "Sin área") === a).map((l) => l.employee_id || l.name)).size;
    const lastCost = last.byArea[a] || 0;
    return { area: a, people: lastPeople, lastCost, ytd: ytdArea, share: ytd ? ytdArea / ytd : 0, avg: lastPeople ? lastCost / lastPeople : 0 };
  }).sort((x, y) => y.ytd - x.ytd);

  const delta = (a, b) => (b ? (a - b) / b : null);
  const dMonth = prev ? delta(last.total, prev.total) : null;
  const dYear = prevYtd ? delta(ytd, prevYtd) : null;
  const isPrimaMonth = [6, 12].includes(lastMonth);

  if (!years.length) return <div className="board-empty-state">Aún no hay nóminas cerradas.</div>;

  return (
    <div className="people-reports">
      <Filters years={years} year={year} setYear={setYear} areas={areas} area={area} setArea={setArea} type={type} setType={setType} />

      <div className="people-kpi-grid">
        <Kpi label={`Nómina ${lastId ? periodLabel({ year, month: lastMonth }) : ""}`} value={usd(last.total)}
          sub={dMonth == null ? "Último mes cerrado" : `${dMonth >= 0 ? "▲" : "▼"} ${pct(Math.abs(dMonth))} vs mes anterior${isPrimaMonth ? " (incluye prima)" : ""}`}
          tone={dMonth == null ? null : dMonth > 0 ? "up" : "down"} />
        <Kpi label="Headcount" value={last.people.size}
          sub={`${movements.hires.length} ingresos · ${movements.exits.length} salidas en ${year}`} />
        <Kpi label={`Costo acumulado ${year}`} value={usd(ytd)}
          sub={dYear == null ? `${yearIds.length} meses cerrados` : `${dYear >= 0 ? "▲" : "▼"} ${pct(Math.abs(dYear))} vs mismo periodo ${year - 1}`}
          tone={dYear == null ? null : dYear > 0 ? "up" : "down"} />
        <Kpi label="Costo promedio por persona" value={usd(last.people.size ? last.total / last.people.size : 0)} sub="Último mes cerrado" />
        <Kpi label="Run-rate anual" value={usd(last.total * 12)} sub={isPrimaMonth ? "Último mes × 12 (mes con prima)" : "Último mes × 12"} />
        <Kpi label="CAPEX" value={pct(ytd ? ytdCapex / ytd : NaN)} sub={`${usd(ytdCapex)} capitalizable en ${year}`} />
        <Kpi label="Rotación" value={pct(avgHeadcount ? movements.exits.length / avgHeadcount : NaN)}
          sub={`Salidas / headcount promedio (${avgHeadcount.toFixed(1)})`} />
        {draft && (
          <Kpi label={`Próxima nómina · ${periodLabel(draft)}`} value={usd(draftTotal)}
            sub={`${draftLines.length} personas · borrador${last.total ? ` · ${draftTotal >= last.total ? "▲" : "▼"} ${pct(Math.abs(delta(draftTotal, last.total)))}` : ""}`} />
        )}
      </div>

      <div className="people-chart-grid">
        <section className="people-card">
          <h3>Nómina mensual por área · {year}</h3>
          <div className="people-chart">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="22%">
                <CartesianGrid vertical={false} stroke="#eef1f5" />
                <XAxis dataKey="month" tickLine={false} axisLine={{ stroke: "#dce3ed" }} tick={{ fill: "#647084", fontSize: 11 }} />
                <YAxis tickFormatter={usdK} tickLine={false} axisLine={false} tick={{ fill: "#647084", fontSize: 11 }} width={52} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "#f4f7fc" }} />
                <Legend iconType="square" iconSize={9} wrapperStyle={{ fontSize: 11 }} formatter={(value) => <span style={{ color: "#40516a" }}>{value}</span>} />
                {chartAreas.map((a, i) => (
                  <Bar key={a} dataKey={a} name={a} stackId="cost" fill={areaColor(a)} stroke="#fff" strokeWidth={1}
                    radius={i === chartAreas.length - 1 ? [4, 4, 0, 0] : 0} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
        <section className="people-card">
          <h3>Headcount · {year}</h3>
          <div className="people-chart">
            <ResponsiveContainer width="100%" height={280}>
              <LineChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#eef1f5" />
                <XAxis dataKey="month" tickLine={false} axisLine={{ stroke: "#dce3ed" }} tick={{ fill: "#647084", fontSize: 11 }} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fill: "#647084", fontSize: 11 }} width={32} />
                <Tooltip content={<ChartTooltip formatter={(v) => `${v} personas`} />} cursor={{ stroke: "#c9d2df" }} />
                <Line type="monotone" dataKey="headcount" name="Personas" stroke="#2a78d6" strokeWidth={2}
                  dot={{ r: 4, fill: "#2a78d6", stroke: "#fff", strokeWidth: 2 }} activeDot={{ r: 5 }} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <section className="people-card">
        <h3>Por área</h3>
        <div className="people-table-wrap">
          <table className="people-table">
            <thead>
              <tr><th>Área</th><th className="num">Personas</th><th className="num">Último mes</th><th className="num">Promedio / persona</th><th className="num">Acumulado {year}</th><th className="num">% del total</th></tr>
            </thead>
            <tbody>
              {areaRows.map((r) => (
                <tr key={r.area}>
                  <td><span className="people-swatch" style={{ background: areaColor(r.area) }} />{r.area}</td>
                  <td className="num">{r.people}</td>
                  <td className="num">{usd(r.lastCost)}</td>
                  <td className="num">{usd(r.avg)}</td>
                  <td className="num">{usd(r.ytd)}</td>
                  <td className="num">{pct(r.share)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><td>Total</td><td className="num">{last.people.size}</td><td className="num">{usd(last.total)}</td>
                <td className="num">{usd(last.people.size ? last.total / last.people.size : 0)}</td><td className="num">{usd(ytd)}</td><td className="num">100%</td></tr>
            </tfoot>
          </table>
        </div>
      </section>

      <div className="people-chart-grid">
        {[["Ingresos", movements.hires], ["Salidas", movements.exits]].map(([title, list]) => (
          <section key={title} className="people-card">
            <h3>{title} · {year} <span className="people-muted">({list.length})</span></h3>
            {list.length ? (
              <ul className="people-movements">
                {list.map((m) => <li key={m.name + m.period}><span>{m.name}</span><span className="people-muted">{MONTH_NAMES[+m.period.slice(5) - 1]}</span></li>)}
              </ul>
            ) : <div className="people-muted">Sin {title.toLowerCase()} con los filtros actuales.</div>}
          </section>
        ))}
      </div>
      <p className="admin-note">
        Basado en nóminas cerradas. Ingreso = primer mes en nómina; salida = último mes en nómina antes del último cierre.
        Los meses importados del Excel solo traen el total pagado por persona.
      </p>
    </div>
  );
}

/* ============================ Payroll mensual ============================ */

function MonthlyPayrollView({ periods, lines }) {
  const statusById = Object.fromEntries(periods.map((p) => [p.id, p.status]));
  const years = [...new Set(periods.map((p) => p.year))].sort((a, b) => b - a);
  const [year, setYear] = useState(years[0]);
  const [area, setArea] = useState("");
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const [grouped, setGrouped] = useState(false);
  const areas = useMemo(() => [...new Set(lines.map((l) => l.area || "Sin área"))].sort(), [lines]);

  const rows = useMemo(() => {
    const map = {};
    for (const l of lines) {
      if (!l.period_id.startsWith(`${year}-`)) continue;
      if (area && (l.area || "Sin área") !== area) continue;
      if (type && l.cost_type !== type) continue;
      if (search && !l.name.toLowerCase().includes(search.toLowerCase())) continue;
      const k = l.employee_id || l.name;
      const r = (map[k] ||= { name: l.name, area: l.area || "Sin área", type: l.cost_type, months: Array(12).fill(null), total: 0 });
      const m = +l.period_id.slice(5) - 1;
      const t = lineTotal(l);
      r.months[m] = (r.months[m] || 0) + t;
      r.total += t;
      r.area = l.area || r.area; r.type = l.cost_type || r.type;
    }
    return Object.values(map).sort((a, b) => (grouped ? a.area.localeCompare(b.area) : 0) || a.name.localeCompare(b.name));
  }, [lines, year, area, type, search, grouped]);

  const monthTotals = Array.from({ length: 12 }, (_, m) => rows.reduce((s, r) => s + (r.months[m] || 0), 0));
  const grand = monthTotals.reduce((s, v) => s + v, 0);
  const monthStatus = Array.from({ length: 12 }, (_, m) => statusById[`${year}-${String(m + 1).padStart(2, "0")}`]);

  const exportCsv = () => downloadCsv(`payroll-${year}${area ? `-${area}` : ""}.csv`, [
    ["Persona", "Área", "Tipo", ...MONTHS, "Total"],
    ...rows.map((r) => [r.name, r.area, r.type, ...r.months.map((v) => (v == null ? "" : v.toFixed(2))), r.total.toFixed(2)]),
    ["Total", "", "", ...monthTotals.map((v) => v.toFixed(2)), grand.toFixed(2)],
  ]);

  const body = [];
  let currentArea = null;
  for (const r of rows) {
    if (grouped && r.area !== currentArea) {
      currentArea = r.area;
      const group = rows.filter((x) => x.area === r.area);
      body.push(
        <tr key={`g-${r.area}`} className="people-group-row">
          <td colSpan={2}><span className="people-swatch" style={{ background: areaColor(r.area) }} />{r.area} <span className="people-muted">({group.length})</span></td>
          {Array.from({ length: 12 }, (_, m) => <td key={m} className="num">{usd(group.reduce((s, x) => s + (x.months[m] || 0), 0))}</td>)}
          <td className="num">{usd(group.reduce((s, x) => s + x.total, 0))}</td>
        </tr>,
      );
    }
    body.push(
      <tr key={r.name}>
        <td className="people-sticky">{r.name}</td>
        <td>{grouped ? <span className="people-muted">{r.type}</span> : <>{r.area} <span className="people-muted">· {r.type}</span></>}</td>
        {r.months.map((v, m) => <td key={m} className={`num${monthStatus[m] === "draft" ? " is-draft" : ""}`}>{v == null ? "" : usd(v)}</td>)}
        <td className="num"><b>{usd(r.total)}</b></td>
      </tr>,
    );
  }

  return (
    <div>
      <Filters years={years} year={year} setYear={setYear} areas={areas} area={area} setArea={setArea} type={type} setType={setType}>
        <label className="people-search">Buscar
          <input type="search" placeholder="Nombre" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="admin-checkbox people-inline-check">
          <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} /> Agrupar por área
        </label>
        <button className="people-secondary-button" onClick={exportCsv}>Descargar CSV</button>
      </Filters>
      <div className="people-table-wrap is-wide">
        <table className="people-table people-pivot">
          <thead>
            <tr>
              <th className="people-sticky">Persona</th><th>{grouped ? "Tipo" : "Área · Tipo"}</th>
              {MONTHS.map((m, i) => <th key={m} className="num">{m}{monthStatus[i] === "draft" && <span className="people-draft-tag">borrador</span>}</th>)}
              <th className="num">Total {year}</th>
            </tr>
          </thead>
          <tbody>{body.length ? body : <tr><td colSpan={15} className="admin-empty">No hay datos con estos filtros.</td></tr>}</tbody>
          <tfoot>
            <tr>
              <td className="people-sticky">Total ({rows.length} personas)</td><td />
              {monthTotals.map((v, m) => <td key={m} className="num">{v ? usd(v) : ""}</td>)}
              <td className="num">{usd(grand)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="admin-note">Los meses en cursiva son la nómina en borrador (aún no cerrada).</p>
    </div>
  );
}

/* ============================ Cálculo de nómina ============================ */

function NumberCell({ value, onCommit, disabled, step = "0.01", width = 78 }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => { setText(value ?? ""); }, [value]);
  const commit = () => {
    const next = text === "" ? 0 : Number(text);
    if (!Number.isFinite(next)) { setText(value ?? ""); return; }
    if (next !== num(value)) onCommit(next);
  };
  return (
    <input className="people-cell-input" type="number" step={step} value={text} disabled={disabled} style={{ width }}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setText(value ?? ""); e.currentTarget.blur(); } }} />
  );
}

function AdjustmentsEditor({ line, period, editable, onSave, onClose }) {
  const [items, setItems] = useState(() => (line.adjustments || []).map((a) => ({ ...a })));
  const [error, setError] = useState(null);
  const fx = num(period.fx_rate);
  const toUsd = (a) => {
    const t = ADJ_TYPES.find((x) => x.id === a.type) || ADJ_TYPES[ADJ_TYPES.length - 1];
    const amount = num(a.amount);
    const base = a.currency === "COP" ? (fx ? amount / fx : NaN) : amount;
    const signed = t.sign === 0 ? base : t.sign * Math.abs(base);
    return Math.round(signed * 100) / 100;
  };
  const set = (i, patch) => setItems((list) => list.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const total = items.reduce((s, a) => s + (Number.isFinite(toUsd(a)) ? toUsd(a) : 0), 0);

  const save = () => {
    if (items.some((a) => a.currency === "COP") && !fx) return setError("Define la TRM de la nómina para convertir novedades en COP.");
    if (items.some((a) => !num(a.amount))) return setError("Cada novedad necesita un monto.");
    onSave(items.map((a) => ({ id: a.id || crypto.randomUUID(), type: a.type, amount: num(a.amount), currency: a.currency, usd: toUsd(a), note: (a.note || "").slice(0, 200) })));
  };

  return (
    <div className="people-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="people-modal" role="dialog" aria-label={`Novedades de ${line.name}`}>
        <div className="admin-form-header">
          <h2>Novedades · {line.name}</h2>
          <button className="admin-link-button" onClick={onClose}>Cerrar</button>
        </div>
        <p className="admin-note">Bonos, comisiones y reembolsos suman; deducciones y prepagada restan. En COP se convierten con la TRM de la nómina ({fx ? fx.toLocaleString("es-CO") : "sin definir"}).</p>
        <table className="people-table people-adjustments">
          <thead><tr><th>Tipo</th><th className="num">Monto</th><th>Moneda</th><th>Nota</th><th className="num">USD</th><th /></tr></thead>
          <tbody>
            {items.map((a, i) => (
              <tr key={a.id || i}>
                <td><select value={a.type} disabled={!editable} onChange={(e) => set(i, { type: e.target.value })}>{ADJ_TYPES.map((t) => <option key={t.id}>{t.id}</option>)}</select></td>
                <td className="num"><input className="people-cell-input" type="number" step="0.01" value={a.amount} disabled={!editable} onChange={(e) => set(i, { amount: e.target.value })} style={{ width: 110 }} /></td>
                <td><select value={a.currency} disabled={!editable} onChange={(e) => set(i, { currency: e.target.value })}><option>USD</option><option>COP</option></select></td>
                <td><input className="people-cell-input" value={a.note || ""} disabled={!editable} maxLength={200} onChange={(e) => set(i, { note: e.target.value })} style={{ width: "100%" }} /></td>
                <td className="num">{Number.isFinite(toUsd(a)) ? usd(toUsd(a), 2) : "—"}</td>
                <td>{editable && <button className="admin-link-button is-danger" onClick={() => setItems((list) => list.filter((_, j) => j !== i))}>Quitar</button>}</td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={6} className="admin-empty">Sin novedades.</td></tr>}
          </tbody>
          <tfoot><tr><td colSpan={4}>Total novedades</td><td className="num">{usd(total, 2)}</td><td /></tr></tfoot>
        </table>
        {error && <div className="board-doc-error" role="alert">{error}</div>}
        {editable && (
          <div className="people-modal-actions">
            <button className="people-secondary-button" onClick={() => setItems((list) => [...list, { type: "Bono", amount: "", currency: "USD", note: "" }])}>+ Agregar novedad</button>
            <button className="admin-primary-button" onClick={save}>Guardar novedades</button>
          </div>
        )}
      </div>
    </div>
  );
}

function AddPersonModal({ period, employees, lines, areas, onAdd, onClose }) {
  const inPeriod = new Set(lines.filter((l) => l.period_id === period.id).map((l) => l.employee_id));
  const candidates = employees.filter((e) => !inPeriod.has(e.id)).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const [mode, setMode] = useState("new");
  const [existingId, setExistingId] = useState("");
  const [form, setForm] = useState({ name: "", area: "", cost_type: "OPEX", role_title: "", start_date: "", base_salary: "", allowance: 60 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (mode === "existing" && !existingId) return setError("Elige una persona.");
    if (mode === "new") {
      if (!form.name.trim()) return setError("Escribe el nombre.");
      if (employees.some((x) => x.name.toLowerCase() === form.name.trim().toLowerCase())) return setError("Ya existe una persona con ese nombre; agrégala desde 'Persona existente'.");
      if (!(num(form.base_salary) > 0)) return setError("El salario base debe ser mayor a 0.");
    }
    setBusy(true);
    try { await onAdd(mode === "existing" ? { existingId } : { employee: { ...form, name: form.name.trim(), base_salary: num(form.base_salary), allowance: num(form.allowance), start_date: form.start_date || null } }); }
    catch (err) { setError(err.message || "No se pudo agregar."); setBusy(false); }
  };

  return (
    <div className="people-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="people-modal" role="dialog" aria-label="Agregar persona" onSubmit={submit}>
        <div className="admin-form-header">
          <h2>Agregar persona · {periodLabel(period)}</h2>
          <button type="button" className="admin-link-button" onClick={onClose}>Cancelar</button>
        </div>
        <div className="people-segmented">
          <button type="button" className={mode === "new" ? "is-active" : ""} onClick={() => setMode("new")}>Nueva persona</button>
          <button type="button" className={mode === "existing" ? "is-active" : ""} onClick={() => setMode("existing")}>Persona existente</button>
        </div>
        {mode === "existing" ? (
          <label className="admin-field"><span>Persona</span>
            <select value={existingId} onChange={(e) => setExistingId(e.target.value)}>
              <option value="">Elegir…</option>
              {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}{c.active ? "" : " (inactiva)"} · {c.area || "Sin área"}</option>)}
            </select>
          </label>
        ) : (
          <div className="admin-form-grid">
            <label className="admin-field"><span>Nombre</span><input value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} /></label>
            <label className="admin-field"><span>Cargo</span><input value={form.role_title} maxLength={120} onChange={(e) => set("role_title", e.target.value)} /></label>
            <label className="admin-field"><span>Área</span>
              <input list="people-areas" value={form.area} maxLength={60} onChange={(e) => set("area", e.target.value)} />
              <datalist id="people-areas">{areas.map((a) => <option key={a} value={a} />)}</datalist>
            </label>
            <label className="admin-field"><span>Tipo</span>
              <select value={form.cost_type} onChange={(e) => set("cost_type", e.target.value)}><option>OPEX</option><option>CAPEX</option></select>
            </label>
            <label className="admin-field"><span>Fecha de ingreso</span><input type="date" value={form.start_date} onChange={(e) => set("start_date", e.target.value)} /></label>
            <label className="admin-field"><span>Salario base (USD)</span><input type="number" step="0.01" value={form.base_salary} onChange={(e) => set("base_salary", e.target.value)} /></label>
            <label className="admin-field"><span>Auxilio (USD)</span><input type="number" step="0.01" value={form.allowance} onChange={(e) => set("allowance", e.target.value)} /></label>
          </div>
        )}
        <p className="admin-note">Si la fecha de ingreso cae en este mes, los días se prorratean automáticamente (meses de 30 días). En junio y diciembre se sugiere la prima.</p>
        {error && <div className="board-doc-error" role="alert">{error}</div>}
        <div className="people-modal-actions"><button className="admin-primary-button" disabled={busy}>{busy ? "Agregando…" : "Agregar a la nómina"}</button></div>
      </form>
    </div>
  );
}

const EXIT_TYPES = {
  voluntario: { label: "Retiro voluntario", hint: "La persona renuncia. Solo se paga la nómina del mes hasta el día que trabajó." },
  involuntario: { label: "Retiro involuntario", hint: "La empresa retira a la persona. Se paga el mes hasta el día trabajado más el plan de retiro (liquidación)." },
};

/**
 * Exit of a person. First asks how they left: voluntary (resignation: only the days worked are
 * paid) or involuntary (the company ends it: days worked + settlement per salary period). The
 * person stays in this month's payroll, highlighted in red, and is excluded from later payrolls.
 */
function ExitModal({ line, period, employee, lines, canEdit, onRegister, onUndo, onRemoveOnly, onClose }) {
  const existing = line.liquidation;
  const defaultExit = line.exit_date || (period.pay_date && period.pay_date.slice(0, 7) === period.id ? period.pay_date : `${period.id}-28`);
  const [exitType, setExitType] = useState(line.exit_type || (line.exit_date ? (existing ? "involuntario" : "voluntario") : null));
  const [exitDate, setExitDate] = useState(defaultExit);
  const [days, setDays] = useState(line.exit_date ? num(line.days) : exitMonthDays(period, defaultExit, num(line.days)));
  const [segments, setSegments] = useState(() => existing?.segments?.map((x) => ({ ...x }))
    || buildLiquidationSegments(employee || { id: line.employee_id }, lines, defaultExit, line.base_salary));
  const [note, setNote] = useState(existing?.note || line.exit_note || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const readOnly = !canEdit;
  const involuntary = exitType === "involuntario";

  const changeExit = (value) => {
    setExitDate(value);
    if (!value) return;
    setDays(exitMonthDays(period, value, num(line.days)));
    setSegments((list) => list.map((x, i) => (i === list.length - 1 ? { ...x, to: value } : x)));
  };
  const setSeg = (i, patch) => setSegments((list) => list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const rows = segments.map((x) => ({ ...x, days: Math.max(0, daysBetween(x.from, x.to)), amount: segmentAmount(x) }));
  const liquidationTotal = involuntary ? Math.round(rows.reduce((t, x) => t + x.amount, 0) * 100) / 100 : 0;
  const monthPay = Math.round((num(line.base_salary) + num(line.allowance)) / 30 * num(days) * 100) / 100;
  const lineTotalPreview = monthPay + num(line.prima) + num(line.platform_fee) + adjustmentsTotal(line) + liquidationTotal;

  const submit = async () => {
    setError(null);
    if (!exitType) return setError("Indica cómo salió la persona.");
    if (!exitDate) return setError("Indica la fecha de salida.");
    if (involuntary && rows.some((x) => !x.from || !x.to || x.to < x.from)) return setError("Revisa las fechas de los tramos.");
    setBusy(true);
    try {
      await onRegister({
        exitType,
        exitDate,
        days: Math.max(0, Math.min(30, num(days))),
        liquidation: involuntary
          ? { segments: rows, total: liquidationTotal, note: note.slice(0, 300), calculated_at: new Date().toISOString() }
          : null,
      });
    } catch (err) { setError(err.message || "No se pudo registrar la salida."); setBusy(false); }
  };

  return (
    <div className="people-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="people-modal" role="dialog" aria-label={`Salida de ${line.name}`}>
        <div className="admin-form-header">
          <h2>Salida · {line.name}</h2>
          <button className="admin-link-button" onClick={onClose}>Cerrar</button>
        </div>

        <fieldset className="admin-fieldset">
          <legend>¿Cómo salió la persona?</legend>
          <div className="admin-role-options">
            {Object.entries(EXIT_TYPES).map(([id, t]) => (
              <label key={id} className={`admin-role-option${exitType === id ? " is-selected" : ""}`}>
                <input type="radio" name="exit-type" value={id} checked={exitType === id} disabled={readOnly} onChange={() => setExitType(id)} />
                <span className="admin-role-name">{t.label}</span>
                <span className="admin-role-description">{t.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {exitType && (
          <>
            <div className="admin-form-grid">
              <label className="admin-field"><span>Fecha de salida</span><input type="date" value={exitDate} disabled={readOnly} onChange={(e) => changeExit(e.target.value)} /></label>
              <label className="admin-field"><span>Días trabajados en {MONTH_NAMES[period.month - 1].toLowerCase()}</span><input type="number" min="0" max="30" step="0.5" value={days} disabled={readOnly} onChange={(e) => setDays(e.target.value)} /></label>
              <label className="admin-field"><span>Ingreso</span><input type="date" value={employee?.start_date || ""} disabled /></label>
            </div>

            {involuntary && (
              <>
                <p className="admin-note">
                  Plan de retiro = salario ÷ 365 × días de cada tramo de salario desde el ingreso, igual que la hoja de liquidaciones del Excel. Los tramos se arman con el historial de salario y se pueden ajustar.
                </p>
                <table className="people-table people-adjustments">
                  <thead><tr><th>Desde</th><th>Hasta</th><th className="num">Salario</th><th className="num">Días</th><th className="num">Valor</th><th /></tr></thead>
                  <tbody>
                    {rows.map((x, i) => (
                      <tr key={i}>
                        <td><input className="people-cell-input" type="date" value={x.from} disabled={readOnly} onChange={(e) => setSeg(i, { from: e.target.value })} /></td>
                        <td><input className="people-cell-input" type="date" value={x.to} disabled={readOnly} onChange={(e) => setSeg(i, { to: e.target.value })} /></td>
                        <td className="num"><input className="people-cell-input" type="number" step="0.01" value={x.salary} disabled={readOnly} style={{ width: 96 }} onChange={(e) => setSeg(i, { salary: e.target.value })} /></td>
                        <td className="num">{x.days}</td>
                        <td className="num">{usd(x.amount, 2)}</td>
                        <td>{!readOnly && rows.length > 1 && <button className="admin-link-button is-danger" onClick={() => setSegments((list) => list.filter((_, j) => j !== i))}>Quitar</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan={4}>Plan de retiro (liquidación)</td><td className="num">{usd(liquidationTotal, 2)}</td><td /></tr></tfoot>
                </table>
                {!readOnly && (
                  <button className="people-secondary-button people-align-start" onClick={() => setSegments((list) => [...list, { from: exitDate, to: exitDate, salary: list[list.length - 1]?.salary || 0 }])}>+ Agregar tramo</button>
                )}
              </>
            )}

            <label className="admin-field"><span>Nota</span><input value={note} maxLength={300} disabled={readOnly} onChange={(e) => setNote(e.target.value)} placeholder={involuntary ? "Motivo, acuerdos, pagos adicionales…" : "Fecha de la carta de renuncia, observaciones…"} /></label>

            <div className="people-exit-summary">
              <div><span>Pago del mes ({num(days)} días)</span><b>{usd(monthPay, 2)}</b></div>
              {involuntary && <div><span>Plan de retiro</span><b>{usd(liquidationTotal, 2)}</b></div>}
              <div className="is-total"><span>Total de la línea (con prima, comisión y novedades)</span><b>{usd(lineTotalPreview, 2)}</b></div>
            </div>
          </>
        )}

        {error && <div className="board-doc-error" role="alert">{error}</div>}
        {!readOnly && (
          <div className="people-modal-actions is-split">
            <div>
              {line.exit_date
                ? <button className="admin-link-button" disabled={busy} onClick={async () => { setBusy(true); await onUndo(); }}>Deshacer salida</button>
                : <button className="admin-link-button is-danger" disabled={busy} onClick={async () => { if (window.confirm(`¿Quitar a ${line.name} de esta nómina sin registrar salida (por ejemplo, si se agregó por error)?`)) { setBusy(true); await onRemoveOnly(); } }}>Quitar sin registrar salida (error de carga)</button>}
            </div>
            <button className="people-danger-button is-solid" disabled={busy || !exitType} onClick={submit}>
              {busy ? "Guardando…" : line.exit_date ? "Actualizar salida" : involuntary ? "Registrar retiro y liquidación" : "Registrar renuncia"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PayrollCalcView({ periods, lines, employees, photos, editable, patchLocal, reload }) {
  const member = useMember();
  const sortedPeriods = [...periods].sort((a, b) => b.id.localeCompare(a.id));
  const firstDraft = [...periods].filter((p) => p.status === "draft").sort((a, b) => a.id.localeCompare(b.id))[0];
  const [periodId, setPeriodId] = useState(firstDraft?.id || sortedPeriods[0]?.id);
  const [search, setSearch] = useState("");
  const [adjFor, setAdjFor] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const savingRef = useRef(0);
  const [saving, setSaving] = useState(false);

  const period = periods.find((p) => p.id === periodId);
  const canEdit = editable && period?.status === "draft";
  const periodLines = lines.filter((l) => l.period_id === periodId)
    .filter((l) => !search || l.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const allPeriodLines = lines.filter((l) => l.period_id === periodId);
  const areas = [...new Set([...lines.map((l) => l.area), ...employees.map((e) => e.area)].filter(Boolean))].sort();
  const prevPeriod = [...periods].filter((p) => p.id < periodId).sort((a, b) => b.id.localeCompare(a.id))[0];
  const prevTotal = prevPeriod ? lines.filter((l) => l.period_id === prevPeriod.id).reduce((s, l) => s + lineTotal(l), 0) : 0;
  const total = allPeriodLines.reduce((s, l) => s + lineTotal(l), 0);
  const adjTotal = allPeriodLines.reduce((s, l) => s + adjustmentsTotal(l), 0);
  const primaTotal = allPeriodLines.reduce((s, l) => s + num(l.prima), 0);
  const detailed = allPeriodLines.some((l) => l.source === "app");

  const track = async (fn) => {
    savingRef.current += 1; setSaving(true); setError(null);
    try { return await fn(); }
    catch (err) { setError(err.message || "No se pudo guardar."); await reload(); return null; }
    finally { savingRef.current -= 1; if (!savingRef.current) setSaving(false); }
  };

  const EMPLOYEE_FIELDS = ["base_salary", "allowance", "area", "cost_type", "role_title"];
  const updateLine = (line, patch) => track(async () => {
    patchLocal((d) => ({ lines: d.lines.map((l) => (l.id === line.id ? { ...l, ...patch } : l)) }));
    const { data, error: err } = await supabase.from("payroll_lines").update(patch).eq("id", line.id).select().single();
    if (err) throw err;
    patchLocal((d) => ({ lines: d.lines.map((l) => (l.id === line.id ? data : l)) }));
    const empPatch = Object.fromEntries(Object.entries(patch).filter(([k]) => EMPLOYEE_FIELDS.includes(k)));
    if (line.employee_id && Object.keys(empPatch).length) {
      const { error: e2 } = await supabase.from("people_employees").update(empPatch).eq("id", line.employee_id);
      if (e2) throw e2;
      patchLocal((d) => ({ employees: d.employees.map((e) => (e.id === line.employee_id ? { ...e, ...empPatch } : e)) }));
    }
    return true;
  });

  const updatePeriod = (patch) => track(async () => {
    const { data, error: err } = await supabase.from("payroll_periods").update(patch).eq("id", period.id).select().single();
    if (err) throw err;
    patchLocal((d) => ({ periods: d.periods.map((p) => (p.id === period.id ? data : p)) }));
  });

  const addPerson = async ({ existingId, employee }) => {
    let emp = employees.find((e) => e.id === existingId);
    if (!emp) {
      const { data, error: err } = await supabase.from("people_employees").insert({ ...employee, active: true }).select().single();
      if (err) throw err;
      emp = data;
    } else if (!emp.active) {
      const { data, error: err } = await supabase.from("people_employees").update({ active: true, end_date: null }).eq("id", emp.id).select().single();
      if (err) throw err;
      emp = data;
    }
    const { data: line, error: err } = await supabase.from("payroll_lines").insert({
      period_id: period.id, employee_id: emp.id, name: emp.name, area: emp.area, cost_type: emp.cost_type, role_title: emp.role_title,
      base_salary: emp.base_salary, allowance: emp.allowance, days: suggestedDays(period, emp.start_date),
      prima: suggestedPrima(period, emp), platform_fee: period.platform_fee, adjustments: [], source: "app",
    }).select().single();
    if (err) throw err;
    patchLocal((d) => ({ lines: [...d.lines, line], employees: d.employees.some((e) => e.id === emp.id) ? d.employees.map((e) => (e.id === emp.id ? emp : e)) : [...d.employees, emp] }));
    setAdding(false);
  };

  const setEmployeeStatus = async (employeeId, patch) => {
    if (!employeeId) return;
    const { error: err } = await supabase.from("people_employees").update(patch).eq("id", employeeId);
    if (err) throw err;
    patchLocal((d) => ({ employees: d.employees.map((e) => (e.id === employeeId ? { ...e, ...patch } : e)) }));
  };

  // Retiro: the line stays in this payroll (red) with the days worked plus the settlement.
  const registerExit = async (line, { exitType, exitDate, days, liquidation }) => {
    if (!(await updateLine(line, { exit_type: exitType, exit_date: exitDate, days, liquidation }))) return;
    await track(() => setEmployeeStatus(line.employee_id, { active: false, end_date: exitDate }));
    setRemoving(null);
  };

  const undoExit = async (line) => {
    if (!(await updateLine(line, { exit_type: null, exit_date: null, liquidation: null, days: 30 }))) return;
    await track(() => setEmployeeStatus(line.employee_id, { active: true, end_date: null }));
    setRemoving(null);
  };

  const removeOnly = (line) => track(async () => {
    const { error: err } = await supabase.from("payroll_lines").delete().eq("id", line.id);
    if (err) throw err;
    patchLocal((d) => ({ lines: d.lines.filter((l) => l.id !== line.id) }));
    setRemoving(null);
  });

  const exportDeel = () => {
    const today = new Date().toISOString().slice(0, 10);
    const { rows, missing } = buildDeelRows(period, allPeriodLines, employees, today);
    if (missing.length && !window.confirm(`Estas personas tienen novedades o liquidación pero no tienen contrato de Deel, así que no van en el archivo:\n\n${missing.join("\n")}\n\n¿Generar el archivo igual?`)) return;
    downloadCsv(`bulk_advanced_${today}.csv`, [DEEL_HEADER, ...rows]);
  };

  const closePayroll = async () => {
    if (!window.confirm(`¿Cerrar la nómina de ${periodLabel(period)} por ${usd(total, 2)}?\n\nQuedará bloqueada y se creará el borrador del mes siguiente con las personas activas.`)) return;
    setBusy(true); setError(null);
    const { data, error: err } = await supabase.rpc("payroll_close_period", { period: period.id });
    if (err) setError(err.message); else { await reload(); setPeriodId(data); }
    setBusy(false);
  };

  const reopen = async () => {
    if (!window.confirm(`¿Reabrir la nómina de ${periodLabel(period)}? Volverá a ser editable.`)) return;
    await updatePeriod({ status: "draft" });
  };

  if (!period) return <div className="board-empty-state">No hay nóminas.</div>;

  return (
    <div className="people-calc">
      <div className="people-calc-header">
        <label className="people-period-select">Nómina
          <select value={periodId} onChange={(e) => { setPeriodId(e.target.value); setSearch(""); }}>
            {sortedPeriods.map((p) => <option key={p.id} value={p.id}>{periodLabel(p)}{p.status === "draft" ? " · borrador" : ""}</option>)}
          </select>
        </label>
        <span className={`people-status is-${period.status}`}>{period.status === "draft" ? "Borrador" : "Cerrada"}</span>
        <label>Fecha de pago
          <input type="date" value={period.pay_date || ""} disabled={!canEdit} onChange={(e) => updatePeriod({ pay_date: e.target.value || null })} />
        </label>
        <label>TRM (COP/USD)
          <NumberCell value={period.fx_rate} disabled={!canEdit} step="1" width={100} onCommit={(v) => updatePeriod({ fx_rate: v || null })} />
        </label>
        <div className="people-calc-actions">
          {saving && <span className="people-muted">Guardando…</span>}
          {canEdit && <button className="people-secondary-button" onClick={() => setAdding(true)}>+ Agregar persona</button>}
          {allPeriodLines.some((l) => l.source === "app") && <button className="people-secondary-button" onClick={exportDeel} title="Archivo de ajustes masivos (bulk_advanced) para cargar en Deel">Archivo Deel</button>}
          {canEdit && <button className="admin-primary-button" disabled={busy || !allPeriodLines.length} onClick={closePayroll}>Cerrar nómina</button>}
          {period.status === "closed" && isSuperAdmin(member) && <button className="people-secondary-button" onClick={reopen}>Reabrir</button>}
        </div>
      </div>

      <div className="people-kpi-grid is-compact">
        <Kpi label="Total a pagar" value={usd(total, 2)} sub={prevPeriod ? `${total >= prevTotal ? "▲" : "▼"} ${usd(Math.abs(total - prevTotal), 2)} vs ${periodLabel(prevPeriod)}` : null} />
        <Kpi label="Personas" value={allPeriodLines.length} />
        <Kpi label="Novedades" value={usd(adjTotal, 2)} sub={`${allPeriodLines.filter((l) => l.adjustments?.length).length} personas con novedades`} />
        {allPeriodLines.some((l) => l.exit_date) && (
          <Kpi label="Salidas" value={allPeriodLines.filter((l) => l.exit_date).length}
            sub={`${allPeriodLines.filter((l) => l.exit_type === "voluntario").length} renuncias · liquidaciones ${usd(allPeriodLines.reduce((t, l) => t + num(l.liquidation?.total), 0), 2)}`} tone="up" />
        )}
        {[6, 12].includes(period.month) && <Kpi label="Prima" value={usd(primaTotal, 2)} sub="Salario × días del semestre / 180" />}
      </div>

      {error && <div className="board-doc-error" role="alert">{error}</div>}

      <div className="people-toolbar">
        <input className="admin-search" type="search" placeholder="Buscar persona" value={search} onChange={(e) => setSearch(e.target.value)} />
        {!detailed && <span className="people-muted">Nómina importada del Excel: solo incluye el total por persona.</span>}
      </div>

      <div className="people-table-wrap is-wide">
        <table className="people-table people-calc-table">
          <thead>
            <tr>
              <th className="people-sticky">Persona</th><th>Área</th><th>Tipo</th>
              <th className="num">Salario base</th><th className="num">Auxilio</th><th className="num">Días</th>
              <th className="num">Prima</th><th className="num">Comisión</th><th className="num">Novedades</th><th className="num">Total</th><th />
            </tr>
          </thead>
          <tbody>
            {periodLines.map((l) => {
              const imported = l.source === "import";
              const off = !canEdit || imported;
              return (
                <tr key={l.id} className={l.exit_date ? "is-exit" : undefined}>
                  <td className="people-sticky">
                    <div className="people-calc-person">
                    <PersonAvatar employee={employees.find((e) => e.id === l.employee_id) || { name: l.name, area: l.area }} photos={photos} size="small" />
                    <div>
                    <div className="people-person">{l.name}</div>
                    {l.exit_date ? (
                      <button className="people-exit-badge" onClick={() => setRemoving(l)}>
                        {l.exit_type === "voluntario" ? "Renuncia" : "Retiro involuntario"} {new Date(`${l.exit_date}T00:00:00`).toLocaleDateString("es-CO", { day: "2-digit", month: "short" })}
                        {l.liquidation ? ` · Liquidación ${usd(num(l.liquidation.total), 2)}` : " · sin liquidación"}
                      </button>
                    ) : <div className="people-muted">{l.role_title}</div>}
                    </div>
                    </div>
                  </td>
                  <td>
                    {off ? (l.area || "—") : (
                      <select className="people-cell-select" value={l.area || ""} onChange={(e) => updateLine(l, { area: e.target.value })}>
                        {[...new Set([l.area, ...areas])].filter(Boolean).map((a) => <option key={a}>{a}</option>)}
                      </select>
                    )}
                  </td>
                  <td>
                    {off ? l.cost_type : (
                      <select className="people-cell-select" value={l.cost_type} onChange={(e) => updateLine(l, { cost_type: e.target.value })}>
                        <option>OPEX</option><option>CAPEX</option>
                      </select>
                    )}
                  </td>
                  {imported ? <td colSpan={6} className="people-muted">Importado del Excel</td> : <>
                    <td className="num"><NumberCell value={l.base_salary} disabled={off} onCommit={(v) => updateLine(l, { base_salary: v })} /></td>
                    <td className="num"><NumberCell value={l.allowance} disabled={off} width={54} onCommit={(v) => updateLine(l, { allowance: v })} /></td>
                    <td className="num"><NumberCell value={l.days} disabled={off} step="0.5" width={48} onCommit={(v) => updateLine(l, { days: Math.max(0, Math.min(31, v)) })} /></td>
                    <td className="num"><NumberCell value={l.prima} disabled={off} width={66} onCommit={(v) => updateLine(l, { prima: v })} /></td>
                    <td className="num"><NumberCell value={l.platform_fee} disabled={off} width={50} onCommit={(v) => updateLine(l, { platform_fee: v })} /></td>
                    <td className="num">
                      <button className={`people-adj-button${l.adjustments?.length ? " has-items" : ""}`} onClick={() => setAdjFor(l)}>
                        {l.adjustments?.length ? `${usd(adjustmentsTotal(l), 2)} (${l.adjustments.length})` : canEdit ? "+ Agregar" : "—"}
                      </button>
                    </td>
                  </>}
                  <td className="num"><b>{usd(lineTotal(l), 2)}</b></td>
                  <td>{canEdit && !l.exit_date && !imported && <button className="board-task-remove-file" title="Sacar de la nómina (renuncia o retiro)" aria-label={`Retirar a ${l.name}`} onClick={() => setRemoving(l)}>×</button>}</td>
                </tr>
              );
            })}
            {!periodLines.length && <tr><td colSpan={11} className="admin-empty">{search ? "Nadie coincide con la búsqueda." : "Esta nómina no tiene personas."}</td></tr>}
          </tbody>
          <tfoot>
            <tr><td className="people-sticky">Total</td><td colSpan={8} /><td className="num">{usd(total, 2)}</td><td /></tr>
          </tfoot>
        </table>
      </div>
      <p className="admin-note">
        Total = (salario base + auxilio) / 30 × días + prima + comisión de plataforma + novedades. Los cambios se guardan al salir de cada celda;
        el total lo recalcula la base de datos. Cambiar salario, auxilio, área, tipo o cargo actualiza también la ficha de la persona para las próximas nóminas.
      </p>

      {adjFor && (
        <AdjustmentsEditor line={adjFor} period={period} editable={canEdit} onClose={() => setAdjFor(null)}
          onSave={async (items) => { await updateLine(adjFor, { adjustments: items }); setAdjFor(null); }} />
      )}
      {adding && <AddPersonModal period={period} employees={employees} lines={lines} areas={areas} onAdd={addPerson} onClose={() => setAdding(false)} />}
      {removing && (
        <ExitModal line={removing} period={period} employee={employees.find((e) => e.id === removing.employee_id)} lines={lines} canEdit={canEdit}
          onClose={() => setRemoving(null)} onRegister={(data) => registerExit(removing, data)} onUndo={() => undoExit(removing)} onRemoveOnly={() => removeOnly(removing)} />
      )}
    </div>
  );
}

/* ============================ workspace ============================ */

const SECTIONS = [
  { id: "directory", label: "Directorio", icon: "◉", title: "Directorio de personas", text: "Ficha de cada persona: datos laborales, contacto, stock options e historial." },
  { id: "reports", label: "Reportes", icon: "▧", title: "Reportes de nómina", text: "KPIs, evolución mensual y distribución por área." },
  { id: "monthly", label: "Payroll mensual", icon: "☰", title: "Payroll mes a mes", text: "Pago por persona y mes, con filtros de año, área y tipo." },
  { id: "calc", label: "Cálculo de nómina", icon: "⊞", title: "Cálculo de nómina", text: "Prepara la próxima nómina: personas, días, prima y novedades." },
];

export default function PeopleWorkspace({ editable }) {
  const [section, setSection] = useState("directory");
  const data = usePeopleData();
  const current = SECTIONS.find((s) => s.id === section);

  return (
    <section className="board-workspace">
      <aside className="board-section-nav" aria-label="Secciones de People">
        <div className="board-section-nav-title">PEOPLE</div>
        {SECTIONS.map((s) => (
          <button key={s.id} className={`board-section-link${section === s.id ? " is-active" : ""}`} aria-current={section === s.id ? "page" : undefined} onClick={() => setSection(s.id)}>
            <span className="board-section-icon" aria-hidden="true">{s.icon}</span> {s.label}
          </button>
        ))}
      </aside>
      <div className="board-section-content">
        <div className="board-docs-heading">
          <div>
            <div className="board-eyebrow">PEOPLE · PAYROLL</div>
            <h1>{current.title}</h1>
            <p>{current.text}</p>
          </div>
          {!editable && <div className="board-doc-count">Solo lectura</div>}
        </div>
        {data.error && <div className="board-doc-error" role="alert">{data.error}</div>}
        {data.loading ? <div className="board-empty-state">Cargando…</div> : (
          <>
            {section === "directory" && <DirectoryView employees={data.employees} privates={data.privates} grants={data.grants} documents={data.documents} photos={data.photos} lines={data.lines} periods={data.periods} editable={editable} patchLocal={data.patchLocal} />}
            {section === "reports" && <ReportsView periods={data.periods} lines={data.lines} employees={data.employees} />}
            {section === "monthly" && <MonthlyPayrollView periods={data.periods} lines={data.lines} />}
            {section === "calc" && <PayrollCalcView periods={data.periods} lines={data.lines} employees={data.employees} photos={data.photos} editable={editable} patchLocal={data.patchLocal} reload={data.reload} />}
          </>
        )}
      </div>
    </section>
  );
}
