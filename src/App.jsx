import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  ComposedChart, Bar, Line, Area, AreaChart, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine, Legend, Cell,
} from "recharts";
import { SEED } from "./seed";
import { loadState, saveState, clearState } from "./storage";


/* ============================= THEME ============================= */
const T = {
  bg: "#F4F5F2",
  panel: "#FFFFFF",
  ink: "#13202F",
  sub: "#5C6B7A",
  line: "#E3E7E9",
  side: "#0D1B2A",
  sideInk: "#B9C6D4",
  sideActive: "#16283C",
  green: "#0E9F6E",
  greenBg: "#E6F6EF",
  red: "#DE3E46",
  redBg: "#FCEBEC",
  amber: "#C77A08",
  amberBg: "#FBF1DF",
  blue: "#2563EB",
  blueBg: "#E8EFFD",
  gray: "#6B7280",
  grayBg: "#EEF1F3",
  mono: "'SF Mono','Cascadia Mono','Roboto Mono',ui-monospace,monospace",
};

const fmt$ = (n, dec = 0) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(n || 0).toLocaleString("en-US", { maximumFractionDigits: dec, minimumFractionDigits: 0 });
const fmtK = (n) => {
  const a = Math.abs(n || 0);
  const s = n < 0 ? "-" : "";
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(0) + "K";
  return s + "$" + a.toFixed(0);
};
const pct = (n) => ((n || 0) * 100).toFixed(1) + "%";

/* ============================= DATE HELPERS ============================= */
const P = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
const addDays = (s, n) => { const d = P(s); d.setDate(d.getDate() + n); return iso(d); };
const addMonths = (s, n) => {
  const d = P(s); const day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last)); return iso(d);
};
const monthKey = (s) => s.slice(0, 7);
const daysBetween = (a, b) => Math.round((P(b) - P(a)) / 86400000);
const fmtD = (s) => { if (!s) return "—"; const d = P(s); return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" }); };
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthLabel = (k) => { const [y, m] = k.split("-"); return MONTHS_SHORT[+m - 1] + " '" + y.slice(2); };

const PERIODICITY = { Mensual: 12, Trimestral: 4, Semestral: 2, Anual: 1 };

/* All months Jan 2026 → Dec 2027 */
const ALL_MONTHS = [];
for (let y = 2026; y <= 2027; y++) for (let m = 1; m <= 12; m++) ALL_MONTHS.push(`${y}-${String(m).padStart(2, "0")}`);

/* ============================= INVOICE GENERATION ============================= */
let _id = 1000;
const nid = () => "x" + _id++;

function generateInvoices(client, fromDate, toDate = "2027-12-31") {
  const per = PERIODICITY[client.periodicity] || 12;
  const step = 12 / per;
  const out = [];
  if (!client.start) return out;
  let ps = client.start;
  let i = 0;
  while (ps <= toDate) {
    const pe = addDays(addMonths(ps, step), -1);
    const contractYear = Math.floor(i / per) + 1;
    const end = client.end;
    if (end && ps > end) break;
    if (pe >= fromDate && ps <= toDate) {
      const arr = contractYear === 1 ? client.arr1 : contractYear === 2 ? client.arr2 : client.arr3;
      const amt = Math.round(((arr || 0) / per) * 100) / 100;
      const idate = ps;
      out.push({
        id: nid(), inv: "", client: client.name, ps, pe, cy: contractYear,
        per: client.periodicity, idate, amt,
        edate: addDays(idate, client.delay || 30),
        paid: false, adate: null, auto: true,
      });
    }
    ps = addMonths(ps, step); i++;
  }
  return out;
}

/* ============================= DERIVED ENGINE ============================= */
function invStatus(inv, today) {
  if (inv.paid) return "Paid";
  if (inv.edate < today) return "Overdue";
  if (inv.edate <= addDays(today, 30)) return "Due Soon";
  if (inv.idate <= today) return "Issued";
  return "Scheduled";
}
const cashDate = (inv) => (inv.paid && inv.adate ? inv.adate : inv.edate);

const STATUS_STYLE = {
  Paid: { c: T.green, bg: T.greenBg },
  Overdue: { c: T.red, bg: T.redBg },
  "Due Soon": { c: T.amber, bg: T.amberBg },
  Issued: { c: T.blue, bg: T.blueBg },
  Scheduled: { c: T.gray, bg: T.grayBg },
};

function useModel(state) {
  const { clients, invoices, outflows, assumptions } = state;
  return useMemo(() => {
    const today = assumptions.today;
    const esc = assumptions.escalation;
    const withStatus = invoices.map((v) => ({ ...v, status: invStatus(v, today), cash: cashDate(v) }));

    /* monthly outflow map */
    const areas = Object.keys(outflows);
    const outflowByMonth = {};
    ALL_MONTHS.forEach((mk, idx) => {
      const mi = idx % 12; const is27 = idx >= 12;
      outflowByMonth[mk] = areas.reduce((s, a) => s + (outflows[a][mi] || 0) * (is27 ? 1 + esc : 1), 0);
    });

    /* monthly summary */
    let projBal = assumptions.opening, realBal = assumptions.opening;
    const monthly = ALL_MONTHS.map((mk) => {
      const inv = withStatus.filter((v) => monthKey(v.cash) === mk);
      const inflow = inv.reduce((s, v) => s + v.amt, 0);
      const paid = inv.filter((v) => v.paid).reduce((s, v) => s + v.amt, 0);
      const out = outflowByMonth[mk];
      const net = inflow - out;
      projBal += net; realBal += paid - out;
      return { mk, label: monthLabel(mk), inflow, paid, outstanding: inflow - paid, outflow: out, net, projBal, realBal };
    });

    /* weekly */
    const weeks = [];
    let ws = "2025-12-29";
    let wProj = assumptions.opening, wReal = assumptions.opening;
    let wk = 1;
    while (ws <= "2027-12-31") {
      const we = addDays(ws, 6);
      const inv = withStatus.filter((v) => v.cash >= ws && v.cash <= we);
      const inflow = inv.reduce((s, v) => s + v.amt, 0);
      const paid = inv.filter((v) => v.paid).reduce((s, v) => s + v.amt, 0);
      let out = 0;
      for (let i = 0; i < 7; i++) {
        const d = addDays(ws, i); const mk = monthKey(d);
        if (outflowByMonth[mk] != null) {
          const dim = new Date(+d.slice(0, 4), +d.slice(5, 7), 0).getDate();
          out += outflowByMonth[mk] / dim;
        }
      }
      wProj += inflow - out; wReal += paid - out;
      weeks.push({ wk, ws, we, year: +we.slice(0, 4), inflow, paid, outstanding: inflow - paid, outflow: out, net: inflow - out, projBal: wProj, realBal: wReal, clients: inv });
      ws = addDays(ws, 7); wk++;
    }

    /* KPIs */
    const total = withStatus.reduce((s, v) => s + v.amt, 0);
    const paidTot = withStatus.filter((v) => v.paid).reduce((s, v) => s + v.amt, 0);
    const overdue = withStatus.filter((v) => v.status === "Overdue");
    const overdueAmt = overdue.reduce((s, v) => s + v.amt, 0);
    const dueSoon = withStatus.filter((v) => v.status === "Due Soon");
    const dueSoonAmt = dueSoon.reduce((s, v) => s + v.amt, 0);
    const y26 = withStatus.filter((v) => v.cash.slice(0, 4) === "2026");
    const y27 = withStatus.filter((v) => v.cash.slice(0, 4) === "2027");
    const billed26 = y26.reduce((s, v) => s + v.amt, 0);
    const billed27 = y27.reduce((s, v) => s + v.amt, 0);
    const collected26 = y26.filter((v) => v.paid).reduce((s, v) => s + v.amt, 0);
    const paidWithDates = withStatus.filter((v) => v.paid && v.adate);
    const dso = paidWithDates.length
      ? paidWithDates.reduce((s, v) => s + daysBetween(v.idate, v.adate), 0) / paidWithDates.length
      : 0;
    const activeClients = clients.filter((c) => c.active).length;

    /* runway: first week projected balance < 0 */
    const zeroWeek = weeks.find((w) => w.projBal < 0);
    const zeroWeekReal = weeks.find((w) => w.realBal < 0);
    const minWeek = weeks.reduce((m, w) => (w.projBal < m.projBal ? w : m), weeks[0]);

    /* concentration: billed by client */
    const byClient = {};
    withStatus.forEach((v) => { byClient[v.client] = (byClient[v.client] || 0) + v.amt; });
    const topClients = Object.entries(byClient).sort((a, b) => b[1] - a[1]);
    const topShare = total ? (topClients[0]?.[1] || 0) / total : 0;

    /* AR aging (unpaid, already invoiced) */
    const ar = withStatus.filter((v) => !v.paid && v.idate <= today);
    const buckets = { Current: [], "1–30": [], "31–60": [], "61–90": [], "90+": [] };
    ar.forEach((v) => {
      const dd = daysBetween(v.edate, today);
      const b = dd <= 0 ? "Current" : dd <= 30 ? "1–30" : dd <= 60 ? "31–60" : dd <= 90 ? "61–90" : "90+";
      buckets[b].push({ ...v, daysOver: dd });
    });

    /* deferred income: revenue recognized per month */
    const deferred = {};
    ALL_MONTHS.forEach((mk) => (deferred[mk] = 0));
    withStatus.forEach((v) => {
      const months = Math.max(1, Math.round((P(v.pe) - P(v.ps)) / 86400000 / 30.4));
      const per = v.amt / months;
      let m = monthKey(v.ps);
      for (let i = 0; i < months; i++) {
        if (deferred[m] != null) deferred[m] += per;
        m = monthKey(addMonths(m + "-01", 1));
      }
    });

    return {
      today, withStatus, monthly, weeks, outflowByMonth, areas,
      kpi: {
        total, paidTot, outstanding: total - paidTot, overdueAmt, overdueCount: overdue.length,
        dueSoonAmt, dueSoonCount: dueSoon.length, billed26, billed27, collected26,
        collectionRate26: billed26 ? collected26 / billed26 : 0, dso, activeClients,
        net26: billed26 - (monthly.slice(0, 12).reduce((s, m) => s + m.outflow, 0)),
        out26: monthly.slice(0, 12).reduce((s, m) => s + m.outflow, 0),
        out27: monthly.slice(12).reduce((s, m) => s + m.outflow, 0),
        end26: monthly[11].projBal, end27: monthly[23].projBal,
        zeroWeek, zeroWeekReal, minWeek, topClients, topShare,
      },
      overdue, dueSoon, buckets, deferred,
    };
  }, [clients, invoices, outflows, assumptions]);
}

/* ============================= SMALL UI PIECES ============================= */
const Chip = ({ status }) => {
  const s = STATUS_STYLE[status] || STATUS_STYLE.Scheduled;
  return <span style={{ background: s.bg, color: s.c, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>{status}</span>;
};

const Card = ({ children, style }) => (
  <div style={{ background: T.panel, border: `1px solid ${T.line}`, borderRadius: 10, padding: 16, ...style }}>{children}</div>
);

const Kpi = ({ label, value, sub, color }) => (
  <Card style={{ flex: 1, minWidth: 150 }}>
    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: T.sub, marginBottom: 6 }}>{label}</div>
    <div style={{ fontSize: 22, fontWeight: 700, fontFamily: T.mono, color: color || T.ink, lineHeight: 1.1 }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: T.sub, marginTop: 4 }}>{sub}</div>}
  </Card>
);

const inputStyle = { border: `1px solid ${T.line}`, borderRadius: 6, padding: "7px 9px", fontSize: 13, width: "100%", boxSizing: "border-box", background: "#fff", color: T.ink };
const Field = ({ label, children }) => (
  <label style={{ display: "block", fontSize: 12, color: T.sub, fontWeight: 600 }}>
    <div style={{ marginBottom: 4 }}>{label}</div>{children}
  </label>
);
const Btn = ({ children, onClick, kind = "primary", small, disabled, title }) => {
  const styles = {
    primary: { background: T.ink, color: "#fff", border: "none" },
    ghost: { background: "#fff", color: T.ink, border: `1px solid ${T.line}` },
    green: { background: T.green, color: "#fff", border: "none" },
    danger: { background: "#fff", color: T.red, border: `1px solid ${T.line}` },
  };
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{ ...styles[kind], borderRadius: 7, padding: small ? "4px 10px" : "8px 14px", fontSize: small ? 12 : 13, fontWeight: 600, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  );
};

const th = { textAlign: "left", padding: "8px 10px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4, color: T.sub, borderBottom: `1px solid ${T.line}`, whiteSpace: "nowrap", position: "sticky", top: 0, background: T.panel, zIndex: 1 };
const td = { padding: "7px 10px", fontSize: 13, borderBottom: `1px solid ${T.line}`, whiteSpace: "nowrap", color: T.ink };
const tdN = { ...td, fontFamily: T.mono, textAlign: "right" };
const thN = { ...th, textAlign: "right" };

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: `1px solid ${T.line}`, borderRadius: 8, padding: "8px 12px", fontSize: 12, boxShadow: "0 4px 12px rgba(0,0,0,.08)" }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ color: p.color || p.stroke, fontFamily: T.mono }}>{p.name}: {fmtK(p.value)}</div>
      ))}
    </div>
  );
};

/* ============================= MODAL ============================= */
const Modal = ({ title, onClose, children, width = 640 }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(13,27,42,.45)", zIndex: 50, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px", overflowY: "auto" }} onClick={onClose}>
    <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: "100%", maxWidth: width, padding: 20, boxShadow: "0 20px 60px rgba(0,0,0,.25)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{title}</div>
        <button onClick={onClose} style={{ border: "none", background: "none", fontSize: 20, cursor: "pointer", color: T.sub }}>×</button>
      </div>
      {children}
    </div>
  </div>
);

/* ============================= CLIENT FORM ============================= */
const emptyClient = { name: "", country: "", razonCeles: "Celes Technologies Inc", razonCliente: "", periodicity: "Mensual", start: "", end: "", arr1: 0, arr2: 0, arr3: 0, delay: 30, active: true };

function ClientForm({ initial, onSave, onClose, isNew }) {
  const [c, setC] = useState({ ...emptyClient, ...initial });
  const [regen, setRegen] = useState(isNew);
  const set = (k) => (e) => setC({ ...c, [k]: e.target.type === "number" ? +e.target.value : e.target.value });
  const per = PERIODICITY[c.periodicity] || 12;
  const valid = c.name && c.start && c.arr1 > 0;
  return (
    <Modal title={isNew ? "Add client" : `Edit ${c.name}`} onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Client name"><input style={inputStyle} value={c.name} onChange={set("name")} disabled={!isNew} /></Field>
        <Field label="Country"><input style={inputStyle} value={c.country || ""} onChange={set("country")} /></Field>
        <Field label="Razón Social Celes">
          <select style={inputStyle} value={c.razonCeles || ""} onChange={set("razonCeles")}>
            <option>Celes Technologies Inc</option><option>BIAI Technologies SAS</option><option>Xeles SAPI de CV</option>
          </select>
        </Field>
        <Field label="Razón Social Cliente"><input style={inputStyle} value={c.razonCliente || ""} onChange={set("razonCliente")} /></Field>
        <Field label="Billing periodicity">
          <select style={inputStyle} value={c.periodicity} onChange={set("periodicity")}>
            <option>Mensual</option><option>Trimestral</option><option>Semestral</option><option>Anual</option>
          </select>
        </Field>
        <Field label="Payment delay (days)"><input type="number" style={inputStyle} value={c.delay} onChange={set("delay")} /></Field>
        <Field label="Contract start"><input type="date" style={inputStyle} value={c.start || ""} onChange={set("start")} /></Field>
        <Field label="Contract end (blank = ongoing)"><input type="date" style={inputStyle} value={c.end || ""} onChange={set("end")} /></Field>
        <Field label="ARR Year 1 ($)"><input type="number" style={inputStyle} value={c.arr1} onChange={set("arr1")} /></Field>
        <Field label="ARR Year 2 ($)"><input type="number" style={inputStyle} value={c.arr2} onChange={set("arr2")} /></Field>
        <Field label="ARR Year 3 ($)"><input type="number" style={inputStyle} value={c.arr3} onChange={set("arr3")} /></Field>
        <Field label="Active">
          <select style={inputStyle} value={c.active ? "Yes" : "No"} onChange={(e) => setC({ ...c, active: e.target.value === "Yes" })}>
            <option>Yes</option><option>No</option>
          </select>
        </Field>
      </div>
      <div style={{ marginTop: 12, background: T.blueBg, borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#1E3A8A" }}>
        Per-invoice amount: <b style={{ fontFamily: T.mono }}>{fmt$((c.arr1 || 0) / per)}</b> (Y1) · <b style={{ fontFamily: T.mono }}>{fmt$((c.arr2 || 0) / per)}</b> (Y2) — {per} invoice{per > 1 ? "s" : ""}/year, paid {c.delay} days after invoice.
      </div>
      {!isNew && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, fontSize: 13 }}>
          <input type="checkbox" checked={regen} onChange={(e) => setRegen(e.target.checked)} />
          Regenerate future unpaid invoices with these terms (paid invoices are never touched)
        </label>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn disabled={!valid} onClick={() => onSave(c, regen)}>{isNew ? "Add client + generate invoices" : "Save changes"}</Btn>
      </div>
    </Modal>
  );
}

/* ============================= INVOICE FORM ============================= */
function InvoiceForm({ initial, clients, onSave, onClose }) {
  const [v, setV] = useState({ ...initial });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.type === "number" ? +e.target.value : e.target.value });
  return (
    <Modal title={initial.id ? "Edit invoice" : "Add manual invoice"} onClose={onClose} width={560}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Invoice #"><input style={inputStyle} value={v.inv || ""} onChange={set("inv")} placeholder="FV-2-470" /></Field>
        <Field label="Client">
          <select style={inputStyle} value={v.client} onChange={set("client")}>
            {clients.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Invoice date"><input type="date" style={inputStyle} value={v.idate || ""} onChange={set("idate")} /></Field>
        <Field label="Amount ($)"><input type="number" style={inputStyle} value={v.amt} onChange={set("amt")} /></Field>
        <Field label="Period start"><input type="date" style={inputStyle} value={v.ps || ""} onChange={set("ps")} /></Field>
        <Field label="Period end"><input type="date" style={inputStyle} value={v.pe || ""} onChange={set("pe")} /></Field>
        <Field label="Expected payment"><input type="date" style={inputStyle} value={v.edate || ""} onChange={set("edate")} /></Field>
        <Field label="Paid?">
          <select style={inputStyle} value={v.paid ? "Yes" : "No"} onChange={(e) => setV({ ...v, paid: e.target.value === "Yes" })}>
            <option>No</option><option>Yes</option>
          </select>
        </Field>
        {v.paid && <Field label="Actual payment date"><input type="date" style={inputStyle} value={v.adate || ""} onChange={set("adate")} /></Field>}
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
        <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
        <Btn disabled={!v.client || !v.idate || !v.amt} onClick={() => onSave(v)}>Save invoice</Btn>
      </div>
    </Modal>
  );
}

/* ============================= VIEWS ============================= */

function DashboardView({ M, A, go }) {
  const { kpi, monthly, overdue, dueSoon } = M;
  const zeroLabel = kpi.zeroWeek ? fmtD(kpi.zeroWeek.ws) : null;
  const chartData = monthly.map((m) => ({ label: m.label, Inflows: m.inflow, Outflows: -m.outflow, "Projected balance": m.projBal, "Real balance (paid only)": m.realBal }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Runway strip — the signature element */}
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", flexWrap: "wrap" }}>
          <div style={{ padding: 20, minWidth: 260, borderRight: `1px solid ${T.line}` }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: T.sub }}>Projected cash runway</div>
            <div style={{ fontSize: 30, fontWeight: 800, fontFamily: T.mono, color: kpi.zeroWeek ? T.red : T.green, margin: "6px 0 2px" }}>
              {kpi.zeroWeek ? zeroLabel : "24+ months"}
            </div>
            <div style={{ fontSize: 12.5, color: T.sub }}>
              {kpi.zeroWeek
                ? <>Projected balance goes negative the week of <b>{zeroLabel}</b>, assuming all scheduled invoices are collected on time.</>
                : "Balance stays positive through the full projection."}
            </div>
            {kpi.zeroWeekReal && (
              <div style={{ fontSize: 12.5, color: T.red, marginTop: 6 }}>
                ⚠ Counting <b>only cash already received</b>, the balance would run out the week of <b>{fmtD(kpi.zeroWeekReal.ws)}</b> — collections keep the company alive.
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 300, height: 150, padding: "12px 12px 0" }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthly.map((m) => ({ label: m.label, bal: m.projBal }))} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="rg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={T.blue} stopOpacity={0.25} /><stop offset="100%" stopColor={T.blue} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: T.sub }} interval={2} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip content={<ChartTip />} />
                <ReferenceLine y={0} stroke={T.red} strokeDasharray="4 3" />
                <Area type="monotone" dataKey="bal" name="Projected balance" stroke={T.blue} strokeWidth={2} fill="url(#rg)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </Card>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Kpi label="Total billed 2026–27" value={fmtK(kpi.total)} sub={`${kpi.activeClients} active clients`} />
        <Kpi label="Collected to date" value={fmtK(kpi.paidTot)} color={T.green} sub={`${pct(kpi.collectionRate26)} of 2026 billing`} />
        <Kpi label="Overdue" value={fmtK(kpi.overdueAmt)} color={T.red} sub={`${kpi.overdueCount} invoices — collect now`} />
        <Kpi label="Due next 30 days" value={fmtK(kpi.dueSoonAmt)} color={T.amber} sub={`${kpi.dueSoonCount} invoices`} />
        <Kpi label="Avg days to collect (DSO)" value={Math.round(kpi.dso) + " d"} sub="invoice → cash, paid invoices" />
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Kpi label="2026 billed / outflows" value={fmtK(kpi.billed26) + " / " + fmtK(kpi.out26)} sub={`Net ${fmtK(kpi.billed26 - kpi.out26)}`} color={kpi.billed26 - kpi.out26 < 0 ? T.red : T.green} />
        <Kpi label="2027 billed / outflows" value={fmtK(kpi.billed27) + " / " + fmtK(kpi.out27)} sub={`Net ${fmtK(kpi.billed27 - kpi.out27)}`} color={kpi.billed27 - kpi.out27 < 0 ? T.red : T.green} />
        <Kpi label="2026 year-end balance" value={fmtK(kpi.end26)} color={kpi.end26 < 0 ? T.red : T.ink} />
        <Kpi label="2027 year-end balance" value={fmtK(kpi.end27)} color={kpi.end27 < 0 ? T.red : T.ink} />
        <Kpi label="Top-client concentration" value={pct(kpi.topShare)} sub={kpi.topClients[0]?.[0] || ""} color={kpi.topShare > 0.2 ? T.amber : T.ink} />
      </div>

      <Card>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Monthly cash flow — inflows vs outflows, projected & real balance</div>
        <div style={{ fontSize: 12, color: T.sub, marginBottom: 10 }}>The gap between the two lines is money billed but not yet collected.</div>
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke={T.line} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: T.sub }} interval={1} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: T.sub }} axisLine={false} tickLine={false} width={54} />
              <Tooltip content={<ChartTip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke={T.sub} />
              <Bar dataKey="Inflows" fill={T.green} radius={[3, 3, 0, 0]} barSize={9} />
              <Bar dataKey="Outflows" fill="#C9535A" radius={[0, 0, 3, 3]} barSize={9} />
              <Line dataKey="Projected balance" stroke={T.blue} strokeWidth={2} dot={false} />
              <Line dataKey="Real balance (paid only)" stroke={T.ink} strokeWidth={2} strokeDasharray="5 4" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 16 }}>
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 700, color: T.red }}>🔴 Urgent collections ({M.overdue.length})</div>
            <Btn small kind="ghost" onClick={() => go("invoices")}>Open invoices →</Btn>
          </div>
          {overdue.length === 0 && <div style={{ fontSize: 13, color: T.sub }}>Nothing overdue. 🎉</div>}
          {overdue.slice().sort((a, b) => a.edate.localeCompare(b.edate)).slice(0, 8).map((v) => (
            <div key={v.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${T.line}`, fontSize: 13 }}>
              <span>{v.client} <span style={{ color: T.sub }}>{v.inv || ""}</span></span>
              <span style={{ fontFamily: T.mono }}>{fmt$(v.amt)} · <span style={{ color: T.red }}>{daysBetween(v.edate, M.today)}d late</span></span>
            </div>
          ))}
        </Card>
        <Card>
          <div style={{ fontWeight: 700, color: T.amber, marginBottom: 8 }}>🟡 Coming due (30 days)</div>
          {dueSoon.length === 0 && <div style={{ fontSize: 13, color: T.sub }}>Nothing due in the next 30 days.</div>}
          {dueSoon.slice().sort((a, b) => a.edate.localeCompare(b.edate)).slice(0, 8).map((v) => (
            <div key={v.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${T.line}`, fontSize: 13 }}>
              <span>{v.client}</span>
              <span style={{ fontFamily: T.mono }}>{fmt$(v.amt)} · {fmtD(v.edate)}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

function ClientsView({ state, setState, M }) {
  const [editing, setEditing] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const clients = state.clients;
  const billedBy = {};
  M.withStatus.forEach((v) => (billedBy[v.client] = (billedBy[v.client] || 0) + v.amt));

  const save = (c, regen) => {
    setState((s) => {
      let clients2, invoices2 = s.invoices;
      if (isNew) {
        clients2 = [...s.clients, c];
        invoices2 = [...s.invoices, ...generateInvoices(c, "2026-01-01")];
      } else {
        clients2 = s.clients.map((x) => (x.name === c.name ? c : x));
        if (regen) {
          invoices2 = s.invoices.filter((v) => !(v.client === c.name && !v.paid && v.idate >= s.assumptions.today));
          const gen = generateInvoices(c, s.assumptions.today).filter((g) => g.idate >= s.assumptions.today);
          invoices2 = [...invoices2, ...gen];
        }
      }
      return { ...s, clients: clients2, invoices: invoices2 };
    });
    setEditing(null);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 13, color: T.sub }}>Adding a client generates its full 2026–27 invoice schedule automatically. Editing terms can regenerate future unpaid invoices.</div>
        <Btn onClick={() => { setIsNew(true); setEditing({ ...emptyClient }); }}>+ Add client</Btn>
      </div>
      <Card style={{ padding: 0, overflow: "auto", maxHeight: "70vh" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}>Client</th><th style={th}>Country</th><th style={th}>Entity (Celes)</th><th style={th}>Periodicity</th>
            <th style={th}>Start</th><th style={th}>End</th>
            <th style={thN}>ARR Y1</th><th style={thN}>ARR Y2</th><th style={thN}>ARR Y3</th>
            <th style={thN}>Delay</th><th style={thN}>Billed 26–27</th><th style={th}>Active</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {clients.slice().sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name)).map((c) => (
              <tr key={c.name} style={{ opacity: c.active ? 1 : 0.45 }}>
                <td style={{ ...td, fontWeight: 600 }}>{c.name}</td>
                <td style={td}>{c.country}</td>
                <td style={{ ...td, fontSize: 12, color: T.sub }}>{c.razonCeles}</td>
                <td style={td}>{c.periodicity}</td>
                <td style={td}>{fmtD(c.start)}</td>
                <td style={td}>{c.end ? fmtD(c.end) : "—"}</td>
                <td style={tdN}>{fmt$(c.arr1)}</td><td style={tdN}>{fmt$(c.arr2)}</td><td style={tdN}>{fmt$(c.arr3)}</td>
                <td style={tdN}>{c.delay}d</td>
                <td style={tdN}>{fmt$(billedBy[c.name] || 0)}</td>
                <td style={td}>{c.active ? <span style={{ color: T.green, fontWeight: 700 }}>Yes</span> : "No"}</td>
                <td style={td}><Btn small kind="ghost" onClick={() => { setIsNew(false); setEditing({ ...c }); }}>Edit</Btn></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {editing && <ClientForm initial={editing} isNew={isNew} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function InvoicesView({ state, setState, M }) {
  const [status, setStatus] = useState("All");
  const [client, setClient] = useState("All");
  const [year, setYear] = useState("All");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null);
  const list = M.withStatus.filter((v) =>
    (status === "All" || v.status === status) &&
    (client === "All" || v.client === client) &&
    (year === "All" || v.cash.slice(0, 4) === year) &&
    (!q || (v.client + " " + (v.inv || "")).toLowerCase().includes(q.toLowerCase()))
  ).sort((a, b) => a.idate.localeCompare(b.idate));
  const sum = list.reduce((s, v) => s + v.amt, 0);

  const markPaid = (id) => setState((s) => ({ ...s, invoices: s.invoices.map((v) => v.id === id ? { ...v, paid: true, adate: s.assumptions.today } : v) }));
  const undoPaid = (id) => setState((s) => ({ ...s, invoices: s.invoices.map((v) => v.id === id ? { ...v, paid: false, adate: null } : v) }));
  const del = (id) => setState((s) => ({ ...s, invoices: s.invoices.filter((v) => v.id !== id) }));
  const saveInv = (v) => {
    setState((s) => ({ ...s, invoices: v.id ? s.invoices.map((x) => x.id === v.id ? { ...v } : x) : [...s.invoices, { ...v, id: nid() }] }));
    setEditing(null);
  };
  const clientNames = state.clients.map((c) => c.name).sort();

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <input style={{ ...inputStyle, width: 180 }} placeholder="Search client / inv #" value={q} onChange={(e) => setQ(e.target.value)} />
        <select style={{ ...inputStyle, width: 130 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          {["All", "Overdue", "Due Soon", "Issued", "Scheduled", "Paid"].map((s) => <option key={s}>{s}</option>)}
        </select>
        <select style={{ ...inputStyle, width: 170 }} value={client} onChange={(e) => setClient(e.target.value)}>
          <option>All</option>{clientNames.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select style={{ ...inputStyle, width: 100 }} value={year} onChange={(e) => setYear(e.target.value)}>
          <option>All</option><option>2026</option><option>2027</option>
        </select>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 13, color: T.sub }}>{list.length} invoices · <b style={{ fontFamily: T.mono, color: T.ink }}>{fmt$(sum)}</b></span>
          <Btn onClick={() => setEditing({ inv: "", client: clientNames[0], ps: M.today, pe: addMonths(M.today, 1), idate: M.today, amt: 0, edate: addDays(M.today, 30), paid: false, adate: null })}>+ Manual invoice</Btn>
        </div>
      </div>
      <Card style={{ padding: 0, overflow: "auto", maxHeight: "70vh" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}>Inv #</th><th style={th}>Client</th><th style={th}>Period</th><th style={th}>CY</th>
            <th style={th}>Invoice date</th><th style={thN}>Amount</th><th style={th}>Expected pay</th>
            <th style={th}>Status</th><th style={th}>Paid on</th><th style={th}>Actions</th>
          </tr></thead>
          <tbody>
            {list.map((v) => (
              <tr key={v.id} style={{ background: v.status === "Overdue" ? "#FFF7F7" : undefined }}>
                <td style={{ ...td, fontFamily: T.mono, fontSize: 12 }}>{v.inv || <span style={{ color: T.sub }}>auto</span>}</td>
                <td style={{ ...td, fontWeight: 600 }}>{v.client}</td>
                <td style={{ ...td, fontSize: 12, color: T.sub }}>{fmtD(v.ps)} → {fmtD(v.pe)}</td>
                <td style={td}>{v.cy || "—"}</td>
                <td style={td}>{fmtD(v.idate)}</td>
                <td style={tdN}>{fmt$(v.amt)}</td>
                <td style={td}>{fmtD(v.edate)}{v.status === "Overdue" && <span style={{ color: T.red, fontSize: 11 }}> ({daysBetween(v.edate, M.today)}d)</span>}</td>
                <td style={td}><Chip status={v.status} /></td>
                <td style={td}>{v.adate ? fmtD(v.adate) : "—"}</td>
                <td style={{ ...td, display: "flex", gap: 6 }}>
                  {!v.paid
                    ? <Btn small kind="green" onClick={() => markPaid(v.id)} title="Mark paid today">✓ Paid</Btn>
                    : <Btn small kind="ghost" onClick={() => undoPaid(v.id)}>Undo</Btn>}
                  <Btn small kind="ghost" onClick={() => setEditing({ ...v })}>Edit</Btn>
                  {!v.paid && <Btn small kind="danger" onClick={() => del(v.id)}>✕</Btn>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {editing && <InvoiceForm initial={editing} clients={state.clients} onClose={() => setEditing(null)} onSave={saveInv} />}
    </div>
  );
}

function WeeklyView({ M }) {
  const [year, setYear] = useState(2026);
  const weeks = M.weeks.filter((w) => w.year === year || (year === 2026 && w.ws === "2025-12-29"));
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
        {[2026, 2027].map((y) => (
          <Btn key={y} small kind={year === y ? "primary" : "ghost"} onClick={() => setYear(y)}>{y}</Btn>
        ))}
        <span style={{ fontSize: 12.5, color: T.sub, marginLeft: 8 }}>Red rows = projected balance below zero that week. "Real" counts only invoices already collected.</span>
      </div>
      <Card style={{ padding: 0, overflow: "auto", maxHeight: "72vh" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}>Wk</th><th style={th}>Week</th>
            <th style={thN}>Collected</th><th style={thN}>Projected in</th><th style={thN}>Total in</th>
            <th style={thN}>Outflow</th><th style={thN}>Net</th><th style={thN}>Proj. balance</th><th style={thN}>Real balance</th>
            <th style={th}>Receipts</th>
          </tr></thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.ws} style={{ background: w.projBal < 0 ? "#FFF3F3" : undefined }}>
                <td style={{ ...td, color: T.sub }}>{w.wk}</td>
                <td style={td}>{fmtD(w.ws)} – {fmtD(w.we)}</td>
                <td style={{ ...tdN, color: T.green }}>{w.paid ? fmt$(w.paid) : "—"}</td>
                <td style={{ ...tdN, color: T.blue }}>{w.outstanding ? fmt$(w.outstanding) : "—"}</td>
                <td style={tdN}>{w.inflow ? fmt$(w.inflow) : "—"}</td>
                <td style={{ ...tdN, color: "#A33" }}>{fmt$(w.outflow)}</td>
                <td style={{ ...tdN, color: w.net < 0 ? T.red : T.green }}>{fmt$(w.net)}</td>
                <td style={{ ...tdN, fontWeight: 700, color: w.projBal < 0 ? T.red : T.ink }}>{fmt$(w.projBal)}</td>
                <td style={{ ...tdN, color: w.realBal < 0 ? T.red : T.sub }}>{fmt$(w.realBal)}</td>
                <td style={{ ...td, fontSize: 11.5, color: T.sub, whiteSpace: "normal", maxWidth: 260 }}>
                  {w.clients.map((c) => c.client + " " + fmtK(c.amt)).join(" · ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function MonthlyView({ M }) {
  const chart = M.monthly.map((m) => ({ label: m.label, Collected: m.paid, Outstanding: m.outstanding, Outflow: -m.outflow, "Projected balance": m.projBal }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Collected vs outstanding vs outflows</div>
        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke={T.line} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: T.sub }} interval={1} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: T.sub }} axisLine={false} tickLine={false} width={54} />
              <Tooltip content={<ChartTip />} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke={T.sub} />
              <Bar dataKey="Collected" stackId="in" fill={T.green} barSize={12} />
              <Bar dataKey="Outstanding" stackId="in" fill="#9DC7F5" barSize={12} radius={[3, 3, 0, 0]} />
              <Bar dataKey="Outflow" fill="#C9535A" barSize={12} radius={[0, 0, 3, 3]} />
              <Line dataKey="Projected balance" stroke={T.blue} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card style={{ padding: 0, overflow: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}>Month</th><th style={thN}>Billed in</th><th style={thN}>Collected</th><th style={thN}>Outstanding</th>
            <th style={thN}>Outflow</th><th style={thN}>Net</th><th style={thN}>Proj. balance</th><th style={thN}>Real balance</th>
          </tr></thead>
          <tbody>
            {M.monthly.map((m) => (
              <tr key={m.mk} style={{ background: m.projBal < 0 ? "#FFF3F3" : undefined }}>
                <td style={{ ...td, fontWeight: 600 }}>{m.label}</td>
                <td style={tdN}>{fmt$(m.inflow)}</td>
                <td style={{ ...tdN, color: T.green }}>{fmt$(m.paid)}</td>
                <td style={{ ...tdN, color: T.blue }}>{fmt$(m.outstanding)}</td>
                <td style={{ ...tdN, color: "#A33" }}>{fmt$(m.outflow)}</td>
                <td style={{ ...tdN, color: m.net < 0 ? T.red : T.green }}>{fmt$(m.net)}</td>
                <td style={{ ...tdN, fontWeight: 700, color: m.projBal < 0 ? T.red : T.ink }}>{fmt$(m.projBal)}</td>
                <td style={{ ...tdN, color: m.realBal < 0 ? T.red : T.sub }}>{fmt$(m.realBal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function OutflowsView({ state, setState, M }) {
  const areas = Object.keys(state.outflows);
  const esc = state.assumptions.escalation;
  const setCell = (area, mi, val) =>
    setState((s) => ({ ...s, outflows: { ...s.outflows, [area]: s.outflows[area].map((v, i) => (i === mi ? val : v)) } }));
  const totals26 = areas.map((a) => state.outflows[a].reduce((s, v) => s + v, 0));
  const colTotals = Array.from({ length: 12 }, (_, i) => areas.reduce((s, a) => s + state.outflows[a][i], 0));
  return (
    <div>
      <div style={{ fontSize: 13, color: T.sub, marginBottom: 12 }}>
        Edit any 2026 monthly cell — everything recalculates instantly. 2027 = 2026 × (1 + <b>{pct(esc)}</b> escalation, set in Assumptions).
      </div>
      <Card style={{ padding: 0, overflow: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}>Area</th>
            {MONTHS_SHORT.map((m) => <th key={m} style={thN}>{m} '26</th>)}
            <th style={thN}>2026 total</th><th style={thN}>2027 (esc.)</th>
          </tr></thead>
          <tbody>
            {areas.map((a, ai) => (
              <tr key={a}>
                <td style={{ ...td, fontWeight: 600 }}>{a}</td>
                {state.outflows[a].map((v, mi) => (
                  <td key={mi} style={{ ...tdN, padding: 3 }}>
                    <input type="number" value={v} onChange={(e) => setCell(a, mi, +e.target.value || 0)}
                      style={{ ...inputStyle, width: 78, textAlign: "right", fontFamily: T.mono, fontSize: 12, padding: "4px 6px", background: "#FFFDF2" }} />
                  </td>
                ))}
                <td style={{ ...tdN, fontWeight: 700 }}>{fmt$(totals26[ai])}</td>
                <td style={{ ...tdN, color: T.sub }}>{fmt$(totals26[ai] * (1 + esc))}</td>
              </tr>
            ))}
            <tr style={{ background: T.grayBg }}>
              <td style={{ ...td, fontWeight: 800 }}>Total</td>
              {colTotals.map((v, i) => <td key={i} style={{ ...tdN, fontWeight: 700 }}>{fmtK(v)}</td>)}
              <td style={{ ...tdN, fontWeight: 800 }}>{fmt$(colTotals.reduce((s, v) => s + v, 0))}</td>
              <td style={{ ...tdN, fontWeight: 800 }}>{fmt$(colTotals.reduce((s, v) => s + v, 0) * (1 + esc))}</td>
            </tr>
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function DeferredView({ M }) {
  const data = ALL_MONTHS.map((mk) => ({ label: monthLabel(mk), "Recognized revenue": Math.round(M.deferred[mk]) }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 13, color: T.sub }}>
        Each invoice is spread evenly across its service period — this is the revenue you can <i>recognize</i> each month (accrual view), independent of when cash lands.
      </div>
      <Card>
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid stroke={T.line} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: T.sub }} interval={1} axisLine={false} tickLine={false} />
              <YAxis tickFormatter={fmtK} tick={{ fontSize: 10, fill: T.sub }} axisLine={false} tickLine={false} width={54} />
              <Tooltip content={<ChartTip />} />
              <Bar dataKey="Recognized revenue" fill="#7C6FD8" radius={[3, 3, 0, 0]} barSize={16} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card style={{ padding: 0, overflow: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><th style={th}>Month</th><th style={thN}>Recognized revenue</th></tr></thead>
          <tbody>
            {ALL_MONTHS.map((mk) => (
              <tr key={mk}><td style={td}>{monthLabel(mk)}</td><td style={tdN}>{fmt$(M.deferred[mk])}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function ArAgingView({ M }) {
  const order = ["Current", "1–30", "31–60", "61–90", "90+"];
  const colors = { Current: T.gray, "1–30": T.amber, "31–60": "#D3600B", "61–90": "#C9403F", "90+": "#8F1D1D" };
  const all = order.flatMap((b) => M.buckets[b].map((v) => ({ ...v, bucket: b }))).sort((a, b) => b.daysOver - a.daysOver);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {order.map((b) => {
          const amt = M.buckets[b].reduce((s, v) => s + v.amt, 0);
          return <Kpi key={b} label={b === "Current" ? "Not yet due" : b + " days late"} value={fmtK(amt)} sub={M.buckets[b].length + " invoices"} color={colors[b]} />;
        })}
      </div>
      <Card style={{ padding: 0, overflow: "auto", maxHeight: "62vh" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={th}>Client</th><th style={th}>Inv #</th><th style={th}>Invoice date</th><th style={th}>Expected pay</th>
            <th style={thN}>Amount</th><th style={thN}>Days overdue</th><th style={th}>Bucket</th>
          </tr></thead>
          <tbody>
            {all.map((v) => (
              <tr key={v.id}>
                <td style={{ ...td, fontWeight: 600 }}>{v.client}</td>
                <td style={{ ...td, fontFamily: T.mono, fontSize: 12 }}>{v.inv || "—"}</td>
                <td style={td}>{fmtD(v.idate)}</td>
                <td style={td}>{fmtD(v.edate)}</td>
                <td style={tdN}>{fmt$(v.amt)}</td>
                <td style={{ ...tdN, color: v.daysOver > 0 ? colors[v.bucket] : T.sub, fontWeight: 700 }}>{v.daysOver > 0 ? v.daysOver : "—"}</td>
                <td style={td}><span style={{ color: colors[v.bucket], fontWeight: 700, fontSize: 12 }}>{v.bucket}</span></td>
              </tr>
            ))}
            {all.length === 0 && <tr><td style={td} colSpan={7}>No open receivables. 🎉</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function AssumptionsView({ state, setState, resetAll, saved }) {
  const a = state.assumptions;
  const set = (k, v) => setState((s) => ({ ...s, assumptions: { ...s.assumptions, [k]: v } }));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16, alignItems: "start" }}>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>Model levers</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label='"As of" date (drives overdue / aging — defaults to today)'>
            <input type="date" style={inputStyle} value={a.today} onChange={(e) => set("today", e.target.value)} />
          </Field>
          <Field label="Opening cash balance, Jan 2026 ($)">
            <input type="number" style={inputStyle} value={a.opening} onChange={(e) => set("opening", +e.target.value || 0)} />
          </Field>
          <Field label="2027 outflow escalation (0.1 = 10%)">
            <input type="number" step="0.01" style={inputStyle} value={a.escalation} onChange={(e) => set("escalation", +e.target.value || 0)} />
          </Field>
          <Field label="Default payment delay for new clients (days)">
            <input type="number" style={inputStyle} value={a.defaultDelay} onChange={(e) => set("defaultDelay", +e.target.value || 30)} />
          </Field>
        </div>
      </Card>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 12 }}>Data</div>
        <div style={{ fontSize: 13, color: T.sub, lineHeight: 1.6, marginBottom: 12 }}>
          {saved
            ? "Changes save automatically through the storage adapter (src/storage.js). With the Supabase backend connected, everyone on the team sees the same data — hit “Sync latest changes” before editing to pull the latest."
            : "Storage isn't available in this session — changes live in memory only and reset on reload."}
          <br />All figures were seeded from <b>Celes_CashFlow_Tracker_v3.xlsx</b>.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn kind="ghost" onClick={() => {
            const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const el = document.createElement("a"); el.href = url; el.download = "celes-cashflow-backup.json"; el.click();
            URL.revokeObjectURL(url);
          }}>Download backup (JSON)</Btn>
          <Btn kind="danger" onClick={() => { if (window.confirm("Reset everything back to the original Excel data? Your edits will be lost.")) resetAll(); }}>Reset to Excel data</Btn>
        </div>
      </Card>
      <Card>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>How the model works</div>
        <ol style={{ fontSize: 13, color: T.sub, lineHeight: 1.7, paddingLeft: 18, margin: 0 }}>
          <li><b>Clients</b> hold the contract terms (ARR per year, periodicity, delay). Adding one auto-generates its invoice schedule.</li>
          <li><b>Invoices</b> are the source of truth for cash-in. Mark them paid with the real date as money lands.</li>
          <li>Cash lands on the <b>actual payment date</b> if paid, else on the <b>expected date</b> (invoice + delay).</li>
          <li><b>Weekly / Monthly / Dashboard</b> views recompute instantly from those two tables plus the Outflow budget.</li>
          <li><b>Projected balance</b> assumes everything scheduled is collected; <b>Real balance</b> counts only cash already received.</li>
        </ol>
      </Card>
    </div>
  );
}

/* ============================= SEED → STATE ============================= */
function buildInitialState() {
  const todayReal = iso(new Date());
  return {
    assumptions: { today: todayReal, opening: 820000, escalation: 0.1, defaultDelay: 30 },
    clients: SEED.clients.map((c) => ({ ...c, delay: c.delay || 30 })),
    /* drop $0 rows caused by #NUM! formula errors in the original Excel */
    invoices: SEED.invoices.filter((v) => v.amt > 0).map((v) => ({ ...v, id: nid(), auto: false })),
    outflows: JSON.parse(JSON.stringify(SEED.outflows)),
  };
}

/* ============================= NAV ============================= */
const NAV = [
  { id: "dashboard", label: "Dashboard", icon: "◧" },
  { id: "clients", label: "Master Clients", icon: "▤" },
  { id: "invoices", label: "Invoice Schedule", icon: "☰" },
  { id: "weekly", label: "Weekly Cash Flow", icon: "▥" },
  { id: "monthly", label: "Monthly Summary", icon: "▦" },
  { id: "outflows", label: "Outflow Schedule", icon: "▽" },
  { id: "deferred", label: "Deferred Income", icon: "◔" },
  { id: "aging", label: "AR Aging", icon: "◷" },
  { id: "assumptions", label: "Assumptions", icon: "⚙" },
];

/* ============================= APP ============================= */
export default function App() {
  const [state, setState] = useState(buildInitialState);
  const [view, setView] = useState("dashboard");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef(null);

  /* load persisted state — backend lives in src/storage.js (swap it there) */
  const loadShared = async () => {
    try {
      const s = await loadState();
      if (s && s.clients && s.invoices) { setState(s); setSaved(true); return true; }
    } catch (e) { /* first run */ }
    return false;
  };
  useEffect(() => {
    (async () => { await loadShared(); setLoaded(true); })();
  }, []);

  /* autosave (debounced) */
  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await saveState(state);
        setSaved(true);
      } catch (e) { setSaved(false); }
    }, 800);
    return () => clearTimeout(saveTimer.current);
  }, [state, loaded]);

  const resetAll = async () => {
    try { await clearState(); } catch (e) {}
    setState(buildInitialState());
  };

  const M = useModel(state);

  const badges = {
    invoices: M.kpi.overdueCount ? { n: M.kpi.overdueCount, c: T.red } : null,
    aging: M.kpi.overdueCount ? { n: M.kpi.overdueCount, c: T.red } : null,
  };

  const titles = {
    dashboard: "Cash Flow Dashboard", clients: "Master Clients", invoices: "Invoice Schedule",
    weekly: "Weekly Cash Flow", monthly: "Monthly Summary", outflows: "Outflow Schedule — Operating Budget",
    deferred: "Deferred Income", aging: "Accounts Receivable Aging", assumptions: "Assumptions & Settings",
  };

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, color: T.ink, fontFamily: "'Segoe UI',system-ui,-apple-system,sans-serif" }}>
      {/* Sidebar */}
      <div style={{ width: 216, minWidth: 216, background: T.side, display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh" }}>
        <div style={{ padding: "20px 18px 14px", borderBottom: "1px solid rgba(255,255,255,.08)" }}>
          <div style={{ color: "#fff", fontWeight: 800, fontSize: 17, letterSpacing: 0.3 }}>CELES</div>
          <div style={{ color: T.sideInk, fontSize: 11, marginTop: 2 }}>Cash Flow Command Center</div>
        </div>
        <div style={{ padding: "10px 8px", flex: 1, overflowY: "auto" }}>
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setView(n.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left",
                background: view === n.id ? T.sideActive : "transparent", border: "none",
                borderLeft: view === n.id ? `3px solid ${T.green}` : "3px solid transparent",
                color: view === n.id ? "#fff" : T.sideInk, padding: "10px 12px", borderRadius: 6,
                fontSize: 13.5, fontWeight: view === n.id ? 700 : 500, cursor: "pointer", marginBottom: 2,
              }}>
              <span style={{ width: 16, textAlign: "center", opacity: 0.8 }}>{n.icon}</span>
              <span style={{ flex: 1 }}>{n.label}</span>
              {badges[n.id] && (
                <span style={{ background: badges[n.id].c, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 999, padding: "1px 7px" }}>{badges[n.id].n}</span>
              )}
            </button>
          ))}
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid rgba(255,255,255,.08)", fontSize: 11, color: T.sideInk }}>
          <div>As of <b style={{ color: "#fff" }}>{fmtD(M.today)}</b></div>
          <div style={{ marginTop: 3 }}>{saved ? "● Synced — shared data" : "○ Not syncing (in-memory)"}</div>
          <button onClick={loadShared}
            style={{ marginTop: 8, width: "100%", background: "transparent", border: "1px solid rgba(255,255,255,.25)", color: "#fff", borderRadius: 6, padding: "5px 8px", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
            ⟳ Sync latest changes
          </button>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, padding: "22px 26px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 21, fontWeight: 800 }}>{titles[view]}</div>
          <div style={{ fontSize: 12.5, color: T.sub, fontFamily: T.mono }}>
            Balance today ≈ <b style={{ color: M.kpi.minWeek && M.weeks.find(w => w.ws <= M.today && w.we >= M.today)?.projBal < 0 ? T.red : T.ink }}>
              {fmtK(M.weeks.find((w) => w.ws <= M.today && w.we >= M.today)?.projBal ?? state.assumptions.opening)}
            </b> · Overdue {fmtK(M.kpi.overdueAmt)}
          </div>
        </div>
        {view === "dashboard" && <DashboardView M={M} A={state.assumptions} go={setView} />}
        {view === "clients" && <ClientsView state={state} setState={setState} M={M} />}
        {view === "invoices" && <InvoicesView state={state} setState={setState} M={M} />}
        {view === "weekly" && <WeeklyView M={M} />}
        {view === "monthly" && <MonthlyView M={M} />}
        {view === "outflows" && <OutflowsView state={state} setState={setState} M={M} />}
        {view === "deferred" && <DeferredView M={M} />}
        {view === "aging" && <ArAgingView M={M} />}
        {view === "assumptions" && <AssumptionsView state={state} setState={setState} resetAll={resetAll} saved={saved} />}
      </div>
    </div>
  );
}
