import React, { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";
import { fmtDate, fmtUnits, METHOD_LABEL } from "./esop";

const longDate = (d = new Date()) => d.toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" });

/** Exact text the collaborator signs. It is stored with the request and hashed (SHA-256) by the database. */
export function buildFormText({ name, idNumber, grant, units, method, installments, instructions, date = new Date() }) {
  const pay = method === "payroll"
    ? `Forma de pago: DEDUCCIÓN DE NÓMINA en ${installments} cuota(s) mensual(es). Autorizo expresamente a Celes Technologies, Inc. y a quien administre mis pagos (incluido Deel) a descontar de mis pagos mensuales las cuotas correspondientes hasta completar el valor total de la compra.`
    : `Forma de pago: TRANSFERENCIA A LA CUENTA DE CELES por el valor total de la compra.${instructions ? ` Datos de la cuenta: ${instructions}.` : " La Compañía me indicará los datos de la cuenta."}`;
  return [
    "SOLICITUD DE COMPRA DE ACCIONES — PLAN DE OPCIONES (ESOP) DE CELES TECHNOLOGIES, INC.",
    "",
    `Fecha: ${longDate(date)}`,
    `Colaborador(a): ${name}`,
    `Documento de identidad: ${idNumber}`,
    "",
    `Yo, ${name}, identificado(a) con el documento ${idNumber}, solicito ejercer ${fmtUnits(units)} opciones de compra de acciones (Common Stock) de Celes Technologies, Inc., de mi asignación de ${fmtUnits(grant.units)} opciones con fecha de inicio el ${fmtDate(grant.vesting_start)}, cliff el ${fmtDate(grant.cliff_date)} y vencimiento el ${fmtDate(grant.expiration_date)}.`,
    "",
    pay,
    "",
    "Entiendo que:",
    "1. El precio por acción de esta compra lo define la Compañía al aprobar la solicitud y me será informado antes del primer pago.",
    "2. La compra está sujeta a la aprobación de la Compañía y a los términos del plan de opciones y de mi acuerdo de opciones.",
    "3. Las acciones se emiten a mi nombre una vez pagado el valor total.",
    "4. Si mi relación con la Compañía termina antes de completar el pago, la solicitud se resolverá según los términos del plan.",
    "",
    "Declaro que la información de esta solicitud es correcta y la firmo electrónicamente.",
  ].join("\n");
}

function SignaturePad({ onChange }) {
  const ref = useRef(null);
  const drawing = useRef(false);
  const inked = useRef(false);
  useEffect(() => {
    const c = ref.current;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.offsetWidth * ratio; c.height = c.offsetHeight * ratio;
    const ctx = c.getContext("2d");
    ctx.scale(ratio, ratio);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0f172a";
  }, []);
  const pos = (e) => { const r = ref.current.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const down = (e) => { e.preventDefault(); ref.current.setPointerCapture(e.pointerId); drawing.current = true; const ctx = ref.current.getContext("2d"); ctx.beginPath(); ctx.moveTo(...pos(e)); };
  const move = (e) => { if (!drawing.current) return; const ctx = ref.current.getContext("2d"); ctx.lineTo(...pos(e)); ctx.stroke(); inked.current = true; };
  const up = () => { if (!drawing.current) return; drawing.current = false; if (inked.current) onChange(ref.current.toDataURL("image/png")); };
  const clear = () => {
    const c = ref.current, ctx = c.getContext("2d");
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.restore();
    inked.current = false; onChange(null);
  };
  return (
    <div className="esop-sign">
      <canvas ref={ref} className="esop-sign-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} aria-label="Firma: dibuja con el mouse o el dedo" />
      <div className="esop-sign-foot"><span>Firma aquí con el mouse o el dedo</span><button type="button" className="admin-link-button" onClick={clear}>Borrar firma</button></div>
    </div>
  );
}

/**
 * Fillable and signable purchase request. `employee` = { name, legal_name, id_number };
 * `grant` = { id, units, vesting_start, cliff_date, expiration_date }; `available` = units that can be bought today and are not yet requested.
 */
export function EsopRequestForm({ employee, grant, available, settings, onDone, onCancel, onBehalf }) {
  const maxInst = settings?.max_installments || 12;
  const [name, setName] = useState(employee?.legal_name || employee?.name || "");
  const [idNumber, setIdNumber] = useState(employee?.id_number || "");
  const [units, setUnits] = useState(String(available));
  const [method, setMethod] = useState("payroll");
  const [installments, setInstallments] = useState(1);
  const [notes, setNotes] = useState("");
  const [agree, setAgree] = useState(false);
  const [signature, setSignature] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const n = Number(units);
  const text = buildFormText({ name: name.trim() || "________", idNumber: idNumber.trim() || "________", grant, units: n > 0 ? n : 0, method, installments: Number(installments), instructions: settings?.payment_instructions });

  const submit = async () => {
    setError(null);
    if (!(n > 0) || n > available || !Number.isInteger(n)) return setError(`Indica un número entero de acciones entre 1 y ${fmtUnits(available)}.`);
    if (!name.trim() || !idNumber.trim()) return setError("Escribe el nombre completo y el documento de identidad.");
    if (!agree) return setError("Confirma que leíste y aceptas la solicitud.");
    if (!signature) return setError("Falta la firma.");
    setBusy(true);
    const { error: err } = await supabase.rpc("esop_submit_request", {
      p_grant: grant.id, p_units: n, p_method: method, p_installments: method === "payroll" ? Number(installments) : 1,
      p_signer_name: name.trim(), p_signer_id: idNumber.trim(), p_form_text: text, p_signature: signature, p_notes: notes.trim() || null,
    });
    setBusy(false);
    if (err) return setError(err.message);
    onDone();
  };

  return (
    <div className="esop-form-doc">
      <div className="esop-form">
        <label className="admin-field"><span>Nombre completo (como en el documento)</span><input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} /></label>
        <label className="admin-field"><span>Documento de identidad</span><input value={idNumber} maxLength={40} onChange={(e) => setIdNumber(e.target.value)} /></label>
        <label className="admin-field"><span>Acciones a comprar (máximo {fmtUnits(available)})</span><input type="number" min="1" max={available} step="1" value={units} onChange={(e) => setUnits(e.target.value)} /></label>
        <fieldset className="esop-methods">
          <legend>Forma de pago</legend>
          <label><input type="radio" name="esop-method" checked={method === "payroll"} onChange={() => setMethod("payroll")} /> {METHOD_LABEL.payroll}</label>
          <label><input type="radio" name="esop-method" checked={method === "transfer"} onChange={() => setMethod("transfer")} /> {METHOD_LABEL.transfer}</label>
        </fieldset>
        {method === "payroll" && (
          <label className="admin-field"><span>Número de cuotas mensuales</span>
            <select value={installments} onChange={(e) => setInstallments(e.target.value)}>{Array.from({ length: maxInst }, (_, i) => i + 1).map((k) => <option key={k} value={k}>{k}</option>)}</select>
          </label>
        )}
        <label className="admin-field esop-wide"><span>Comentarios (opcional)</span><input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></label>
      </div>
      <div className="esop-doc-text" aria-label="Texto de la solicitud">{text}</div>
      <label className="esop-agree"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> Leí y acepto el texto de esta solicitud{method === "payroll" ? ", incluida la autorización de descuento de nómina" : ""}.</label>
      <SignaturePad onChange={setSignature} />
      <p className="admin-note">Al firmar quedan registrados la fecha y hora, tu cuenta, la dirección IP y el navegador, junto con una huella (SHA-256) del texto firmado.{onBehalf ? " Estás registrando la solicitud en nombre del colaborador: él o ella debe firmar en este dispositivo." : ""}</p>
      {error && <div className="board-doc-error" role="alert">{error}</div>}
      <div className="people-modal-actions">
        {onCancel && <button className="people-secondary-button" onClick={onCancel}>Cancelar</button>}
        <button className="admin-primary-button" disabled={busy} onClick={submit}>{busy ? "Enviando…" : "Firmar y enviar solicitud"}</button>
      </div>
    </div>
  );
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Opens the signed form in a new tab, ready to print or save as PDF. */
export async function openSignedDocument(requestId) {
  const win = window.open("", "_blank");
  const { data: d, error } = await supabase.rpc("esop_request_document", { req: requestId });
  if (error || !d) { if (win) win.close(); window.alert(error?.message || "No se encontró el formato."); return; }
  if (!win) return;
  const when = d.signed_at ? new Date(d.signed_at).toLocaleString("es-CO", { dateStyle: "long", timeStyle: "medium" }) : "—";
  win.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Solicitud ESOP · ${esc(d.employee)}</title>
<style>body{font-family:Georgia,'Times New Roman',serif;color:#0f172a;max-width:760px;margin:32px auto;padding:0 24px;line-height:1.55}
.text{white-space:pre-wrap;font-size:14.5px}.sig{margin-top:28px}.sig img{width:320px;border-bottom:1px solid #0f172a}
table{border-collapse:collapse;margin-top:28px;font:12px ui-sans-serif,system-ui,sans-serif;width:100%}td{border:1px solid #cbd5e1;padding:6px 8px;vertical-align:top}
td:first-child{width:200px;color:#475569}.bar{font:13px ui-sans-serif,system-ui,sans-serif;margin-bottom:20px}.ok{color:#0f7a5c}.bad{color:#b42318}
@media print{.bar{display:none}}</style></head><body>
<div class="bar"><button onclick="window.print()">Imprimir / guardar como PDF</button></div>
<div class="text">${esc(d.form_text || "Esta solicitud no tiene formato firmado.")}</div>
${d.signature ? `<div class="sig"><img src="${esc(d.signature)}" alt="Firma"><div>${esc(d.signer_name)} · ${esc(d.signer_id_number)}</div></div>` : ""}
<table>
<tr><td>Firmado</td><td>${esc(when)}</td></tr>
<tr><td>Cuenta que firmó</td><td>${esc(d.signed_by)}${d.channel === "people" ? " (registrado por People en nombre del colaborador)" : " (portal del colaborador)"}</td></tr>
<tr><td>Dirección IP</td><td>${esc(d.signed_ip || "—")}</td></tr>
<tr><td>Navegador</td><td>${esc(d.signed_user_agent || "—")}</td></tr>
<tr><td>Huella SHA-256 del texto</td><td style="word-break:break-all">${esc(d.form_hash || "—")} <span class="${d.hash_ok ? "ok" : "bad"}">${d.hash_ok ? "· el texto no ha cambiado" : "· no coincide"}</span></td></tr>
${d.price != null ? `<tr><td>Precio aprobado</td><td>USD ${esc(d.price)} por acción · total USD ${esc(d.amount)}</td></tr>` : ""}
<tr><td>Identificador</td><td>${esc(d.id)}</td></tr>
</table></body></html>`);
  win.document.close();
}
