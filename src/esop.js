// Shared ESOP helpers (Board > ESOP and People > Compra de acciones ESOP).
// The database enforces the rules (supabase/esop.sql); these only decide what the interface shows.

export const fmtDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" }) : "—");
export const fmtUnits = (n) => Number(n || 0).toLocaleString("es-CO", { maximumFractionDigits: 2 });
export const fmtPrice = (n) => (n == null || n === "" ? "Sin definir" : `USD ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`);
export const fmtUsd = (n) => `USD ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const today = () => new Date().toISOString().slice(0, 10);

/** Vesting stage from the grant dates. The schedule has no partial vesting: everything vests at the cliff. */
export function grantStage(g) {
  if (g.grant_type && g.grant_type !== "Stock options") return { label: g.grant_type, tone: "muted", exercisable: false };
  if (g.status && g.status.toLowerCase() !== "active") return { label: g.status, tone: "muted", exercisable: false };
  if (g.expiration_date && today() > g.expiration_date) return { label: "Vencida", tone: "muted", exercisable: false };
  if (g.cliff_date && today() >= g.cliff_date) return { label: "Ejercible", tone: "good", exercisable: true };
  return { label: g.cliff_date ? `Cliff el ${fmtDate(g.cliff_date)}` : "Sin cliff", tone: "wait", exercisable: false };
}

export const REQUEST_STATUS = {
  requested: { label: "Solicitada", tone: "wait" },
  approved: { label: "Aprobada · en pago", tone: "wait" },
  paid: { label: "Pagada", tone: "good" },
  rejected: { label: "Rechazada", tone: "muted" },
  cancelled: { label: "Cancelada", tone: "muted" },
};
export const OPEN_STATUSES = ["requested", "approved"];
export const METHOD_LABEL = { payroll: "Deducción de nómina", transfer: "Transferencia a cuenta de Celes" };

/** Units of a grant already committed (requested, approved or paid). */
export const unitsUsed = (requests, grantId) => requests
  .filter((r) => r.grant_id === grantId && [...OPEN_STATUSES, "paid"].includes(r.status))
  .reduce((s, r) => s + Number(r.units || 0), 0);
