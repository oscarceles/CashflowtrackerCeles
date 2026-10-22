import React, { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";
import { useMember, isSuperAdmin, roleName } from "./access";

const initialsOf = (member) => {
  const source = member?.display_name || member?.email || "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
};

/** Profile photo in the top bar; opens a menu with Administración and sign out. */
export default function UserMenu({ onAdmin }) {
  const member = useMember();
  const [open, setOpen] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!member) return null;
  const showPhoto = member.avatar_url && !photoFailed;
  const avatar = showPhoto ? (
    <img src={member.avatar_url} alt="" referrerPolicy="no-referrer" onError={() => setPhotoFailed(true)} />
  ) : (
    <span aria-hidden="true">{initialsOf(member)}</span>
  );

  return (
    <div className="user-menu" ref={rootRef}>
      <button type="button" className="user-menu-trigger" aria-haspopup="menu" aria-expanded={open}
        aria-label={`Cuenta de ${member.display_name || member.email}`} onClick={() => setOpen((value) => !value)}>
        {avatar}
      </button>
      {open && (
        <div className="user-menu-panel" role="menu">
          <div className="user-menu-identity">
            <div className="user-menu-avatar-large">{avatar}</div>
            <div className="user-menu-identity-text">
              {member.display_name && <div className="user-menu-name">{member.display_name}</div>}
              <div className="user-menu-email">{member.email}</div>
              <span className={`admin-role-badge role-${member.role}`}>{roleName(member.role)}</span>
            </div>
          </div>
          {isSuperAdmin(member) && (
            <button type="button" role="menuitem" className="user-menu-item" onClick={() => { setOpen(false); onAdmin(); }}>
              <span aria-hidden="true">◈</span> Administración
            </button>
          )}
          <button type="button" role="menuitem" className="user-menu-item is-danger" onClick={() => supabase.auth.signOut()}>
            <span aria-hidden="true">⎋</span> Cerrar sesión
          </button>
        </div>
      )}
    </div>
  );
}
