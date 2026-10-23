// Emails a newly added member (Administración → Miembros). Only a Super Admin can call it,
// and only for an email that is already on the member list. New accounts get a Supabase
// invitation (Authentication → Email Templates → Invite user); people who already have an
// account get a magic sign-in link instead.
const ROLE_NAMES = { super_admin: "Super Admin", admin: "Admin", colaborador: "Colaborador", board_member: "Board Member" };
// Links in the email point to the domain the admin is using (falls back to the primary domain).
const SITE_URLS = ["https://workspace.celes.ai", "https://cashflow.celes.ai"];
const siteUrlFor = (event) => {
  const origin = (event.headers.origin || event.headers.Origin || "").replace(/\/$/, "");
  return SITE_URLS.includes(origin) ? origin : SITE_URLS[1];
};

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  const SITE_URL = siteUrlFor(event);

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) return jsonResponse(503, { error: "Invite service is not configured" });

  const authorization = event.headers.authorization || event.headers.Authorization || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return jsonResponse(401, { error: "Sign-in required" });
  const admin = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: authorization } });
    if (!userResponse.ok) return jsonResponse(401, { error: "Session is invalid or expired" });
    const caller = await userResponse.json();
    const callerEmail = caller.email?.toLowerCase();
    if (!callerEmail || !caller.email_confirmed_at) return jsonResponse(403, { error: "Account is not authorized" });

    const lookup = async (email) => {
      const url = new URL(`${supabaseUrl}/rest/v1/allowed_users`);
      url.search = new URLSearchParams({ select: "email,role,full_name", email: `eq.${email}`, limit: "1" }).toString();
      const res = await fetch(url, { headers: admin });
      if (!res.ok) throw new Error("lookup failed");
      return (await res.json())[0] || null;
    };

    const me = await lookup(callerEmail);
    if (me?.role !== "super_admin") return jsonResponse(403, { error: "Solo un Super Admin puede enviar invitaciones." });

    let body = {};
    try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}"); } catch { body = {}; }
    const email = String(body.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonResponse(400, { error: "Correo inválido." });
    const member = await lookup(email);
    if (!member) return jsonResponse(404, { error: "Ese correo no está en la lista de miembros." });

    const data = { full_name: member.full_name || "", role_name: ROLE_NAMES[member.role] || member.role, invited_by: callerEmail };
    const invite = await fetch(`${supabaseUrl}/auth/v1/invite?redirect_to=${encodeURIComponent(SITE_URL)}`, {
      method: "POST",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({ email, data }),
    });
    if (invite.ok) return jsonResponse(200, { sent: "invite" });

    const detail = await invite.json().catch(() => ({}));
    const alreadyRegistered = invite.status === 422 || /already been registered|already exists/i.test(detail.msg || detail.message || detail.error_description || "");
    if (!alreadyRegistered) return jsonResponse(502, { error: "No se pudo enviar la invitación." });

    // Existing account: send a sign-in link so they still get an email.
    const otp = await fetch(`${supabaseUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(SITE_URL)}`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email, create_user: false }),
    });
    if (!otp.ok) return jsonResponse(502, { error: "La persona ya tenía cuenta y no se pudo enviar el enlace de acceso." });
    return jsonResponse(200, { sent: "magic_link" });
  } catch {
    return jsonResponse(502, { error: "Invite service is temporarily unavailable" });
  }
};
