import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Team members allowed to use the app. Add/remove emails here.
export const ALLOWED_EMAILS = [
  "luis@celes.ai",
  "oscar@celes.ai",
  "natalie.figueroa@celes.ai",
];

export function isEmailAllowed(email) {
  return !!email && ALLOWED_EMAILS.includes(email.toLowerCase());
}
