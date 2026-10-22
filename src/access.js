import { createContext, useContext } from "react";

// Mirrors public.module_access() in supabase/security-hardening.sql and
// moduleAccess() in the Netlify functions. The database and the functions are
// the real enforcement; this only decides what the interface shows.

export const MODULES = [
  { id: "cashflow", name: "Cashflow" },
  { id: "board", name: "Board" },
  { id: "people", name: "People" },
];

export const ROLES = [
  { id: "super_admin", name: "Super Admin", description: "Puede ver y editar todo, y administrar miembros." },
  { id: "admin", name: "Admin", description: "Ve o edita los módulos que se le asignen." },
  { id: "colaborador", name: "Colaborador", description: "Solo puede ver los módulos que se le asignen." },
  { id: "board_member", name: "Board Member", description: "Solo puede leer la información de Board." },
];

export const roleName = (role) => ROLES.find((item) => item.id === role)?.name || role;

/** Returns "edit", "view" or null. */
export function moduleAccess(member, module) {
  if (!member) return null;
  const chosen = member.modules?.[module];
  switch (member.role) {
    case "super_admin": return "edit";
    case "board_member": return module === "board" ? "view" : null;
    case "admin": return chosen === "view" || chosen === "edit" ? chosen : null;
    case "colaborador": return chosen === "view" || chosen === "edit" ? "view" : null;
    default: return null;
  }
}

export const canView = (member, module) => moduleAccess(member, module) !== null;
export const canEdit = (member, module) => moduleAccess(member, module) === "edit";
export const isSuperAdmin = (member) => member?.role === "super_admin";

export const MemberContext = createContext(null);
export const useMember = () => useContext(MemberContext);
