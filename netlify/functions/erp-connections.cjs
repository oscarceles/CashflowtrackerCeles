// Read-only connections from Board → Financials to the entities' ERPs. The ERP credentials live only in the
// Netlify environment and the QuickBooks OAuth tokens in public.erp_tokens (service role only); the browser
// receives connection status and report contents, never keys or tokens.

const crypto = require("crypto");

const siigoBase = "https://api.siigo.com";

// Entity of consolidation_entities → ERP.
const connections = {
  "biai-colombia": { provider: "siigo", label: "Siigo Nube" },
  "celes-us": { provider: "qbo", label: "QuickBooks Online" },
};

// QuickBooks Online (Intuit OAuth 2.0, authorization code flow). Only the Accounting scope is requested: the
// app reads reports and never needs Payments or the user's OpenID profile.
const qboAuthorizeUrl = "https://appcenter.intuit.com/connect/oauth2";
const qboTokenUrl = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const qboRevokeUrl = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const qboScope = "com.intuit.quickbooks.accounting";
const qboMinorVersion = "75";
const qboApiBase = (environment) => (environment === "production" ? "https://quickbooks.api.intuit.com" : "https://sandbox-quickbooks.api.intuit.com");
const qboConfig = () => ({
  clientId: process.env.QBO_CLIENT_ID,
  clientSecret: process.env.QBO_CLIENT_SECRET,
  environment: process.env.QBO_ENVIRONMENT === "production" ? "production" : "sandbox",
});
const qboConfigured = () => Boolean(qboConfig().clientId && qboConfig().clientSecret);

// The redirect URI is this function on the domain the user is on; each one must be registered in the Intuit app.
const appOrigins = ["https://cashflow.celes.ai", "https://workspace.celes.ai", "http://localhost:8888"];
const requestOrigin = (event) => {
  const host = event.headers["x-forwarded-host"] || event.headers.host || "";
  const origin = `${host.startsWith("localhost") ? "http" : "https"}://${host}`;
  return appOrigins.includes(origin) ? origin : appOrigins[0];
};
const redirectUriFor = (origin) => `${origin}/.netlify/functions/erp-connections`;
const stateCookie = "erp_qbo_state";

const siigoConfig = () => ({
  username: process.env.SIIGO_USERNAME,
  accessKey: process.env.SIIGO_ACCESS_KEY,
  partnerId: process.env.SIIGO_PARTNER_ID,
});

// Mirrors public.module_access() in supabase/security-hardening.sql and src/access.js.
const moduleAccess = (member, module) => {
  if (!member) return null;
  const chosen = member.modules && member.modules[module];
  switch (member.role) {
    case "super_admin": return "edit";
    case "board_member": return module === "board" ? "view" : null;
    case "admin": return chosen === "view" || chosen === "edit" ? chosen : null;
    case "colaborador": return chosen === "view" || chosen === "edit" ? "view" : null;
    default: return null;
  }
};

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  body: JSON.stringify(body),
});

const readBody = (event) => {
  if (!event.body) return {};
  return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body);
};

class ErpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Siigo tokens last 24 h; a warm function instance reuses its token until a minute before it expires.
let siigoToken = null;

const siigoMessage = async (response) => {
  try {
    const data = await response.json();
    return (data.errors || []).map((e) => e.message).filter(Boolean).join(" ") || data.message || null;
  } catch { return null; }
};

const siigoAuth = async (force = false) => {
  const { username, accessKey, partnerId } = siigoConfig();
  if (!username || !accessKey || !partnerId) throw new ErpError(503, "Faltan las credenciales de Siigo en el servidor (SIIGO_USERNAME, SIIGO_ACCESS_KEY, SIIGO_PARTNER_ID).");
  if (!force && siigoToken && siigoToken.expiresAt > Date.now() + 60_000) return siigoToken.value;
  const response = await fetch(`${siigoBase}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Partner-Id": partnerId },
    body: JSON.stringify({ username, access_key: accessKey }),
  });
  if (!response.ok) {
    const detail = await siigoMessage(response);
    throw new ErpError(502, `Siigo rechazó el inicio de sesión (${response.status})${detail ? `: ${detail}` : "."}`);
  }
  const data = await response.json();
  if (!data.access_token) throw new ErpError(502, "Siigo no devolvió un token de acceso.");
  siigoToken = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return siigoToken.value;
};

const siigoPost = async (path, payload) => {
  const { partnerId } = siigoConfig();
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await siigoAuth(attempt > 0);
    const response = await fetch(`${siigoBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Partner-Id": partnerId, Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (response.status === 401 && attempt === 0) { siigoToken = null; continue; }
    if (!response.ok) {
      const detail = await siigoMessage(response);
      throw new ErpError(502, `Siigo respondió ${response.status}${detail ? `: ${detail}` : "."}`);
    }
    return response.json();
  }
  throw new ErpError(502, "Siigo no aceptó la sesión.");
};

// Siigo stores generated reports in its Azure blob storage; only those URLs are downloaded.
const isSiigoReportUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.endsWith(".blob.core.windows.net");
  } catch { return false; }
};

/**
 * Trial balance of one month as Siigo's Excel report ("Balance de prueba general").
 * includes_tax_difference must be true: without it Siigo leaves out accounts such as 41800197
 * (deferred revenue) and the report no longer matches the one exported from Siigo Nube.
 */
const siigoTrialBalance = async (periodId) => {
  const [year, month] = periodId.split("-").map(Number);
  const report = await siigoPost("/v1/test-balance-report", { year, month_start: month, month_end: month, includes_tax_difference: true });
  if (!report.file_url || !isSiigoReportUrl(report.file_url)) throw new ErpError(502, "Siigo no devolvió el archivo del reporte.");
  const file = await fetch(report.file_url);
  if (!file.ok) throw new ErpError(502, `No se pudo descargar el reporte de Siigo (${file.status}).`);
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > 10 * 1024 * 1024) throw new ErpError(502, "El reporte de Siigo es demasiado grande.");
  return { fileName: `Siigo - Balance de prueba ${periodId}.xlsx`, contentBase64: buffer.toString("base64") };
};

/* ---------------- QuickBooks Online ---------------- */

// Supabase REST with the service role, used only for public.erp_tokens and allowed_users.
const makeDb = (supabaseUrl, serviceKey) => {
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  return {
    async member(email) {
      const url = new URL(`${supabaseUrl}/rest/v1/allowed_users`);
      url.search = new URLSearchParams({ select: "email,role,modules", email: `eq.${email}`, limit: "1" }).toString();
      const response = await fetch(url, { headers });
      if (!response.ok) throw new ErpError(503, "Could not verify access");
      return (await response.json())[0] || null;
    },
    async token(entityId) {
      const url = new URL(`${supabaseUrl}/rest/v1/erp_tokens`);
      url.search = new URLSearchParams({ select: "*", entity_id: `eq.${entityId}`, limit: "1" }).toString();
      const response = await fetch(url, { headers });
      if (response.status === 404) throw new ErpError(503, "Falta la tabla erp_tokens en Supabase (supabase/board.sql).");
      if (!response.ok) throw new ErpError(503, "No se pudo leer la conexión guardada.");
      return (await response.json())[0] || null;
    },
    async saveToken(row) {
      const response = await fetch(`${supabaseUrl}/rest/v1/erp_tokens?on_conflict=entity_id`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
      });
      if (!response.ok) throw new ErpError(503, "No se pudo guardar la conexión con QuickBooks.");
    },
    async deleteToken(entityId) {
      const response = await fetch(`${supabaseUrl}/rest/v1/erp_tokens?entity_id=eq.${encodeURIComponent(entityId)}`, { method: "DELETE", headers });
      if (!response.ok) throw new ErpError(503, "No se pudo borrar la conexión con QuickBooks.");
    },
  };
};

const basicAuth = () => `Basic ${Buffer.from(`${qboConfig().clientId}:${qboConfig().clientSecret}`).toString("base64")}`;

// The OAuth state carries the entity, the user and an expiry, signed with the client secret; its nonce must
// also match an HttpOnly cookie set in the same browser, so a callback cannot be replayed from elsewhere.
const sign = (payload) => crypto.createHmac("sha256", qboConfig().clientSecret).update(payload).digest("base64url");
const makeState = (data) => { const payload = Buffer.from(JSON.stringify(data)).toString("base64url"); return `${payload}.${sign(payload)}`; };
const readState = (state) => {
  const [payload, signature] = String(state || "").split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (expected.length !== signature.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
  try { const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); return data.exp > Date.now() ? data : null; } catch { return null; }
};
const readCookie = (event, name) => {
  const raw = event.headers.cookie || event.headers.Cookie || "";
  const found = raw.split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
};

const qboTokenRequest = async (params) => {
  const response = await fetch(qboTokenUrl, {
    method: "POST",
    headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (data.error === "invalid_grant") throw new ErpError(401, "La autorización de QuickBooks venció o fue revocada: vuelve a conectar QuickBooks.");
    throw new ErpError(502, `Intuit rechazó la solicitud de token (${response.status}${data.error ? `: ${data.error}` : ""}).`);
  }
  return data;
};

const tokenRow = (entityId, data, base) => ({
  ...base,
  entity_id: entityId,
  provider: "qbo",
  access_token: data.access_token,
  access_expires_at: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
  // Intuit rotates the refresh token: always keep the latest one it returns.
  refresh_token: data.refresh_token || base.refresh_token,
  refresh_expires_at: data.x_refresh_token_expires_in ? new Date(Date.now() + Number(data.x_refresh_token_expires_in) * 1000).toISOString() : base.refresh_expires_at || null,
});

/** Saved connection with a valid access token, refreshing it when it expires within two minutes (or when forced). */
const qboSession = async (db, entityId, force = false) => {
  if (!qboConfigured()) throw new ErpError(503, "Faltan las llaves de QuickBooks en el servidor (QBO_CLIENT_ID, QBO_CLIENT_SECRET).");
  const saved = await db.token(entityId);
  if (!saved) throw new ErpError(409, "QuickBooks todavía no está conectado: usa «Conectar QuickBooks».");
  if (saved.environment !== qboConfig().environment) throw new ErpError(409, `La conexión guardada es de ${saved.environment} y el servidor usa ${qboConfig().environment}: vuelve a conectar QuickBooks.`);
  if (!force && Date.parse(saved.access_expires_at) > Date.now() + 120_000) return saved;
  const data = await qboTokenRequest({ grant_type: "refresh_token", refresh_token: saved.refresh_token });
  const row = tokenRow(entityId, data, saved);
  await db.saveToken(row);
  return row;
};

const qboGet = async (db, entityId, path, query = {}) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await qboSession(db, entityId, attempt > 0);
    const url = new URL(`${qboApiBase(session.environment)}/v3/company/${encodeURIComponent(session.realm_id)}/${path.replace("{realm}", encodeURIComponent(session.realm_id))}`);
    url.search = new URLSearchParams({ ...query, minorversion: qboMinorVersion }).toString();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${session.access_token}`, Accept: "application/json" } });
    if (response.status === 401 && attempt === 0) continue;
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.Fault) {
      const error = data.Fault?.Error?.[0];
      const tid = response.headers.get("intuit_tid");
      throw new ErpError(502, `QuickBooks respondió ${response.status}${error ? `: ${error.Message}${error.Detail ? ` (${error.Detail})` : ""}` : "."}${tid ? ` [intuit_tid ${tid}]` : ""}`);
    }
    return { data, session };
  }
  throw new ErpError(401, "QuickBooks no aceptó la sesión: vuelve a conectar QuickBooks.");
};

// A QuickBooks report (JSON) as the rows of its Excel export: title, column headers, then each section's header,
// its rows and its "Total …" summary. The statement importer then reads it exactly like the uploaded files,
// so account codes (header path + name) and their saved mappings stay the same.
const cellValues = (colData = []) => colData.map((c, i) => {
  const v = c.value ?? "";
  if (i === 0 || v === "") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
});
const reportRows = (report, titleRows) => {
  const rows = [...titleRows, [], (report.Columns?.Column || []).map((c, i) => (i === 0 ? "" : c.ColTitle || ""))];
  const walk = (block) => {
    for (const row of block?.Row || []) {
      if (row.Header) rows.push(cellValues(row.Header.ColData));
      if (row.ColData) rows.push(cellValues(row.ColData));
      if (row.Rows) walk(row.Rows);
      if (row.Summary) rows.push(cellValues(row.Summary.ColData));
    }
  };
  walk(report.Rows);
  return rows;
};

const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Balance Sheet at the month end and Profit and Loss by Month from January, as two statement "files". */
const qboMonth = async (db, entityId, periodId) => {
  const [year, month] = periodId.split("-").map(Number);
  const end = `${periodId}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, "0")}`;
  const { data: info, session } = await qboGet(db, entityId, "companyinfo/{realm}");
  const company = info.CompanyInfo?.CompanyName || "QuickBooks";
  const { data: bs } = await qboGet(db, entityId, "reports/BalanceSheet", { start_date: `${year}-01-01`, end_date: end, accounting_method: "Accrual" });
  const { data: pl } = await qboGet(db, entityId, "reports/ProfitAndLoss", { start_date: `${year}-01-01`, end_date: end, accounting_method: "Accrual", summarize_column_by: "Month" });
  const asOf = `As of ${MONTHS_EN[month - 1].slice(0, 3)} ${+end.slice(8)}, ${year}`;
  const range = month === 1 ? `January, ${year}` : `January-${MONTHS_EN[month - 1]}, ${year}`;
  const label = session.environment === "sandbox" ? " (sandbox)" : "";
  return {
    company,
    environment: session.environment,
    files: [
      { fileName: `QuickBooks${label} - Balance Sheet ${periodId}`, sheets: [{ name: "Balance Sheet", rows: reportRows(bs, [[company], ["Balance Sheet"], [asOf]]) }] },
      { fileName: `QuickBooks${label} - Profit and Loss by Month ${periodId}`, sheets: [{ name: "Profit and Loss by Month", rows: reportRows(pl, [[company], ["Profit and Loss by Month"], [range]]) }] },
    ],
  };
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const clearStateCookie = `${stateCookie}=; Path=/.netlify/functions/erp-connections; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
const htmlPage = (statusCode, title, message, origin) => ({
  statusCode,
  headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Set-Cookie": clearStateCookie },
  body: `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 20px;color:#0f172a">`
    + `<h1 style="font-size:20px">${title}</h1><p>${message}</p><p><a href="${origin}/">Volver a Celes</a> y abrir Board → Financials → Conexiones ERP (prueba).</p></body></html>`,
});

/** Intuit redirects the browser here (GET) after the user authorizes or cancels the connection. */
const qboCallback = async (event, db) => {
  const origin = requestOrigin(event);
  const q = event.queryStringParameters || {};
  const state = readState(q.state);
  if (!state || readCookie(event, stateCookie) !== state.nonce) return htmlPage(400, "No se pudo conectar QuickBooks", "La solicitud venció o no se inició desde este navegador. Vuelve a intentarlo desde la app.", origin);
  if (q.error) return htmlPage(400, "Conexión cancelada", `QuickBooks no autorizó la conexión (${escapeHtml(q.error)}).`, origin);
  if (!q.code || !q.realmId) return htmlPage(400, "No se pudo conectar QuickBooks", "Intuit no devolvió el código de autorización.", origin);
  if (moduleAccess(await db.member(state.email), "board") !== "edit") return htmlPage(403, "Sin permiso", "Tu cuenta ya no tiene acceso de edición a Board.", origin);
  try {
    const data = await qboTokenRequest({ grant_type: "authorization_code", code: q.code, redirect_uri: redirectUriFor(origin) });
    await db.saveToken(tokenRow(state.entityId, data, {
      environment: qboConfig().environment, realm_id: String(q.realmId), connected_by: state.email, connected_at: new Date().toISOString(),
    }));
  } catch (e) {
    console.error(`[erp-connections] qbo callback ${state.entityId}: ${e instanceof ErpError ? e.message : e?.stack || e}`);
    return htmlPage(502, "No se pudo conectar QuickBooks", escapeHtml(e instanceof ErpError ? e.message : "Error al guardar la conexión."), origin);
  }
  return htmlPage(200, "QuickBooks conectado", `La empresa ${escapeHtml(q.realmId)} quedó conectada (${qboConfig().environment}).`, origin);
};

exports.handler = async (event) => {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) return jsonResponse(503, { error: "ERP service is not configured" });
  const db = makeDb(supabaseUrl, serviceKey);

  if (event.httpMethod === "GET") {
    if ((event.queryStringParameters || {}).state && qboConfigured()) {
      try { return await qboCallback(event, db); } catch (e) {
        console.error(`[erp-connections] qbo callback: ${e?.stack || e}`);
        return htmlPage(502, "No se pudo conectar QuickBooks", "El servicio no está disponible.", requestOrigin(event));
      }
    }
    return jsonResponse(405, { error: "Method not allowed" });
  }
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  const authorization = event.headers.authorization || event.headers.Authorization || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return jsonResponse(401, { error: "Sign-in required" });

  let body = {};
  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: authorization } });
    if (!userResponse.ok) return jsonResponse(401, { error: "Session is invalid or expired" });
    const user = await userResponse.json();
    const email = user.email?.toLowerCase();
    if (!email || !user.email_confirmed_at) return jsonResponse(403, { error: "Account is not authorized" });
    // Pulling the books straight from an ERP is part of preparing the consolidation: Board edit access only.
    if (moduleAccess(await db.member(email), "board") !== "edit") return jsonResponse(403, { error: "Se necesita acceso de edición a Board para usar las conexiones ERP." });

    body = readBody(event);
    const action = body.action;

    if (action === "status") {
      const list = [];
      for (const [entityId, c] of Object.entries(connections)) {
        if (c.provider === "siigo") list.push({ entityId, provider: c.provider, label: c.label, configured: Object.values(siigoConfig()).every(Boolean) });
        if (c.provider === "qbo") {
          let saved = null, tableMissing = false;
          try { saved = await db.token(entityId); } catch { tableMissing = true; }
          list.push({
            entityId, provider: c.provider, label: c.label, configured: qboConfigured(), environment: qboConfig().environment, oauth: true, tableMissing,
            connected: saved ? { environment: saved.environment, realmId: saved.realm_id, by: saved.connected_by, at: saved.connected_at, refreshExpiresAt: saved.refresh_expires_at } : null,
          });
        }
      }
      return jsonResponse(200, { connections: list });
    }

    const connection = connections[body.entityId];
    if (!connection) return jsonResponse(404, { error: "Esta entidad no tiene conexión ERP." });
    const isMonth = typeof body.periodId === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(body.periodId);

    if (connection.provider === "qbo") {
      if (action === "connect") {
        if (!qboConfigured()) return jsonResponse(503, { error: "Faltan las llaves de QuickBooks en el servidor (QBO_CLIENT_ID, QBO_CLIENT_SECRET)." });
        const nonce = crypto.randomBytes(24).toString("base64url");
        const state = makeState({ nonce, entityId: body.entityId, email, exp: Date.now() + 10 * 60_000 });
        const url = new URL(qboAuthorizeUrl);
        url.search = new URLSearchParams({ client_id: qboConfig().clientId, response_type: "code", scope: qboScope, redirect_uri: redirectUriFor(requestOrigin(event)), state }).toString();
        const response = jsonResponse(200, { url: url.toString() });
        response.headers["Set-Cookie"] = `${stateCookie}=${encodeURIComponent(nonce)}; Path=/.netlify/functions/erp-connections; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
        return response;
      }
      if (action === "disconnect") {
        const saved = await db.token(body.entityId);
        if (saved) {
          await fetch(qboRevokeUrl, { method: "POST", headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ token: saved.refresh_token }) }).catch(() => null);
          await db.deleteToken(body.entityId);
        }
        return jsonResponse(200, { disconnected: true });
      }
      if (action === "test") {
        const started = Date.now();
        const { data, session } = await qboGet(db, body.entityId, "companyinfo/{realm}");
        return jsonResponse(200, { ok: true, provider: connection.label, company: data.CompanyInfo?.CompanyName || null, environment: session.environment, ms: Date.now() - started, testedAt: new Date().toISOString() });
      }
      if (action === "fetch-month") {
        if (!isMonth) return jsonResponse(400, { error: "Mes inválido" });
        const month = await qboMonth(db, body.entityId, body.periodId);
        return jsonResponse(200, { ...month, provider: connection.label, periodId: body.periodId, fetchedAt: new Date().toISOString(), fetchedBy: email });
      }
      return jsonResponse(400, { error: "Unknown ERP action" });
    }

    if (action === "test") {
      const started = Date.now();
      await siigoAuth(true);
      return jsonResponse(200, { ok: true, provider: connection.label, ms: Date.now() - started, testedAt: new Date().toISOString() });
    }

    if (action === "fetch-month") {
      if (!isMonth) return jsonResponse(400, { error: "Mes inválido" });
      const file = await siigoTrialBalance(body.periodId);
      return jsonResponse(200, { files: [file], provider: connection.label, periodId: body.periodId, fetchedAt: new Date().toISOString(), fetchedBy: email });
    }

    return jsonResponse(400, { error: "Unknown ERP action" });
  } catch (e) {
    // Errors go to the Netlify function log (messages carry Intuit's intuit_tid, never tokens or credentials).
    console.error(`[erp-connections] ${body?.action || event.httpMethod} ${body?.entityId || ""}: ${e instanceof ErpError ? `${e.status} ${e.message}` : e?.stack || e}`);
    if (e instanceof ErpError) return jsonResponse(e.status, { error: e.message });
    return jsonResponse(502, { error: "El servicio de conexiones ERP no está disponible." });
  }
};
