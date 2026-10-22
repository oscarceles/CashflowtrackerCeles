const bucket = "board-legal-docs";
const stateId = "board-series-a-tasks";
const allowedAttachmentTypes = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const tasks = [
  { id: "drag-along-notice", title: "Send formal drag-along notice to John", dueDate: "2026-10-22", dueLabel: "Now", owner: "Legal & Compliance", source: "Voting Agreement; SAFE", details: "Confirm the vote math in John's SAFE tranche and collect the required written consents before sending notice.", status: "Open", attachments: [] },
  { id: "schedule-first-board-meeting", title: "Propose dates for first post-close board meeting", dueDate: "2026-10-23", dueLabel: "This week", owner: "CEO; Corporate Secretary", source: "Closing Record, Section 6", details: "Propose dates for the first post-close board meeting.", status: "Open", attachments: [] },
  { id: "sp-q3-report", title: "Deliver first SP Ventures quarterly report", dueDate: "2026-10-30", owner: "Finance", source: "SP Ventures side letter, Section 6", details: "Report revenue, EBITDA, run rate, gross margin and top-five KPIs. Confirm with SP whether the reporting period is counted from the side-letter date.", status: "Open", attachments: [] },
  { id: "colombia-trademark-status", title: "Deliver status certificates and files for Colombia trademark applications", dueDate: "2026-10-31", owner: "Legal & Compliance", source: "IRA 5.16", details: "Cover the three CELES trademark applications in Colombia: Classes 9, 35 and 42.", status: "Open", attachments: [] },
  { id: "series-a-form-d", title: "File Form D for Series A and state notice filings", dueDate: "2026-10-31", owner: "Legal & Compliance", source: "IRA 5.17", details: "The closing record calculates this as 15 days after first sale.", status: "Open", attachments: [] },
  { id: "fy2027-budget", title: "Send FY2027 monthly budget and business plan to Major Investors", dueDate: "2026-11-01", owner: "CEO; Finance", source: "IRA 3.1(a)(v)", details: "The closing record assumes a December 31 fiscal year-end and calculates the deadline as 60 days before year-end.", status: "Open", attachments: [] },
  { id: "a1-purchase-price", title: "Track A-1 purchase price payments", dueDate: "2026-11-15", owner: "Finance", source: "SPA 1.2(b)", details: "Purchase price is due from all purchasers except Taram II. Shares are not issued until paid in full; unpaid shares can be withheld.", status: "Open", attachments: [] },
  { id: "confidentiality-ip-agreements", title: "Collect NDA, non-solicit and IP agreements", dueDate: "2026-11-15", owner: "People", source: "IRA 5.2", details: "Everyone with access to confidential information must sign agreements in investor-acceptable form.", status: "Open", attachments: [] },
  { id: "prior-form-d-filings", title: "File any missing Forms D for earlier financings", dueDate: "2026-11-15", owner: "Legal & Compliance", source: "IRA 5.17", details: "Identify earlier financings with any delinquent Form D filings and complete applicable state notices.", status: "Open", attachments: [] },
  { id: "taram-chile-capital-increase", title: "Complete Chile subsidiary capital increase for Taram II", dueDate: "2026-11-15", owner: "Legal & Compliance; Finance; CEO for Taram II", source: "SPA 1.6", details: "Obtain Chilean subsidiary approval and deliver FT Program documents. The CORFO approval window may be extendable to December 15 by agreement; confirm any extension with the parties.", status: "Open", attachments: [] },
  { id: "founder-83b-elections", title: "Confirm and file founder 83(b) elections if applicable", dueDate: "2026-11-15", owner: "Founders (personal)", source: "RSA 12", details: "Protective elections for re-vested shares are conditional on tax counsel confirming they apply.", status: "Open", attachments: [] },
  { id: "option-agreement-repapering", title: "Re-paper existing option agreements", dueDate: "2026-11-30", owner: "People; Corporate Secretary for Board approval", source: "IRA 5.3, 5.15", details: "Update exercise price, single vesting start and cliff, and expiry no earlier than 90 days after full vesting; obtain Board approval.", status: "Open", attachments: [] },
  { id: "october-monthly-financials", title: "Deliver October monthly income statement and balance sheet", dueDate: "2026-11-30", owner: "Finance", source: "IRA 3.1(a)(iv)", details: "Prepare on a GAAP basis.", status: "Open", attachments: [] },
  { id: "foreign-reporting-review", title: "Engage firm or tax counsel for US foreign reporting review", dueDate: "2026-12-15", owner: "Finance", source: "IRA 5.14", details: "Board-approved review of Forms 5471, 926 and FBAR reporting.", status: "Open", attachments: [] },
  { id: "d-and-o-insurance", title: "Put D&O insurance of at least $1M in place", dueDate: "2027-01-14", owner: "Legal & Compliance", source: "IRA 5.1", details: "Confirm policy coverage meets the stated minimum.", status: "Open", attachments: [] },
  { id: "colombia-contractor-plan", title: "Submit Colombian contractor classification remediation plan", dueDate: "2027-01-14", owner: "People; Legal & Compliance", source: "IRA 5.12", details: "Submit the plan to the Board and obtain approval by a Preferred Director.", status: "Open", attachments: [] },
  { id: "gender-schedule", title: "Agree Gender Commitment Schedule and 2X criterion with SP Ventures", dueDate: "2027-01-14", owner: "People", source: "SP Ventures side letter 5(e)", details: "Agree the schedule and selected 2X criterion with SP Ventures.", status: "Open", attachments: [] },
  { id: "annual-esg-q4-report", title: "Prepare annual C-level ESG/anti-corruption attestation and Q4 SP report", dueDate: "2027-01-30", owner: "CEO signs; Legal & Compliance prepares; Finance prepares Q4 report", source: "SP Ventures side letter 5(c), 6", details: "Coordinate the annual C-level ESG and anti-corruption attestation with the Q4 2026 SP report.", status: "Open", attachments: [] },
  { id: "colombia-employment-transition", title: "Transition Colombian contractor fees to compliant employment", dueDate: "2027-02-13", owner: "People; Legal & Compliance", source: "IRA 5.12", details: "Move contractors covering at least 70% of Colombian individual fees; deliver officer's certificate by February 23, 2027.", status: "Open", attachments: [] },
  { id: "colombia-reorganization", title: "Regularize March 2023 Colombian reorganization", dueDate: "2027-02-13", owner: "Founders; Legal & Compliance; Finance", source: "IRA 5.13", details: "Address tax and Banco de la República registrations; company and founders certify completion.", status: "Open", attachments: [] },
  { id: "q4-financials-cap-table", title: "Send Q4 unaudited financials and cap table statement to Major Investors", dueDate: "2027-02-14", owner: "Finance", source: "IRA 3.1(a)(ii)-(iii)", details: "Prepare and deliver Q4 unaudited financials and the capitalization table statement.", status: "Open", attachments: [] },
  { id: "foreign-returns-trademarks", title: "File delinquent US foreign returns and obtain final CELES trademark registrations", dueDate: "2027-04-14", owner: "Finance (filings); Legal & Compliance (trademarks)", source: "IRA 5.14, 5.16", details: "Complete applicable delinquent US foreign information returns and obtain final CELES trademark registrations.", status: "Open", attachments: [] },
  { id: "esms", title: "Adopt Environmental and Social Management System", dueDate: "2027-04-16", owner: "Legal & Compliance; People; Data", source: "SP Ventures side letter 5", details: "Adopt ESMS with SP Ventures; People and Data contribute to its development.", status: "Open", attachments: [] },
  { id: "fy2026-audit-sp-report", title: "Deliver FY2026 audited financials and SP annual report", dueDate: "2027-04-30", owner: "Finance; Corporate Secretary for auditor approval", source: "IRA 3.1(a)(i); SP Ventures side letter 6", details: "Audited GAAP financials prepared by a firm of national standing; obtain Board approval of the auditor and deliver the SP annual report.", status: "Open", attachments: [] },
  { id: "gender-policies-founder-vesting", title: "Adopt core gender policies and track founders' first annual vesting tranche", dueDate: "2027-10-16", owner: "People", source: "SP Ventures side letter 5(e)(i); RSAs", details: "Adopt non-discrimination, GBVH zero-tolerance and equal-pay policies. Track founders' first annual vesting tranche on the closing anniversary.", status: "Open", attachments: [] },
  { id: "interim-2x-milestone", title: "Demonstrate interim 2X milestone", dueDate: "2028-10-16", owner: "People", source: "SP Ventures side letter 5(e)(ii)", details: "Track and document the interim 2X milestone specified in the Gender Commitment Schedule.", status: "Open", attachments: [] },
  { id: "monthly-financials-recurring", title: "Monthly financials to investors", dueDate: null, dueLabel: "Monthly · within 30 days of month-end", owner: "Finance", source: "IRA 3.1", details: "Deliver monthly financials within 30 days after each month-end.", status: "Open", recurring: true, attachments: [] },
  { id: "quarterly-financials-recurring", title: "Quarterly financials and cap table", dueDate: null, dueLabel: "Quarterly · within 45 days", owner: "Finance", source: "IRA 3.1", details: "Deliver quarterly financials and a capitalization table within 45 days.", status: "Open", recurring: true, attachments: [] },
  { id: "annual-audit-recurring", title: "Annual audit", dueDate: null, dueLabel: "Annual · within 120 days", owner: "Finance", source: "IRA 3.1", details: "Deliver the annual audit within 120 days.", status: "Open", recurring: true, attachments: [] },
  { id: "sp-quarterly-reports-recurring", title: "SP Ventures quarterly reports", dueDate: null, dueLabel: "Quarterly · within 30 days", owner: "Finance; CEO for investor consultation", source: "SP Ventures side letter 4–8", details: "Provide the quarterly report; CEO owns advance consultation on significant corporate actions.", status: "Open", recurring: true, attachments: [] },
  { id: "sp-half-yearly-impact", title: "SP Ventures half-yearly impact data", dueDate: null, dueLabel: "Half-yearly", owner: "Data", source: "SP Ventures side letter 4–8", details: "Prepare impact metrics. The closing record says the SP template KPIs mostly do not apply; propose Celes-specific metrics through the ESMS before the first half-yearly report.", status: "Open", recurring: true, attachments: [] },
  { id: "sp-annual-esg-questionnaire", title: "SP Ventures annual ESG questionnaire", dueDate: null, dueLabel: "Annual", owner: "Legal & Compliance; People; Data", source: "SP Ventures side letter 4–8", details: "Coordinate the annual ESG questionnaire and supporting company information.", status: "Open", recurring: true, attachments: [] },
  { id: "es-risk-event-notice", title: "Notify SP Ventures of E&S Risk Events", dueDate: null, dueLabel: "Event-driven · within 2 days", owner: "Legal & Compliance", source: "SP Ventures side letter 4–8", details: "Notify SP Ventures within two days after an E&S Risk Event.", status: "Open", recurring: true, attachments: [] },
  { id: "integrity-breach-notice", title: "Notify SP Ventures of integrity or anti-corruption breaches", dueDate: null, dueLabel: "Event-driven · within 10 business days", owner: "CEO; Legal & Compliance", source: "SP Ventures side letter 4–8", details: "Notify SP Ventures within ten business days after an integrity or anti-corruption breach.", status: "Open", recurring: true, attachments: [] },
  { id: "esms-information-requests", title: "Respond to SP Ventures ESMS information requests", dueDate: null, dueLabel: "On request · within 5 business days", owner: "Legal & Compliance; People; Data", source: "SP Ventures side letter 4–8", details: "Provide requested ESMS information within five business days.", status: "Open", recurring: true, attachments: [] },
  { id: "corfo-information-requests", title: "Route CORFO information requests through Taram II", dueDate: null, dueLabel: "On request", owner: "Taram II", source: "IRA 3.9", details: "Coordinate any CORFO information request through Taram II.", status: "Open", recurring: true, attachments: [] },
  { id: "new-option-grants", title: "Use Board-approved option form and obtain required consents for new grants", dueDate: null, dueLabel: "For each new grant", owner: "People; Corporate Secretary", source: "IRA 5.3, 5.15; Restated Certificate 3.3.3", details: "Use four-year vesting, one-year cliff and monthly vesting thereafter; obtain Board approval and written consent of 66% of Series A-1.", status: "Open", recurring: true, attachments: [] },
  { id: "wayra-side-letter-confirmation", title: "Confirm whether the Telefónica/Wayra side letter was executed", dueDate: null, dueLabel: "Confirm with Legal & Compliance", owner: "Legal & Compliance", source: "Closing Record, Section 6", details: "If executed, add the signed copy and track its no-hire, tag-along and share-surrender obligations. The closing record does not confirm execution.", status: "Open", recurring: false, attachments: [] },
];

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

const storageKey = (path) => path.split("/").map(encodeURIComponent).join("/");

// Only paths created by create-upload are valid: series-a-tasks/<taskId>/<uuid>-<name>,
// with no traversal segments, so an attachment can never point at another task or
// at the Legal Docs PDFs in the same bucket.
const safeTaskId = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(value);
const isTaskAttachmentPath = (path, taskId) => {
  if (typeof path !== "string" || !safeTaskId(taskId)) return false;
  const segments = path.split("/");
  return segments.length === 3
    && segments[0] === "series-a-tasks"
    && segments[1] === taskId
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-.+$/.test(segments[2])
    && !segments.some((segment) => segment === "." || segment === "..");
};

const cleanFileName = (value) => String(value || "attachment")
  .replace(/[\u0000-\u001f\u007f\\/]/g, "_")
  .replace(/^\.+/, "_")
  .trim()
  .slice(0, 180) || "attachment";

exports.handler = async (event) => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceKey) return jsonResponse(503, { error: "Document service is not configured" });

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
    const boardAccess = moduleAccess(member, "board");
    if (!boardAccess) return jsonResponse(403, { error: "Account is not authorized" });

    const readTasks = async () => {
      const url = new URL(`${supabaseUrl}/rest/v1/app_state`);
      url.search = new URLSearchParams({ select: "data", id: `eq.${stateId}`, limit: "1" }).toString();
      const response = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!response.ok) throw new Error("Could not load Series A tasks");
      const rows = await response.json();
      if (rows.length) return rows[0].data.tasks || [];
      const initialTasks = tasks.map((task) => ({ ...task }));
      const created = await fetch(`${supabaseUrl}/rest/v1/app_state`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify({ id: stateId, data: { tasks: initialTasks }, updated_at: new Date().toISOString() }),
      });
      if (!created.ok) throw new Error("Could not initialize Series A tasks");
      return initialTasks;
    };

    const writeTasks = async (items) => {
      const response = await fetch(`${supabaseUrl}/rest/v1/app_state?on_conflict=id`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ id: stateId, data: { tasks: items }, updated_at: new Date().toISOString() }),
      });
      if (!response.ok) throw new Error("Could not save Series A tasks");
    };

    const params = new URLSearchParams(event.queryStringParameters || {});
    const body = event.httpMethod === "POST" ? readBody(event) : {};
    const action = event.httpMethod === "GET" ? params.get("action") : body.action;

    // Reading (list, open-attachment) needs Board view access; every change needs edit access.
    const readOnlyActions = new Set(["list", "open-attachment"]);
    if (!readOnlyActions.has(action) && boardAccess !== "edit") return jsonResponse(403, { error: "You have view-only access to Board" });

    if (action === "list") return jsonResponse(200, { tasks: await readTasks() });

    if (action === "create-upload") {
      const taskId = body.taskId;
      const fileName = cleanFileName(body.fileName);
      const contentType = String(body.contentType || "application/octet-stream").slice(0, 120);
      const fileSize = Number(body.fileSize || 0);
      if (!safeTaskId(taskId) || !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > 25 * 1024 * 1024) return jsonResponse(400, { error: "Attachment must be between 1 byte and 25 MB" });
      if (!allowedAttachmentTypes.has(contentType)) return jsonResponse(415, { error: "Supported attachments: PDF, Word, Excel, CSV, TXT and common image formats." });
      if (!(await readTasks()).some((task) => task.id === taskId)) return jsonResponse(404, { error: "Task not found" });
      const path = `series-a-tasks/${taskId}/${crypto.randomUUID()}-${fileName}`;
      const uploadResponse = await fetch(`${supabaseUrl}/storage/v1/object/upload/sign/${bucket}/${storageKey(path)}`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ upsert: false }),
      });
      if (!uploadResponse.ok) return jsonResponse(502, { error: "Could not prepare secure attachment upload" });
      const upload = await uploadResponse.json();
      const signedPath = upload.signedURL || upload.signedUrl || (upload.token ? `/object/upload/sign/${bucket}/${storageKey(path)}?token=${encodeURIComponent(upload.token)}` : null);
      if (!signedPath) return jsonResponse(502, { error: "Could not prepare secure attachment upload" });
      const uploadUrl = signedPath.startsWith("http") ? signedPath : signedPath.startsWith("/storage/v1/") ? `${supabaseUrl}${signedPath}` : `${supabaseUrl}/storage/v1${signedPath}`;
      return jsonResponse(200, { uploadUrl, path, contentType });
    }

    if (action === "save-task") {
      const input = body.task || {};
      const now = new Date().toISOString();
      const items = await readTasks();
      // Existing tasks keep their id; new tasks always get a server-generated id.
      const isExisting = typeof input.id === "string" && items.some((item) => item.id === input.id);
      const dueDate = typeof input.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) ? input.dueDate : null;
      const task = {
        id: isExisting ? input.id : `task-${crypto.randomUUID()}`,
        title: String(input.title || "").trim().slice(0, 240),
        dueDate,
        dueLabel: String(input.dueLabel || "").slice(0, 120),
        owner: String(input.owner || "").slice(0, 240),
        source: String(input.source || "").slice(0, 240),
        details: String(input.details || "").slice(0, 3000),
        status: ["Open", "In progress", "Done"].includes(input.status) ? input.status : "Open",
        recurring: Boolean(input.recurring),
        attachments: [],
        updatedAt: now,
        updatedBy: email,
      };
      if (!task.title) return jsonResponse(400, { error: "Task title is required" });
      const existingIndex = items.findIndex((item) => item.id === task.id);
      if (existingIndex >= 0) items[existingIndex] = { ...items[existingIndex], ...task, attachments: items[existingIndex].attachments || [] };
      else items.push({ ...task, createdAt: now });
      await writeTasks(items);
      return jsonResponse(200, { task: existingIndex >= 0 ? items[existingIndex] : items[items.length - 1] });
    }

    if (action === "add-attachment") {
      const { taskId, attachment } = body;
      if (!attachment?.path || !attachment?.name) return jsonResponse(400, { error: "Attachment details are required" });
      if (!isTaskAttachmentPath(attachment.path, taskId)) return jsonResponse(400, { error: "Attachment path does not match task" });
      const items = await readTasks();
      const index = items.findIndex((item) => item.id === taskId);
      if (index < 0) return jsonResponse(404, { error: "Task not found" });
      if ((items[index].attachments || []).length >= 30) return jsonResponse(400, { error: "This task already has the maximum number of attachments" });
      if ((items[index].attachments || []).some((item) => item.path === attachment.path)) return jsonResponse(409, { error: "Attachment is already registered" });
      // Confirm the file really was uploaded, and take its type and size from storage
      // rather than trusting the browser.
      const info = await fetch(`${supabaseUrl}/storage/v1/object/info/${bucket}/${storageKey(attachment.path)}`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!info.ok) return jsonResponse(400, { error: "Uploaded file was not found" });
      const stored = await info.json();
      const storedType = stored.content_type || stored.metadata?.mimetype || attachment.contentType;
      const storedSize = Number(stored.size ?? stored.metadata?.size ?? attachment.size);
      if (!allowedAttachmentTypes.has(storedType)) return jsonResponse(415, { error: "Unsupported attachment type" });
      const record = {
        id: crypto.randomUUID(),
        path: attachment.path,
        name: cleanFileName(attachment.name),
        contentType: storedType,
        size: Number.isFinite(storedSize) ? storedSize : 0,
        uploadedBy: email,
        uploadedAt: new Date().toISOString(),
      };
      items[index] = { ...items[index], attachments: [...(items[index].attachments || []), record] };
      await writeTasks(items);
      return jsonResponse(200, { task: items[index] });
    }

    if (action === "remove-attachment") {
      const { taskId, attachmentId } = body;
      const items = await readTasks();
      const index = items.findIndex((item) => item.id === taskId);
      if (index < 0) return jsonResponse(404, { error: "Task not found" });
      const attachment = (items[index].attachments || []).find((item) => item.id === attachmentId);
      if (!attachment) return jsonResponse(404, { error: "Attachment not found" });
      if (!isTaskAttachmentPath(attachment.path, taskId)) return jsonResponse(400, { error: "Attachment path does not match task" });
      const deleted = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${storageKey(attachment.path)}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      });
      if (!deleted.ok) return jsonResponse(502, { error: "Could not remove attachment file" });
      items[index] = { ...items[index], attachments: items[index].attachments.filter((item) => item.id !== attachmentId) };
      await writeTasks(items);
      return jsonResponse(200, { task: items[index] });
    }

    if (action === "open-attachment") {
      const { taskId, attachmentId } = body;
      const items = await readTasks();
      const task = items.find((item) => item.id === taskId);
      const attachment = task?.attachments?.find((item) => item.id === attachmentId);
      if (!attachment) return jsonResponse(404, { error: "Attachment not found" });
      if (!isTaskAttachmentPath(attachment.path, taskId)) return jsonResponse(400, { error: "Attachment path does not match task" });
      const signedResponse = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}/${storageKey(attachment.path)}`, {
        method: "POST",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: 300 }),
      });
      if (!signedResponse.ok) return jsonResponse(502, { error: "Could not open attachment" });
      const signed = await signedResponse.json();
      const signedUrl = signed.signedURL || signed.signedUrl;
      if (!signedUrl) return jsonResponse(502, { error: "Could not open attachment" });
      return jsonResponse(200, { url: signedUrl.startsWith("http") ? signedUrl : `${supabaseUrl}/storage/v1${signedUrl}`, attachment });
    }

    if (action === "delete-task") {
      const items = await readTasks();
      const task = items.find((item) => item.id === body.taskId);
      if (!task) return jsonResponse(404, { error: "Task not found" });
      for (const attachment of task.attachments || []) {
        if (!isTaskAttachmentPath(attachment.path, body.taskId)) continue;
        await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${storageKey(attachment.path)}`, {
          method: "DELETE",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        });
      }
      await writeTasks(items.filter((item) => item.id !== body.taskId));
      return jsonResponse(200, { deleted: true });
    }

    return jsonResponse(400, { error: "Unknown task action" });
  } catch {
    return jsonResponse(502, { error: "Task service is temporarily unavailable" });
  }
};
