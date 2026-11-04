import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";
import { readSpreadsheet } from "./sheetReader";
import { applyMapping, defaultChart, parseErpExport } from "./erpImport";
import { importToValues, prepareImport } from "./ConsolidationImport";

const fmt = (n, decimals = 2) => (Number.isFinite(n) ? n : 0).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
const when = (iso) => new Date(iso).toLocaleString("es-CO", { dateStyle: "medium", timeStyle: "short" });

async function callErp(payload) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("La sesión expiró: vuelve a iniciar sesión.");
  const response = await fetch("/.netlify/functions/erp-connections", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Error ${response.status}`);
  return body;
}

const decodeBase64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

/** Leaf accounts whose balance differs between the ERP report and the import already loaded for the month. */
function compareImports(fetched, loaded) {
  if (!loaded) return null;
  const leaves = (imp) => new Map(imp.accounts.filter((a) => a.leaf).map((a) => [a.code, a]));
  const a = leaves(fetched), b = leaves(loaded);
  const rows = [];
  for (const code of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(code), y = b.get(code);
    const diff = (x?.balance || 0) - (y?.balance || 0);
    if (Math.abs(diff) > 0.5) rows.push({ code, name: x?.name || y?.name, erp: x ? x.balance : null, loaded: y ? y.balance : null, diff });
  }
  return { rows: rows.sort((p, q) => Math.abs(q.diff) - Math.abs(p.diff)), file: loaded.file, compared: a.size };
}

function ConnectionCard({ connection, entity, entities, model, periodId, periodName, maps, editable, member, onSave }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [test, setTest] = useState(null);
  const [fetched, setFetched] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [applied, setApplied] = useState(null);
  const entry = model.entry(periodId, entity.id);
  const loaded = entry?.values?.import;

  useEffect(() => { setFetched(null); setApplied(null); setError(null); }, [periodId]);

  const run = async (kind, fn) => {
    setBusy(kind); setError(null);
    try { await fn(); } catch (e) { setError(e.message || String(e)); } finally { setBusy(null); }
  };

  const testConnection = () => run("test", async () => setTest(await callErp({ action: "test", entityId: entity.id })));

  const fetchTrialBalance = () => run("fetch", async () => {
    setApplied(null);
    const res = await callErp({ action: "trial-balance", entityId: entity.id, periodId });
    const buffer = decodeBase64(res.contentBase64);
    const parsed = parseErpExport(await readSpreadsheet({ name: res.fileName, arrayBuffer: async () => buffer }), res.fileName, { periodId });
    const chart = loaded?.chart || defaultChart(entity);
    const imp = { ...prepareImport([parsed], { periodId, chart, by: member?.email }), source: { provider: res.provider, fetched_at: res.fetchedAt } };
    const check = applyMapping(imp, maps, { entity, entities, periodYear: +periodId.slice(0, 4) });
    setFetched({ imp, check, meta: res });
  });

  const useInFinancials = () => run("apply", async () => {
    if (loaded && !window.confirm(`${entity.name} ya tiene una importación en ${periodName} (${loaded.file}). ¿Reemplazarla por la balanza traída de ${connection.label}?`)) return;
    await onSave(entity.id, importToValues({ values: entry?.values || {}, imp: fetched.imp, maps, entity, entities, model, periodId }), "loaded");
    setApplied(new Date().toISOString());
  });

  const comparison = useMemo(() => (fetched ? compareImports(fetched.imp, loaded) : null), [fetched, loaded]);
  const leaves = fetched ? fetched.imp.accounts.filter((a) => a.leaf) : [];
  const trialOk = fetched && Math.abs(fetched.check.trialDifference) <= 1;
  const periodOk = fetched && fetched.imp.meta?.from === `${periodId}-01`;

  return (
    <section className="cons-card cons-erp">
      <div className="cons-card-head">
        <h3>{entity.name} <span className="people-muted">· {connection.label} ({entity.currency})</span></h3>
        <span className={`people-chip is-${connection.configured ? "good" : "bad"}`}>{connection.configured ? "Credenciales configuradas" : "Sin credenciales"}</span>
      </div>

      <div className="cons-import-controls">
        <button className="people-secondary-button" disabled={!!busy || !connection.configured} onClick={testConnection}>{busy === "test" ? "Probando…" : "Probar conexión"}</button>
        <button className="admin-primary-button" disabled={!!busy || !connection.configured} onClick={fetchTrialBalance}>{busy === "fetch" ? "Trayendo…" : `Traer balanza de ${periodName}`}</button>
        {test && <span className="people-muted" role="status">✓ Conectado a {test.provider} · {when(test.testedAt)} · {test.ms} ms</span>}
      </div>
      {error && <div className="board-doc-error" role="alert">{error}</div>}

      {fetched && (
        <>
          <div className="cons-import-summary">
            <div><span>Empresa</span><b>{fetched.imp.meta?.company || "—"}</b></div>
            <div><span>Período del reporte</span><b className={periodOk ? "" : "is-bad"}>{fetched.imp.meta?.from ? `${fetched.imp.meta.from} → ${fetched.imp.meta.to}` : "no indicado"}</b></div>
            <div><span>Cuentas</span><b>{leaves.length} de detalle · {fetched.imp.accounts.length} total</b></div>
            <div><span>Débitos − créditos</span><b className={trialOk ? "is-good" : "is-bad"}>{trialOk ? "0 ✓" : fmt(fetched.check.trialDifference)}</b></div>
            <div><span>Resultados</span><b>{fetched.imp.basis === "month" ? "Movimientos del mes" : "Acumulados del año"}</b></div>
            <div><span>Traído</span><b>{when(fetched.meta.fetchedAt)}</b></div>
            <div>
              <span>Contra lo cargado en {periodName}</span>
              <b className={!comparison ? "" : comparison.rows.length ? "is-bad" : "is-good"}>
                {!comparison ? "No hay importación cargada" : comparison.rows.length ? `${comparison.rows.length} cuentas con diferencia` : `Coinciden las ${comparison.compared} cuentas ✓`}
              </b>
            </div>
          </div>

          {comparison && comparison.rows.length > 0 && (
            <div className="admin-table-wrap">
              <table className="admin-table cons-table">
                <thead><tr><th>Código</th><th>Cuenta</th><th className="num">{connection.label}</th><th className="num">Cargado ({comparison.file})</th><th className="num">Diferencia</th></tr></thead>
                <tbody>
                  {comparison.rows.slice(0, 50).map((r) => (
                    <tr key={r.code}>
                      <td className="cons-map-code">{r.code}</td><td>{r.name}</td>
                      <td className="num">{r.erp == null ? "—" : fmt(r.erp)}</td><td className="num">{r.loaded == null ? "—" : fmt(r.loaded)}</td><td className="num">{fmt(r.diff)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="cons-import-controls">
            <button className="admin-link-button" onClick={() => setShowAll(!showAll)}>{showAll ? "Ocultar cuentas" : `Ver las ${leaves.length} cuentas del reporte`}</button>
            {editable
              ? <button className="admin-primary-button" disabled={!!busy || !trialOk} onClick={useInFinancials}>{busy === "apply" ? "Guardando…" : "Usar en Financials"}</button>
              : <span className="people-muted">{periodName} está cerrado o es de solo lectura: no se puede cargar.</span>}
            {applied && <span className="people-muted" role="status">✓ Cargado en {entity.name} · {periodName}. Revisa las asignaciones en Entidades.</span>}
          </div>

          {showAll && (
            <div className="admin-table-wrap">
              <table className="admin-table cons-table">
                <thead><tr><th>Código</th><th>Cuenta</th><th className="num">Saldo inicial</th><th className="num">Débito</th><th className="num">Crédito</th><th className="num">Saldo final</th></tr></thead>
                <tbody>
                  {leaves.map((a) => (
                    <tr key={a.code}>
                      <td className="cons-map-code">{a.code}</td><td>{a.name}</td>
                      <td className="num">{fmt(a.opening)}</td><td className="num">{fmt(a.debit)}</td><td className="num">{fmt(a.credit)}</td><td className="num">{fmt(a.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** Board → Financials → "Conexiones ERP (prueba)": pulls an entity's trial balance straight from its ERP. */
export default function ErpConnectionsTab({ model, periodId, periodName, entities, maps, editable, member, onSave }) {
  const [connections, setConnections] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    callErp({ action: "status" }).then((r) => setConnections(r.connections)).catch((e) => setError(e.message || String(e)));
  }, []);

  return (
    <div>
      <p className="admin-note">
        Prueba de conexión directa con el ERP de cada entidad (solo lectura). Trae la balanza de comprobación del mes seleccionado,
        la compara con la que ya está cargada y, si cuadra, permite usarla en Financials como si se hubiera subido el archivo:
        se aplican las mismas asignaciones de cuentas. Las credenciales del ERP están solo en el servidor.
      </p>
      {error && <div className="board-doc-error" role="alert">{error}</div>}
      {!connections && !error && <div className="board-empty-state">Cargando conexiones…</div>}
      {connections?.map((c) => {
        const entity = entities.find((e) => e.id === c.entityId);
        if (!entity) return null;
        return (
          <ConnectionCard key={c.entityId} connection={c} entity={entity} entities={entities} model={model} periodId={periodId} periodName={periodName}
            maps={maps[entity.id] || {}} editable={editable} member={member} onSave={onSave} />
        );
      })}
      <p className="admin-note">Celes Technologies (QuickBooks Online) y Xeles todavía no tienen conexión: se siguen cargando con archivos en Entidades.</p>
    </div>
  );
}
