import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Activity, ArrowLeft, ChevronLeft, ChevronRight, CircleAlert, ClipboardList, CreditCard, Database, FileClock, LayoutDashboard, LogOut, Menu, MonitorSmartphone, RefreshCw, Search, Settings, ShieldCheck, Smartphone, Users, Wallet, X } from "lucide-react";
import { api } from "./api";
import "./admin-panel.css";

type Overview = { users: number; devices: number; pendingPayments: number; activeSubscriptions: number; queuedCommands: number };
type PageResult<T = Record<string, unknown>> = { items: T[]; page: number; pageSize: number; total: number };
type Plan = { id: string; code: string; name: string; priceKes: number; durationDays: number; maxDevices: number | null; transactionHistoryDays: number; active: boolean };
type SettingsData = { runtime: { webOrigin: string; pairingCodeTtlSeconds: number; deviceTokenTtlDays: number; commandDefaultTtlSeconds: number }; plans: Plan[] };
type Section = "Dashboard" | "User Management" | "Device Management" | "Subscription Management" | "Payment Records" | "Token Management" | "Audit Logs" | "System Settings";
type EntityKind = "users" | "devices" | "subscriptions" | "payments" | "tokens" | "audit-logs";
type DetailState = { kind: EntityKind; id: string; row: Record<string, any>; data?: any; loading?: boolean; error?: string };

const sections: { name: Section; icon: typeof LayoutDashboard }[] = [
  { name: "Dashboard", icon: LayoutDashboard }, { name: "User Management", icon: Users },
  { name: "Device Management", icon: Smartphone }, { name: "Subscription Management", icon: CreditCard },
  { name: "Payment Records", icon: Wallet }, { name: "Token Management", icon: Database },
  { name: "Audit Logs", icon: FileClock }, { name: "System Settings", icon: Settings }
];
const pageSize = 10;
const listPaths: Record<EntityKind, string> = { users: "/api/admin/users", devices: "/api/admin/devices", subscriptions: "/api/admin/subscriptions", payments: "/api/admin/payments", tokens: "/api/admin/tokens", "audit-logs": "/api/admin/audit-logs" };
const listFields: Record<EntityKind, string[]> = {
  users: ["id", "phone", "role", "createdAt", "phoneVerifiedAt", "suspendedAt", "suspensionReason", "devicesCount", "subscriptionStatus"],
  devices: ["id", "deviceName", "model", "status", "createdAt", "lastSeenAt", "userId", "ownerId", "ownerPhone", "owner", "user"],
  subscriptions: ["id", "userId", "ownerId", "phone", "ownerPhone", "planName", "plan", "status", "startsAt", "expiresAt", "createdAt", "user"],
  payments: ["id", "userId", "phone", "ownerPhone", "amountKes", "status", "provider", "createdAt", "updatedAt", "providerReference", "externalReference", "user"],
  tokens: ["userId", "id", "phone", "role", "balance", "tokenBalance", "createdAt"],
  "audit-logs": ["id", "createdAt", "action", "targetType", "targetId", "actorId", "actorLabel", "requestId", "idempotencyKey"]
};
const detailFields: Record<EntityKind, string[]> = {
  users: ["id", "phone", "role", "createdAt", "phoneVerifiedAt", "suspendedAt", "suspensionReason", "devicesCount", "subscriptionStatus", "status"],
  devices: ["id", "deviceName", "model", "status", "createdAt", "lastSeenAt", "appVersion", "userId", "ownerId", "ownerPhone", "owner", "user", "revokedAt", "revocationReason"],
  subscriptions: ["id", "userId", "ownerId", "phone", "ownerPhone", "planName", "plan", "status", "startsAt", "expiresAt", "createdAt", "updatedAt"],
  payments: ["id", "userId", "phone", "ownerPhone", "amountKes", "status", "provider", "createdAt", "updatedAt", "providerReference", "externalReference", "user"],
  tokens: ["id", "userId", "phone", "role", "balance", "tokenBalance", "createdAt", "items"],
  "audit-logs": listFields["audit-logs"]
};
const forbiddenKey = /password|secret|credential|authorization|device.?token|access.?token|refresh.?token|private.?key|signature|raw.?payload/i;
const titleCase = (v: string) => v.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase());
const dateText = (value: unknown) => { if (!value) return "—"; const date = new Date(String(value)); return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString(); };
const idempotencyKey = () => globalThis.crypto?.randomUUID?.() ?? `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const scalar = (value: unknown) => typeof value === "boolean" ? (value ? "Yes" : "No") : value == null || value === "" ? "—" : typeof value === "object" ? "" : String(value);

function queryString(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams(); Object.entries(values).forEach(([key, value]) => { if (value !== undefined && value !== "") params.set(key, String(value)); }); return params.toString();
}
function StatusBadge({ value }: { value: unknown }) {
  const status = String(value ?? "UNKNOWN").toUpperCase();
  const style = /SUCCESS|ACTIVE|VERIFIED|COMPLETED|ONLINE|CREDIT|APPROVED/.test(status) ? "good" : /PENDING|QUEUED|PROCESSING|UNKNOWN/.test(status) ? "wait" : /FAILED|REVERSED|REVOKED|SUSPENDED|EXPIRED|INACTIVE|DEBIT|CANCELLED/.test(status) ? "bad" : "neutral";
  return <span className={`ap-badge ${style}`}>{status}</span>;
}
function Metric({ icon: Icon, label, value, note }: { icon: typeof Users; label: string; value: unknown; note: string }) {
  return <article className="ap-metric"><span className="ap-metric-icon"><Icon size={18}/></span><span className="ap-muted">{label}</span><strong>{value == null ? "—" : String(value)}</strong><small>{note}</small></article>;
}
function SafeFields({ data, fields }: { data: Record<string, any>; fields: string[] }) {
  return <dl className="ap-fields">{fields.filter(key => Object.prototype.hasOwnProperty.call(data ?? {}, key) && !forbiddenKey.test(key)).map(key => {
    const value = data[key]; if (value != null && typeof value === "object") return null;
    const shown = /At$|Date$/.test(key) ? dateText(value) : scalar(value);
    return <div key={key}><dt>{titleCase(key)}</dt><dd>{/status/i.test(key) ? <StatusBadge value={shown}/> : shown}</dd></div>;
  })}</dl>;
}

export default function AdminPanel({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [section, setSection] = useState<Section>("Dashboard");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState("");
  const [result, setResult] = useState<PageResult | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [query, setQuery] = useState(""); const [draftQuery, setDraftQuery] = useState("");
  const [status, setStatus] = useState(""); const [extraFilter, setExtraFilter] = useState(""); const [sort, setSort] = useState("createdAt_desc"); const [page, setPage] = useState(1); const [ledgerPage, setLedgerPage] = useState(1);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [busy, setBusy] = useState(false);
  const [adjustForm, setAdjustForm] = useState({ direction: "CREDIT", amount: "", reason: "" });
  const [extendForm, setExtendForm] = useState({ days: "", reason: "" });
  const [adjustKey, setAdjustKey] = useState(""); const [extendKey, setExtendKey] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [planDrafts, setPlanDrafts] = useState<Record<string, Plan>>({});
  const [savingPlan, setSavingPlan] = useState("");
  const [activationPlans, setActivationPlans] = useState<Plan[]>([]);
  const [activationPlanId, setActivationPlanId] = useState("");
  const [activationDays, setActivationDays] = useState("");
  const [activationReason, setActivationReason] = useState("");
  const [activationKey, setActivationKey] = useState("");
  const idempotency = useRef<{ adjust: string; extend: string }>({ adjust: "", extend: "" });
  const mutationLock = useRef(false);

  const fetchOverview = useCallback(async () => {
    setOverviewLoading(true); setOverviewError("");
    try { setOverview(await api<Overview>("/api/admin/overview")); }
    catch (e) { setOverviewError(e instanceof Error ? e.message : "Could not load overview"); }
    finally { setOverviewLoading(false); }
  }, []);
  const loadSection = useCallback(async () => {
    setError(""); setNotice(null);
    if (section === "Dashboard") { setResult(null); setLoading(false); return; }
    if (section === "System Settings") {
      setLoading(true); try { setSettings(await api<SettingsData>("/api/admin/settings")); }
      catch (e) { setError(e instanceof Error ? e.message : "Could not load system settings"); }
      finally { setLoading(false); } return;
    }
    const kind: EntityKind = section === "User Management" ? "users" : section === "Device Management" ? "devices" : section === "Subscription Management" ? "subscriptions" : section === "Payment Records" ? "payments" : section === "Token Management" ? "tokens" : "audit-logs";
    const queryParams: Record<string, string | number | undefined> = { page, pageSize, search: query };
    if (kind !== "tokens") queryParams.status = status;
    if (kind === "users") queryParams.subscriptionStatus = extraFilter;
    if (kind === "devices") queryParams.ownerId = extraFilter;
    if (kind === "audit-logs") { queryParams.action = status; queryParams.status = undefined; queryParams.targetType = extraFilter; }
    if (["users", "devices", "subscriptions", "payments", "audit-logs"].includes(kind)) queryParams.sort = sort.endsWith("_asc") ? "asc" : "desc";
    setLoading(true); try { setResult(await api<PageResult>(`${listPaths[kind]}?${queryString(queryParams)}`)); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load records"); }
    finally { setLoading(false); }
  }, [section, page, query, status, extraFilter, sort]);
  useEffect(() => { void fetchOverview(); }, [fetchOverview]);
  useEffect(() => { void loadSection(); }, [loadSection]);
  useEffect(() => { setPage(1); setResult(null); setStatus(""); setExtraFilter(""); setQuery(""); setDraftQuery(""); }, [section]);

  const kind: EntityKind | null = section === "User Management" ? "users" : section === "Device Management" ? "devices" : section === "Subscription Management" ? "subscriptions" : section === "Payment Records" ? "payments" : section === "Token Management" ? "tokens" : section === "Audit Logs" ? "audit-logs" : null;
  const rows = result?.items ?? [];
  const pageResult = result ?? { items: [], page: 1, pageSize, total: 0 };
  const columns = useMemo(() => kind ? listFields[kind].filter(f => rows.some(row => Object.prototype.hasOwnProperty.call(row, f)) && f !== "owner" && f !== "plan") : [], [kind, rows]);
  const openDetail = async (entity: EntityKind, row: Record<string, any>, preserveMutation = false, requestedLedgerPage?: number) => {
    const id = String(entity === "tokens" ? row.userId ?? row.id : row.id ?? row.targetId ?? "");
    setDetail({ kind: entity, id, row, loading: entity !== "audit-logs" });
    if (!preserveMutation) { setAdjustForm({ direction: "CREDIT", amount: "", reason: "" }); setExtendForm({ days: "", reason: "" }); setLedgerPage(1);
      setAdjustKey(""); setExtendKey(""); idempotency.current = { adjust: "", extend: "" }; }
    if (entity === "audit-logs") { setDetail({ kind: entity, id, row, data: row }); return; }
    const effectiveLedgerPage = requestedLedgerPage ?? (preserveMutation ? ledgerPage : 1);
    if (entity === "tokens") setLedgerPage(effectiveLedgerPage);
    let path = entity === "tokens" ? `${listPaths.tokens}/${encodeURIComponent(id)}/ledger?page=${effectiveLedgerPage}&pageSize=10` : `${listPaths[entity]}/${encodeURIComponent(id)}`;
    try { const data = await api<any>(path); setDetail(current => current?.id === id ? { ...current, data, loading: false } : current); if (entity === "users") { const catalog = await api<SettingsData>("/api/admin/settings"); setActivationPlans((catalog.plans ?? []).filter(plan => plan.active)); setActivationPlanId(current => current || (catalog.plans ?? []).find(plan => plan.active)?.id || ""); } }
    catch (e) { setDetail(current => current?.id === id ? { ...current, loading: false, error: e instanceof Error ? e.message : "Could not load record details" } : current); }
  };
  const reloadDetail = async () => { if (detail) await openDetail(detail.kind, detail.row, true); };
  const reloadCurrent = async () => { await loadSection(); if (section === "Dashboard") await fetchOverview(); };
  const showFailure = (e: unknown) => { const message = e instanceof Error ? e.message : "The request failed"; setNotice({ ok: false, text: message }); };

  const toggleSuspension = async () => {
    if (!detail || mutationLock.current) return; const currently = Boolean(detail.row.suspendedAt ?? detail.data?.user?.suspendedAt);
    const reason = window.prompt(currently ? "Reason for reactivating this account:" : "Reason for suspending this account:", "");
    if (reason === null) return; if (reason.trim().length < 3) { setNotice({ ok: false, text: "Enter a reason of at least 3 characters." }); return; }
    if (!window.confirm(`${currently ? "Reactivate" : "Suspend"} ${detail.row.phone ?? "this account"}?`)) return;
    mutationLock.current = true; setBusy(true); try { await api(`/api/admin/users/${encodeURIComponent(detail.id)}/suspension`, { method: "PATCH", body: JSON.stringify({ suspended: !currently, reason }) }); await reloadCurrent(); await reloadDetail(); setNotice({ ok: true, text: `Account ${currently ? "reactivated" : "suspended"}.` }); }
    catch (e) { showFailure(e); } finally { mutationLock.current = false; setBusy(false); }
  };
  const revokeDevice = async () => {
    if (!detail || mutationLock.current || !window.confirm(`Revoke device ${detail.row.deviceName ?? detail.id}? This cannot be undone here.`)) return;
    const reason = window.prompt("Reason for revoking this device:", ""); if (reason === null) return; if (reason.trim().length < 3) { setNotice({ ok: false, text: "Enter a reason of at least 3 characters." }); return; }
    mutationLock.current = true; setBusy(true); try { await api(`/api/admin/devices/${encodeURIComponent(detail.id)}/revoke`, { method: "POST", body: JSON.stringify({ reason }) }); await reloadCurrent(); await reloadDetail(); setNotice({ ok: true, text: "Device revoked." }); }
    catch (e) { showFailure(e); } finally { mutationLock.current = false; setBusy(false); }
  };
  const activateUserSubscription = async (event: FormEvent) => {
    event.preventDefault();
    if (!detail || detail.kind !== "users" || !activationPlanId || activationReason.trim().length < 3 || mutationLock.current) return;
    if (!window.confirm(`Activate ${activationPlans.find(p => p.id === activationPlanId)?.name ?? "selected plan"} for ${detail.row.phone ?? detail.id}?`)) return;
    if (!activationKey) setActivationKey(idempotencyKey());
    const key = activationKey || idempotencyKey();
    mutationLock.current = true; setBusy(true);
    try {
      await api(`/api/admin/users/${encodeURIComponent(detail.id)}/subscriptions/activate`, { method: "POST", body: JSON.stringify({ planId: activationPlanId, ...(activationDays.trim() ? { days: Number(activationDays) } : {}), reason: activationReason.trim(), idempotencyKey: key }) });
      setActivationKey(""); setActivationDays(""); setActivationReason("");
      await reloadCurrent(); await reloadDetail();
      setNotice({ ok: true, text: "Subscription activated. The user's account will show ACTIVE on its next profile refresh." });
    } catch (e) { showFailure(e); } finally { mutationLock.current = false; setBusy(false); }
  };

  const extendSubscription = async (event: FormEvent) => {
    event.preventDefault(); if (!detail || extendForm.reason.trim().length < 3 || mutationLock.current) return;
    if (!window.confirm(`Extend this subscription by ${extendForm.days} days?`)) return;
    if (!idempotency.current.extend) idempotency.current.extend = idempotencyKey(); setExtendKey(idempotency.current.extend);
    mutationLock.current = true; setBusy(true); try { await api(`/api/admin/subscriptions/${encodeURIComponent(detail.id)}/extend`, { method: "POST", body: JSON.stringify({ days: Number(extendForm.days), reason: extendForm.reason.trim(), idempotencyKey: idempotency.current.extend }) }); idempotency.current.extend = ""; setExtendKey(""); await reloadCurrent(); await reloadDetail(); setNotice({ ok: true, text: "Subscription extended." }); }
    catch (e) { showFailure(e); } finally { mutationLock.current = false; setBusy(false); }
  };
  const adjustTokens = async (event: FormEvent) => {
    event.preventDefault(); if (!detail || adjustForm.reason.trim().length < 10 || mutationLock.current) return;
    if (!window.confirm(`${adjustForm.direction === "CREDIT" ? "Credit" : "Debit"} ${adjustForm.amount} tokens for ${detail.row.phone ?? detail.id}?`)) return;
    if (!idempotency.current.adjust) idempotency.current.adjust = idempotencyKey(); setAdjustKey(idempotency.current.adjust);
    mutationLock.current = true; setBusy(true); try { await api(`/api/admin/tokens/${encodeURIComponent(detail.id)}/adjustments`, { method: "POST", body: JSON.stringify({ direction: adjustForm.direction, amount: Number(adjustForm.amount), reason: adjustForm.reason.trim(), idempotencyKey: idempotency.current.adjust }) }); idempotency.current.adjust = ""; setAdjustKey(""); await reloadCurrent(); await reloadDetail(); setNotice({ ok: true, text: "Token ledger adjustment recorded." }); }
    catch (e) { showFailure(e); } finally { mutationLock.current = false; setBusy(false); }
  };
  const savePlan = async (plan: Plan) => {
    if (mutationLock.current || !window.confirm(`Save changes to the existing plan “${plan.name}”?`)) return;
    mutationLock.current = true;
    setSavingPlan(plan.id); setNotice(null);
    try { await api(`/api/admin/plans/${encodeURIComponent(plan.id)}`, { method: "PUT", body: JSON.stringify({ code: plan.code, name: plan.name, priceKes: Number(plan.priceKes), durationDays: Number(plan.durationDays), maxDevices: plan.maxDevices == null ? null : Number(plan.maxDevices), transactionHistoryDays: Number(plan.transactionHistoryDays), active: Boolean(plan.active) }) }); setNotice({ ok: true, text: `Plan ${plan.name} updated.` }); const updated = await api<SettingsData>("/api/admin/settings"); setSettings(updated); setPlanDrafts({}); }
    catch (e) { showFailure(e); } finally { mutationLock.current = false; setSavingPlan(""); }
  };

  const dataForDetail = detail?.data;
  const userRecord = dataForDetail?.user ?? detail?.row;
  const wrappedEntity = detail?.kind === "devices" ? dataForDetail?.device : detail?.kind === "subscriptions" ? dataForDetail?.subscription : detail?.kind === "payments" ? dataForDetail?.payment : null;
  const detailRecord = detail && detail.kind === "users" ? userRecord : wrappedEntity ?? (dataForDetail && !Array.isArray(dataForDetail) && !dataForDetail.items ? dataForDetail : detail?.row);
  const detailTitle = detail ? `${titleCase(detail.kind.slice(0, -1))} details` : "Record details";
  const headerTitle = section === "Dashboard" ? "Admin dashboard" : section;
  const statusOptions = section === "Payment Records" ? ["PENDING", "SUCCESS", "FAILED", "REVERSED"] : section === "User Management" ? ["ACTIVE", "SUSPENDED"] : section === "Device Management" ? ["ONLINE", "OFFLINE", "REVOKED"] : section === "Subscription Management" ? ["ACTIVE", "EXPIRED", "CANCELLED", "PENDING"] : [];

  return <div className="ap-shell">
    <aside className={`ap-sidebar ${mobileNav ? "open" : ""}`} aria-label="Administration navigation">
      <div className="ap-brand"><span className="ap-mark">B</span><span><strong>Bingwa Sokoni</strong><small>ADMIN CONSOLE</small></span><button className="ap-icon-button ap-mobile-close" aria-label="Close navigation" onClick={() => setMobileNav(false)}><X size={19}/></button></div>
      <div className="ap-user"><span className="ap-avatar">{username.slice(0, 1).toUpperCase()}</span><span><strong>{username}</strong><small>Administrator</small></span><ShieldCheck size={16}/></div>
      <nav className="ap-nav">{sections.map(({ name, icon: Icon }) => <button key={name} className={`ap-nav-item ${section === name ? "selected" : ""}`} aria-current={section === name ? "page" : undefined} onClick={() => { setSection(name); setMobileNav(false); }}><Icon size={17}/><span>{name}</span></button>)}</nav>
      <div className="ap-side-foot"><span><ShieldCheck size={15}/> Protected admin session</span><button className="ap-nav-item" onClick={onLogout}><LogOut size={17}/><span>Sign out</span></button></div>
    </aside>
    {mobileNav && <button className="ap-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)}/>}
    <main className="ap-main"><header className="ap-topbar"><button className="ap-icon-button ap-mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={20}/></button><div><span className="ap-crumb">Administration /</span><strong>{section}</strong></div><div className="ap-top-actions"><span className="ap-session"><i/> Secure session</span><button className="ap-button secondary" onClick={() => void reloadCurrent()}><RefreshCw size={15}/> Refresh</button><button className="ap-button secondary" onClick={onLogout}><LogOut size={15}/> Sign out</button></div></header>
      <div className="ap-content"><div className="ap-heading"><div><span className="ap-eyebrow">BINGWA SOKONI · ADMINISTRATION</span><h1>{headerTitle}</h1><p>Administrative actions are audited and independently authorized by the API.</p></div></div>
        {notice && <div className={`ap-notice ${notice.ok ? "success" : "failure"}`} role="status"><span>{notice.ok ? "Success" : "Request failed"}: {notice.text}</span><button className="ap-icon-button" aria-label="Dismiss notice" onClick={() => setNotice(null)}><X size={16}/></button></div>}
        {section === "Dashboard" && <>
          {overviewLoading && <div className="ap-state" role="status">Loading overview…</div>}
          {overviewError && <div className="ap-state error" role="alert"><CircleAlert size={19}/><span>{overviewError}</span><button className="ap-button secondary" onClick={() => void fetchOverview()}>Retry</button></div>}
          {overview && <div className="ap-metrics"><Metric icon={Users} label="Users" value={overview.users} note="Registered accounts"/><Metric icon={Smartphone} label="Devices" value={overview.devices} note="Non-revoked devices"/><Metric icon={CreditCard} label="Pending payments" value={overview.pendingPayments} note="Awaiting verification"/><Metric icon={Activity} label="Active subscriptions" value={overview.activeSubscriptions} note="Active and unexpired"/><Metric icon={ClipboardList} label="Queued commands" value={overview.queuedCommands} note="Unexpired queued commands"/></div>}
          <section className="ap-panel ap-welcome"><div className="ap-panel-icon"><ShieldCheck size={21}/></div><div><h2>Administrator access</h2><p>Manage portal records using the role-protected admin APIs. Payment records are read-only; token and subscription changes require audited reasons.</p></div></section>
        </>}
        {section === "System Settings" && <>
          {loading && <div className="ap-state" role="status">Loading system settings…</div>}
          {error && <div className="ap-state error" role="alert"><CircleAlert size={19}/><span>{error}</span><button className="ap-button secondary" onClick={() => void loadSection()}>Retry</button></div>}
          {settings && !loading && <>
            <section className="ap-panel"><div className="ap-panel-heading"><div><h2>Runtime metadata</h2><p>Read-only values reported by the service. This is not an environment editor.</p></div><span className="ap-badge neutral">READ ONLY</span></div><div className="ap-runtime">{Object.entries(settings.runtime ?? {}).map(([key, value]) => <div key={key}><span>{titleCase(key)}</span><strong>{String(value ?? "—")}</strong></div>)}</div></section>
            <section className="ap-panel"><div className="ap-panel-heading"><div><h2>Existing plans</h2><p>Edit plan configuration only. No arbitrary runtime or environment settings can be changed here.</p></div></div>
              {!settings.plans?.length ? <div className="ap-empty">No existing plans were returned by the API.</div> : <div className="ap-plan-grid">{settings.plans.map(plan => { const draft = planDrafts[plan.id] ?? plan; return <form className="ap-plan" key={plan.id} onSubmit={e => { e.preventDefault(); void savePlan(draft); }}><div className="ap-plan-head"><div><span className="ap-overline">{draft.code}</span><h3>{draft.name || "Unnamed plan"}</h3></div><StatusBadge value={draft.active ? "ACTIVE" : "INACTIVE"}/></div><label>Plan name<input aria-label={`${draft.name} plan name`} value={draft.name} onChange={e => setPlanDrafts(p => ({ ...p, [plan.id]: { ...draft, name: e.target.value } }))}/></label><div className="ap-plan-fields"><label>Price (KSh)<input type="number" min="0" step="1" value={draft.priceKes} onChange={e => setPlanDrafts(p => ({ ...p, [plan.id]: { ...draft, priceKes: Number(e.target.value) } }))}/></label><label>Duration (days)<input type="number" min="1" value={draft.durationDays} onChange={e => setPlanDrafts(p => ({ ...p, [plan.id]: { ...draft, durationDays: Number(e.target.value) } }))}/></label><label>Maximum devices (blank = unlimited)<input type="number" min="1" value={draft.maxDevices ?? ""} onChange={e => setPlanDrafts(p => ({ ...p, [plan.id]: { ...draft, maxDevices: e.target.value === "" ? null : Number(e.target.value) } }))}/></label><label>Transaction history (days)<input type="number" min="0" value={draft.transactionHistoryDays} onChange={e => setPlanDrafts(p => ({ ...p, [plan.id]: { ...draft, transactionHistoryDays: Number(e.target.value) } }))}/></label></div><label className="ap-checkbox"><input type="checkbox" checked={draft.active} onChange={e => setPlanDrafts(p => ({ ...p, [plan.id]: { ...draft, active: e.target.checked } }))}/> Plan active</label><div className="ap-plan-actions"><button type="button" className="ap-button secondary" disabled={savingPlan === plan.id || !planDrafts[plan.id]} onClick={() => setPlanDrafts(p => { const next = { ...p }; delete next[plan.id]; return next; })}>Reset</button><button className="ap-button primary" disabled={savingPlan === plan.id || !planDrafts[plan.id]}>{savingPlan === plan.id ? "Saving…" : "Save plan"}</button></div></form>; })}</div>}
            </section>
          </>}
        </>}
        {kind && <section className="ap-panel ap-list-panel"><div className="ap-panel-heading"><div><h2>{section}</h2><p>{section === "Payment Records" ? "Read-only payment records. Never mark a payment as paid from this console." : section === "Token Management" ? "Balances and immutable ledger. Adjustments are sent only to the backend." : "Search, filter, inspect records, and use audited actions where available."}</p></div></div>
          <form className="ap-filters" onSubmit={e => { e.preventDefault(); setPage(1); setQuery(draftQuery.trim()); }}><label className="ap-search"><span>Search records</span><div><Search size={16}/><input aria-label="Search records" value={draftQuery} onChange={e => setDraftQuery(e.target.value)} placeholder="Search…"/><button className="ap-button secondary" type="submit">Search</button></div></label>
            {kind !== "tokens" && kind !== "audit-logs" && <label><span>Status</span><select aria-label="Filter by status" value={status} onChange={e => { setPage(1); setStatus(e.target.value); }}><option value="">All statuses</option>{statusOptions.map(option => <option key={option} value={option}>{titleCase(option)}</option>)}</select></label>}
            {kind === "users" && <label><span>Subscription</span><select aria-label="Filter by subscription status" value={extraFilter} onChange={e => { setPage(1); setExtraFilter(e.target.value); }}><option value="">Any subscription</option>{["ACTIVE", "EXPIRED", "CANCELLED", "NONE", "PENDING"].map(v => <option key={v}>{v}</option>)}</select></label>}
            {kind === "devices" && <label><span>Owner ID</span><input aria-label="Filter by owner ID" value={extraFilter} onChange={e => { setPage(1); setExtraFilter(e.target.value); }} placeholder="Owner ID"/></label>}
            {kind === "audit-logs" && <><label><span>Action</span><input aria-label="Filter by action" value={status} onChange={e => { setPage(1); setStatus(e.target.value); }} placeholder="Action"/></label><label><span>Target type</span><input aria-label="Filter by target type" value={extraFilter} onChange={e => { setPage(1); setExtraFilter(e.target.value); }} placeholder="Target type"/></label></>}
            {kind !== "tokens" && <label><span>Sort</span><select aria-label="Sort records" value={sort} onChange={e => setSort(e.target.value)}><option value="createdAt_desc">Newest first</option><option value="createdAt_asc">Oldest first</option></select></label>}
          </form>
          {error && <div className="ap-state error" role="alert"><CircleAlert size={19}/><span>{error}</span><button className="ap-button secondary" onClick={() => void loadSection()}>Retry</button></div>}
          {loading && <div className="ap-state" role="status">Loading records…</div>}
          {!loading && !error && result && rows.length === 0 && <div className="ap-empty">No records match these filters.</div>}
          {!loading && !error && rows.length > 0 && <><div className="ap-table-wrap"><table className="ap-table"><thead><tr>{columns.map(col => <th key={col}>{titleCase(col)}</th>)}<th><span className="ap-sr-only">Record actions</span></th></tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? row.userId ?? row.targetId ?? index)}>{columns.map(col => { const v = row[col]; const obj = v && typeof v === "object" ? v as Record<string, any> : null; const value = obj ? (obj.phone ?? obj.name ?? obj.planName ?? "—") : v; return <td key={col}>{/status/i.test(col) ? <StatusBadge value={value}/> : /At$|Date$/.test(col) ? dateText(value) : col === "amountKes" ? `KSh ${value ?? "—"}` : scalar(value) || "—"}</td>; })}<td><button className="ap-button secondary ap-view" onClick={() => void openDetail(kind, row)}>View details</button></td></tr>)}</tbody></table></div><div className="ap-pagination"><span>{pageResult.total ? `Showing ${(pageResult.page - 1) * pageResult.pageSize + 1}–${Math.min(pageResult.page * pageResult.pageSize, pageResult.total)} of ${pageResult.total}` : "No records"}</span><div><button className="ap-button secondary" aria-label="Previous page" disabled={pageResult.page <= 1 || loading} onClick={() => setPage(Math.max(1, pageResult.page - 1))}><ChevronLeft size={16}/> Previous</button><span>Page {pageResult.page} of {Math.max(1, Math.ceil(pageResult.total / pageResult.pageSize))}</span><button className="ap-button secondary" aria-label="Next page" disabled={pageResult.page * pageResult.pageSize >= pageResult.total || loading} onClick={() => setPage(Math.min(Math.ceil(pageResult.total / pageResult.pageSize), pageResult.page + 1))}>Next <ChevronRight size={16}/></button></div></div></>}
        </section>}
        <footer className="ap-footer"><span>© 2026 Bingwa Sokoni Portal</span><span><i/> Secure administrator session</span></footer>
      </div>
    </main>
    {detail && <div className="ap-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget && !busy) setDetail(null); }}><section className="ap-drawer" role="dialog" aria-modal="true" aria-labelledby="ap-detail-title"><header><div><span className="ap-eyebrow">RECORD INSPECTOR</span><h2 id="ap-detail-title">{detailTitle}</h2></div><button className="ap-icon-button" aria-label="Close details" onClick={() => setDetail(null)}><X size={20}/></button></header>
      {detail.loading && <div className="ap-state" role="status">Loading details…</div>}{detail.error && <div className="ap-state error" role="alert"><span>{detail.error}</span><button className="ap-button secondary" onClick={() => void reloadDetail()}>Retry</button></div>}
      {!detail.loading && !detail.error && <div className="ap-detail-content">
        {detail.kind === "users" ? <><SafeFields data={userRecord ?? {}} fields={detailFields.users}/>{["devices", "subscriptions", "payments", "auditEvents"].map(key => <section className="ap-detail-group" key={key}><h3>{titleCase(key)}</h3>{Array.isArray(dataForDetail?.[key]) && dataForDetail[key].length ? dataForDetail[key].map((item: any, i: number) => <div className="ap-mini-record" key={item.id ?? i}><SafeFields data={item} fields={key === "devices" ? detailFields.devices : key === "payments" ? detailFields.payments : key === "subscriptions" ? detailFields.subscriptions : detailFields["audit-logs"]}/></div>) : <p className="ap-muted">No {key} records returned.</p>}</section>)}</> : detail.kind === "tokens" ? <><SafeFields data={dataForDetail?.user ?? detail.row} fields={detailFields.tokens.filter(f => f !== "items")}/><div className="ap-detail-group"><h3>Token ledger</h3>{Array.isArray(dataForDetail?.items) && dataForDetail.items.length ? dataForDetail.items.map((item: any, i: number) => <div className="ap-mini-record" key={item.id ?? i}><SafeFields data={item} fields={["id", "delta", "balanceAfter", "reason", "reference", "createdAt"]}/></div>) : <p className="ap-muted">No ledger entries returned.</p>}{dataForDetail?.total > 10 && <div className="ap-pagination"><span>Page {dataForDetail.page} of {Math.max(1, Math.ceil(dataForDetail.total / dataForDetail.pageSize))}</span><div><button className="ap-button secondary" disabled={ledgerPage <= 1 || busy} onClick={() => void openDetail("tokens", detail.row, true, ledgerPage - 1)}>Previous</button><button className="ap-button secondary" disabled={ledgerPage * 10 >= dataForDetail.total || busy} onClick={() => void openDetail("tokens", detail.row, true, ledgerPage + 1)}>Next</button></div></div>}</div></> : <><SafeFields data={detailRecord ?? detail.row} fields={detailFields[detail.kind]}/>{detail.kind === "devices" && (dataForDetail?.owner ?? dataForDetail?.user ?? detailRecord?.owner ?? detailRecord?.user) && <section className="ap-detail-group"><h3>Owner</h3><SafeFields data={dataForDetail?.owner ?? dataForDetail?.user ?? detailRecord.owner ?? detailRecord.user} fields={["id", "phone", "role"]}/></section>}{detail.kind === "subscriptions" && (dataForDetail?.plan ?? detailRecord?.plan) && <section className="ap-detail-group"><h3>Plan</h3><SafeFields data={dataForDetail?.plan ?? detailRecord.plan} fields={["id", "code", "name", "priceKes", "durationDays", "maxDevices", "transactionHistoryDays", "active"]}/></section>}</>}
        {detail.kind === "users" && <form className="ap-mutation" onSubmit={e => void activateUserSubscription(e)}><h3>Activate subscription</h3><label>Plan<select required value={activationPlanId} onChange={e => setActivationPlanId(e.target.value)}><option value="">Select a plan</option>{activationPlans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} — KSh {plan.priceKes} / {plan.durationDays} days</option>)}</select></label>{!activationPlans.length && <p className="ap-muted">No active plans returned. The API seeds the catalogue during startup; check database connectivity and deployment logs.</p>}<label>Duration override in days (optional)<input type="number" min="1" max="3650" value={activationDays} onChange={e => setActivationDays(e.target.value)} placeholder="Use plan duration"/></label><label>Reason (required)<textarea required minLength={3} value={activationReason} onChange={e => setActivationReason(e.target.value)} placeholder="Reason for manual activation"/></label><button className="ap-button primary" disabled={busy || !activationPlanId || activationReason.trim().length < 3}>{busy ? "Activating…" : "Activate subscription"}</button></form>}
        {detail.kind === "users" && <div className="ap-action"><button className={`ap-button ${userRecord?.suspendedAt ? "primary" : "danger"}`} disabled={busy} onClick={() => void toggleSuspension()}>{busy ? "Working…" : userRecord?.suspendedAt ? "Reactivate account" : "Suspend account"}</button></div>}
        {detail.kind === "devices" && <div className="ap-action"><button className="ap-button danger" disabled={busy || String(detailRecord?.status ?? detail.row.status).toUpperCase() === "REVOKED"} onClick={() => void revokeDevice()}>{busy ? "Working…" : "Revoke device"}</button></div>}
        {detail.kind === "subscriptions" && <form className="ap-mutation" onSubmit={e => void extendSubscription(e)}><h3>Extend subscription</h3><label>Additional days<input type="number" min="1" step="1" required value={extendForm.days} onChange={e => setExtendForm(v => ({ ...v, days: e.target.value }))}/></label><label>Reason (required)<textarea required minLength={3} value={extendForm.reason} onChange={e => setExtendForm(v => ({ ...v, reason: e.target.value }))}/></label><button className="ap-button primary" disabled={busy || extendForm.reason.trim().length < 3}>{busy ? "Submitting…" : extendKey ? "Retry extension" : "Extend subscription"}</button></form>}
        {detail.kind === "tokens" && <form className="ap-mutation" onSubmit={e => void adjustTokens(e)}><h3>Manual token adjustment</h3><label>Direction<select value={adjustForm.direction} onChange={e => setAdjustForm(v => ({ ...v, direction: e.target.value }))}><option value="CREDIT">Credit</option><option value="DEBIT">Debit</option></select></label><label>Amount<input type="number" min="1" step="1" required value={adjustForm.amount} onChange={e => setAdjustForm(v => ({ ...v, amount: e.target.value }))}/></label><label>Reason (required)<textarea required minLength={10} value={adjustForm.reason} onChange={e => setAdjustForm(v => ({ ...v, reason: e.target.value }))}/></label><button className="ap-button primary" disabled={busy || adjustForm.reason.trim().length < 10}>{busy ? "Submitting…" : adjustKey ? "Retry adjustment" : "Submit adjustment"}</button><p className="ap-muted">The backend ledger is the source of truth for balances.</p></form>}
        {detail.kind === "devices" && Array.isArray(dataForDetail?.commands) && <section className="ap-detail-group"><h3>Recent command lifecycle</h3>{dataForDetail.commands.length ? dataForDetail.commands.map((command: any) => <div className="ap-mini-record" key={command.id}><SafeFields data={command} fields={["id", "commandType", "status", "expiresAt", "deliveredAt", "startedAt", "completedAt", "errorMessage", "createdAt"]}/></div>) : <p className="ap-muted">No recent commands returned.</p>}</section>}
        {detail.kind === "payments" && <div className="ap-readonly-note"><ShieldCheck size={16}/> Payment records are read-only. This console cannot mark payments as paid.</div>}
        {detail.kind === "audit-logs" && <><div className="ap-readonly-note"><ShieldCheck size={16}/> Audit records are read-only.</div>{detail.row.metadata && <section className="ap-detail-group"><h3>Safe event metadata</h3><div className="ap-mini-record"><SafeFields data={detail.row.metadata} fields={Object.keys(detail.row.metadata)}/></div></section>}</>}
      </div>}
      <div className="ap-drawer-bottom"><button className="ap-button secondary" onClick={() => setDetail(null)}><ArrowLeft size={15}/> Close</button></div>
    </section></div>}
  </div>;
}
