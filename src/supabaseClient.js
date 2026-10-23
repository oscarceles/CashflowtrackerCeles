import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Members (with role and module access) live in the `allowed_users` table
// (see supabase/security-hardening.sql), managed from Administración → Miembros.
// Row-level security lets everyone read only their own row; only super admins
// can list, add, update or remove members.

const MEMBER_COLUMNS = "email, full_name, role, modules, added_at, updated_at, updated_by";

export async function getMyMember(email) {
  if (!email) return null;
  const { data, error } = await supabase
    .from("allowed_users")
    .select(MEMBER_COLUMNS)
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listMembers() {
  const { data, error } = await supabase
    .from("allowed_users")
    .select(MEMBER_COLUMNS)
    .order("added_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function addMember({ email, full_name, role, modules }, by) {
  const { error } = await supabase.from("allowed_users").insert({
    email: email.trim().toLowerCase(),
    full_name: full_name?.trim() || null,
    role,
    modules,
    updated_at: new Date().toISOString(),
    updated_by: by,
  });
  if (error) throw error;
}

export async function updateMember(email, { full_name, role, modules }, by) {
  const { error } = await supabase
    .from("allowed_users")
    .update({
      full_name: full_name?.trim() || null,
      role,
      modules,
      updated_at: new Date().toISOString(),
      updated_by: by,
    })
    .eq("email", email.toLowerCase());
  if (error) throw error;
}

export async function removeMember(email) {
  const { error } = await supabase
    .from("allowed_users")
    .delete()
    .eq("email", email.toLowerCase());
  if (error) throw error;
}

// Emails a member that was just added (invitation for new accounts, sign-in link otherwise).
export async function sendMemberInvite(email) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");
  const response = await fetch("/.netlify/functions/member-invite", {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "No se pudo enviar el correo.");
  return result.sent;
}
