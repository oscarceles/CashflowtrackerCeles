import React, { useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient";
import { MONTH_NAMES, areaColor, usd, num, lineTotal } from "./peopleUtils";

const fmtDate = (iso, opts = { day: "2-digit", month: "short", year: "numeric" }) =>
  (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString("es-CO", opts) : "—");
const birthday = (iso) => (iso ? fmtDate(iso, { day: "numeric", month: "long" }) : "—");
const initials = (name) => name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

function tenure(start, end) {
  if (!start) return "—";
  const a = new Date(`${start}T00:00:00`), b = end ? new Date(`${end}T00:00:00`) : new Date();
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) months -= 1;
  if (months < 0) return "Por ingresar";
  const y = Math.floor(months / 12), m = months % 12;
  return [y && `${y} ${y === 1 ? "año" : "años"}`, m && `${m} ${m === 1 ? "mes" : "meses"}`].filter(Boolean).join(" ") || "Menos de 1 mes";
}

/** Photo (uploaded, else Google) or initials. */
export function PersonAvatar({ employee, photos, size }) {
  const [failed, setFailed] = useState(false);
  const src = (photos && employee.id && photos[employee.id]) || employee.avatar_url;
  const cls = `people-avatar${size === "large" ? " is-large" : size === "small" ? " is-small" : ""}`;
  if (src && !failed) return <img className={`${cls} is-photo`} src={src} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return <span className={cls} style={{ background: areaColor(employee.area) }} aria-hidden="true">{initials(employee.name || "?")}</span>;
}

const DOC_KINDS = ["Contrato Deel", "Stock options", "Otro"];
const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const safeFileName = (name) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9._ -]/g, "").replace(/\s+/g, "_");

function DocumentsSection({ employeeId, documents, patchLocal }) {
  const inputRef = useRef(null);
  const [kind, setKind] = useState("Contrato Deel");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const open = async (doc) => {
    setError(null);
    const tab = window.open("about:blank", "_blank");
    const { data, error: err } = await supabase.storage.from("people-documents").createSignedUrl(doc.path, 300);
    if (err || !data?.signedUrl) { tab?.close(); setError("No se pudo abrir el documento."); return; }
    if (tab) { tab.opener = null; tab.location.href = data.signedUrl; } else window.location.assign(data.signedUrl);
  };

  const upload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["application/pdf", "image/png", "image/jpeg"].includes(file.type)) { setError("Solo PDF, PNG o JPG."); return; }
    if (file.size > 25 * 1024 * 1024) { setError("El archivo supera 25 MB."); return; }
    setBusy(true);
    setError(null);
    try {
      const path = `${employeeId}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
      const { error: upErr } = await supabase.storage.from("people-documents").upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data, error: dbErr } = await supabase.from("people_documents").insert({ employee_id: employeeId, kind, name: file.name, path, size: file.size }).select().single();
      if (dbErr) throw dbErr;
      patchLocal((d) => ({ documents: [...d.documents, data] }));
    } catch (err) {
      setError(err.message || "No se pudo subir el archivo.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (doc) => {
    if (!window.confirm(`¿Eliminar "${doc.name}"?`)) return;
    setError(null);
    const { error: stErr } = await supabase.storage.from("people-documents").remove([doc.path]);
    if (stErr) { setError(stErr.message); return; }
    const { error: dbErr } = await supabase.from("people_documents").delete().eq("id", doc.id);
    if (dbErr) { setError(dbErr.message); return; }
    patchLocal((d) => ({ documents: d.documents.filter((x) => x.id !== doc.id) }));
  };

  return (
    <div>
      <ul className="people-docs">
        {documents.map((doc) => (
          <li key={doc.id}>
            <span className={`people-doc-kind is-${doc.kind === "Stock options" ? "stock" : doc.kind === "Contrato Deel" ? "deel" : "other"}`}>{doc.kind}</span>
            <button className="people-doc-name" onClick={() => open(doc)} title="Abrir (enlace privado de 5 minutos)">{doc.name}</button>
            <span className="people-muted">{doc.size ? fileSize(doc.size) : ""}</span>
            <button className="admin-link-button is-danger" onClick={() => remove(doc)}>Eliminar</button>
          </li>
        ))}
        {!documents.length && <li className="people-muted">Sin documentos.</li>}
      </ul>
      <div className="people-inline-form">
        <label className="admin-field"><span>Tipo</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>{DOC_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
        </label>
        <input ref={inputRef} type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg" onChange={upload} />
        <button className="people-secondary-button" disabled={busy} onClick={() => inputRef.current?.click()}>{busy ? "Subiendo…" : "+ Adjuntar documento"}</button>
      </div>
      {error && <div className="board-doc-error" role="alert">{error}</div>}
    </div>
  );
}

/** Status of a stock option grant from its dates (the schedule file does not define partial vesting). */
function grantStage(g) {
  const today = new Date().toISOString().slice(0, 10);
  if (g.status && g.status.toLowerCase() !== "active") return { label: g.status, tone: "muted" };
  if (g.expiration_date && today >= g.expiration_date) return { label: "Vencida", tone: "muted" };
  if (g.cliff_date && today >= g.cliff_date) return { label: "Cliff cumplido", tone: "good" };
  return { label: g.cliff_date ? `Cliff el ${fmtDate(g.cliff_date)}` : "Activa", tone: "wait" };
}

const PUBLIC_FIELDS = [
  ["Laboral", [
    ["name", "Nombre"], ["legal_name", "Nombre legal"], ["role_title", "Cargo"], ["area", "Área"],
    ["cost_type", "Tipo", ["OPEX", "CAPEX"]], ["start_date", "Fecha de ingreso", "date"], ["end_date", "Fecha de salida", "date"],
    ["base_salary", "Salario base (USD)", "number"], ["allowance", "Auxilio (USD)", "number"],
  ]],
  ["Contacto", [
    ["work_email", "Correo corporativo"], ["personal_email", "Correo personal"], ["phone", "Celular"],
    ["country", "País"], ["city", "Ciudad"], ["birth_date", "Fecha de nacimiento", "date"],
  ]],
  ["Otros", [
    ["shirt_size", "Talla camiseta"], ["pants_size", "Talla pantalón"], ["dietary_notes", "Alimentación / alergias"], ["notes", "Notas"],
  ]],
  ["Deel", [
    ["deel_contract_id", "ID de contrato"], ["deel_name", "Nombre en Deel"], ["deel_email", "Correo en Deel"],
    ["deel_contract_name", "Nombre del contrato"], ["deel_group", "Grupo"],
  ]],
];

const PRIVATE_FIELDS = [
  ["id_number", "Número de identificación"], ["address", "Dirección"], ["neighborhood", "Barrio"], ["eps", "EPS"],
  ["bank", "Banco"], ["account_type", "Tipo de cuenta"], ["account_number", "Número de cuenta"],
  ["emergency_name", "Contacto de emergencia"], ["emergency_phone", "Celular de emergencia"], ["emergency_relationship", "Parentesco"],
  ["marital_status", "Estado civil"], ["children", "Hijos"],
];

function FieldGrid({ fields, values, editing, onChange }) {
  return (
    <div className="people-field-grid">
      {fields.map(([key, label, kind]) => {
        const value = values?.[key];
        let shown = value == null || value === "" ? "—" : String(value);
        if (kind === "date") shown = key === "birth_date" ? birthday(value) : fmtDate(value);
        if (kind === "number") shown = value == null ? "—" : usd(num(value), 2);
        return (
          <label key={key} className="people-field">
            <span>{label}</span>
            {editing ? (
              Array.isArray(kind) ? (
                <select value={value || kind[0]} onChange={(e) => onChange(key, e.target.value)}>{kind.map((o) => <option key={o}>{o}</option>)}</select>
              ) : (
                <input type={kind === "date" ? "date" : kind === "number" ? "number" : "text"} step={kind === "number" ? "0.01" : undefined}
                  value={value ?? ""} onChange={(e) => onChange(key, kind === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)} />
              )
            ) : <b>{shown}</b>}
          </label>
        );
      })}
    </div>
  );
}

function GrantsEditor({ employeeId, grants, editable, patchLocal }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const save = async () => {
    setError(null);
    const row = { employee_id: employeeId, units: num(draft.units), vesting_start: draft.vesting_start || null, cliff_date: draft.cliff_date || null, expiration_date: draft.expiration_date || null, status: draft.status || "Active", signed: Boolean(draft.signed) };
    const query = draft.id ? supabase.from("people_equity_grants").update(row).eq("id", draft.id) : supabase.from("people_equity_grants").insert(row);
    const { data, error: err } = await query.select().single();
    if (err) return setError(err.message);
    patchLocal((d) => ({ grants: draft.id ? d.grants.map((g) => (g.id === data.id ? data : g)) : [...d.grants, data] }));
    setDraft(null);
  };
  const remove = async (g) => {
    if (!window.confirm("¿Eliminar esta asignación de stock options?")) return;
    const { error: err } = await supabase.from("people_equity_grants").delete().eq("id", g.id);
    if (err) return setError(err.message);
    patchLocal((d) => ({ grants: d.grants.filter((x) => x.id !== g.id) }));
  };
  return (
    <div>
      <table className="people-table">
        <thead><tr><th className="num">Unidades</th><th>Inicio vesting</th><th>Cliff</th><th>Vencimiento</th><th>Firmado</th><th>Estado</th><th /></tr></thead>
        <tbody>
          {grants.map((g) => {
            const stage = grantStage(g);
            return (
              <tr key={g.id}>
                <td className="num">{num(g.units).toLocaleString("es-CO")}</td>
                <td>{fmtDate(g.vesting_start)}</td><td>{fmtDate(g.cliff_date)}</td><td>{fmtDate(g.expiration_date)}</td>
                <td>{g.signed ? "Sí" : "No"}</td>
                <td><span className={`people-chip is-${stage.tone}`}>{stage.label}</span></td>
                <td className="num">{editable && <>
                  <button className="admin-link-button" onClick={() => setDraft({ ...g })}>Editar</button>
                  <button className="admin-link-button is-danger" onClick={() => remove(g)}>Eliminar</button>
                </>}</td>
              </tr>
            );
          })}
          {!grants.length && <tr><td colSpan={7} className="admin-empty">Sin stock options.</td></tr>}
        </tbody>
      </table>
      {draft && (
        <div className="people-inline-form">
          <label className="admin-field"><span>Unidades</span><input type="number" value={draft.units ?? ""} onChange={(e) => setDraft({ ...draft, units: e.target.value })} /></label>
          <label className="admin-field"><span>Inicio vesting</span><input type="date" value={draft.vesting_start || ""} onChange={(e) => setDraft({ ...draft, vesting_start: e.target.value })} /></label>
          <label className="admin-field"><span>Cliff</span><input type="date" value={draft.cliff_date || ""} onChange={(e) => setDraft({ ...draft, cliff_date: e.target.value })} /></label>
          <label className="admin-field"><span>Vencimiento</span><input type="date" value={draft.expiration_date || ""} onChange={(e) => setDraft({ ...draft, expiration_date: e.target.value })} /></label>
          <label className="admin-checkbox"><input type="checkbox" checked={Boolean(draft.signed)} onChange={(e) => setDraft({ ...draft, signed: e.target.checked })} /> Firmado</label>
          <button className="admin-primary-button" onClick={save}>Guardar</button>
          <button className="admin-link-button" onClick={() => setDraft(null)}>Cancelar</button>
        </div>
      )}
      {error && <div className="board-doc-error" role="alert">{error}</div>}
      {editable && !draft && (
        <button className="people-secondary-button people-align-start" onClick={() => setDraft({ units: "", vesting_start: "", cliff_date: "", expiration_date: "", signed: false, status: "Active" })}>
          + Agregar stock options
        </button>
      )}
    </div>
  );
}

function PersonModal({ employee, privateData, grants, documents, photos, lines, periods, editable, patchLocal, onClose, isNew }) {
  const photoRef = useRef(null);
  const [editing, setEditing] = useState(Boolean(isNew));
  const [form, setForm] = useState({ ...employee });
  const [priv, setPriv] = useState({ ...(privateData || {}) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const history = useMemo(() => {
    const own = lines.filter((l) => l.employee_id === employee.id).sort((a, b) => a.period_id.localeCompare(b.period_id));
    const changes = [];
    for (const l of own) {
      const base = num(l.base_salary);
      if (base > 0 && (!changes.length || changes[changes.length - 1].base !== base)) changes.push({ period: l.period_id, base });
    }
    const exit = own.find((l) => l.exit_date);
    return { recent: own.slice(-12).reverse(), changes: changes.reverse(), exit, total: own.reduce((s, l) => s + lineTotal(l), 0), months: own.length };
  }, [lines, employee.id]);
  const statusOf = (pid) => periods.find((p) => p.id === pid)?.status;

  const save = async () => {
    setError(null);
    if (!form.name?.trim()) return setError("El nombre es obligatorio.");
    setBusy(true);
    try {
      const fields = Object.fromEntries(PUBLIC_FIELDS.flatMap(([, list]) => list.map(([k]) => [k, form[k] === "" ? null : form[k] ?? null])));
      fields.name = form.name.trim();
      fields.cost_type = form.cost_type || "OPEX";
      fields.base_salary = num(form.base_salary);
      fields.allowance = form.allowance == null ? 60 : num(form.allowance);
      const query = isNew
        ? supabase.from("people_employees").insert({ ...fields, active: true })
        : supabase.from("people_employees").update(fields).eq("id", employee.id);
      const { data, error: err } = await query.select().single();
      if (err) throw err;
      let privRow = privateData;
      if (editable) {
        const privFields = Object.fromEntries(PRIVATE_FIELDS.map(([k]) => [k, priv[k] === "" ? null : priv[k] ?? null]));
        const { data: p, error: e2 } = await supabase.from("people_private").upsert({ employee_id: data.id, ...privFields }).select().single();
        if (e2) throw e2;
        privRow = p;
      }
      patchLocal((d) => ({
        employees: isNew ? [...d.employees, data] : d.employees.map((e) => (e.id === data.id ? data : e)),
        privates: privRow ? [...d.privates.filter((p) => p.employee_id !== data.id), privRow] : d.privates,
      }));
      if (isNew) onClose(); else { setEditing(false); setForm({ ...data }); }
    } catch (err) {
      setError(err.message?.includes("people_employees_name_key") ? "Ya existe una persona con ese nombre." : err.message || "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  };

  const changePhoto = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) { setError("La foto debe ser PNG, JPG o WEBP de hasta 5 MB."); return; }
    setError(null);
    const path = `${employee.id}/${crypto.randomUUID()}.${file.type.split("/")[1]}`;
    const { error: upErr } = await supabase.storage.from("people-photos").upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) { setError(upErr.message); return; }
    const { data, error: err } = await supabase.from("people_employees").update({ photo_path: path }).eq("id", employee.id).select().single();
    if (err) { setError(err.message); return; }
    if (employee.photo_path) await supabase.storage.from("people-photos").remove([employee.photo_path]);
    const { data: signed } = await supabase.storage.from("people-photos").createSignedUrl(path, 3600);
    patchLocal((d) => ({ employees: d.employees.map((e) => (e.id === data.id ? data : e)), photos: { ...d.photos, [data.id]: signed?.signedUrl } }));
  };

  const toggleActive = async () => {
    const next = !employee.active;
    if (!window.confirm(next ? `¿Marcar a ${employee.name} como activa? Entrará en el próximo borrador de nómina.` : `¿Marcar a ${employee.name} como inactiva? No entrará en las próximas nóminas.`)) return;
    const { data, error: err } = await supabase.from("people_employees").update({ active: next, end_date: next ? null : employee.end_date || new Date().toISOString().slice(0, 10) }).eq("id", employee.id).select().single();
    if (err) return setError(err.message);
    patchLocal((d) => ({ employees: d.employees.map((e) => (e.id === data.id ? data : e)) }));
    setForm({ ...data });
  };

  return (
    <div className="people-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="people-modal is-wide" role="dialog" aria-label={`Ficha de ${employee.name || "nueva persona"}`}>
        <div className="people-person-header">
          <div className="people-photo-wrap">
            <PersonAvatar employee={isNew ? form : employee} photos={photos} size="large" />
            {editable && !isNew && <>
              <input ref={photoRef} type="file" className="sr-only" accept="image/png,image/jpeg,image/webp" onChange={changePhoto} />
              <button className="people-photo-button" onClick={() => photoRef.current?.click()}>Cambiar foto</button>
            </>}
          </div>
          <div>
            <h2>{isNew ? "Nueva persona" : employee.name}</h2>
            {!isNew && <div className="people-muted">{employee.role_title || "Sin cargo"} · {employee.area || "Sin área"} · {tenure(employee.start_date, employee.end_date)}</div>}
            {!isNew && <span className={`people-chip is-${employee.active ? "good" : "muted"}`}>{employee.active ? "Activa" : "Inactiva"}</span>}
          </div>
          <div className="people-person-actions">
            {editable && !isNew && !editing && <button className="people-secondary-button" onClick={toggleActive}>{employee.active ? "Marcar inactiva" : "Marcar activa"}</button>}
            {editable && !editing && <button className="admin-primary-button" onClick={() => setEditing(true)}>Editar</button>}
            {editing && <button className="admin-primary-button" disabled={busy} onClick={save}>{busy ? "Guardando…" : "Guardar"}</button>}
            {editing && !isNew && <button className="admin-link-button" onClick={() => { setEditing(false); setForm({ ...employee }); setPriv({ ...(privateData || {}) }); }}>Cancelar</button>}
            <button className="admin-link-button" onClick={onClose}>Cerrar</button>
          </div>
        </div>
        {error && <div className="board-doc-error" role="alert">{error}</div>}

        {PUBLIC_FIELDS.map(([title, fields]) => (
          <section key={title} className="people-person-section">
            <h3>{title}</h3>
            <FieldGrid fields={fields} values={form} editing={editing} onChange={(k, v) => setForm((f) => ({ ...f, [k]: v }))} />
          </section>
        ))}

        <section className="people-person-section">
          <h3>Datos personales y bancarios <span className="people-muted">· solo editores de People</span></h3>
          {editable
            ? <FieldGrid fields={PRIVATE_FIELDS} values={priv} editing={editing} onChange={(k, v) => setPriv((p) => ({ ...p, [k]: v }))} />
            : <p className="admin-note">Tu acceso a People es de solo lectura; estos datos no se muestran.</p>}
        </section>

        {!isNew && (
          <>
            <section className="people-person-section">
              <h3>Documentos <span className="people-muted">· solo editores de People</span></h3>
              {editable
                ? <DocumentsSection employeeId={employee.id} documents={documents} patchLocal={patchLocal} />
                : <p className="admin-note">Tu acceso a People es de solo lectura; los contratos no se muestran.</p>}
            </section>
            <section className="people-person-section">
              <h3>Stock options</h3>
              <GrantsEditor employeeId={employee.id} grants={grants} editable={editable} patchLocal={patchLocal} />
            </section>
            <section className="people-person-section">
              <h3>Historial de nómina <span className="people-muted">· {history.months} meses · {usd(history.total)} pagados</span></h3>
              {history.exit && (
                <div className="people-exit-note">
                  {history.exit.exit_type === "voluntario" ? "Renuncia" : "Retiro involuntario"} el {fmtDate(history.exit.exit_date)}{history.exit.liquidation ? ` · liquidación ${usd(num(history.exit.liquidation.total), 2)}` : " · sin liquidación"} en la nómina de {history.exit.period_id}
                </div>
              )}
              <div className="people-history">
                <div>
                  <h4>Cambios de salario base</h4>
                  <ul className="people-movements">
                    {history.changes.map((c) => <li key={c.period}><span>{MONTH_NAMES[+c.period.slice(5) - 1]} {c.period.slice(0, 4)}</span><b>{usd(c.base, 0)}</b></li>)}
                    {!history.changes.length && <li className="people-muted">Sin datos de salario.</li>}
                  </ul>
                </div>
                <div>
                  <h4>Últimos pagos</h4>
                  <ul className="people-movements">
                    {history.recent.map((l) => (
                      <li key={l.id}><span>{MONTH_NAMES[+l.period_id.slice(5) - 1]} {l.period_id.slice(0, 4)}{statusOf(l.period_id) === "draft" ? " · borrador" : ""}</span><b>{usd(lineTotal(l), 2)}</b></li>
                    ))}
                    {!history.recent.length && <li className="people-muted">Sin pagos registrados.</li>}
                  </ul>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

export default function DirectoryView({ employees, privates, grants, documents, photos, lines, periods, editable, patchLocal }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [area, setArea] = useState("");
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const areas = useMemo(() => [...new Set(employees.map((e) => e.area || "Sin área"))].sort(), [employees]);
  const unitsBy = useMemo(() => {
    const m = {}; for (const g of grants) m[g.employee_id] = (m[g.employee_id] || 0) + num(g.units); return m;
  }, [grants]);

  const list = employees
    .filter((e) => (status === "all" ? true : status === "active" ? e.active : !e.active))
    .filter((e) => !area || (e.area || "Sin área") === area)
    .filter((e) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return [e.name, e.legal_name, e.role_title, e.work_email, e.personal_email, e.city].some((v) => v && v.toLowerCase().includes(q));
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const thisMonth = new Date().getMonth() + 1;
  const birthdays = employees.filter((e) => e.active && e.birth_date && +e.birth_date.slice(5, 7) === thisMonth)
    .sort((a, b) => a.birth_date.slice(8).localeCompare(b.birth_date.slice(8)));
  const open = employees.find((e) => e.id === openId);

  return (
    <div>
      <div className="people-kpi-grid is-compact">
        <div className="people-kpi"><div className="people-kpi-label">Personas activas</div><div className="people-kpi-value">{employees.filter((e) => e.active).length}</div><div className="people-kpi-sub">{employees.length} en el directorio</div></div>
        <div className="people-kpi"><div className="people-kpi-label">Stock options asignadas</div><div className="people-kpi-value">{grants.reduce((s, g) => s + num(g.units), 0).toLocaleString("es-CO")}</div><div className="people-kpi-sub">{new Set(grants.map((g) => g.employee_id)).size} personas</div></div>
        <div className="people-kpi"><div className="people-kpi-label">Cumpleaños en {MONTH_NAMES[thisMonth - 1].toLowerCase()}</div>
          <div className="people-kpi-sub people-birthdays">{birthdays.length ? birthdays.map((e) => `${e.name.split(" ")[0]} (${+e.birth_date.slice(8)})`).join(" · ") : "Ninguno"}</div>
        </div>
      </div>

      <div className="people-filters">
        <label className="people-search">Buscar<input type="search" placeholder="Nombre, cargo, correo, ciudad" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
        <label>Estado
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">Activas</option><option value="inactive">Inactivas</option><option value="all">Todas</option>
          </select>
        </label>
        <label>Área
          <select value={area} onChange={(e) => setArea(e.target.value)}>
            <option value="">Todas</option>{areas.map((a) => <option key={a}>{a}</option>)}
          </select>
        </label>
        {editable && <button className="admin-primary-button" onClick={() => setCreating(true)}>+ Nueva persona</button>}
      </div>

      <div className="people-table-wrap">
        <table className="people-table people-directory">
          <thead>
            <tr><th>Persona</th><th>Área · tipo</th><th>Ingreso</th><th>Contacto</th><th>Cumpleaños</th><th className="num">Stock options</th><th>Estado</th></tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id} className="is-clickable" onClick={() => setOpenId(e.id)}>
                <td>
                  <div className="people-directory-person">
                    <PersonAvatar employee={e} photos={photos} />
                    <div><div className="people-person">{e.name}</div><div className="people-muted">{e.role_title || "—"}</div></div>
                  </div>
                </td>
                <td>{e.area || "Sin área"} <span className="people-muted">· {e.cost_type}</span></td>
                <td>{fmtDate(e.start_date)}<div className="people-muted">{tenure(e.start_date, e.end_date)}</div></td>
                <td>{e.work_email || e.personal_email || "—"}<div className="people-muted">{[e.phone, e.city].filter(Boolean).join(" · ")}</div></td>
                <td>{birthday(e.birth_date)}</td>
                <td className="num">{unitsBy[e.id] ? unitsBy[e.id].toLocaleString("es-CO") : "—"}</td>
                <td><span className={`people-chip is-${e.active ? "good" : "muted"}`}>{e.active ? "Activa" : e.end_date ? `Salió ${fmtDate(e.end_date, { month: "short", year: "numeric" })}` : "Inactiva"}</span></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={7} className="admin-empty">Nadie coincide con los filtros.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="admin-note">Haz clic en una persona para ver su ficha. Los datos personales y bancarios solo los ven quienes pueden editar People.</p>

      {open && (
        <PersonModal key={open.id} employee={open} privateData={privates.find((p) => p.employee_id === open.id)}
          grants={grants.filter((g) => g.employee_id === open.id)} documents={documents.filter((d) => d.employee_id === open.id)} photos={photos} lines={lines} periods={periods}
          editable={editable} patchLocal={patchLocal} onClose={() => setOpenId(null)} />
      )}
      {creating && (
        <PersonModal isNew employee={{ name: "", cost_type: "OPEX", allowance: 60, active: true }} privateData={null} grants={[]} documents={[]} photos={photos} lines={[]} periods={periods}
          editable={editable} patchLocal={patchLocal} onClose={() => setCreating(false)} />
      )}
    </div>
  );
}
