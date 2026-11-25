import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import "./people.css";
import { fmtDate, fmtUnits, fmtPrice, fmtUsd, grantStage, REQUEST_STATUS, METHOD_LABEL, availableUnits } from "./esop";
import { EsopRequestForm, openSignedDocument } from "./EsopForm";

const SECTIONS = [
  { id: "esop", label: "Stock options", icon: "◔", title: "Mis stock options", text: "Tus opciones, cuántas puedes comprar hoy y tus solicitudes de compra." },
];

/** Portal for every collaborator: only their own data (esop_self). More requests will be added here. */
export default function SelfServiceWorkspace() {
  const [section, setSection] = useState("esop");
  const [data, setData] = useState(undefined);
  const [error, setError] = useState(null);
  const [requesting, setRequesting] = useState(null);
  const [done, setDone] = useState(false);
  const current = SECTIONS.find((s) => s.id === section);

  const load = async () => {
    const { data: d, error: err } = await supabase.rpc("esop_self");
    if (err) setError(err.message); else setData(d);
  };
  useEffect(() => { load(); }, []);

  const grants = data?.grants || [];
  const requests = data?.requests || [];

  return (
    <section className="board-workspace">
      <aside className="board-section-nav" aria-label="Mis solicitudes">
        <div className="board-section-nav-title">MIS SOLICITUDES</div>
        {SECTIONS.map((s) => (
          <button key={s.id} className={`board-section-link${section === s.id ? " is-active" : ""}`} aria-current={section === s.id ? "page" : undefined} onClick={() => setSection(s.id)}>
            <span className="board-section-icon" aria-hidden="true">{s.icon}</span> {s.label}
          </button>
        ))}
      </aside>
      <div className="board-section-content">
        <div className="board-docs-heading">
          <div>
            <div className="board-eyebrow">MIS SOLICITUDES · {data?.employee?.name?.toUpperCase() || ""}</div>
            <h1>{current.title}</h1>
            <p>{current.text}</p>
          </div>
        </div>
        {error && <div className="board-doc-error" role="alert">{error}</div>}
        {data === undefined ? <div className="board-empty-state">Cargando…</div> : data === null ? (
          <div className="board-empty-state">Tu usuario aún no está vinculado a tu ficha de colaborador. Escríbele al equipo de People para que registre este correo en tu ficha.</div>
        ) : requesting ? (
          <div className="esop-portal-form">
            <h2 className="esop-title">Solicitud de compra de acciones</h2>
            <p className="admin-note">Puedes comprar hasta <b>{fmtUnits(requesting.available)}</b> acciones habilitadas de esta asignación. Llena el formato, léelo y fírmalo.</p>
            <EsopRequestForm employee={data.employee} grant={requesting.g} available={requesting.available} settings={data.settings}
              onCancel={() => setRequesting(null)} onDone={() => { setRequesting(null); setDone(true); load(); }} />
          </div>
        ) : (
          <>
            {done && <div className="admin-notice" role="status">Tu solicitud quedó firmada y enviada. People la revisará y te informará el precio por acción al aprobarla.</div>}
            <div className="admin-table-wrap">
              <table className="people-table">
                <thead><tr><th>Tipo</th><th className="num">Asignadas</th><th>Inicio</th><th>Cliff</th><th>Vencimiento</th><th>Estado</th><th className="num">Habilitadas</th><th className="num">Compradas</th><th className="num">Disponibles</th><th /></tr></thead>
                <tbody>
                  {grants.map((g) => {
                    const st = grantStage(g);
                    const available = availableUnits(g, Number(g.used));
                    return (
                      <tr key={g.id}>
                        <td>{g.grant_type}</td>
                        <td className="num">{fmtUnits(g.units)}</td>
                        <td>{fmtDate(g.vesting_start)}</td><td>{fmtDate(g.cliff_date)}</td><td>{fmtDate(g.expiration_date)}</td>
                        <td><span className={`people-chip is-${st.tone}`}>{st.label}</span></td>
                        <td className="num">{g.grant_type === "Stock options" ? fmtUnits(g.purchasable) : "—"}</td>
                        <td className="num">{fmtUnits(g.bought)}</td>
                        <td className="num">{fmtUnits(available)}</td>
                        <td className="admin-row-actions">{available > 0 && <button className="admin-primary-button" onClick={() => { setDone(false); setRequesting({ g, available }); }}>Solicitar compra</button>}</td>
                      </tr>
                    );
                  })}
                  {!grants.length && <tr><td colSpan={10} className="admin-empty">No tienes stock options registradas.</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="admin-note">En la fecha del cliff puedes comprar hasta el 25% de tu asignación; el 75% restante se habilita mes a mes durante los 2 años siguientes. Puedes comprar mes a mes, cuando quieras, dentro de lo habilitado. Puedes pagar con deducción de nómina en cuotas o con transferencia a la cuenta de Celes. El precio por acción lo define la Compañía al aprobar cada compra.</p>

            <h2 className="esop-title">Mis solicitudes</h2>
            <div className="admin-table-wrap">
              <table className="people-table">
                <thead><tr><th>Fecha</th><th className="num">Acciones</th><th className="num">Precio</th><th className="num">Total</th><th>Forma de pago</th><th>Estado</th><th /></tr></thead>
                <tbody>
                  {requests.map((r) => {
                    const st = REQUEST_STATUS[r.status];
                    return (
                      <tr key={r.id}>
                        <td>{fmtDate(r.requested_at)}</td>
                        <td className="num">{fmtUnits(r.units)}</td>
                        <td className="num">{r.price != null ? fmtPrice(r.price) : "Por definir"}</td>
                        <td className="num">{r.amount != null ? fmtUsd(r.amount) : "—"}</td>
                        <td>{METHOD_LABEL[r.payment_method]}{r.payment_method === "payroll" ? ` · ${r.installments_paid}/${r.installments} cuotas` : ""}</td>
                        <td><span className={`people-chip is-${st.tone}`}>{st.label}</span>{r.decision_note && <><br /><small className="people-muted">{r.decision_note}</small></>}</td>
                        <td className="admin-row-actions">{r.signed_at && <button className="admin-link-button" onClick={() => openSignedDocument(r.id)}>Ver formato</button>}</td>
                      </tr>
                    );
                  })}
                  {!requests.length && <tr><td colSpan={7} className="admin-empty">Aún no has hecho solicitudes.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
