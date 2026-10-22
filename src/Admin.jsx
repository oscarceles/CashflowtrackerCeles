import React, { useEffect, useMemo, useState } from "react";
import { listMembers, addMember, updateMember, removeMember } from "./supabaseClient";
import { MODULES, ROLES, roleName, moduleAccess, useMember } from "./access";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emptyMember = { email: "", full_name: "", role: "colaborador", modules: {} };

// Stored modules are normalised per role so the record always matches what the
// role can actually do (the database applies the same rules in module_access()).
function normaliseModules(role, modules) {
  if (role === "super_admin") return {};
  if (role === "board_member") return { board: "view" };
  const result = {};
  for (const { id } of MODULES) {
    const value = modules?.[id];
    if (value !== "view" && value !== "edit") continue;
    result[id] = role === "colaborador" ? "view" : value;
  }
  return result;
}

function accessSummary(member) {
  return MODULES
    .map((module) => ({ module, access: moduleAccess(member, module.id) }))
    .filter((item) => item.access);
}

function MemberForm({ initial, isNew, onSave, onCancel, busy }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState(null);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const setModule = (id, value) => setForm((current) => {
    const modules = { ...current.modules };
    if (value) modules[id] = value; else delete modules[id];
    return { ...current, modules };
  });

  const submit = (event) => {
    event.preventDefault();
    setError(null);
    const email = form.email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) return setError("Escribe un correo válido.");
    const modules = normaliseModules(form.role, form.modules);
    if ((form.role === "admin" || form.role === "colaborador") && !Object.keys(modules).length) {
      return setError("Elige al menos un módulo para este rol.");
    }
    onSave({ ...form, email, modules });
  };

  return (
    <form className="admin-member-form" onSubmit={submit}>
      <div className="admin-form-header">
        <h2>{isNew ? "Agregar miembro" : "Editar miembro"}</h2>
        <button type="button" className="admin-link-button" onClick={onCancel}>Cancelar</button>
      </div>

      <div className="admin-form-grid">
        <label className="admin-field">
          <span>Correo</span>
          <input type="email" required autoComplete="off" value={form.email} disabled={!isNew}
            placeholder="nombre@celes.ai" onChange={(event) => set("email", event.target.value)} />
        </label>
        <label className="admin-field">
          <span>Nombre (opcional)</span>
          <input type="text" maxLength={120} value={form.full_name || ""}
            onChange={(event) => set("full_name", event.target.value)} />
        </label>
      </div>

      <fieldset className="admin-fieldset">
        <legend>Rol</legend>
        <div className="admin-role-options">
          {ROLES.map((role) => (
            <label key={role.id} className={`admin-role-option${form.role === role.id ? " is-selected" : ""}`}>
              <input type="radio" name="role" value={role.id} checked={form.role === role.id}
                onChange={() => set("role", role.id)} />
              <span className="admin-role-name">{role.name}</span>
              <span className="admin-role-description">{role.description}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="admin-fieldset">
        <legend>Módulos</legend>
        {form.role === "super_admin" ? (
          <p className="admin-note">Acceso total: ve y edita todos los módulos y administra miembros.</p>
        ) : form.role === "board_member" ? (
          <p className="admin-note">Solo lectura de Board (documentos y tareas). No puede editar ni ver otros módulos.</p>
        ) : (
          <div className="admin-module-grid">
            {MODULES.map((module) => {
              const value = form.modules?.[module.id] || "";
              return (
                <div key={module.id} className="admin-module-row">
                  <span className="admin-module-name">{module.name}</span>
                  {form.role === "admin" ? (
                    <select value={value} onChange={(event) => setModule(module.id, event.target.value)}
                      aria-label={`Acceso a ${module.name}`}>
                      <option value="">Sin acceso</option>
                      <option value="view">Ver</option>
                      <option value="edit">Ver y editar</option>
                    </select>
                  ) : (
                    <label className="admin-checkbox">
                      <input type="checkbox" checked={Boolean(value)}
                        onChange={(event) => setModule(module.id, event.target.checked ? "view" : "")} />
                      Ver
                    </label>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </fieldset>

      {error && <div className="board-doc-error" role="alert">{error}</div>}

      <div className="admin-form-actions">
        <button type="submit" className="admin-primary-button" disabled={busy}>
          {busy ? "Guardando…" : isNew ? "Agregar miembro" : "Guardar cambios"}
        </button>
      </div>
    </form>
  );
}

function MembersView() {
  const me = useMember();
  const [members, setMembers] = useState(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState(null); // { member, isNew }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    setError(null);
    try {
      setMembers(await listMembers());
    } catch (err) {
      setError(err.message || "No se pudo cargar la lista de miembros.");
    }
  };
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => (members || []).filter((member) =>
    `${member.email} ${member.full_name || ""} ${roleName(member.role)}`.toLowerCase().includes(search.toLowerCase())
  ), [members, search]);

  const save = async (form) => {
    setBusy(true);
    setError(null);
    try {
      if (editing.isNew) {
        if (members?.some((member) => member.email === form.email)) throw new Error("Ese correo ya es miembro.");
        await addMember(form, me.email);
      } else {
        await updateMember(form.email, form, me.email);
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message || "No se pudo guardar el miembro.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (member) => {
    if (!window.confirm(`¿Quitar el acceso de ${member.email}? Ya no podrá ingresar a la plataforma.`)) return;
    setBusy(true);
    setError(null);
    try {
      await removeMember(member.email);
      await load();
    } catch (err) {
      setError(err.message || "No se pudo quitar el acceso.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-members">
      <div className="board-docs-heading">
        <div>
          <div className="board-eyebrow">ADMINISTRACIÓN · MIEMBROS</div>
          <h1>Miembros</h1>
          <p>Solo las personas de esta lista pueden ingresar. El rol define qué módulos ven y editan.</p>
        </div>
        <div className="board-doc-count">{members ? `${members.length} miembros` : "…"}</div>
      </div>

      {error && <div className="board-doc-error" role="alert">{error}</div>}

      {editing ? (
        <MemberForm key={editing.member.email || "new"} initial={editing.member} isNew={editing.isNew}
          busy={busy} onSave={save} onCancel={() => setEditing(null)} />
      ) : (
        <>
          <div className="admin-toolbar">
            <input className="admin-search" type="search" placeholder="Buscar por correo, nombre o rol"
              value={search} onChange={(event) => setSearch(event.target.value)} />
            <button className="admin-primary-button" onClick={() => setEditing({ member: { ...emptyMember }, isNew: true })}>
              + Agregar miembro
            </button>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr><th>Miembro</th><th>Rol</th><th>Acceso</th><th aria-label="Acciones" /></tr>
              </thead>
              <tbody>
                {!members ? (
                  <tr><td colSpan={4} className="admin-empty">Cargando…</td></tr>
                ) : !visible.length ? (
                  <tr><td colSpan={4} className="admin-empty">No hay miembros que coincidan.</td></tr>
                ) : visible.map((member) => {
                  const isMe = member.email === me?.email;
                  return (
                    <tr key={member.email}>
                      <td>
                        <div className="admin-member-name">{member.full_name || member.email}{isMe && <span className="admin-you">tú</span>}</div>
                        {member.full_name && <div className="admin-member-email">{member.email}</div>}
                      </td>
                      <td><span className={`admin-role-badge role-${member.role}`}>{roleName(member.role)}</span></td>
                      <td>
                        <div className="admin-access-list">
                          {accessSummary(member).map(({ module, access }) => (
                            <span key={module.id} className={`admin-access-chip is-${access}`}>
                              {module.name} · {access === "edit" ? "Editar" : "Ver"}
                            </span>
                          ))}
                          {member.role === "super_admin" && <span className="admin-access-chip is-edit">Miembros · Administrar</span>}
                          {!accessSummary(member).length && <span className="admin-member-email">Sin módulos</span>}
                        </div>
                      </td>
                      <td className="admin-row-actions">
                        <button className="admin-link-button" disabled={busy || isMe}
                          title={isMe ? "Otro Super Admin debe cambiar tu rol" : "Editar miembro"}
                          onClick={() => setEditing({ member: { ...member, modules: { ...(member.modules || {}) } }, isNew: false })}>
                          Editar
                        </button>
                        <button className="admin-link-button is-danger" disabled={busy || isMe}
                          title={isMe ? "Otro Super Admin debe quitar tu acceso" : "Quitar acceso"}
                          onClick={() => remove(member)}>
                          Quitar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="admin-note">
            Los cambios aplican de inmediato en la base de datos y en Board; la interfaz de la persona se
            actualiza al recargar la página. Nadie puede cambiar su propio rol ni quitarse a sí mismo.
          </p>
        </>
      )}
    </div>
  );
}

export default function AdminWorkspace() {
  return (
    <section className="board-workspace">
      <aside className="board-section-nav" aria-label="Secciones de Administración">
        <div className="board-section-nav-title">ADMINISTRACIÓN</div>
        <button className="board-section-link is-active" aria-current="page">
          <span className="board-section-icon" aria-hidden="true">◈</span> Miembros
        </button>
      </aside>
      <div className="board-section-content">
        <MembersView />
      </div>
    </section>
  );
}
