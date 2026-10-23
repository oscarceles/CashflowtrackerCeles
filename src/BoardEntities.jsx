import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient";
import PdfReader from "./PdfReader";

export const ENTITY_CATEGORIES = ["Historical Financial Information", "Legal Documents", "Tax & Accounting Risk Indicators"];
const CATEGORY_LABELS = {
  "Historical Financial Information": "Información financiera histórica",
  "Legal Documents": "Documentos legales",
  "Tax & Accounting Risk Indicators": "Impuestos y riesgo contable",
};
const ALLOWED = ["application/pdf", "image/png", "image/jpeg", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "text/csv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
const fileSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const kindOf = (t) => (t === "application/pdf" ? "PDF" : t?.startsWith("image/") ? "IMG" : /sheet|excel|csv/.test(t || "") ? "XLS" : "DOC");

/** Documents of one local entity (private bucket board-entity-docs), with an in-app viewer. */
export default function LocalEntityView({ entityId, label, editable }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [openGroups, setOpenGroups] = useState({});
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [uploadCategory, setUploadCategory] = useState(ENTITY_CATEGORIES[0]);
  const [uploadFolder, setUploadFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setSelected(null); setPreview(null);
    supabase.from("board_entity_documents").select("*").eq("entity", entityId).order("category").order("folder", { nullsFirst: true }).order("name")
      .then(({ data, error: err }) => {
        if (cancelled) return;
        if (err) setError(err.message); else { setDocs(data || []); setError(null); }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [entityId]);

  const groups = useMemo(() => {
    const q = search.toLowerCase();
    const map = {};
    for (const d of docs) {
      if (q && !`${d.name} ${d.folder || ""}`.toLowerCase().includes(q)) continue;
      const key = `${d.category}||${d.folder || ""}`;
      (map[key] ||= { category: d.category, folder: d.folder, docs: [] }).docs.push(d);
    }
    return Object.values(map).sort((a, b) => ENTITY_CATEGORIES.indexOf(a.category) - ENTITY_CATEGORIES.indexOf(b.category) || (a.folder || "").localeCompare(b.folder || ""));
  }, [docs, search]);

  const open = async (doc) => {
    setSelected(doc); setPreview(null); setError(null);
    const isInline = doc.content_type === "application/pdf" || doc.content_type?.startsWith("image/");
    const { data, error: err } = await supabase.storage.from("board-entity-docs").createSignedUrl(doc.path, 300, isInline ? undefined : { download: doc.name });
    if (err || !data?.signedUrl) { setError("No se pudo abrir el documento."); return; }
    setPreview({ url: data.signedUrl, inline: isInline });
  };

  const upload = async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = "";
    if (!files.length) return;
    setBusy(true); setError(null);
    const added = [];
    for (const file of files) {
      if (!ALLOWED.includes(file.type) || file.size > 25 * 1024 * 1024) { setError(`"${file.name}": solo PDF, imágenes, Excel, CSV o Word de hasta 25 MB.`); continue; }
      const safe = file.name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9._ -]/g, "").replace(/\s+/g, "_");
      const path = `${entityId}/${crypto.randomUUID()}-${safe}`;
      const { error: upErr } = await supabase.storage.from("board-entity-docs").upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) { setError(upErr.message); continue; }
      const { data, error: dbErr } = await supabase.from("board_entity_documents")
        .insert({ entity: entityId, category: uploadCategory, folder: uploadFolder.trim() || null, name: file.name, path, size: file.size, content_type: file.type }).select().single();
      if (dbErr) { setError(dbErr.message); continue; }
      added.push(data);
    }
    setDocs((list) => [...list, ...added]);
    setBusy(false);
  };

  const remove = async (doc) => {
    if (!window.confirm(`¿Eliminar "${doc.name}"?`)) return;
    const { error: stErr } = await supabase.storage.from("board-entity-docs").remove([doc.path]);
    if (stErr) { setError(stErr.message); return; }
    const { error: dbErr } = await supabase.from("board_entity_documents").delete().eq("id", doc.id);
    if (dbErr) { setError(dbErr.message); return; }
    setDocs((list) => list.filter((d) => d.id !== doc.id));
    if (selected?.id === doc.id) { setSelected(null); setPreview(null); }
  };

  const groupKey = (g) => `${g.category}||${g.folder || ""}`;
  const isOpen = (g) => Boolean(search) || (openGroups[groupKey(g)] ?? !g.folder);

  return (
    <div className="board-docs">
      <div className="board-docs-heading">
        <div>
          <div className="board-eyebrow">BOARD · LOCAL ENTITIES</div>
          <h1>{label}</h1>
          <p>Información financiera, documentos legales e indicadores de impuestos y riesgo contable de la entidad.</p>
        </div>
        <div className="board-doc-count">{docs.length} documentos</div>
      </div>
      {error && <div className="board-doc-error" role="alert">{error}</div>}

      {loading ? <div className="board-empty-state">Cargando…</div> : !docs.length && !editable ? (
        <div className="board-empty-state">No hay documentos de esta entidad todavía.</div>
      ) : (
        <div className="board-docs-layout">
          <aside className="board-doc-list entity-doc-list" aria-label={`Documentos de ${label}`}>
            <input className="board-doc-search" type="search" placeholder="Buscar documento" value={search} onChange={(e) => setSearch(e.target.value)} />
            {ENTITY_CATEGORIES.map((cat) => {
              const catGroups = groups.filter((g) => g.category === cat);
              if (!catGroups.length) return null;
              return (
                <div key={cat} className="entity-doc-category">
                  <div className="entity-doc-category-title">{CATEGORY_LABELS[cat]}<span>{catGroups.reduce((s, g) => s + g.docs.length, 0)}</span></div>
                  {catGroups.map((g) => (
                    <div key={groupKey(g)}>
                      {g.folder && (
                        <button className="entity-doc-folder" aria-expanded={Boolean(isOpen(g))} onClick={() => setOpenGroups((o) => ({ ...o, [groupKey(g)]: !isOpen(g) }))}>
                          {isOpen(g) ? "▾" : "▸"} {g.folder} <span>{g.docs.length}</span>
                        </button>
                      )}
                      {isOpen(g) && g.docs.map((d) => (
                        <div key={d.id} className={`entity-doc-item${selected?.id === d.id ? " is-active" : ""}${g.folder ? " is-nested" : ""}`}>
                          <button onClick={() => open(d)} title={d.name}>
                            <span className={`entity-doc-kind is-${kindOf(d.content_type).toLowerCase()}`}>{kindOf(d.content_type)}</span>
                            <span className="entity-doc-name">{d.name.replace(/\.[^.]+$/, "")}</span>
                          </button>
                          {editable && <button className="entity-doc-remove" aria-label={`Eliminar ${d.name}`} onClick={() => remove(d)}>×</button>}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              );
            })}
            {!groups.length && <div className="people-muted entity-doc-empty">{search ? "Nada coincide con la búsqueda." : "Sin documentos."}</div>}
            {editable && (
              <div className="entity-doc-upload">
                <select value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value)} aria-label="Categoría">
                  {ENTITY_CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                </select>
                <input value={uploadFolder} onChange={(e) => setUploadFolder(e.target.value)} placeholder="Carpeta (opcional), ej. Impuestos / 2026" maxLength={120} />
                <input ref={inputRef} type="file" multiple className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.xlsx,.xls,.csv,.docx" onChange={upload} />
                <button className="people-secondary-button" disabled={busy} onClick={() => inputRef.current?.click()}>{busy ? "Subiendo…" : "+ Subir documentos"}</button>
              </div>
            )}
          </aside>
          <section className="board-doc-viewer">
            {!selected ? (
              <div className="board-doc-placeholder">Selecciona un documento para verlo.</div>
            ) : !preview ? (
              <div className="board-doc-placeholder">Abriendo…</div>
            ) : selected.content_type === "application/pdf" ? (
              <PdfReader key={selected.id} url={preview.url} title={selected.name} />
            ) : preview.inline ? (
              <div className="entity-doc-image"><img src={preview.url} alt={selected.name} /></div>
            ) : (
              <div className="board-doc-placeholder">
                Este tipo de archivo no tiene vista previa. <a href={preview.url} rel="noreferrer">Descargar {selected.name}</a>
                <small className="people-muted">{selected.size ? fileSize(selected.size) : ""}</small>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
