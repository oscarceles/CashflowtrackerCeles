// Read-only connections from Board → Financials to the entities' ERPs. The ERP credentials live only in the
// Netlify environment; the browser receives connection status and report files, never keys or tokens.

const siigoBase = "https://api.siigo.com";

// Entity of consolidation_entities → ERP. Only Biai (Siigo Nube) is connected for now.
const connections = {
  "biai-colombia": { provider: "siigo", label: "Siigo Nube" },
};

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

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) return jsonResponse(503, { error: "ERP service is not configured" });

  const authorization = event.headers.authorization || event.headers.Authorization || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return jsonResponse(401, { error: "Sign-in required" });

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: authorization } });
    if (!userResponse.ok) return jsonResponse(401, { error: "Session is invalid or expired" });
    const user = await userResponse.json();
    const email = user.email?.toLowerCase();
    if (!email || !user.email_confirmed_at) return jsonResponse(403, { error: "Account is not authorized" });

    const memberUrl = new URL(`${supabaseUrl}/rest/v1/allowed_users`);
    memberUrl.search = new URLSearchParams({ select: "email,role,modules", email: `eq.${email}`, limit: "1" }).toString();
    const memberResponse = await fetch(memberUrl, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
    if (!memberResponse.ok) return jsonResponse(503, { error: "Could not verify access" });
    const [member] = await memberResponse.json();
    // Pulling the books straight from an ERP is part of preparing the consolidation: Board edit access only.
    if (moduleAccess(member, "board") !== "edit") return jsonResponse(403, { error: "Se necesita acceso de edición a Board para usar las conexiones ERP." });

    const body = readBody(event);
    const action = body.action;

    if (action === "status") {
      const configured = (c) => (c.provider === "siigo" ? Object.values(siigoConfig()).every(Boolean) : false);
      return jsonResponse(200, { connections: Object.entries(connections).map(([entityId, c]) => ({ entityId, provider: c.provider, label: c.label, configured: configured(c) })) });
    }

    const connection = connections[body.entityId];
    if (!connection) return jsonResponse(404, { error: "Esta entidad no tiene conexión ERP." });

    if (action === "test") {
      const started = Date.now();
      await siigoAuth(true);
      return jsonResponse(200, { ok: true, provider: connection.label, ms: Date.now() - started, testedAt: new Date().toISOString() });
    }

    if (action === "trial-balance") {
      if (typeof body.periodId !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.periodId)) return jsonResponse(400, { error: "Mes inválido" });
      const file = await siigoTrialBalance(body.periodId);
      return jsonResponse(200, { ...file, provider: connection.label, periodId: body.periodId, fetchedAt: new Date().toISOString(), fetchedBy: email });
    }

    return jsonResponse(400, { error: "Unknown ERP action" });
  } catch (e) {
    if (e instanceof ErpError) return jsonResponse(e.status, { error: e.message });
    return jsonResponse(502, { error: "El servicio de conexiones ERP no está disponible." });
  }
};
