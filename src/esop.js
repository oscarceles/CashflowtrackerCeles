// Shared ESOP helpers (Board > ESOP and People > Compra de acciones ESOP).
// The database enforces the rules (supabase/esop.sql); these only decide what the interface shows.

export const fmtDate = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString("es-CO", { day: "2-digit", month: "short", year: "numeric" }) : "—");
export const fmtUnits = (n) => Number(n || 0).toLocaleString("es-CO", { maximumFractionDigits: 2 });
export const fmtPrice = (n) => (n == null || n === "" ? "Sin definir" : `USD ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`);
export const fmtUsd = (n) => `USD ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Purchase stage. `purchasable` comes from the database (esop_purchasable_units): nothing before the
 * cliff, 25% on the cliff date and the remaining 75% monthly for 2 years. Nothing is vested until bought.
 */
export function grantStage(g) {
  if (g.grant_type && g.grant_type !== "Stock options") return { label: g.grant_type, tone: "muted", exercisable: false };
  if (g.status && g.status.toLowerCase() !== "active") return { label: g.status, tone: "muted", exercisable: false };
  if (g.expiration_date && today() > g.expiration_date) return { label: "Vencida", tone: "muted", exercisable: false };
  if (!g.cliff_date || today() < g.cliff_date) return { label: g.cliff_date ? `Cliff el ${fmtDate(g.cliff_date)}` : "Sin cliff", tone: "wait", exercisable: false };
  const open = Number(g.purchasable || 0), units = Number(g.units || 0);
  return open >= units
    ? { label: "100% habilitada para compra", tone: "good", exercisable: true }
    : { label: `Compra habilitada: ${fmtUnits(open)} de ${fmtUnits(units)}`, tone: "good", exercisable: true };
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

/** Units that can be bought today and are not yet requested. */
export const availableUnits = (g, used) => (grantStage(g).exercisable ? Math.max(0, Number(g.purchasable || 0) - used) : 0);
export const PURCHASE_RULE = "25% en el cliff y el 75% restante mes a mes durante 2 años";

/** Columns People can read (signature and form are only read through esop_request_document). */
export const REQUEST_COLUMNS = "id,grant_id,employee_id,units,price,amount,payment_method,installments,status,notes,requested_at,requested_by,decided_at,decided_by,decision_note,paid_at,payment_reference,channel,signer_name,signed_at,signed_by";
