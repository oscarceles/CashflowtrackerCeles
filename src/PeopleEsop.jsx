import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";
import { fmtDate, fmtUnits, fmtPrice, fmtUsd, grantStage, REQUEST_STATUS, OPEN_STATUSES, METHOD_LABEL, unitsUsed, availableUnits, REQUEST_COLUMNS } from "./esop";
import { EsopRequestForm, openSignedDocument } from "./EsopForm";

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="people-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`people-modal${wide ? " esop-modal-wide" : ""}`} role="dialog" aria-label={title}>
        <div className="admin-form-header">
          <h2>{title}</h2>
          <button className="admin-link-button" onClick={onClose}>Cerrar</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Approval: the price per share is set on each purchase. */
function ApproveModal({ request, employee, onClose, onApprove }) {
  const [price, setPrice] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const p = Number(price);
  const amount = p > 0 ? Math.round(Number(request.units) * p * 100) / 100 : null;
  return (
    <Modal title={`Aprobar compra · ${employee?.name || ""}`} onClose={onClose}>
      <p className="admin-note">{fmtUnits(request.units)} acciones · {METHOD_LABEL[request.payment_method]}{request.payment_method === "payroll" ? ` en ${request.installments} cuota(s), que se agregan a las nóminas en borrador` : ""}.</p>
      <div className="esop-form">
        <label className="admin-field"><span>Precio por acción de esta compra (USD)</span><input type="number" min="0" step="0.000001" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus /></label>
        <label className="admin-field esop-wide"><span>Nota (opcional)</span><input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      <div className="esop-estimate">{amount == null ? <span>Indica el precio para calcular el total.</span> : <span>Total: <b>{fmtUsd(amount)}</b>{request.payment_method === "payroll" && request.installments > 1 ? <> · {request.installments} cuotas de ~{fmtUsd(amount / request.installments)}</> : null}</span>}</div>
      {error && <div className="board-doc-error" role="alert">{error}</div>}
      <div className="people-modal-actions">
        <button className="admin-primary-button" disabled={!amount} onClick={async () => { const msg = await onApprove(p, note.trim() || null); if (msg) setError(msg); }}>Aprobar</button>
      </div>
    </Modal>
  );
}

function PaymentModal({ request, employee, onClose, onSave }) {
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState("");
  const [error, setError] = useState(null);
  return (
    <Modal title={`Registrar pago · ${employee?.name || ""}`} onClose={onClose}>
      <p className="admin-note">{fmtUnits(request.units)} acciones por <b>{fmtUsd(request.amount)}</b>, pagadas por transferencia a la cuenta de Celes. Al registrar el pago, Board › ESOP las muestra como compradas.</p>
      <div className="esop-form">
        <label className="admin-field"><span>Fecha del pago</span><input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></label>
        <label className="admin-field esop-wide"><span>Referencia / comprobante</span><input value={reference} maxLength={200} onChange={(e) => setReference(e.target.value)} placeholder="Nº de transacción, banco…" /></label>
      </div>
      {error && <div className="board-doc-error" role="alert">{error}</div>}
      <div className="people-modal-actions">
        <button className="admin-primary-button" onClick={async () => { const msg = await onSave(paidOn, reference); if (msg) setError(msg); }}>Confirmar pago recibido</button>
      </div>
    </Modal>
  );
}

/** People > Compra de acciones ESOP: vested options per collaborator and the purchase requests. */
export default function EsopView({ employees, editable, reloadPeople }) {
  const [grants, setGrants] = useState([]);
  const [requests, setRequests] = useState([]);
  const [installments, setInstallments] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [requesting, setRequesting] = useState(null);
  const [approving, setApproving] = useState(null);
  const [paying, setPaying] = useState(null);
  const [filter, setFilter] = useState("open");

  const load = async () => {
    const [o, r, i] = await Promise.all([
      supabase.rpc("esop_overview"),
      supabase.from("esop_requests").select(REQUEST_COLUMNS).order("requested_at", { ascending: false }),
      supabase.from("esop_installments").select("*").order("n"),
    ]);
    const err = o.error || r.error || i.error;
    if (err) setError(err.message);
    else { setGrants(o.data?.grants || []); setSettings(o.data?.settings || null); setRequests(r.data || []); setInstallments(i.data || []); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const byId = useMemo(() => Object.fromEntries(employees.map((e) => [e.id, e])), [employees]);
  const options = grants.filter((g) => g.grant_type === "Stock options");
  const rows = options.map((g) => {
    const used = unitsUsed(requests, g.id);
    const bought = requests.filter((r) => r.grant_id === g.id && r.status === "paid").reduce((s, r) => s + Number(r.units), 0);
    return { g, e: byId[g.employee_id], stage: grantStage(g), bought, inProcess: used - bought, available: availableUnits(g, used) };
  }).sort((a, b) => (b.available - a.available) || (a.e?.name || "").localeCompare(b.e?.name || ""));

  const total = options.reduce((s, g) => s + Number(g.units), 0);
  const vested = options.reduce((s, g) => s + Number(g.vested || 0), 0);
  const exercisable = rows.reduce((s, r) => s + r.available, 0);
  const inProcess = rows.reduce((s, r) => s + r.inProcess, 0);
  const bought = rows.reduce((s, r) => s + r.bought, 0);

  const act = async (r, action, extra = {}) => {
    setError(null);
    const { error: err } = await supabase.rpc("esop_request_action", {
      req: r.id, action, note: extra.note ?? null, paid_on: extra.paidOn ?? null, reference: extra.reference ?? null, price_in: extra.price ?? null,
    });
    if (err) { setError(err.message); return err.message; }
    await load();
    if (r.payment_method === "payroll" && ["approve", "cancel"].includes(action)) reloadPeople();
    return null;
  };
  const reject = (r) => { const note = window.prompt("Motivo del rechazo:"); if (note !== null) act(r, "reject", { note: note.trim() || null }); };
  const cancel = (r) => { if (window.confirm("¿Cancelar esta solicitud? Se quitan las cuotas pendientes de las nóminas en borrador.")) act(r, "cancel"); };

  const shown = requests.filter((r) => filter === "all" || (filter === "open" ? OPEN_STATUSES.includes(r.status) : r.status === filter));
  const progress = (r) => {
    if (r.payment_method !== "payroll" || !["approved", "paid"].includes(r.status)) return null;
    const list = installments.filter((i) => i.request_id === r.id);
    const next = list.find((i) => !i.paid && i.period_id);
    return <small className="people-muted">{list.filter((i) => i.paid).length}/{r.installments} cuotas descontadas{next ? ` · próxima en la nómina ${next.period_id}` : ""}</small>;
  };

  if (loading) return <div className="board-empty-state">Cargando…</div>;

  return (
    <div className="esop-view">
      {error && <div className="board-doc-error" role="alert">{error}</div>}
      <div className="people-kpi-grid">
        <div className="people-kpi"><div className="people-kpi-label">Stock options asignadas</div><div className="people-kpi-value">{fmtUnits(total)}</div><div className="people-kpi-sub">{new Set(options.map((g) => g.employee_id)).size} personas</div></div>
        <div className="people-kpi"><div className="people-kpi-label">Vestidas a hoy</div><div className="people-kpi-value">{fmtUnits(vested)}</div><div className="people-kpi-sub">1/48 por mes desde el cliff</div></div>
        <div className="people-kpi"><div className="people-kpi-label">Disponibles para comprar</div><div className="people-kpi-value">{fmtUnits(exercisable)}</div><div className="people-kpi-sub">Vestidas y sin solicitar</div></div>
        <div className="people-kpi"><div className="people-kpi-label">En proceso</div><div className="people-kpi-value">{fmtUnits(inProcess)}</div><div className="people-kpi-sub">Solicitadas o aprobadas en pago</div></div>
        <div className="people-kpi"><div className="people-kpi-label">Compradas</div><div className="people-kpi-value">{fmtUnits(bought)}</div><div className="people-kpi-sub">{bought ? "Pagadas en su totalidad" : "Nadie ha comprado aún"}</div></div>
      </div>

      <h2 className="esop-title">Solicitudes de compra</h2>
      <p className="admin-note">Los colaboradores solicitan desde su portal (Mis solicitudes) con el formato firmado. El precio por acción se define en cada compra al aprobarla.</p>
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
                  <td>{fmtDate(r.requested_at)}<br /><small className="people-muted">{r.channel === "self" ? "Portal" : "Registrada por People"}</small></td>
                  <td>{byId[r.employee_id]?.name || "—"}{r.notes && <><br /><small className="people-muted">{r.notes}</small></>}</td>
                  <td className="num">{fmtUnits(r.units)}</td>
                  <td className="num">{r.amount != null ? fmtUsd(r.amount) : "Al aprobar"}{r.price != null && <><br /><small className="people-muted">{fmtPrice(r.price)} c/u</small></>}</td>
                  <td>{METHOD_LABEL[r.payment_method]}{r.payment_method === "payroll" && ` · ${r.installments} cuota(s)`}<br />{progress(r)}</td>
                  <td>
                    <span className={`people-chip is-${st.tone}`}>{st.label}</span>
                    {r.status === "paid" && <><br /><small className="people-muted">{fmtDate(r.paid_at)}{r.payment_reference ? ` · ${r.payment_reference}` : ""}</small></>}
                    {r.decision_note && <><br /><small className="people-muted">{r.decision_note}</small></>}
                  </td>
                  <td className="admin-row-actions">
                    {r.signed_at && <button className="admin-link-button" onClick={() => openSignedDocument(r.id)}>Ver formato</button>}
                    {editable && <>
                      {r.status === "requested" && <><button className="admin-link-button" onClick={() => setApproving(r)}>Aprobar</button><button className="admin-link-button is-danger" onClick={() => reject(r)}>Rechazar</button></>}
                      {r.status === "approved" && r.payment_method === "transfer" && <button className="admin-link-button" onClick={() => setPaying(r)}>Registrar pago</button>}
                      {OPEN_STATUSES.includes(r.status) && <button className="admin-link-button is-danger" onClick={() => cancel(r)}>Cancelar</button>}
                    </>}
                  </td>
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
          <thead><tr><th>Persona</th><th className="num">Asignadas</th><th>Cliff</th><th>Vencimiento</th><th>Vesting</th><th className="num">Vestidas</th><th className="num">Compradas</th><th className="num">En proceso</th><th className="num">Disponibles</th><th /></tr></thead>
          <tbody>
            {rows.map(({ g, e, stage, bought: b, inProcess: p, available }) => (
              <tr key={g.id}>
                <td>{e?.name || g.holder}{e && !e.active && <small className="people-muted"> · inactiva</small>}</td>
                <td className="num">{fmtUnits(g.units)}</td>
                <td>{fmtDate(g.cliff_date)}</td>
                <td>{fmtDate(g.expiration_date)}</td>
                <td><span className={`people-chip is-${stage.tone}`}>{stage.label}</span></td>
                <td className="num">{fmtUnits(g.vested)}</td>
                <td className="num">{fmtUnits(b)}</td>
                <td className="num">{fmtUnits(p)}</td>
                <td className="num">{fmtUnits(available)}</td>
                <td className="admin-row-actions">{editable && available > 0 && <button className="admin-link-button" onClick={() => setRequesting({ g, e, available })}>Registrar solicitud</button>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={10} className="admin-empty">No hay stock options registradas. Se asignan en la ficha de cada persona (Directorio).</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="admin-note">Vesting: nada antes del cliff; desde la fecha del cliff se puede comprar 1/48 de la asignación por mes durante 4 años (acciones enteras). Las deducciones de nómina aparecen como novedad “Compra ESOP” en Cálculo de nómina; si se quita una cuota de una nómina, pasa a la siguiente.</p>

      {requesting && (
        <Modal title={`Solicitud de compra · ${requesting.e?.name || ""}`} onClose={() => setRequesting(null)} wide>
          <EsopRequestForm onBehalf employee={{ name: requesting.e?.name, legal_name: requesting.e?.legal_name }} grant={requesting.g} available={requesting.available}
            settings={settings} onCancel={() => setRequesting(null)} onDone={() => { setRequesting(null); load(); }} />
        </Modal>
      )}
      {approving && <ApproveModal request={approving} employee={byId[approving.employee_id]} onClose={() => setApproving(null)}
        onApprove={async (price, note) => { const msg = await act(approving, "approve", { price, note }); if (!msg) setApproving(null); return msg; }} />}
      {paying && <PaymentModal request={paying} employee={byId[paying.employee_id]} onClose={() => setPaying(null)}
        onSave={async (paidOn, reference) => { const msg = await act(paying, "mark_paid", { paidOn, reference }); if (!msg) setPaying(null); return msg; }} />}
    </div>
  );
}
