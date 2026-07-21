import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Team allowlist lives in the `allowed_users` table (see supabase/schema.sql),
// managed from the app's "Team Access" tab — not hardcoded here anymore.

export async function isEmailAllowed(email) {
  if (!email) return false;
  const { data, error } = await supabase
    .from("allowed_users")
    .select("email")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function listAllowedUsers() {
  const { data, error } = await supabase
    .from("allowed_users")
    .select("email, added_at")
    .order("added_at", { ascending: true });
  if (error) throw error;
  return data;
}

export async function addAllowedUser(email) {
  const { error } = await supabase
    .from("allowed_users")
    .insert({ email: email.toLowerCase() });
  if (error) throw error;
}

export async function removeAllowedUser(email) {
  const { error } = await supabase
    .from("allowed_users")
    .delete()
    .eq("email", email.toLowerCase());
  if (error) throw error;
}
