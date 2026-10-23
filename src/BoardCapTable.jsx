import React, { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";

const SHARE_CLASSES = ["Common", "Series A Preferred", "Seed Preferred", "SAFE", "Option pool (granted)", "Option pool (available)", "Warrants", "Otra"];

const fmtShares = (n) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 4 });
const fmtPct = (n) => `${(n * 100).toFixed(2)}%`;
const fmtUpdated = (iso) => new Date(iso).toLocaleString("es-CO", { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" });

function downloadCsv(rows) {
  const csv = rows.map((r) => r.map((c) => { const s = String(c ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = `cap-table-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

function Cell({ value, onCommit, disabled, type = "text", width }) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => { setText(value ?? ""); }, [value]);
  const commit = () => { const next = type === "number" ? Number(text || 0) : text.trim(); if (next !== (value ?? (type === "number" ? 0 : ""))) onCommit(next); };
  return (
    <input className="cap-cell" type={type} value={text} disabled={disabled} style={width ? { width } : undefined}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setText(value ?? ""); e.currentTarget.blur(); } }} />
  );
}

/** Cap Table: holders by share class with the date of the last change always visible. */
export default function CapTableView({ editable }) {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    const [{ data: list, error: e1 }, { data: m, error: e2 }] = await Promise.all([
      supabase.from("board_cap_table").select("*").order("sort_order").order("created_at"),
      supabase.from("board_cap_table_meta").select("updated_at, updated_by").eq("id", 1).maybeSingle(),
    ]);
    if (e1 || e2) setError((e1 || e2).message);
    else { setRows(list || []); setMeta(m); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const refreshMeta = async () => {
    const { data } = await supabase.from("board_cap_table_meta").select("updated_at, updated_by").eq("id", 1).maybeSingle();
    if (data) setMeta(data);
  };

  const update = async (row, patch) => {
    setError(null);
    setRows((list) => list.map((r) => (r.id === row.id ? { ...r, ...patch } : r)));
    const { data, error: err } = await supabase.from("board_cap_table").update(patch).eq("id", row.id).select().single();
    if (err) { setError(err.message); load(); return; }
    setRows((list) => list.map((r) => (r.id === row.id ? data : r)));
    refreshMeta();
  };

  const add = async () => {
    setError(null);
    const { data, error: err } = await supabase.from("board_cap_table")
      .insert({ holder: "Nuevo accionista", share_class: "Common", shares: 0, sort_order: rows.length }).select().single();
    if (err) { setError(err.message); return; }
    setRows((list) => [...list, data]);
    refreshMeta();
  };

  const remove = async (row) => {
    if (!window.confirm(`¿Eliminar a "${row.holder}" (${row.share_class}) de la cap table?`)) return;
    setError(null);
    const { error: err } = await supabase.from("board_cap_table").delete().eq("id", row.id);
    if (err) { setError(err.message); return; }
    setRows((list) => list.filter((r) => r.id !== row.id));
    refreshMeta();
  };

  const total = rows.reduce((s, r) => s + Number(r.shares || 0), 0);
  const byClass = Object.entries(rows.reduce((m, r) => ({ ...m, [r.share_class]: (m[r.share_class] || 0) + Number(r.shares || 0) }), {}))
    .sort((a, b) => b[1] - a[1]);
  const byHolder = Object.values(rows.reduce((m, r) => {
    const k = r.holder.trim().toLowerCase();
    m[k] = m[k] || { holder: r.holder, shares: 0 };
    m[k].shares += Number(r.shares || 0);
    return m;
  }, {})).sort((a, b) => b.shares - a.shares);

  return (
    <div className="board-docs">
      <div className="board-docs-heading">
        <div>
          <div className="board-eyebrow">BOARD · CAP TABLE</div>
          <h1>Cap Table</h1>
          <p>Participación por accionista y clase de acción, sobre el total de acciones registradas (fully diluted si incluye el pool de opciones).</p>
        </div>
        <div className="cap-updated" role="status">
          <span>Última actualización</span>
          <b>{meta?.updated_at ? fmtUpdated(meta.updated_at) : "Sin cambios registrados"}</b>
          {meta?.updated_by && <small>por {meta.updated_by}</small>}
        </div>
      </div>

      {error && <div className="board-doc-error" role="alert">{error}</div>}

      {loading ? <div className="board-empty-state">Cargando…</div> : (
        <>
          <div className="cap-summary">
            <div><span>Total de acciones</span><b>{fmtShares(total)}</b></div>
            <div><span>Accionistas</span><b>{byHolder.length}</b></div>
            {byClass.slice(0, 3).map(([cls, n]) => (
              <div key={cls}><span>{cls}</span><b>{total ? fmtPct(n / total) : "—"}</b></div>
            ))}
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table cap-table">
              <thead>
                <tr><th>Accionista</th><th>Clase de acción</th><th className="num">Acciones</th><th className="num">% del total</th><th>Notas</th><th aria-label="Acciones" /></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{editable ? <Cell value={r.holder} onCommit={(v) => v && update(r, { holder: v })} /> : r.holder}</td>
                    <td>
                      {editable ? (
                        <select className="cap-cell" value={r.share_class} onChange={(e) => update(r, { share_class: e.target.value })}>
                          {[...new Set([r.share_class, ...SHARE_CLASSES])].map((c) => <option key={c}>{c}</option>)}
                        </select>
                      ) : r.share_class}
                    </td>
                    <td className="num">{editable ? <Cell type="number" value={Number(r.shares)} width={130} onCommit={(v) => update(r, { shares: Math.max(0, v) })} /> : fmtShares(r.shares)}</td>
                    <td className="num">{total ? fmtPct(Number(r.shares || 0) / total) : "—"}</td>
                    <td>{editable ? <Cell value={r.notes || ""} onCommit={(v) => update(r, { notes: v || null })} /> : (r.notes || "—")}</td>
                    <td className="admin-row-actions">{editable && <button className="admin-link-button is-danger" onClick={() => remove(r)}>Eliminar</button>}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={6} className="admin-empty">La cap table está vacía.{editable ? " Agrega el primer accionista." : ""}</td></tr>}
              </tbody>
              {rows.length > 0 && (
                <tfoot><tr><td>Total</td><td /><td className="num">{fmtShares(total)}</td><td className="num">100%</td><td colSpan={2} /></tr></tfoot>
              )}
            </table>
          </div>

          <div className="cap-actions">
            {editable && <button className="admin-primary-button" onClick={add}>+ Agregar fila</button>}
            {rows.length > 0 && (
              <button className="admin-link-button" onClick={() => downloadCsv([
                ["Accionista", "Clase de acción", "Acciones", "% del total", "Notas"],
                ...rows.map((r) => [r.holder, r.share_class, Number(r.shares), total ? (Number(r.shares) / total * 100).toFixed(4) : "", r.notes || ""]),
                [], ["Última actualización", meta?.updated_at || ""],
              ])}>Descargar CSV</button>
            )}
          </div>
          {!editable && <p className="admin-note">Tu acceso a Board es de solo lectura.</p>}
        </>
      )}
    </div>
  );
}
