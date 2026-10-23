import React, { useEffect, useRef, useState } from "react";

// PDF.js is loaded on demand so the main bundle stays small.
let pdfjsPromise;
const loadPdfjs = () => {
  pdfjsPromise ||= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([pdfjsLib, worker]) => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjsLib;
  });
  return pdfjsPromise;
};

/** In-app PDF viewer (PDF.js on a canvas, page and zoom controls, no download button). */
export default function PdfReader({ url, title }) {
  const canvasRef = useRef(null);
  const renderTaskRef = useRef(null);
  const loadingTaskRef = useRef(null);
  const [pdf, setPdf] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setPdf(null);
    setPageNumber(1);
    setLoading(true);
    setError(null);

    const loadPdf = async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`No se pudo leer el PDF (${response.status}).`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const pdfjsLib = await loadPdfjs();
        if (cancelled) return;
        const loadingTask = pdfjsLib.getDocument({ data: bytes, isEvalSupported: false });
        loadingTaskRef.current = loadingTask;
        const loadedPdf = await loadingTask.promise;
        if (!cancelled) setPdf(loadedPdf);
      } catch (err) {
        if (!cancelled) setError(err.message || "No se pudo abrir este PDF.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadPdf();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      loadingTaskRef.current?.destroy();
      loadingTaskRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return undefined;
    let cancelled = false;
    renderTaskRef.current?.cancel();

    const renderPage = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        const outputScale = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * outputScale);
        canvas.height = Math.ceil(viewport.height * outputScale);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTaskRef.current = page.render({
          canvasContext: context,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
        });
        await renderTaskRef.current.promise;
      } catch (err) {
        if (!cancelled && err.name !== "RenderingCancelledException") setError("No se pudo renderizar esta página del PDF.");
      }
    };

    renderPage();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [pdf, pageNumber, scale]);

  return (
    <div className="board-pdf-reader">
      {pdf && (
        <div className="board-pdf-toolbar" aria-label="Controles del lector PDF">
          <button type="button" title="Página anterior" aria-label="Página anterior" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))}>‹</button>
          <span className="board-pdf-page">Página {pageNumber} de {pdf.numPages}</span>
          <button type="button" title="Página siguiente" aria-label="Página siguiente" disabled={pageNumber >= pdf.numPages} onClick={() => setPageNumber((page) => Math.min(pdf.numPages, page + 1))}>›</button>
          <span className="board-pdf-toolbar-spacer" />
          <button type="button" title="Alejar" aria-label="Alejar" disabled={scale <= 0.65} onClick={() => setScale((value) => Math.max(0.65, +(value - 0.15).toFixed(2)))}>−</button>
          <span className="board-pdf-zoom">{Math.round(scale * 100)}%</span>
          <button type="button" title="Acercar" aria-label="Acercar" disabled={scale >= 1.8} onClick={() => setScale((value) => Math.min(1.8, +(value + 0.15).toFixed(2)))}>+</button>
        </div>
      )}
      <div className="board-pdf-page-stage">
        {loading && <div className="board-doc-placeholder">Preparando vista previa segura…</div>}
        {!loading && error && <div className="board-doc-placeholder" role="alert">{error}</div>}
        {!loading && !error && pdf && <canvas ref={canvasRef} className="board-pdf-canvas" aria-label={`${title}, página ${pageNumber}`} />}
      </div>
    </div>
  );
}
