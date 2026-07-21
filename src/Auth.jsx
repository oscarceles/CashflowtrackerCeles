import React, { useEffect, useState } from "react";
import { supabase, isEmailAllowed } from "./supabaseClient";

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
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setMessage("Revisa tu correo: te enviamos un enlace para entrar.");
    } catch (err) {
      setError(err.message || "Error de autenticación.");
    } finally {
      setBusy(false);
    }
  }

  async function handleOAuth(provider) {
    setError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
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

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="email"
            required
            placeholder="Correo"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
          <button type="submit" disabled={busy} style={primaryBtn}>
            {busy ? "..." : "Enviar enlace de acceso"}
          </button>
        </form>

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

        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "20px 0" }}>
          <div style={{ flex: 1, height: 1, background: T.line }} />
          <span style={{ fontSize: 12, color: T.sub }}>o</span>
          <div style={{ flex: 1, height: 1, background: T.line }} />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button type="button" onClick={() => handleOAuth("azure")} style={oauthBtn}>
            Continuar con Microsoft
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AuthGate({ children }) {
  const [session, setSession] = useState(undefined); // undefined = loading, null = signed out
  const [notAllowed, setNotAllowed] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => checkSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => checkSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  function checkSession(s) {
    if (!s) {
      setSession(null);
      return;
    }
    if (!isEmailAllowed(s.user.email)) {
      setNotAllowed(s.user.email);
      supabase.auth.signOut();
      setSession(null);
      return;
    }
    setNotAllowed(null);
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

  return children;
}
