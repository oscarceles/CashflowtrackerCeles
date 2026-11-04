// Minimal spreadsheet reader for ERP exports (no dependencies). Works in the browser and in Node 18+.
// Supports .xlsx/.xlsm (zip + XML, read with DecompressionStream), .csv/.tsv/.txt (auto-detects the delimiter).
// Legacy .xls (BIFF) is not supported: export from the ERP as .xlsx or .csv.
// Returns [{ name, rows }] where rows is an array of arrays of cell values (string | number).

const td = new TextDecoder("utf-8");

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads the entries of a zip file: { path: Uint8Array } (only stored and deflated entries). */
async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("El archivo no es un .xlsx válido.");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    files[name] = { method, data };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: (path) => path in files,
    async text(path) {
      const f = files[path];
      if (!f) return null;
      // Some generators (e.g. Siigo, .NET OpenXML SDK) prefix every element: <x:row>, <x:c>. Drop the prefixes.
      return td.decode(f.method === 0 ? f.data : await inflateRaw(f.data)).replace(/^﻿/, "").replace(/<(\/?)[A-Za-z][\w.-]*:(?=[A-Za-z])/g, "<$1");
    },
  };
}

const decodeXml = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const map = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  if (map[e.toLowerCase()]) return map[e.toLowerCase()];
  return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`)); return m ? decodeXml(m[1]) : null; };
const textOf = (xml) => decodeXml([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(""));
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

async function readXlsx(buffer) {
  const zip = await unzip(buffer);
  const shared = [];
  const sst = await zip.text("xl/sharedStrings.xml");
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1]));
  const wbXml = (await zip.text("xl/workbook.xml")) || "";
  const relsXml = (await zip.text("xl/_rels/workbook.xml.rels")) || "";
  const rels = Object.fromEntries([...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id"), attr(m[0], "Target")]));
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], "name");
    let target = rels[attr(m[0], "r:id")] || "";
    target = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const xml = await zip.text(target);
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const rAttr = attr(r[1], "r");
      const ri = rAttr ? Number(rAttr) - 1 : NaN;
      const row = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1], "r");
        const type = attr(c[1], "t");
        const body = c[2] || "";
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = textOf(body);
        else if (type === "str" || type === "e") value = v != null ? decodeXml(v) : "";
        else if (type === "b") value = v === "1";
        else if (v != null) value = Number(v);
        row[ref ? colIndex(ref) : row.length] = value;
      }
      rows[Number.isFinite(ri) ? ri : rows.length] = Array.from(row, (x) => (x === undefined ? "" : x));
    }
    sheets.push({ name, rows: Array.from(rows, (x) => x || []) });
  }
  return sheets;
}

function readDelimited(text) {
  text = text.replace(/^﻿/, "");
  const sample = text.split(/\r?\n/).slice(0, 20).join("\n");
  const delim = [";", "\t", ",", "|"].map((d) => [d, sample.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return [{ name: "CSV", rows }];
}

/** Reads a File/Blob (browser) or { name, arrayBuffer() } and returns its sheets. */
export async function readSpreadsheet(file) {
  const name = (file.name || "").toLowerCase();
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer.slice(0, 8));
  if (head[0] === 0x50 && head[1] === 0x4b) return readXlsx(buffer);
  if (head[0] === 0xd0 && head[1] === 0xcf) throw new Error("Formato .xls antiguo no soportado: exporta el reporte del ERP como .xlsx o .csv.");
  if (name.endsWith(".pdf") || (head[0] === 0x25 && head[1] === 0x50)) throw new Error("Los PDF no se pueden leer como balanza: exporta el reporte del ERP en Excel o CSV.");
  let text = td.decode(buffer);
  if (text.includes("�")) text = new TextDecoder("windows-1252").decode(buffer);
  return readDelimited(text);
}
