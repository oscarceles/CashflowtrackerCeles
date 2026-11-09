import React, { useEffect, useState } from "react";
import { supabase, getMyMember } from "./supabaseClient";
import { MemberContext } from "./access";

const T = {
  bg: "#F4F5F2",
  panel: "#FFFFFF",
  ink: "#13202F",
  sub: "#5C6B7A",
  line: "#E3E7E9",
  side: "#0D1B2A",
  red: "#DE3E46",
  redBg: "#FCEBEC",
  blue: "#2563EB",
  blueBg: "#E8EFFD",
};

const inputStyle = {
  padding: "10px 12px",
  borderRadius: 8,
  border: `1px solid ${T.line}`,
  fontSize: 14,
};
const primaryBtn = {
  padding: "10px 12px",
  borderRadius: 8,
  border: "none",
  background: T.side,
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
const linkBtn = {
  background: "none",
  border: "none",
  color: T.blue,
  fontSize: 12,
  cursor: "pointer",
  padding: 0,
  textAlign: "left",
};
const oauthBtn = {
  padding: "10px 12px",
  borderRadius: 8,
  border: `1px solid ${T.line}`,
  background: "#fff",
  color: T.ink,
  fontSize: 14,
  cursor: "pointer",
};

function LoginForm({ banner }) {
  const [authMethod, setAuthMethod] = useState("magic"); // "magic" | "password"
  const [passwordMode, setPasswordMode] = useState("signin"); // "signin" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  function resetFeedback() {
    setError(null);
    setMessage(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    resetFeedback();
    try {
      if (authMethod === "magic") {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        setMessage("Revisa tu correo: te enviamos un enlace para entrar.");
      } else if (passwordMode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (data.user && !data.session) {
          setMessage("Revisa tu correo para confirmar la cuenta antes de entrar.");
        }
      }
    } catch (err) {
      setError(err.message || "Error de autenticación.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGoogle() {
    resetFeedback();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) setError(error.message);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: T.bg,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          width: 360,
          background: T.panel,
          borderRadius: 12,
          padding: 32,
          boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700, color: T.ink, marginBottom: 4 }}>
          Celes Cash Flow
        </h1>
        <p style={{ fontSize: 13, color: T.sub, marginBottom: 24 }}>
          Acceso solo para el equipo de Celes.
        </p>

        <button type="button" onClick={handleGoogle} style={{ ...oauthBtn, width: "100%", marginBottom: 16 }}>
          Continuar con Google
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <div style={{ flex: 1, height: 1, background: T.line }} />
          <span style={{ fontSize: 12, color: T.sub }}>o</span>
          <div style={{ flex: 1, height: 1, background: T.line }} />
        </div>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="email"
            required
            placeholder="Correo"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
          {authMethod === "password" && (
            <input
              type="password"
              required
              minLength={passwordMode === "signup" ? 12 : 6}
              autoComplete={passwordMode === "signup" ? "new-password" : "current-password"}
              placeholder="Contraseña"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />
          )}
          <button type="submit" disabled={busy} style={primaryBtn}>
            {busy
              ? "..."
              : authMethod === "magic"
              ? "Enviar enlace de acceso"
              : passwordMode === "signin"
              ? "Entrar"
              : "Crear cuenta"}
          </button>
        </form>

        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
          <button
            type="button"
            style={linkBtn}
            onClick={() => {
              setAuthMethod(authMethod === "magic" ? "password" : "magic");
              resetFeedback();
            }}
          >
            {authMethod === "magic" ? "¿Prefieres usar contraseña?" : "¿Prefieres usar un enlace mágico?"}
          </button>
          {authMethod === "password" && (
            <button
              type="button"
              style={linkBtn}
              onClick={() => {
                setPasswordMode(passwordMode === "signin" ? "signup" : "signin");
                resetFeedback();
              }}
            >
              {passwordMode === "signin" ? "¿No tienes cuenta? Regístrate" : "¿Ya tienes cuenta? Inicia sesión"}
            </button>
          )}
        </div>

        {error && (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: T.redBg, color: T.red, fontSize: 13 }}>
            {error}
          </div>
        )}
        {message && (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: T.blueBg, color: T.blue, fontSize: 13 }}>
            {message}
          </div>
        )}
        {banner && (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: T.redBg, color: T.red, fontSize: 13 }}>
            {banner}
          </div>
        )}
      </div>
    </div>
  );
}

// Shown to members outside the company domain the first time they open their invitation
// (user_metadata.needs_password, set by netlify/functions/member-invite.cjs), and after a
// password-recovery link. They cannot enter the app until they set a password.
function SetPasswordScreen({ email, onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) return setError("La contraseña debe tener al menos 12 caracteres.");
    if (password !== confirm) return setError("Las contraseñas no coinciden.");
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password, data: { needs_password: false } });
      if (error) throw error;
      onDone();
    } catch (err) {
      setError(err.message || "No se pudo guardar la contraseña.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ width: 360, background: T.panel, borderRadius: 12, padding: 32, boxShadow: "0 1px 3px rgba(0,0,0,0.08)" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: T.ink, marginBottom: 4 }}>Crea tu contraseña</h1>
        <p style={{ fontSize: 13, color: T.sub, marginBottom: 24 }}>
          {email}: elige una contraseña para entrar a Celes. La usarás con este correo en “¿Prefieres usar contraseña?”.
        </p>
        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input type="password" required minLength={12} autoComplete="new-password" placeholder="Contraseña (mínimo 12 caracteres)"
            value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
          <input type="password" required minLength={12} autoComplete="new-password" placeholder="Confirmar contraseña"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} style={inputStyle} />
          <button type="submit" disabled={busy} style={primaryBtn}>{busy ? "..." : "Guardar y entrar"}</button>
        </form>
        <button type="button" style={{ ...linkBtn, marginTop: 10 }} onClick={() => supabase.auth.signOut()}>
          Salir
        </button>
        {error && (
          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: T.redBg, color: T.red, fontSize: 13 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading, null = signed out
  const [notAllowed, setNotAllowed] = useState(null);
  const [member, setMember] = useState(null);
  const [needsPassword, setNeedsPassword] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => checkSession(data.session));
    // Defer with setTimeout: calling supabase.auth.signOut() synchronously
    // inside onAuthStateChange can deadlock the internal auth lock.
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setNeedsPassword(true);
      setTimeout(() => checkSession(s), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function checkSession(s) {
    if (!s) {
      setMember(null);
      setNeedsPassword(false);
      setSession(null);
      return;
    }
    // Fail closed: if the member record cannot be loaded, treat it as not allowed.
    const record = await getMyMember(s.user.email).catch(() => null);
    if (!record) {
      setNotAllowed(s.user.email);
      await supabase.auth.signOut();
      setSession(null);
      return;
    }
    setNotAllowed(null);
    // Google sign-in provides the profile name and photo in user_metadata.
    const meta = s.user.user_metadata || {};
    if (meta.needs_password === true) setNeedsPassword(true);
    // Keep the member's Google photo on their People directory card (best effort).
    if (meta.avatar_url || meta.picture) {
      supabase.rpc("people_sync_my_avatar", { url: meta.avatar_url || meta.picture }).then(() => {}, () => {});
    }
    setMember({
      ...record,
      display_name: record.full_name || meta.full_name || meta.name || null,
      avatar_url: meta.avatar_url || meta.picture || null,
    });
    setSession(s);
  }

  if (session === undefined) {
    return <div style={{ minHeight: "100vh", background: T.bg }} />;
  }

  if (!session) {
    return (
      <LoginForm
        banner={notAllowed ? `${notAllowed} no tiene acceso a esta app. Contacta al administrador.` : null}
      />
    );
  }

  if (needsPassword) {
    return <SetPasswordScreen email={session.user.email} onDone={() => setNeedsPassword(false)} />;
  }

  return <MemberContext.Provider value={member}>{children}</MemberContext.Provider>;
}
