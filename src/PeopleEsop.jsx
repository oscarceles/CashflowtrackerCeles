import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";
import { fmtDate, fmtUnits, fmtPrice, fmtUsd, grantStage, REQUEST_STATUS, OPEN_STATUSES, METHOD_LABEL, unitsUsed } from "./esop";

/** Request to buy vested stock options for a collaborator. */
function RequestModal({ grant, employee, available, settings, onClose, onSaved }) {
  const price = grant.exercise_price ?? settings?.exercise_price;
  const maxInst = settings?.max_installments || 12;
  const [units, setUnits] = useState(String(available));
  const [method, setMethod] = useState("payroll");
  const [installments, setInstallments] = useState(1);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const n = Number(units);
  const amount = price != null && n > 0 ? Math.round(n * Number(price) * 100) / 100 : null;

  const submit = async () => {
    if (!(n > 0) || n > available) return setError(`Indica entre 1 y ${fmtUnits(available)} acciones.`);
    setBusy(true); setError(null);
    const { error: err } = await supabase.from("esop_requests").insert({
      grant_id: grant.id, employee_id: grant.employee_id, units: n, payment_method: method,
      installments: method === "payroll" ? Number(installments) : 1, notes: notes.trim() || null,
    });
    setBusy(false);
    if (err) return setError(err.message);
    onSaved();
  };

  return (
    <div className="people-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="people-modal" role="dialog" aria-label={`Solicitud de compra de ${employee?.name}`}>
        <div className="admin-form-header">
          <h2>Solicitud de compra · {employee?.name}</h2>
          <button className="admin-link-button" onClick={onClose}>Cerrar</button>
        </div>
        <p className="admin-note">
          Opciones ejercibles: <b>{fmtUnits(available)}</b> de {fmtUnits(grant.units)} (cliff {fmtDate(grant.cliff_date)}, vencen {fmtDate(grant.expiration_date)}).
          Precio de ejercicio: <b>{fmtPrice(price)}</b> por acción{price == null ? " — se define en Board › ESOP y se fija al aprobar" : ""}.
        </p>
        <div className="esop-form">
          <label className="admin-field"><span>Acciones a comprar</span>
            <input type="number" min="1" max={available} step="1" value={units} onChange={(e) => setUnits(e.target.value)} />
          </label>
          <fieldset className="esop-methods">
            <legend>Forma de pago</legend>
            <label><input type="radio" name="method" checked={method === "payroll"} onChange={() => setMethod("payroll")} /> Deducción de nómina</label>
            <label><input type="radio" name="method" checked={method === "transfer"} onChange={() => setMethod("transfer")} /> Transferencia a cuenta de Celes</label>
          </fieldset>
          {method === "payroll" && (
            <label className="admin-field"><span>Número de cuotas</span>
              <select value={installments} onChange={(e) => setInstallments(e.target.value)}>
                {Array.from({ length: maxInst }, (_, i) => i + 1).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
          )}
          <label className="admin-field esop-wide"><span>Notas</span>
            <input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} placeholder="Fecha de la carta de solicitud, observaciones…" />
          </label>
        </div>
        <div className="esop-estimate">
          {amount == null ? <span>El monto se calcula al aprobar, con el precio de ejercicio vigente.</span> : (
            <span>Monto estimado: <b>{fmtUsd(amount)}</b>{method === "payroll" && Number(installments) > 1 ? <> · {installments} cuotas de ~{fmtUsd(amount / installments)}</> : null}</span>
          )}
          {method === "payroll" && <small>Al aprobarse, cada cuota se agrega como deducción en las nóminas en borrador y se da por pagada cuando esa nómina se cierra.</small>}
          {method === "transfer" && <small>{settings?.payment_instructions ? <>Datos para la transferencia: {settings.payment_instructions}</> : "Los datos de la cuenta de Celes se configuran en Board › ESOP."} El pago se registra con fecha y referencia cuando se reciba.</small>}
        </div>
        {error && <div className="board-doc-error" role="alert">{error}</div>}
        <div className="people-modal-actions">
          <button className="admin-primary-button" disabled={busy} onClick={submit}>Registrar solicitud</button>
        </div>
      </div>
    </div>
  );
}

function PaymentModal({ request, employee, onClose, onSave }) {
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [error, setError] = useState(null);
  return (
    <div className="people-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="people-modal" role="dialog" aria-label="Registrar pago">
        <div className="admin-form-header">
          <h2>Registrar pago · {employee?.name}</h2>
          <button className="admin-link-button" onClick={onClose}>Cerrar</button>
        </div>
        <p className="admin-note">{fmtUnits(request.units)} acciones por <b>{fmtUsd(request.amount)}</b>, pagadas por transferencia a la cuenta de Celes. Al registrar el pago, Board › ESOP las muestra como compradas.</p>
        <div className="esop-form">
          <label className="admin-field"><span>Fecha del pago</span><input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></label>
          <label className="admin-field esop-wide"><span>Referencia / comprobante</span><input value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} placeholder="Nº de transacción, banco…" /></label>
        </div>
        {error && <div className="board-doc-error" role="alert">{error}</div>}
        <div className="people-modal-actions">
          <button className="admin-primary-button" onClick={async () => { const msg = await onSave(paidOn, reference); if (msg) setError(msg); }}>Confirmar pago recibido</button>
        </div>
      </div>
    </div>
  );
}

/** People > Compra de acciones ESOP: vested options per collaborator and the purchase requests. */
export default function EsopView({ employees, grants, editable, reloadPeople }) {
  const [requests, setRequests] = useState([]);
  const [installments, setInstallments] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [requesting, setRequesting] = useState(null);
  const [paying, setPaying] = useState(null);
  const [filter, setFilter] = useState("open");

  const load = async () => {
    const [r, i, s] = await Promise.all([
      supabase.from("esop_requests").select("*").order("requested_at", { ascending: false }),
      supabase.from("esop_installments").select("*").order("n"),
      supabase.from("esop_settings").select("*").eq("id", 1).maybeSingle(),
    ]);
    const err = r.error || i.error || s.error;
    if (err) setError(err.message);
    else { setRequests(r.data || []); setInstallments(i.data || []); setSettings(s.data); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const byId = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e])), [employees]);
  const options = grants.filter((g) => (g.grant_type || "Stock options") === "Stock options");
  const rows = options.map((g) => {
    const stage = grantStage(g);
    const bought = requests.filter((r) => r.grant_id === g.id && r.status === "paid").reduce((s, r) => s + Number(r.units), 0);
    const inProcess = requests.filter((r) => r.grant_id === g.id && OPEN_STATUSES.includes(r.status)).reduce((s, r) => s + Number(r.units), 0);
    const available = stage.exercisable ? Math.max(0, Number(g.units) - unitsUsed(requests, g.id)) : 0;
    return { g, e: byId[g.employee_id], stage, bought, inProcess, available };
  }).sort((a, b) => (b.available - a.available) || (a.e?.name || "").localeCompare(b.e?.name || ""));

  const total = options.reduce((s, g) => s + Number(g.units), 0);
  const exercisable = rows.reduce((s, r) => s + r.available, 0);
  const inProcess = rows.reduce((s, r) => s + r.inProcess, 0);
  const bought = rows.reduce((s, r) => s + r.bought, 0);

  const act = async (r, action, extra = {}) => {
    setError(null);
    const { error: err } = await supabase.rpc("esop_request_action", { req: r.id, action, note: extra.note ?? null, paid_on: extra.paidOn ?? null, reference: extra.reference ?? null });
    if (err) { setError(err.message); return err.message; }
    await load();
    if (r.payment_method === "payroll" && ["approve", "cancel"].includes(action)) reloadPeople();
    return null;
  };
  const approve = (r) => {
    const price = grants.find((g) => g.id === r.grant_id)?.exercise_price ?? settings?.exercise_price;
    if (price == null) return setError("Define el precio de ejercicio en Board › ESOP antes de aprobar.");
    const amount = Math.round(Number(r.units) * Number(price) * 100) / 100;
    const how = r.payment_method === "payroll" ? `en ${r.installments} cuota(s) descontadas de la nómina, empezando por las nóminas en borrador` : "por transferencia a la cuenta de Celes";
    if (window.confirm(`¿Aprobar la compra de ${fmtUnits(r.units)} acciones de ${byId[r.employee_id]?.name} por ${fmtUsd(amount)} (${fmtPrice(price)} por acción), ${how}?`)) act(r, "approve");
  };
  const reject = (r) => { const note = window.prompt("Motivo del rechazo:"); if (note !== null) act(r, "reject", { note: note.trim() || null }); };
  const cancel = (r) => { if (window.confirm("¿Cancelar esta solicitud? Se quitan las cuotas pendientes de las nóminas en borrador.")) act(r, "cancel"); };

  const shown = requests.filter((r) => filter === "all" || (filter === "open" ? OPEN_STATUSES.includes(r.status) : r.status === filter));
  const progress = (r) => {
    if (r.payment_method !== "payroll" || !["approved", "paid"].includes(r.status)) return null;
    const list = installments.filter((i) => i.request_id === r.id);
    const paid = list.filter((i) => i.paid).length;
    const next = list.find((i) => !i.paid && i.period_id);
    return <small className="people-muted">{paid}/{r.installments} cuotas descontadas{next ? ` · próxima en la nómina ${next.period_id}` : ""}</small>;
  };

  if (loading) return <div className="board-empty-state">Cargando…</div>;

  return (
    <div className="esop-view">
      {error && <div className="board-doc-error" role="alert">{error}</div>}
      <div className="people-kpi-grid">
        <div className="people-kpi"><div className="people-kpi-label">Stock options asignadas</div><div className="people-kpi-value">{fmtUnits(total)}</div><div className="people-kpi-sub">{new Set(options.map((g) => g.employee_id)).size} personas</div></div>
        <div className="people-kpi"><div className="people-kpi-label">Ejercibles hoy</div><div className="people-kpi-value">{fmtUnits(exercisable)}</div><div className="people-kpi-sub">Cliff cumplido, sin vencer ni comprometer</div></div>
        <div className="people-kpi"><div className="people-kpi-label">En proceso</div><div className="people-kpi-value">{fmtUnits(inProcess)}</div><div className="people-kpi-sub">Solicitadas o aprobadas en pago</div></div>
        <div className="people-kpi"><div className="people-kpi-label">Compradas</div><div className="people-kpi-value">{fmtUnits(bought)}</div><div className="people-kpi-sub">{bought ? "Pagadas en su totalidad" : "Nadie ha comprado aún"}</div></div>
        <div className="people-kpi"><div className="people-kpi-label">Precio de ejercicio</div><div className="people-kpi-value esop-kpi-small">{fmtPrice(settings?.exercise_price)}</div><div className="people-kpi-sub">Se configura en Board › ESOP</div></div>
      </div>

      <h2 className="esop-title">Solicitudes de compra</h2>
      <div className="esop-toolbar">
        {[["open", "En curso"], ["paid", "Pagadas"], ["all", "Todas"]].map(([id, label]) => (
          <button key={id} className={`people-secondary-button${filter === id ? " is-active" : ""}`} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      <div className="admin-table-wrap">
        <table className="people-table">
          <thead><tr><th>Fecha</th><th>Persona</th><th className="num">Acciones</th><th className="num">Monto</th><th>Forma de pago</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {shown.map((r) => {
              const st = REQUEST_STATUS[r.status];
              return (
                <tr key={r.id}>
                  <td>{fmtDate(r.requested_at)}</td>
                  <td>{byId[r.employee_id]?.name || "—"}{r.notes && <><br /><small className="people-muted">{r.notes}</small></>}</td>
                  <td className="num">{fmtUnits(r.units)}</td>
                  <td className="num">{r.amount != null ? fmtUsd(r.amount) : "Al aprobar"}{r.price != null && <><br /><small className="people-muted">{fmtPrice(r.price)} c/u</small></>}</td>
                  <td>{METHOD_LABEL[r.payment_method]}{r.payment_method === "payroll" && ` · ${r.installments} cuota(s)`}<br />{progress(r)}</td>
                  <td>
                    <span className={`people-chip is-${st.tone}`}>{st.label}</span>
                    {r.status === "paid" && <><br /><small className="people-muted">{fmtDate(r.paid_at)}{r.payment_reference ? ` · ${r.payment_reference}` : ""}</small></>}
                    {r.decision_note && <><br /><small className="people-muted">{r.decision_note}</small></>}
                  </td>
                  <td className="admin-row-actions">{editable && <>
                    {r.status === "requested" && <><button className="admin-link-button" onClick={() => approve(r)}>Aprobar</button><button className="admin-link-button is-danger" onClick={() => reject(r)}>Rechazar</button></>}
                    {r.status === "approved" && r.payment_method === "transfer" && <button className="admin-link-button" onClick={() => setPaying(r)}>Registrar pago</button>}
                    {OPEN_STATUSES.includes(r.status) && <button className="admin-link-button is-danger" onClick={() => cancel(r)}>Cancelar</button>}
                  </>}</td>
                </tr>
              );
            })}
            {!shown.length && <tr><td colSpan={7} className="admin-empty">{requests.length ? "No hay solicitudes en este filtro." : "Aún no hay solicitudes de compra."}</td></tr>}
          </tbody>
        </table>
      </div>

      <h2 className="esop-title">Stock options por persona</h2>
      <div className="admin-table-wrap">
        <table className="people-table">
          <thead><tr><th>Persona</th><th className="num">Asignadas</th><th>Cliff</th><th>Vencimiento</th><th>Estado</th><th className="num">Compradas</th><th className="num">En proceso</th><th className="num">Disponibles</th><th /></tr></thead>
          <tbody>
            {rows.map(({ g, e, stage, bought: b, inProcess: p, available }) => (
              <tr key={g.id}>
                <td>{e?.name || "—"}{e && !e.active && <small className="people-muted"> · inactiva</small>}</td>
                <td className="num">{fmtUnits(g.units)}</td>
                <td>{fmtDate(g.cliff_date)}</td>
                <td>{fmtDate(g.expiration_date)}</td>
                <td><span className={`people-chip is-${stage.tone}`}>{stage.label}</span></td>
                <td className="num">{fmtUnits(b)}</td>
                <td className="num">{fmtUnits(p)}</td>
                <td className="num">{fmtUnits(available)}</td>
                <td className="admin-row-actions">{editable && available > 0 && <button className="admin-link-button" onClick={() => setRequesting({ g, e, available })}>Solicitar compra</button>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={9} className="admin-empty">No hay stock options registradas. Se asignan en la ficha de cada persona (Directorio).</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="admin-note">Solo se pueden comprar stock options activas con el cliff cumplido y sin vencer (todo el grant se vuelve ejercible en el cliff). Las deducciones de nómina aparecen como novedad “Compra ESOP” en Cálculo de nómina; si se quita una cuota de una nómina, pasa a la siguiente.</p>

      {requesting && <RequestModal grant={requesting.g} employee={requesting.e} available={requesting.available} settings={settings}
        onClose={() => setRequesting(null)} onSaved={() => { setRequesting(null); load(); }} />}
      {paying && <PaymentModal request={paying} employee={byId[paying.employee_id]} onClose={() => setPaying(null)}
        onSave={async (paidOn, reference) => { const msg = await act(paying, "mark_paid", { paidOn, reference }); if (!msg) setPaying(null); return msg; }} />}
    </div>
  );
}
