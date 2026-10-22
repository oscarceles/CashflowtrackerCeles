const bucket = "board-legal-docs";
let deploymentSecrets = {};
try {
  deploymentSecrets = require("./series-a-secrets.json");
} catch {
  deploymentSecrets = {};
}
const documents = [
  { id: "secretary-certificate", name: "Celes - Secretary Certificate executed.pdf" },
  { id: "series-a-ira", name: "Celes Technologies - Series A IRA executed.pdf" },
  { id: "series-a-rofr", name: "Celes Technologies - Series A ROFR executed .pdf" },
  { id: "series-a-spa", name: "Celes Technologies - Series A SPA executed.pdf" },
  { id: "series-a-voting-agreement", name: "Celes Technologies - Series A Voting Agreement executed.pdf" },
  { id: "compliance-certificate", name: "Celes Technologies Inc. - Compliance Certificate executed.pdf" },
  { id: "indemnification-agreement", name: "Celes Technologies Inc. - Indemnification Agreement (Alexandre Stephan) Executed.pdf" },
  { id: "delaware-filing", name: "CELES TECHNOLOGIES, INC. Filed Delaware.pdf" },
  { id: "wire-details-checking-8454", name: "celes-technologies-inc_Wire-Details-Checking-8454.pdf" },
  { id: "founders-stock-david-florian", name: "Founders_Stock Agreement David Florian executed .pdf" },
  { id: "founders-stock-luis-almanza", name: "Founders_Stock Agreement Luis Almanza executed (1).pdf" },
  { id: "founders-stock-luis-ballestas", name: "Founders_Stock Agreement Luis Ballestas executed.pdf" },
  { id: "side-letter-agviii", name: "Side_Letter_AGVIII executed.pdf" },
];

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || deploymentSecrets.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || deploymentSecrets.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || deploymentSecrets.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) return jsonResponse(503, { error: "Document service is not configured" });

  const authorization = event.headers.authorization || event.headers.Authorization || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return jsonResponse(401, { error: "Sign-in required" });

  try {
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: authorization },
    });
    if (!userResponse.ok) return jsonResponse(401, { error: "Session is invalid or expired" });
    const user = await userResponse.json();
    const email = user.email?.toLowerCase();
    if (!email) return jsonResponse(403, { error: "Account is not authorized" });

    const allowlistUrl = new URL(`${supabaseUrl}/rest/v1/allowed_users`);
    allowlistUrl.search = new URLSearchParams({ select: "email", email: `eq.${email}`, limit: "1" }).toString();
    const allowlistResponse = await fetch(allowlistUrl, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!allowlistResponse.ok) return jsonResponse(503, { error: "Could not verify document access" });
    const allowedUsers = await allowlistResponse.json();
    if (!allowedUsers.length) return jsonResponse(403, { error: "Account is not authorized" });

    const params = new URLSearchParams(event.queryStringParameters || {});
    if (params.get("action") === "list") {
      return jsonResponse(200, { documents: documents.map(({ id, name }) => ({ id, name })) });
    }

    const document = documents.find((item) => item.id === params.get("documentId"));
    if (!document) return jsonResponse(404, { error: "Document not found" });

    const storageUrl = `${supabaseUrl}/storage/v1/object/sign/${bucket}/${document.id}.pdf`;
    const signedResponse = await fetch(storageUrl, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 900 }),
    });
    if (!signedResponse.ok) return jsonResponse(502, { error: "Could not open this document" });
    const signedData = await signedResponse.json();
    const signedUrl = signedData.signedURL || signedData.signedUrl;
    if (!signedUrl) return jsonResponse(502, { error: "Could not open this document" });

    const url = signedUrl.startsWith("http") ? signedUrl : `${supabaseUrl}/storage/v1${signedUrl}`;
    return jsonResponse(200, { url, name: document.name, expiresIn: 900 });
  } catch {
    return jsonResponse(502, { error: "Document service is temporarily unavailable" });
  }
};