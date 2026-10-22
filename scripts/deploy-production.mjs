import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
const localEnv = Object.fromEntries(readFileSync(envPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => /^\s*[^#=]+\s*=/.test(line))
  .map((line) => {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
    return [key, value];
  }));

const required = ["NETLIFY_AUTH_TOKEN", "NETLIFY_SITE_ID", "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = required.filter((key) => !localEnv[key]);
if (missing.length) throw new Error(`Missing local settings: ${missing.join(", ")}`);

const supabaseUrl = localEnv.VITE_SUPABASE_URL.replace(/\/$/, "");
const bucketUpdate = await fetch(`${supabaseUrl}/storage/v1/bucket/board-legal-docs`, {
  method: "PUT",
  headers: {
    apikey: localEnv.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${localEnv.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    public: false,
    file_size_limit: 25 * 1024 * 1024,
    allowed_mime_types: [
      "application/pdf", "text/plain", "text/csv", "application/csv",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/vnd.ms-powerpoint",
      "image/png", "image/jpeg", "image/gif", "image/webp",
    ],
  }),
});
if (!bucketUpdate.ok) throw new Error(`Could not update private attachment bucket policy (HTTP ${bucketUpdate.status})`);
console.log("Updated private attachment bucket: supported document and image MIME types, 25 MB max");

const netlify = process.platform === "win32" ? "npx.cmd" : "npx";
const runNetlify = (args, label) => {
  console.log(label);
  const result = spawnSync(netlify, ["--yes", "netlify-cli", ...args], {
    env: { ...process.env, ...localEnv },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) throw new Error(`${label} failed`);
};

// Board functions read SUPABASE_SERVICE_ROLE_KEY (and the VITE_ Supabase URL/anon key)
// from the Netlify site environment, so no credentials are packaged with them.
runNetlify(["deploy", "--prod", "--dir=dist", "--skip-functions-cache", "--site", localEnv.NETLIFY_SITE_ID], "Deploying production site and functions");