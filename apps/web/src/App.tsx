import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Activity, ArrowDownLeft, ArrowUpRight, Bell, CheckCircle2, ChevronDown, CircleHelp, Command, CreditCard, Database, LayoutDashboard, LogOut, Menu, MonitorSmartphone, Plus, RefreshCw, Search, Settings, ShieldCheck, Smartphone, Users, Wallet, Wifi, X } from "lucide-react";
import { api } from "./api";

type Device = { id: string; deviceName: string; status: string; lastSeenAt?: string | null; appVersion?: string | null; model?: string | null; automationEnabled: boolean; executionState: string };
type Me = { id: string; phone: string; role: string; tokenBalance: number; devices: Device[]; subscriptions: any[] };
type Tx = { id: string; phoneNumber: string; packageName: string; amountKes: string; status: string; lastSyncedAt: string; device: { deviceName: string } };

const nav = [
  { label: "Overview", icon: LayoutDashboard, group: "WORKSPACE" },
  { label: "My Devices", icon: Smartphone, group: "WORKSPACE" },
  { label: "Transactions", icon: Activity, group: "WORKSPACE" },
  { label: "Data Plans", icon: Database, group: "WORKSPACE" },
  { label: "Transaction Queue", icon: Database, group: "WORKSPACE" },
  { label: "Signature Learning", icon: ShieldCheck, group: "AUTOMATION" },
  { label: "Approved Signatures", icon: CheckCircle2, group: "AUTOMATION" },
  { label: "Buy Tokens", icon: Wallet, group: "BILLING" },
  { label: "Token History", icon: ArrowDownLeft, group: "BILLING" },
  { label: "Subscription", icon: CreditCard, group: "BILLING" },
  { label: "Account Settings", icon: Settings, group: "ACCOUNT" }
];

function money(value: unknown) { return `KSh ${Number(value || 0).toLocaleString("en-KE")}`; }
function time(value?: string | null) { return value ? new Date(value).toLocaleString() : "Not connected yet"; }

export default function App() {
  const [page, setPage] = useState("Overview");
  const [me, setMe] = useState<Me | null>(null);
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loginPhone, setLoginPhone] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [registering, setRegistering] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [showPair, setShowPair] = useState(false);
  const [commandBusy, setCommandBusy] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [dataPlans, setDataPlans] = useState<any[]>([]);
  const [planMode, setPlanMode] = useState<"SIMPLE" | "ADVANCED">("SIMPLE");
  const [editingPlan, setEditingPlan] = useState<any | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);

  async function refresh() {
    if (!localStorage.getItem("bingwa_token")) return;
    setLoading(true); setError("");
    try {
      const [profile, tx, plans] = await Promise.all([
        api<Me>("/api/me"),
        api<Tx[]>("/api/transactions"),
        api<any[]>("/api/data-plans")
      ]);
      setMe(profile); setTransactions(tx); setDataPlans(plans);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load portal data"); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function auth() {
    setError("");
    try {
      const result = await api<any>(registering ? "/api/auth/register" : "/api/auth/login", {
        method: "POST", body: JSON.stringify({ phone: loginPhone, password: loginPassword })
      });
      localStorage.setItem("bingwa_token", result.token);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Sign in failed"); }
  }
  async function createPairCode() {
    try {
      const result = await api<{code:string;expiresAt:string}>("/api/devices/pairing-code", { method: "POST", body: "{}" });
      setPairCode(result.code); setShowPair(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create link code"); }
  }
  async function command(device: Device, commandType: string) {
    setCommandBusy(`${device.id}:${commandType}`); setError("");
    try {
      await api(`/api/devices/${device.id}/commands`, { method: "POST", body: JSON.stringify({ commandType, payload: {}, idempotencyKey: crypto.randomUUID() }) });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Command could not be queued"); }
    finally { setCommandBusy(""); }
  }
  async function savePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editingPlan) return; setSavingPlan(true); setError("");
    const form = new FormData(event.currentTarget);
    const payload = { packageName: String(form.get("packageName") || ""), description: String(form.get("description") || ""), ussdCode: String(form.get("ussdCode") || ""), ussdSteps: String(form.get("ussdSteps") || "") || null, priceKes: Number(form.get("priceKes") || 0), validity: String(form.get("validity") || ""), dataAmount: String(form.get("dataAmount") || ""), category: String(form.get("category") || "DATA"), isActive: form.get("isActive") === "on", commissionPerSale: Number(form.get("commissionPerSale") || 0), executeSim: Number(form.get("executeSim") || -1), ussdMode: String(form.get("ussdMode") || "SIMPLE") as "SIMPLE" | "ADVANCED", source: String(form.get("source") || "CUSTOM"), expectedVersion: Number(editingPlan.version) };
    try { await api(`/api/data-plans/${editingPlan.id}`, { method: "PUT", body: JSON.stringify(payload) }); setEditingPlan(null); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Plan could not be saved"); } finally { setSavingPlan(false); }
  }

  function logout() { localStorage.removeItem("bingwa_token"); setMe(null); setTransactions([]); }

  if (!me) return <div className="auth-shell">
    <div className="auth-card">
      <div className="brand-mark">B</div><div className="eyebrow">BINGWA SOKONI</div>
      <h1>{registering ? "Create your account" : "Welcome back"}</h1>
      <p className="muted">Manage your connected phones, automation and tokens in one place.</p>
      {error && <div className="alert">{error}</div>}
      <label>Phone number</label><input value={loginPhone} onChange={e=>setLoginPhone(e.target.value)} placeholder="2547XXXXXXXX" autoComplete="tel" />
      <label>Password</label><input type="password" value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="At least 10 characters" autoComplete={registering?"new-password":"current-password"} />
      <button className="primary full" onClick={auth}>{registering ? "Create account" : "Sign in"}</button>
      <button className="text-button full" onClick={()=>setRegistering(!registering)}>{registering ? "Already have an account? Sign in" : "New to Bingwa? Create an account"}</button>
      <div className="auth-foot"><ShieldCheck size={15}/> Secure account access · Phone verification setup required before production</div>
    </div>
  </div>;

  const online = me.devices.filter(d => d.status === "ONLINE").length;
  const activeSub = me.subscriptions?.find(s => s.status === "ACTIVE" && s.expiresAt && new Date(s.expiresAt) > new Date());
  const title = page === "Overview" ? "Dashboard overview" : page;
  return <div className="app-shell">
    <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
      <div className="brand"><div className="brand-mark">B</div><div><strong>Bingwa Sokoni</strong><small>PORTAL</small></div><button className="icon-button mobile-close" onClick={()=>setMobileNav(false)}><X size={18}/></button></div>
      <div className="workspace"><span className="workspace-icon">BS</span><div><strong>My Workspace</strong><small>{me.phone}</small></div><ChevronDown size={15}/></div>
      {["WORKSPACE","AUTOMATION","BILLING","ACCOUNT"].map(group=><div className="nav-group" key={group}><div className="nav-label">{group}</div>{nav.filter(n=>n.group===group).map(n=><button key={n.label} className={`nav-item ${page===n.label?"selected":""}`} onClick={()=>{setPage(n.label);setMobileNav(false)}}><n.icon size={17}/><span>{n.label}</span>{n.label==="My Devices"&&<b className="nav-count">{me.devices.length}</b>}</button>)}</div>)}
      {me.role==="ADMIN"&&<div className="nav-group"><div className="nav-label">ADMINISTRATION</div><button className={`nav-item ${page==="Admin Panel"?"selected":""}`} onClick={()=>setPage("Admin Panel")}><Users size={17}/><span>Admin Panel</span></button></div>}
      <div className="sidebar-bottom"><div className="help-card"><CircleHelp size={18}/><strong>Need help?</strong><span>Portal help centre</span></div><button className="nav-item" onClick={logout}><LogOut size={17}/><span>Sign out</span></button><div className="profile"><div className="avatar">{me.phone.slice(-2)}</div><div><strong>{me.phone}</strong><small>{me.role==="ADMIN"?"Administrator":"Account owner"}</small></div><Settings size={16}/></div></div>
    </aside>
    {mobileNav&&<div className="scrim" onClick={()=>setMobileNav(false)}/>}
    <main className="main">
      <header className="topbar"><button className="icon-button mobile-menu" onClick={()=>setMobileNav(true)}><Menu size={20}/></button><div className="breadcrumbs">Portal <span>/</span> <strong>{page}</strong></div><div className="top-actions"><div className="status-pill"><i/> System operational</div><button className="icon-button" onClick={()=>void refresh()} title="Refresh"><RefreshCw size={17}/></button><button className="icon-button" title="Notifications"><Bell size={17}/></button><div className="avatar small">{me.phone.slice(-2)}</div></div></header>
      <div className="content">
        {error&&<div className="alert page-alert">{error}<button onClick={()=>setError("")}><X size={15}/></button></div>}
        <div className="page-heading"><div><div className="eyebrow">YOUR OPERATIONS AT A GLANCE</div><h1>{title}</h1><p className="muted">{page==="Overview"?"Monitor your connected devices, transactions and account activity.":"Manage your Bingwa Sokoni account and connected automation devices."}</p></div><button className="primary" onClick={createPairCode}><Plus size={17}/> Link new phone</button></div>
        {page==="Overview"&&<>
          <div className="welcome-banner"><div><div className="welcome-tag"><span/> LIVE WORKSPACE</div><h2>Good to have you back.</h2><p>Your automation workspace, connected devices and transactions in one view.</p><button className="banner-button" onClick={()=>setPage("My Devices")}>Manage devices <ArrowUpRight size={16}/></button></div><div className="banner-art"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="phone-art"><Smartphone size={55}/><span><i/></span></div><div className="floating-chip"><Wifi size={15}/> Secure sync</div></div></div>
          <div className="metric-grid">
            <Metric icon={<MonitorSmartphone/>} label="Connected devices" value={`${online} / ${me.devices.length}`} note={`${me.devices.length-online} offline`} />
            <Metric icon={<Activity/>} label="Transactions synced" value={String(transactions.length)} note="Synced from connected phones" />
            <Metric icon={<Wallet/>} label="Token balance" value={String(me.tokenBalance)} note="Shared account balance" />
            <Metric icon={<CreditCard/>} label="Subscription" value={activeSub?.plan?.name??"Inactive"} note={activeSub?.expiresAt?`Expires ${new Date(activeSub.expiresAt).toLocaleDateString()}`:"Renew to enable Portal commands"} />
          </div>
          <div className="section-grid">
            <section className="panel"><div className="panel-heading"><div><h3>Recent transactions</h3><p>Latest records reported by your devices</p></div><button className="link-button" onClick={()=>setPage("Transactions")}>View all <ArrowUpRight size={14}/></button></div><Transactions rows={transactions.slice(0,5)}/></section>
            <section className="panel"><div className="panel-heading"><div><h3>My devices</h3><p>Device connectivity and automation status</p></div><button className="link-button" onClick={()=>setPage("My Devices")}>Manage <ArrowUpRight size={14}/></button></div>
              {me.devices.length===0?<Empty title="No phones linked yet" detail="Generate a one-time code to link your Android app." action={<button className="primary small-btn" onClick={createPairCode}>Link first phone</button>}/>:me.devices.slice(0,4).map(d=><DeviceRow key={d.id} device={d}/>)}
            </section>
          </div>
        </>}
        {page==="My Devices"&&<section className="panel"><div className="panel-heading"><div><h3>Linked phones</h3><p>Only devices linked to your account can receive commands.</p></div><button className="primary" onClick={createPairCode}><Plus size={16}/> Link new phone</button></div>{me.devices.length?me.devices.map(d=><div className="device-card" key={d.id}><DeviceRow device={d}/><div className="device-actions"><button disabled={commandBusy===`${d.id}:CHECK_AIRTIME`} onClick={()=>command(d,"CHECK_AIRTIME")}><RefreshCw size={14}/> Refresh balance</button><button disabled={commandBusy===`${d.id}:START_AUTOMATION`} onClick={()=>command(d,d.automationEnabled?"STOP_AUTOMATION":"START_AUTOMATION")}><Command size={14}/> {d.automationEnabled?"Stop automation":"Start automation"}</button></div></div>):<Empty title="No phones linked" detail="Create a code here, then enter it inside the Android app." action={<button className="primary" onClick={createPairCode}>Generate link code</button}/>}</section>}
        {page==="Data Plans"&&<section className="panel">
          <div className="panel-heading"><div><h3>Data Plans</h3><p>Simple and Advanced modes matching the Android app. The phone remains the USSD execution engine.</p></div><button className="icon-button" onClick={()=>void refresh()} title="Refresh plans"><RefreshCw size={16}/></button></div>
          <div className="mode-tabs"><button className={planMode==="SIMPLE"?"active":""} onClick={()=>setPlanMode("SIMPLE")}>Simple USSD</button><button className={planMode==="ADVANCED"?"active":""} onClick={()=>setPlanMode("ADVANCED")}>Advanced USSD</button></div>
          <div className="notice"><ShieldCheck size={18}/><div><strong>Phone execution stays authoritative</strong><p>Edits are versioned and marked pending sync. The matching Android update must download, validate, apply and acknowledge portal versions before those edits can affect execution.</p></div></div>
          {dataPlans.filter(p=>String(p.ussdMode).toUpperCase()===planMode).length===0 ? <Empty title={`No ${planMode==="SIMPLE"?"Simple":"Advanced"} plans synced`} detail="Open the app on a linked phone and allow it to sync its existing plans."/> : <div className="plan-list">{dataPlans.filter(p=>String(p.ussdMode).toUpperCase()===planMode).map(p=><div className="portal-plan-row" key={p.id}><div className="plan-row-main"><div className="plan-badge">{planMode==="ADVANCED"?"ADV":"SIM"}</div><div><strong>{p.packageName}</strong><span>{p.description||p.dataAmount||p.category} · {p.validity||"Validity not set"}</span><small>{p.device?.deviceName||"Linked phone"} · v{p.version} · {p.syncStatus==="PENDING_SYNC"?"Sync pending":"Synced"}</small></div></div><div className="plan-row-price"><strong>{money(p.priceKes)}</strong><span className={`tag ${p.isActive?"success":"pending"}`}>{p.isActive?"Enabled":"Disabled"}</span></div><button className="secondary" onClick={()=>setEditingPlan(p)}>Edit plan</button></div>)}</div>}
        </section>}
        {page==="Transactions"&&<section className="panel"><div className="panel-heading"><div><h3>Transaction history</h3><p>Records synchronized from your Android devices. Verify outcomes in the app when status is uncertain.</p></div><button className="icon-button" onClick={()=>void refresh()}><RefreshCw size={16}/></button></div><Transactions rows={transactions}/></section>}
        {page==="Transaction Queue"&&<section className="panel"><div className="panel-heading"><div><h3>Command and transaction queue</h3><p>Commands expire if the device does not receive them in time.</p></div></div><Empty title="Queue view is being connected" detail="The backend command log is available; the full queue detail view will be completed with the command lifecycle." /></section>}
        {page==="Signature Learning"&&<section className="panel"><div className="panel-heading"><div><h3>Signature learning</h3><p>Learn and approve signatures on the Android phone, where the live USSD menu can be validated.</p></div></div><Empty title="Learning happens on your phone" detail="Portal will show synchronization and compatibility status once the approved-signature upload contract is connected. The Portal cannot approve or execute chargeable steps." /></section>}
        {page==="Approved Signatures"&&<section className="panel"><div className="panel-heading"><div><h3>Approved signatures</h3><p>Approved signatures may be shared only with compatible devices on this account.</p></div></div><Empty title="No signature records to display" detail="Signature upload, version history and revocation endpoints are the next integration step." /></section>}
        {page==="Buy Tokens"&&<section className="panel"><div className="panel-heading"><div><h3>Buy tokens</h3><p>Token payments must be verified server-side before crediting the shared balance.</p></div></div><div className="notice"><ShieldCheck size={18}/><div><strong>Secure payment setup required</strong><p>Token purchase is not enabled until the backend payment provider and signed callback verification are configured. No tokens are credited by this prototype.</p></div></div><div className="balance-card"><span>Current token balance</span><strong>{me.tokenBalance}</strong><small>Shared with your linked Android app after ledger integration</small></div></section>}
        {page==="Token History"&&<section className="panel"><div className="panel-heading"><div><h3>Token history</h3><p>Every credit/debit will be recorded in an immutable ledger.</p></div></div><Empty title="No ledger entries loaded" detail="The database ledger is defined; the paginated history endpoint and Android balance reconciliation are pending." /></section>}
        {page==="Subscription"&&<><div className="plan-grid">{[{name:"Starter",price:80,devices:"Up to 2 devices",history:"3-day transaction history"},{name:"Pro",price:180,devices:"Up to 5 devices",history:"7-day transaction history"},{name:"Unlimited",price:350,devices:"Unlimited devices",history:"7-day transaction history"}].map(p=><div className={`plan-card ${activeSub?.plan?.name===p.name?"plan-current":""}`} key={p.name}><span className="plan-label">{activeSub?.plan?.name===p.name?"CURRENT PLAN":"30 DAYS"}</span><h3>{p.name}</h3><div className="plan-price">{money(p.price)}<small>/30 days</small></div><p><CheckCircle2 size={15}/>{p.devices}</p><p><CheckCircle2 size={15}/>{p.history}</p><button className="secondary full" disabled>Payment integration pending</button></div>)}</div><div className="notice"><CreditCard size={18}/><div><strong>Subscription renewal</strong><p>Your account remains accessible when a subscription expires, but subscription-dependent automation and remote commands must be disabled until renewal is confirmed.</p></div></div></>}
        {page==="Account Settings"&&<section className="panel"><div className="panel-heading"><div><h3>Account settings</h3><p>Profile and account security</p></div></div><div className="settings-row"><div><strong>Phone number</strong><span>{me.phone}</span></div><span className="tag pending">Verification provider required</span></div><div className="settings-row"><div><strong>Account role</strong><span>{me.role}</span></div></div><div className="settings-row"><div><strong>Security</strong><span>Password recovery and phone OTP must be configured before production.</span></div></div><button className="secondary" onClick={logout}><LogOut size={15}/> Sign out</button></section>}
        {page==="Admin Panel"&&<section className="panel"><div className="panel-heading"><div><h3>Administration</h3><p>Restricted account overview. Detailed management actions require separate audited endpoints.</p></div></div><Empty title="Admin overview API is ready" detail="User, subscription, device, payment, token and audit-log management screens need to be wired to role-protected admin endpoints. Separate transaction/signature monitoring pages are intentionally omitted." /></section>}
        <footer className="footer"><span>© 2026 Bingwa Sokoni Portal</span><span><i/> Secure connection architecture</span><span>{loading?"Syncing…":"Last refreshed just now"}</span></footer>
      </div>
    </main>
    {editingPlan&&<div className="modal-backdrop"><form className="modal plan-editor-modal" onSubmit={savePlan}>
      <button type="button" className="icon-button modal-close" onClick={()=>setEditingPlan(null)}><X size={18}/></button><div className="eyebrow">DATA PLAN · VERSION {editingPlan.version}</div><h2>Edit {editingPlan.ussdMode==="ADVANCED"?"Advanced":"Simple"} plan</h2><p className="muted">Changes are saved as a new version. A compatible Android sync update must apply them before execution.</p>
      <div className="form-grid"><label>Package name<input name="packageName" defaultValue={editingPlan.packageName} required maxLength={160}/></label><label>Price (KSh)<input name="priceKes" type="number" min="0" step="0.01" defaultValue={editingPlan.priceKes} required/></label><label>Description<input name="description" defaultValue={editingPlan.description||""}/></label><label>Data amount<input name="dataAmount" defaultValue={editingPlan.dataAmount||""}/></label><label>Validity<input name="validity" defaultValue={editingPlan.validity||""}/></label><label>Category<input name="category" defaultValue={editingPlan.category||"DATA"} required/></label><label>USSD mode<select name="ussdMode" defaultValue={editingPlan.ussdMode}><option value="SIMPLE">Simple USSD</option><option value="ADVANCED">Advanced USSD</option></select></label><label>Execute SIM<select name="executeSim" defaultValue={String(editingPlan.executeSim??-1)}><option value="-1">Use app default</option><option value="0">SIM 1</option><option value="1">SIM 2</option></select></label><label className="span-two">USSD code<input name="ussdCode" defaultValue={editingPlan.ussdCode} required maxLength={300}/></label><label className="span-two">Advanced USSD steps (comma-separated)<textarea name="ussdSteps" defaultValue={editingPlan.ussdSteps||""} placeholder="Example: 5,2,pn,1,1" maxLength={2000}/></label><label>Commission per sale<input name="commissionPerSale" type="number" min="0" step="0.01" defaultValue={editingPlan.commissionPerSale||0}/></label><label>Source<input name="source" defaultValue={editingPlan.source||"CUSTOM"}/></label><label className="checkbox-field"><input name="isActive" type="checkbox" defaultChecked={editingPlan.isActive}/> Plan enabled</label></div>
      <div className="modal-actions"><button type="button" className="secondary" onClick={()=>setEditingPlan(null)}>Cancel</button><button className="primary" disabled={savingPlan}>{savingPlan?"Saving…":"Save new version"}</button></div></form></div>}
    {showPair&&<div className="modal-backdrop"><div className="modal"><button className="icon-button modal-close" onClick={()=>setShowPair(false)}><X size={18}/></button><div className="modal-icon"><Smartphone size={23}/></div><div className="eyebrow">LINK A NEW DEVICE</div><h2>Your one-time linking code</h2><p className="muted">On your Android phone, open Bingwa Sokoni Automation → Settings → Portal linking and enter this code. It expires in 5 minutes.</p><div className="pair-code">{pairCode.split("").join(" ")}</div><div className="notice compact"><ShieldCheck size={17}/><span>Code only. It can be redeemed once; a device credential is issued securely in the background after successful linking.</span></div><button className="primary full" onClick={()=>{navigator.clipboard?.writeText(pairCode);}}>Copy code</button><button className="text-button full" onClick={()=>setShowPair(false)}>Done</button></div></div>}
  </div>;
}
function Metric({icon,label,value,note}:{icon:React.ReactNode;label:string;value:string;note:string}){return <div className="metric-card"><div className="metric-top"><span className="metric-icon">{icon}</span><span className="metric-dots">•••</span></div><span className="metric-label">{label}</span><strong>{value}</strong><small>{note}</small></div>}
function DeviceRow({device}:{device:Device}){return <div className="device-row"><div className="device-icon"><Smartphone size={21}/></div><div className="device-info"><strong>{device.deviceName}</strong><span>{device.model||"Android device"} · {device.appVersion||"App version unknown"}</span></div><div className="device-state"><span className={`state-dot ${device.status==="ONLINE"?"online":""}`}/><span>{device.status==="ONLINE"?"Online":"Offline"}</span></div><div className="device-extra"><span>{device.automationEnabled?"Automation enabled":"Automation stopped"}</span><small>Last seen {time(device.lastSeenAt)}</small></div></div>}
function Transactions({rows}:{rows:Tx[]}){if(!rows.length)return <Empty title="No transactions synced yet" detail="Once a phone is linked and syncs successfully, recent transaction records will appear here."/>;return <div className="table-wrap"><table><thead><tr><th>Customer / Phone</th><th>Package</th><th>Device</th><th>Amount</th><th>Status</th><th>Last synced</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><strong>{r.phoneNumber}</strong></td><td>{r.packageName}</td><td>{r.device?.deviceName||"Android device"}</td><td>{money(r.amountKes)}</td><td><span className={`tag ${r.status==="COMPLETED"?"success":r.status==="FAILED"?"danger":"pending"}`}>{r.status}</span></td><td>{time(r.lastSyncedAt)}</td></tr>)}</tbody></table></div>}
function Empty({title,detail,action}:{title:string;detail:string;action?:React.ReactNode}){return <div className="empty"><div className="empty-icon"><Database size={21}/></div><strong>{title}</strong><p>{detail}</p>{action}</div>}
