import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import "./people.css";
import { fmtDate, fmtUnits, fmtUsd, grantStage } from "./esop";

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");
// Validated categorical order shared with People (dataviz palette).
const COLORS = { bought: "#1baf7a", process: "#eda100", exercisable: "#2a78d6", notyet: "#4a3aa7", restricted: "#e87ba4", unallocated: "#cbd5e1" };

function Settings({ settings, editable, onSaved }) {
  const [form, setForm] = useState(settings);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(settings), [settings]);
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setSaved(false); };
  const save = async () => {
    setError(null);
    const patch = {
      pool_size: Number(form.pool_size) || 0,
      max_installments: Number(form.max_installments) || 12,
      payment_instructions: (form.payment_instructions || "").trim() || null,
    };
    const { error: err } = await supabase.from("esop_settings").update(patch).eq("id", 1);
    if (err) return setError(err.message);
    setSaved(true); onSaved();
  };
  if (!editable) return null;
  return (
    <>
      <div className="esop-settings">
        <label className="admin-field"><span>Pool ESOP (acciones)</span><input type="number" min="0" value={form.pool_size ?? ""} onChange={(e) => set("pool_size", e.target.value)} /></label>
        <label className="admin-field"><span>Máximo de cuotas por nómina</span><input type="number" min="1" max="36" value={form.max_installments ?? 12} onChange={(e) => set("max_installments", e.target.value)} /></label>
        <label className="admin-field esop-wide"><span>Datos de la cuenta de Celes para transferencias</span><input value={form.payment_instructions || ""} maxLength={500} onChange={(e) => set("payment_instructions", e.target.value)} placeholder="Banco, número de cuenta, titular, referencia a incluir…" /></label>
        <div className="esop-wide"><button className="admin-primary-button" onClick={save}>Guardar configuración</button>{saved && <span className="people-muted"> Guardado.</span>}</div>
      </div>
      {error && <div className="board-doc-error" role="alert">{error}</div>}
    </>
  );
}

/** Board > ESOP: pool status, purchase windows and purchases (fed by People > Compra de acciones ESOP). */
export default function EsopBoardView({ editable }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = async () => {
    const { data: d, error: err } = await supabase.rpc("esop_overview");
    if (err) setError(err.message); else setData(d || { settings: {}, grants: [] });
  };
  useEffect(() => { load(); }, []);

  const s = data?.settings || {};
  const grants = data?.grants || [];
  const pool = Number(s.pool_size || 0);
  const granted = grants.reduce((t, g) => t + Number(g.units), 0);
  const options = grants.filter((g) => g.grant_type === "Stock options");
  const restricted = granted - options.reduce((t, g) => t + Number(g.units), 0);
  const bought = grants.reduce((t, g) => t + Number(g.bought), 0);
  const process = grants.reduce((t, g) => t + Number(g.in_process), 0);
  const purchasable = options.reduce((t, g) => t + Number(g.purchasable || 0), 0);
  const exercisable = options.reduce((t, g) => t + (grantStage(g).exercisable ? Math.max(0, Number(g.purchasable || 0) - Number(g.bought) - Number(g.in_process)) : 0), 0);
  const notYet = Math.max(0, granted - restricted - bought - process - exercisable);
  const unallocated = Math.max(0, pool - granted);
  const paid = grants.reduce((t, g) => t + Number(g.paid_amount), 0);
  const segments = [
    ["bought", "Compradas", bought], ["process", "En proceso de compra", process], ["exercisable", "Ejercibles sin comprar", exercisable],
    ["notyet", "Aún no habilitadas para compra", notYet], ["restricted", "Common stock (sin compra)", restricted], ["unallocated", "Sin asignar", unallocated],
  ];
  const base = Math.max(pool, granted);

  return (
    <div className="board-docs">
      <div className="board-docs-heading">
        <div>
          <div className="board-eyebrow">BOARD · ESOP</div>
          <h1>ESOP</h1>
          <p>Estado del plan de stock options: pool, asignaciones, opción de compra y compras de los colaboradores. Las compras se gestionan en People › Compra de acciones ESOP.</p>
        </div>
      </div>
      {error && <div className="board-doc-error" role="alert">{error}</div>}
      {!data ? <div className="board-empty-state">Cargando…</div> : (
        <>
          <p className="esop-status">
            {bought > 0
              ? <>Se han comprado <b>{fmtUnits(bought)}</b> acciones ({pct(bought, granted)} de lo asignado) por <b>{fmtUsd(paid)}</b>.</>
              : <><b>Ningún colaborador ha comprado sus stock options.</b> {process > 0 ? `${fmtUnits(process)} acciones están en proceso de compra.` : ""}</>}
            {" "}El precio por acción se define en cada compra.
          </p>
          <div className="people-kpi-grid">
            <div className="people-kpi"><div className="people-kpi-label">Pool ESOP</div><div className="people-kpi-value">{fmtUnits(pool)}</div><div className="people-kpi-sub">Acciones reservadas</div></div>
            <div className="people-kpi"><div className="people-kpi-label">Asignadas</div><div className="people-kpi-value">{fmtUnits(granted)}</div><div className="people-kpi-sub">{pct(granted, pool)} del pool · {new Set(grants.map((g) => g.holder)).size} personas</div></div>
            <div className="people-kpi"><div className="people-kpi-label">Sin asignar</div><div className="people-kpi-value">{fmtUnits(unallocated)}</div><div className="people-kpi-sub">{granted > pool ? "Lo asignado supera el pool" : "Disponibles para nuevas asignaciones"}</div></div>
            <div className="people-kpi"><div className="people-kpi-label">Habilitadas sin comprar</div><div className="people-kpi-value">{fmtUnits(exercisable)}</div><div className="people-kpi-sub">{fmtUnits(purchasable)} habilitadas a hoy (25% en el cliff, luego mensual 2 años)</div></div>
            <div className="people-kpi"><div className="people-kpi-label">En proceso</div><div className="people-kpi-value">{fmtUnits(process)}</div><div className="people-kpi-sub">Solicitadas o en pago</div></div>
            <div className="people-kpi"><div className="people-kpi-label">Compradas</div><div className="people-kpi-value">{fmtUnits(bought)}</div><div className="people-kpi-sub">{fmtUsd(paid)} recibidos</div></div>
          </div>
          <div className="esop-bar" role="img" aria-label={segments.map(([, l, v]) => `${l}: ${fmtUnits(v)}`).join(", ")}>
            {segments.filter(([, , v]) => v > 0).map(([k, l, v]) => <span key={k} title={`${l}: ${fmtUnits(v)}`} style={{ width: `${(v / base) * 100}%`, background: COLORS[k] }} />)}
          </div>
          <div className="esop-legend">{segments.map(([k, l, v]) => <span key={k}><i style={{ background: COLORS[k] }} />{l} · {fmtUnits(v)}</span>)}</div>

          <Settings settings={s} editable={editable} onSaved={load} />

          <div className="admin-table-wrap">
            <table className="people-table">
              <thead><tr><th>Colaborador</th><th>Tipo</th><th className="num">Unidades</th><th>Inicio</th><th>Cliff</th><th>Vencimiento</th><th>Compra</th><th className="num">Habilitadas</th><th>Firmado</th><th className="num">Compradas</th><th className="num">En proceso</th></tr></thead>
              <tbody>
                {grants.map((g) => {
                  const st = grantStage(g);
                  return (
                    <tr key={g.id}>
                      <td>{g.holder}{!g.active && <small className="people-muted"> · inactiva</small>}</td>
                      <td>{g.grant_type}</td>
                      <td className="num">{fmtUnits(g.units)}</td>
                      <td>{fmtDate(g.vesting_start)}</td><td>{fmtDate(g.cliff_date)}</td><td>{fmtDate(g.expiration_date)}</td>
                      <td><span className={`people-chip is-${st.tone}`}>{st.label}</span></td>
                      <td className="num">{g.grant_type === "Stock options" ? fmtUnits(g.purchasable) : "—"}</td>
                      <td>{g.signed ? "Sí" : "No"}</td>
                      <td className="num">{fmtUnits(g.bought)}</td>
                      <td className="num">{fmtUnits(g.in_process)}</td>
                    </tr>
                  );
                })}
                {!grants.length && <tr><td colSpan={11} className="admin-empty">No hay asignaciones registradas.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="admin-note">Asignaciones tomadas de las fichas de People (Directorio). Ninguna opción está vestida hasta que se compra. Opción de compra: nada antes del cliff; en la fecha del cliff se habilita el 25% de la asignación y el 75% restante mes a mes durante 2 años. El Common stock asignado no requiere compra. Las compras se marcan como compradas cuando se paga el total: por transferencia, al registrar el pago; por nómina, al cerrar la nómina de la última cuota.{!editable && " Tu acceso a Board es de solo lectura."}</p>
        </>
      )}
    </div>
  );
}
