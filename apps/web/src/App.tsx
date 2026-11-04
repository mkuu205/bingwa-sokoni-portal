import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Activity, ArrowDownLeft, ArrowUpRight, Bell, CheckCircle2, ChevronDown, CircleHelp, Command, CreditCard, Database, LayoutDashboard, LogOut, Menu, MonitorSmartphone, Plus, RefreshCw, Search, Settings, ShieldCheck, Smartphone, Users, Wallet, Wifi, X } from "lucide-react";
import { ApiError, api, logoutSession, restoreSessionFromCookie } from "./api";
import { resolveRoute } from "./route-state.js";
import AdminPanel from "./AdminPanel";

type Device = { id: string; deviceName: string; status: string; lastSeenAt?: string | null; appVersion?: string | null; model?: string | null; automationEnabled: boolean; executionState: string };
type Me = { id: string; phone: string; role: string; phoneVerifiedAt?: string | null; tokenBalance: number; devices: Device[]; subscriptions: any[]; subscription?: any | null };
type Tx = { id: string; phoneNumber: string; packageName: string; amountKes: string; status: string; lastSyncedAt: string; device: { deviceName: string } };
type AdminOverview = { users: number; devices: number; pendingPayments: number; activeSubscriptions: number; queuedCommands: number };
type BillingPlan = { id: string; code: string; name: string; priceKes: number; durationDays: number; maxDevices: number | null; transactionHistoryDays: number; active?: boolean };
type TokenPackage = { code: string; name: string; amountKes: number; tokens: number };
type BillingPayment = { id: string; externalReference: string; purpose: string; amountKes: number; status: string; createdAt: string; verifiedAt?: string | null };
type TrackedPayment = { id: string; externalReference: string; purpose: string; status: string; createdAt: string; providerStatus?: string | null };

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
  const [pathname, setPathname] = useState(window.location.pathname);
  const [me, setMe] = useState<Me | null>(null);
  const [adminSession, setAdminSession] = useState<{ username: string } | null>(null);
  const [adminOverview, setAdminOverview] = useState<AdminOverview | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [transactions, setTransactions] = useState<Tx[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loginPhone, setLoginPhone] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [adminUsername, setAdminUsername] = useState("kish");
  const [adminPassword, setAdminPassword] = useState("");
  const [registering, setRegistering] = useState(false);
  const [authStep, setAuthStep] = useState<"credentials" | "registration-otp" | "forgot-phone" | "reset-otp">("credentials");
  const [otpCode, setOtpCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [phoneChange, setPhoneChange] = useState({ phone: "", code: "", step: "idle" as "idle" | "code" });
  const [phoneChangeNotice, setPhoneChangeNotice] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [showPair, setShowPair] = useState(false);
  const [commandBusy, setCommandBusy] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [dataPlans, setDataPlans] = useState<any[]>([]);
  const [planMode, setPlanMode] = useState<"SIMPLE" | "ADVANCED">("SIMPLE");
  const [editingPlan, setEditingPlan] = useState<any | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);
  const [billingPlans, setBillingPlans] = useState<BillingPlan[]>([]);
  const [tokenPackages, setTokenPackages] = useState<TokenPackage[]>([]);
  const [billingPhone, setBillingPhone] = useState("");
  const [billingBusy, setBillingBusy] = useState(false);
  const [billingNotice, setBillingNotice] = useState("");
  const [billingPayments, setBillingPayments] = useState<BillingPayment[]>([]);
  const [tokenLedger, setTokenLedger] = useState<any[]>([]);
  const [billingPlansLoading, setBillingPlansLoading] = useState(false);
  const [billingPlansError, setBillingPlansError] = useState("");
  const [billingPlanRetry, setBillingPlanRetry] = useState(0);
  const restoreGeneration = useRef(0);
  const checkoutLock = useRef(false);
  const subscriptionIdempotency = useRef("");
  const [billingPlanSubmitting, setBillingPlanSubmitting] = useState("");
  const [trackedPayment, setTrackedPayment] = useState<TrackedPayment | null>(null);
  const [paymentPollingTimedOut, setPaymentPollingTimedOut] = useState(false);

  function navigate(to: string, replace = false) {
    if (replace) window.history.replaceState({}, "", to);
    else window.history.pushState({}, "", to);
    setPathname(window.location.pathname);
  }

  async function refresh() {
    const generation = ++restoreGeneration.current;
    let savedToken = localStorage.getItem("bingwa_token");
    if (!savedToken) {
      const restored = await restoreSessionFromCookie();
      if (generation !== restoreGeneration.current) return;
      savedToken = restored ? localStorage.getItem("bingwa_token") : null;
    }
    if (!savedToken) {
      if (generation !== restoreGeneration.current) return;
      setMe(null); setAdminSession(null); setAdminOverview(null); setAuthReady(true);
      return;
    }
    setLoading(true); setError("");
    try {
      let profile: Me;
      try {
        profile = await api<Me>("/api/me");
      } catch (profileError) {
        if (!(profileError instanceof ApiError) || profileError.status !== 401) throw profileError;
        try {
          const overview = await api<AdminOverview>("/api/admin/overview");
          if (generation !== restoreGeneration.current) return;
          setMe(null); setAdminSession({ username: localStorage.getItem("bingwa_admin_username") || "Administrator" });
          setAdminOverview(overview); setTransactions([]); setDataPlans([]); setAuthReady(true);
          return;
        } catch (adminError) {
          if (generation !== restoreGeneration.current) return;
          if (adminError instanceof ApiError && (adminError.status === 401 || adminError.status === 403)) {
            localStorage.removeItem("bingwa_token"); localStorage.removeItem("bingwa_admin_username");
            setMe(null); setAdminSession(null); setAdminOverview(null); setTransactions([]); setDataPlans([]);
            setAuthReady(true);
            return;
          }
          throw adminError;
        }
      }

      if (generation !== restoreGeneration.current) return;
      if (profile.role !== "USER" && profile.role !== "ADMIN") {
        localStorage.removeItem("bingwa_token"); localStorage.removeItem("bingwa_admin_username");
        setMe(null); setAdminSession(null); setAdminOverview(null); setAuthReady(true);
        return;
      }
      setMe(profile); setAdminSession(null); localStorage.removeItem("bingwa_admin_username");
      if (profile.role === "ADMIN") {
        const overview = await api<AdminOverview>("/api/admin/overview");
        if (generation !== restoreGeneration.current) return;
        setAdminOverview(overview);
        setTransactions([]); setDataPlans([]);
      } else {
        setAdminOverview(null);
        const [txResult, plansResult] = await Promise.allSettled([
          api<Tx[]>("/api/transactions"), api<any[]>("/api/data-plans")
        ]);
        if (generation !== restoreGeneration.current) return;
        if (txResult.status === "fulfilled") setTransactions(txResult.value);
        if (plansResult.status === "fulfilled") setDataPlans(plansResult.value);
        const failedResult = txResult.status === "rejected" ? txResult : plansResult.status === "rejected" ? plansResult : null;
        if (failedResult) setError(failedResult.reason instanceof Error ? failedResult.reason.message : "Could not load portal data");
      }
      setAuthReady(true);
    } catch (e) {
      if (generation !== restoreGeneration.current) return;
      setError(e instanceof Error ? e.message : "Could not load portal data");
      setAuthReady(true);
    } finally { if (generation === restoreGeneration.current) setLoading(false); }
  }

  useEffect(() => {
    const onPopState = () => { setPathname(window.location.pathname); void refresh(); };
    window.addEventListener("popstate", onPopState);
    void refresh();
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!me || !["Overview", "Subscription"].includes(page)) return;
    const timer = window.setInterval(async () => {
      try { setMe(await api<Me>("/api/me")); } catch { /* The explicit refresh control remains available. */ }
    }, 10000);
    return () => window.clearInterval(timer);
  }, [me?.id, page]);

  useEffect(() => {
    if (!trackedPayment || trackedPayment.status !== "PENDING" || paymentPollingTimedOut) return;
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      if (cancelled) return;
      if (Date.now() - new Date(trackedPayment.createdAt).getTime() >= 10 * 60_000) {
        setBillingNotice(`Payment ${trackedPayment.externalReference} is still awaiting final confirmation. Check status below; no subscription is activated while payment remains pending.`);
        setPaymentPollingTimedOut(true);
        void api<BillingPayment[]>("/api/billing/payments").then(setBillingPayments).catch(() => undefined);
        return;
      }
      try {
        const payment = await api<TrackedPayment & { awaitingVerifiedCallback?: boolean }>(`/api/billing/payments/${encodeURIComponent(trackedPayment.id)}`);
        if (cancelled) return;
        setTrackedPayment(current => current?.id === payment.id ? { ...current, ...payment } : current);
        if (payment.status === "SUCCESS") {
          setBillingNotice(`Payment ${payment.externalReference} was verified successfully. Your subscription has been activated.`);
          setTrackedPayment(null); setPaymentPollingTimedOut(false); void refresh();
          void api<BillingPayment[]>("/api/billing/payments").then(setBillingPayments).catch(() => undefined);
          return;
        }
        if (payment.status === "FAILED" || payment.status === "REVERSED") {
          setBillingNotice(`Payment ${payment.externalReference} ${payment.status.toLowerCase()}. No subscription was activated.`);
          setTrackedPayment(null); setPaymentPollingTimedOut(false);
          void api<BillingPayment[]>("/api/billing/payments").then(setBillingPayments).catch(() => undefined);
          return;
        }
        if (payment.awaitingVerifiedCallback) setBillingNotice(`PayHero reports success for ${payment.externalReference}; waiting for the amount-verified callback before activation.`);
      } catch (error) {
        if (!cancelled) setBillingNotice(error instanceof Error ? `Payment status check failed: ${error.message}. Retrying…` : "Payment status check failed. Retrying…");
      }
      if (!cancelled) timer = window.setTimeout(poll, 5000);
    };
    timer = window.setTimeout(poll, 5000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [trackedPayment?.id, trackedPayment?.status, paymentPollingTimedOut]);

  useEffect(() => {
    const expired = () => {
      restoreGeneration.current += 1;
      setMe(null); setAdminSession(null); setAdminOverview(null); setTransactions([]); setDataPlans([]);
      setAuthReady(true); setError("Your session expired. Please sign in again.");
    };
    window.addEventListener("bingwa:session-expired", expired);
    return () => window.removeEventListener("bingwa:session-expired", expired);
  }, []);

  useEffect(() => {
    if (!me || !["Subscription", "Buy Tokens", "Token History"].includes(page)) return;
    let cancelled = false;
    const loadBilling = async () => {
      setBillingPlansLoading(true); setBillingPlansError(""); setBillingPlans([]);
      void api<BillingPlan[]>("/api/plans").then(plans => {
        if (!cancelled) setBillingPlans(plans);
      }).catch(e => {
        if (!cancelled) setBillingPlansError(e instanceof Error ? e.message : "Could not load subscription plans");
      }).finally(() => { if (!cancelled) setBillingPlansLoading(false); });
      const [packs, payments, ledger] = await Promise.allSettled([
        api<TokenPackage[]>("/api/billing/token-packages"),
        api<BillingPayment[]>("/api/billing/payments"),
        api<any[]>("/api/billing/token-ledger")
      ]);
      if (cancelled) return;
      if (packs.status === "fulfilled") setTokenPackages(packs.value);
      if (payments.status === "fulfilled") {
        setBillingPayments(payments.value);
        const pendingSubscription = page === "Subscription" ? payments.value.find(payment => payment.purpose.startsWith("SUBSCRIPTION:") && payment.status === "PENDING") : undefined;
        if (pendingSubscription) {
          setTrackedPayment(current => current?.id ? current : { id: pendingSubscription.id, externalReference: pendingSubscription.externalReference, purpose: pendingSubscription.purpose, status: pendingSubscription.status, createdAt: pendingSubscription.createdAt });
        }
      }
      if (ledger.status === "fulfilled") setTokenLedger(ledger.value);
      const failed = [packs, payments, ledger].find(result => result.status === "rejected");
      if (failed?.status === "rejected") setBillingNotice(failed.reason instanceof Error ? failed.reason.message : "Could not load billing information");
    };
    void loadBilling();
    return () => { cancelled = true; };
  }, [me?.id, page, billingPlanRetry]);

  const role = adminSession ? "ADMIN" : me?.role ?? null;
  const route = resolveRoute(pathname, role);
  useEffect(() => {
    if (route.view === "redirect") navigate(route.to, true);
  }, [pathname, role]);

  async function auth() {
    setError("");
    try {
      const result = await api<any>(registering ? "/api/auth/register" : "/api/auth/login", {
        method: "POST", body: JSON.stringify({ phone: loginPhone, password: loginPassword })
      });
      if (result.requiresOtp) { setAuthStep("registration-otp"); setError(""); return; }
      localStorage.setItem("bingwa_token", result.token);
      localStorage.removeItem("bingwa_admin_username");
      setAuthReady(false); navigate(result.user?.role === "ADMIN" ? "/admin" : "/");
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Sign in failed"); }
  }


  async function verifyRegistrationOtp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    try {
      const result = await api<any>("/api/auth/register/verify", { method: "POST", body: JSON.stringify({ phone: loginPhone, code: otpCode }) });
      localStorage.setItem("bingwa_token", result.token); localStorage.removeItem("bingwa_admin_username");
      setAuthStep("credentials"); setOtpCode(""); setAuthReady(false); navigate("/"); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Verification failed"); }
  }
  async function requestPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    try { await api("/api/auth/password/forgot", { method: "POST", body: JSON.stringify({ phone: loginPhone }) }); setAuthStep("reset-otp"); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not send recovery code"); }
  }
  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    try {
      await api("/api/auth/password/reset", { method: "POST", body: JSON.stringify({ phone: loginPhone, code: otpCode, newPassword }) });
      setAuthStep("credentials"); setOtpCode(""); setNewPassword(""); setLoginPassword(""); setError("Password updated. Sign in with your new password.");
    } catch (e) { setError(e instanceof Error ? e.message : "Password reset failed"); }
  }
  async function requestPhoneChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPhoneChangeNotice("");
    try {
      const result = await api<{ message: string }>("/api/auth/phone/change/request", { method: "POST", body: JSON.stringify({ phone: phoneChange.phone }) });
      setPhoneChange(v => ({ ...v, step: "code" })); setPhoneChangeNotice(result.message);
    } catch (e) { setPhoneChangeNotice(e instanceof Error ? e.message : "Could not send phone verification code"); }
  }
  async function verifyPhoneChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPhoneChangeNotice("");
    try {
      await api("/api/auth/phone/change/verify", { method: "POST", body: JSON.stringify({ phone: phoneChange.phone, code: phoneChange.code }) });
      setPhoneChange({ phone: "", code: "", step: "idle" }); setPhoneChangeNotice("Phone number verified and updated."); await refresh();
    } catch (e) { setPhoneChangeNotice(e instanceof Error ? e.message : "Phone verification failed"); }
  }
  async function adminAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    try {
      const result = await api<any>("/api/auth/admin/login", {
        method: "POST", body: JSON.stringify({ username: adminUsername, password: adminPassword })
      });
      localStorage.setItem("bingwa_token", result.token);
      localStorage.setItem("bingwa_admin_username", result.user.username);
      setAdminPassword(""); setAuthReady(false); navigate("/admin"); await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Administrator sign in failed"); }
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

  async function purchaseSubscription(planId: string) {
    if (checkoutLock.current || trackedPayment?.status === "PENDING") return;
    checkoutLock.current = true; setBillingBusy(true); setBillingPlanSubmitting(planId); setBillingNotice("");
    const requestIdentity = JSON.stringify({ userId: me?.id, planId, phoneNumber: billingPhone || me?.phone || "" });
    let storedAttempt: { identity?: string; key?: string } = {};
    try { storedAttempt = JSON.parse(sessionStorage.getItem("bingwa_subscription_attempt") || "{}"); } catch { storedAttempt = {}; }
    if (!subscriptionIdempotency.current) {
      subscriptionIdempotency.current = storedAttempt.identity === requestIdentity && storedAttempt.key ? storedAttempt.key : crypto.randomUUID();
      sessionStorage.setItem("bingwa_subscription_attempt", JSON.stringify({ identity: requestIdentity, key: subscriptionIdempotency.current }));
    }
    const idempotencyKey = subscriptionIdempotency.current;
    try {
      const result = await api<{ paymentId: string; externalReference: string; status: string; createdAt?: string; replayed?: boolean }>("/api/billing/subscriptions", {
        method: "POST", body: JSON.stringify({ planId, phoneNumber: billingPhone || me?.phone || "", idempotencyKey })
      });
      subscriptionIdempotency.current = "";
      sessionStorage.removeItem("bingwa_subscription_attempt");
      if (result.status !== "PENDING") {
        setTrackedPayment(null); setPaymentPollingTimedOut(false);
        setBillingNotice(`This payment attempt already has status ${result.status}. No new STK Push was started. Refresh payment history or start a new attempt if it failed.`);
        void api<BillingPayment[]>("/api/billing/payments").then(setBillingPayments).catch(() => undefined);
        if (result.status === "SUCCESS") void refresh();
        return;
      }
      const payment: TrackedPayment = { id: result.paymentId, externalReference: result.externalReference, purpose: `SUBSCRIPTION:${planId}`, status: result.status, createdAt: result.createdAt ?? new Date().toISOString() };
      setTrackedPayment(payment); setPaymentPollingTimedOut(false);
      setBillingNotice(`STK Push ${result.replayed ? "is already in progress" : "sent"}. Approve it on your phone. Payment remains pending until PayHero verifies it.`);
      void api<BillingPayment[]>("/api/billing/payments").then(setBillingPayments).catch(() => undefined);
    } catch (e) {
      if (e instanceof ApiError && e.status !== 408) {
        subscriptionIdempotency.current = "";
        sessionStorage.removeItem("bingwa_subscription_attempt");
      }
      setBillingNotice(e instanceof Error ? e.message : "Could not initiate payment");
    } finally {
      checkoutLock.current = false; setBillingBusy(false); setBillingPlanSubmitting("");
    }
  }
  async function purchaseTokens(packageCode: string) {
    if (checkoutLock.current) return;
    checkoutLock.current = true; setBillingBusy(true); setBillingNotice("");
    const idempotencyKey = crypto.randomUUID();
    try {
      const result = await api<{ paymentId: string; externalReference: string; status: string }>("/api/billing/tokens", {
        method: "POST", body: JSON.stringify({ packageCode, phoneNumber: billingPhone || me?.phone || "", idempotencyKey })
      });
      setBillingNotice(`M-Pesa STK Push sent. Approve it on your phone. Tokens are credited only after verified PayHero payment. Reference: ${result.externalReference}.`);
      void api<BillingPayment[]>("/api/billing/payments").then(setBillingPayments).catch(() => undefined);
    } catch (e) { setBillingNotice(e instanceof Error ? e.message : "Could not initiate payment"); }
    finally { checkoutLock.current = false; setBillingBusy(false); }
  }

  function logout() {
    restoreGeneration.current += 1;
    logoutSession();
    localStorage.removeItem("bingwa_token"); localStorage.removeItem("bingwa_admin_username");
    setMe(null); setAdminSession(null); setAdminOverview(null); setTransactions([]); setDataPlans([]); setAuthReady(true);
    navigate(adminSession || me?.role === "ADMIN" ? "/admin" : "/login");
  }

  if (!authReady) return <div className="auth-shell"><div className="auth-card"><div className="brand-mark">B</div><p className="muted">Restoring your secure session…</p></div></div>;

  if (route.view === "admin-dashboard") return adminOverview
    ? <AdminPanel username={adminSession?.username || me?.phone || "Administrator"} onLogout={logout} />
    : <div className="auth-shell"><div className="auth-card"><h1>Admin dashboard unavailable</h1><p className="muted">{error || "The overview could not be loaded."}</p><button className="primary full" onClick={()=>void refresh()}>Retry</button><button className="text-button full" onClick={logout}>Sign out</button></div></div>;

  if (route.view === "admin-login") return <AdminLogin username={adminUsername} password={adminPassword} error={error} onUsername={setAdminUsername} onPassword={setAdminPassword} onSubmit={adminAuth} onCustomerLogin={() => { setError(""); navigate("/login"); }} />;

  if (route.view === "invalid-session") {
    localStorage.removeItem("bingwa_token"); localStorage.removeItem("bingwa_admin_username");
    return <div className="auth-shell"><div className="auth-card"><h1>Account role is invalid</h1><p className="muted">Please sign in again or contact support.</p><button className="primary full" onClick={logout}>Return to sign in</button></div></div>;
  }

  if (route.view === "redirect") return null;

  if (!me) return <div className="auth-shell">
    <div className="auth-card">
      <div className="brand-mark">B</div><div className="eyebrow">BINGWA SOKONI</div>
      <h1>{authStep === "registration-otp" ? "Verify your phone" : authStep === "forgot-phone" ? "Forgot password" : authStep === "reset-otp" ? "Reset password" : registering ? "Create your account" : "Welcome back"}</h1>
      <p className="muted">{authStep === "registration-otp" ? `Enter the six-digit code sent to ${loginPhone}.` : authStep === "forgot-phone" ? "Enter the phone number registered to your account." : authStep === "reset-otp" ? "Enter the recovery code and choose a new password." : "Manage your connected phones, automation and tokens in one place."}</p>
      {error && <div className="alert">{error}</div>}
      {authStep === "registration-otp" && <form onSubmit={verifyRegistrationOtp}>
        <label>Six-digit phone verification code</label><input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otpCode} onChange={e=>setOtpCode(e.target.value.replace(/\D/g, "").slice(0,6))} required />
        <button className="primary full" type="submit">Verify phone and finish registration</button>
        <button className="text-button full" type="button" onClick={()=>{setAuthStep("credentials");setRegistering(true);setOtpCode("");}}>Back to registration</button>
      </form>}
      {authStep === "forgot-phone" && <form onSubmit={requestPasswordReset}>
        <label>Registered phone number</label><input value={loginPhone} onChange={e=>setLoginPhone(e.target.value)} placeholder="2547XXXXXXXX" autoComplete="tel" required />
        <button className="primary full" type="submit">Send recovery code</button>
        <button className="text-button full" type="button" onClick={()=>setAuthStep("credentials")}>Back to sign in</button>
      </form>}
      {authStep === "reset-otp" && <form onSubmit={resetPassword}>
        <label>Six-digit recovery code</label><input inputMode="numeric" maxLength={6} value={otpCode} onChange={e=>setOtpCode(e.target.value.replace(/\D/g, "").slice(0,6))} required />
        <label>New password</label><input type="password" minLength={10} autoComplete="new-password" value={newPassword} onChange={e=>setNewPassword(e.target.value)} required />
        <button className="primary full" type="submit">Reset password</button>
      </form>}
      {authStep === "credentials" && <>
        <label>Phone number</label><input value={loginPhone} onChange={e=>setLoginPhone(e.target.value)} placeholder="2547XXXXXXXX" autoComplete="tel" />
        <label>Password</label><input type="password" value={loginPassword} onChange={e=>setLoginPassword(e.target.value)} placeholder="At least 10 characters" autoComplete={registering?"new-password":"current-password"} />
        {!registering && <button className="text-button full" type="button" onClick={()=>{setError("");setAuthStep("forgot-phone");}}>Forgot password?</button>}
        <button className="primary full" onClick={auth}>{registering ? "Create account" : "Continue"}</button>
        <button className="text-button full" onClick={()=>setRegistering(!registering)}>{registering ? "Already have an account? Sign in" : "New to Bingwa? Create an account"}</button>
      </>}
      <div className="auth-foot"><ShieldCheck size={15}/> Registration and password recovery codes are delivered via TalkSasa SMS. Normal login uses your password only.</div>
    </div>
  </div>;

  const online = me.devices.filter(d => d.status === "ONLINE").length;
  const activeSub = me.subscription?.status === "ACTIVE" && me.subscription.expiresAt && new Date(me.subscription.expiresAt) > new Date()
    ? me.subscription
    : me.subscriptions?.find(s => s.status === "ACTIVE" && s.expiresAt && new Date(s.expiresAt) > new Date());
  const effectiveSub = me.subscription ?? activeSub ?? me.subscriptions?.[0] ?? null;
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
        {page==="My Devices"&&<section className="panel"><div className="panel-heading"><div><h3>Linked phones</h3><p>Only devices linked to your account can receive commands.</p></div><button className="primary" onClick={createPairCode}><Plus size={16}/> Link new phone</button></div>{me.devices.length?me.devices.map(d=><div className="device-card" key={d.id}><DeviceRow device={d}/><div className="device-actions"><button disabled={commandBusy===`${d.id}:CHECK_AIRTIME`} onClick={()=>command(d,"CHECK_AIRTIME")}><RefreshCw size={14}/> Refresh balance</button><button disabled={commandBusy===`${d.id}:START_AUTOMATION`} onClick={()=>command(d,d.automationEnabled?"STOP_AUTOMATION":"START_AUTOMATION")}><Command size={14}/> {d.automationEnabled?"Stop automation":"Start automation"}</button></div></div>):<Empty title="No phones linked" detail="Create a code here, then enter it inside the Android app." action={<button className="primary" onClick={createPairCode}>Generate link code</button>}/>}</section>}
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
        {page==="Buy Tokens"&&<section className="panel"><div className="panel-heading"><div><h3>Buy tokens</h3><p>Pay by M-Pesa STK Push. Tokens are credited only after provider verification.</p></div></div><div className="balance-card"><span>Current token balance</span><strong>{me.tokenBalance}</strong><small>Shared account balance</small></div><label className="billing-label">M-Pesa phone number</label><input className="billing-input" value={billingPhone} onChange={e=>setBillingPhone(e.target.value)} placeholder={me.phone || "07XXXXXXXX or 2547XXXXXXXX"} />{billingNotice&&<div className="notice"><ShieldCheck size={18}/><div>{billingNotice}</div></div>}{tokenPackages.length===0?<div className="notice"><ShieldCheck size={18}/><div><strong>Token packages unavailable</strong><p>Please refresh the page or contact support if this continues.</p></div></div>:<div className="plan-grid">{tokenPackages.map(pack=><div className="plan-card" key={pack.code}><span className="plan-label">TOKEN PACKAGE</span><h3>{pack.name}</h3><div className="plan-price">{money(pack.amountKes)}</div><p><CheckCircle2 size={15}/>{pack.tokens.toLocaleString()} tokens</p><button className="primary full" disabled={billingBusy} onClick={()=>void purchaseTokens(pack.code)}>{billingBusy?"Requesting…":"Pay with M-Pesa"}</button></div>)}</div>}</section>}
        {page==="Token History"&&<section className="panel"><div className="panel-heading"><div><h3>Token history</h3><p>Token ledger and payment status.</p></div><button className="icon-button" onClick={()=>void refresh()}><RefreshCw size={16}/></button></div>{tokenLedger.length===0?<Empty title="No token ledger entries" detail="Verified token purchases and ledger adjustments will appear here."/>:<div className="table-wrap"><table><thead><tr><th>Date</th><th>Reason</th><th>Change</th><th>Balance after</th><th>Reference</th></tr></thead><tbody>{tokenLedger.map(entry=><tr key={entry.id}><td>{time(entry.createdAt)}</td><td>{entry.reason}</td><td>{entry.delta>0?"+":""}{entry.delta}</td><td>{entry.balanceAfter}</td><td>{entry.reference}</td></tr>)}</tbody></table></div>}<h3>Recent payments</h3>{billingPayments.length===0?<Empty title="No payments yet" detail="Your PayHero payment attempts will appear here."/>:<div className="table-wrap"><table><thead><tr><th>Date</th><th>Reference</th><th>Purpose</th><th>Amount</th><th>Status</th></tr></thead><tbody>{billingPayments.map(payment=><tr key={payment.id}><td>{time(payment.createdAt)}</td><td>{payment.externalReference}</td><td>{payment.purpose.startsWith("TOKENS:")?"Token purchase":payment.purpose.startsWith("SUBSCRIPTION:")?"Subscription":"Other"}</td><td>{money(payment.amountKes)}</td><td>{payment.status}</td></tr>)}</tbody></table></div>}</section>}
        {page==="Subscription"&&<>
          <section className="panel">
            <div className="panel-heading"><div><h3>Your subscription</h3><p>Current status from your account profile, shared with the dashboard.</p></div><button className="icon-button" onClick={()=>void refresh()} title="Refresh subscription status"><RefreshCw size={16}/></button></div>
            <div className="settings-row"><div><strong>Status</strong><span className={`tag ${activeSub?"success":"pending"}`}>{activeSub?"ACTIVE":effectiveSub?.status==="ACTIVE"?"EXPIRED":effectiveSub?.status??"INACTIVE"}</span></div></div>
            <div className="settings-row"><div><strong>Selected plan</strong><span>{effectiveSub?.plan?.name??"No plan selected"}</span></div></div>
            <div className="settings-row"><div><strong>Activation date</strong><span>{effectiveSub?.startsAt?time(effectiveSub.startsAt):"—"}</span></div></div>
            <div className="settings-row"><div><strong>Expiry date</strong><span>{effectiveSub?.expiresAt?time(effectiveSub.expiresAt):"—"}</span></div></div>
          </section>
          <section className="panel">
            <div className="panel-heading"><div><h3>Choose a subscription</h3><p>Pay with M-Pesa. Your subscription changes only after PayHero verification.</p></div></div>
            <label className="billing-label">M-Pesa phone number</label><input className="billing-input" value={billingPhone} onChange={e=>setBillingPhone(e.target.value)} placeholder={me.phone || "07XXXXXXXX or 2547XXXXXXXX"} />
            {billingNotice&&<div className="notice"><ShieldCheck size={18}/><div>{billingNotice}</div></div>}{trackedPayment?.status==="PENDING"&&<div className="notice" role="status"><CreditCard size={18}/><div><strong>Payment pending · {trackedPayment.externalReference}</strong><p>No subscription is active until the verified PayHero callback completes. {paymentPollingTimedOut&&<button className="secondary" onClick={()=>setPaymentPollingTimedOut(false)}>Check payment status</button>}</p></div></div>}
            {billingPlansLoading&&<div className="notice" role="status"><RefreshCw size={18}/><div>Loading available subscription plans…</div></div>}
            {billingPlansError&&<div className="alert page-alert" role="alert"><span>Could not load subscription plans: {billingPlansError}</span><button type="button" onClick={()=>setBillingPlanRetry(v=>v+1)}>Retry</button></div>}
            {!billingPlansLoading&&!billingPlansError&&billingPlans.filter(p=>p.active!==false).length===0&&<Empty title="No subscription plans are available" detail="The plan catalogue is currently empty. Refresh to try again, or contact support if the plans remain unavailable." action={<button className="secondary" onClick={()=>setBillingPlanRetry(v=>v+1)}>Retry plan loading</button>} />}
            {!billingPlansLoading&&billingPlans.filter(p=>p.active!==false).length>0&&<div className="plan-grid">{billingPlans.filter(p=>p.active!==false).map(p=><div className={`plan-card ${activeSub?.plan?.id===p.id?"plan-current":""}`} key={p.id}><span className="plan-label">{activeSub?.plan?.id===p.id?"CURRENT PLAN":`${p.durationDays} DAYS`}</span><h3>{p.name}</h3><div className="plan-price">{money(p.priceKes)}<small>/{p.durationDays} days</small></div><p><CheckCircle2 size={15}/>{p.maxDevices==null?"Unlimited devices":`Up to ${p.maxDevices} devices`}</p><p><CheckCircle2 size={15}/>{p.transactionHistoryDays}-day transaction history</p><button className="primary full" disabled={Boolean(billingPlanSubmitting)||trackedPayment?.status==="PENDING"} onClick={()=>void purchaseSubscription(p.id)}>{billingPlanSubmitting===p.id?"Requesting…":trackedPayment?.status==="PENDING"&&trackedPayment.purpose===`SUBSCRIPTION:${p.id}`?"Awaiting payment…":activeSub?.plan?.id===p.id?"Renew with M-Pesa":"Subscribe with M-Pesa"}</button></div>)}</div>}
          </section>
          <div className="notice"><CreditCard size={18}/><div><strong>Subscription renewal</strong><p>Your account remains accessible when a subscription expires, but subscription-dependent automation and remote commands must be disabled until renewal is confirmed.</p></div></div>
        </>}
        {page==="Account Settings"&&<section className="panel"><div className="panel-heading"><div><h3>Account settings</h3><p>Profile and account security</p></div></div><div className="settings-row"><div><strong>Phone number</strong><span>{me.phone}</span></div><span className={`tag ${me.phoneVerifiedAt?"success":"pending"}`}>{me.phoneVerifiedAt?"VERIFIED":"UNVERIFIED"}</span></div>{phoneChangeNotice&&<div className="notice"><ShieldCheck size={18}/><div>{phoneChangeNotice}</div></div>}{phoneChange.step==="idle"?<form className="billing-phone-change" onSubmit={requestPhoneChange}><label className="billing-label">Change phone number</label><input className="billing-input" value={phoneChange.phone} onChange={e=>setPhoneChange(v=>({...v,phone:e.target.value}))} placeholder="07XXXXXXXX or 2547XXXXXXXX" required/><button className="secondary" type="submit">Send verification code</button></form>:<form className="billing-phone-change" onSubmit={verifyPhoneChange}><p>Enter the six-digit code sent to {phoneChange.phone}.</p><label className="billing-label">Verification code</label><input className="billing-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={phoneChange.code} onChange={e=>setPhoneChange(v=>({...v,code:e.target.value.replace(/\D/g,"").slice(0,6)}))} required/><button className="primary" type="submit">Verify and update number</button><button className="text-button" type="button" onClick={()=>setPhoneChange(v=>({...v,step:"idle",code:""}))}>Use a different number</button></form>}<div className="settings-row"><div><strong>Account role</strong><span>{me.role}</span></div></div><div className="settings-row"><div><strong>Security</strong><span>Normal sign-in uses your phone number and password. OTP is used for registration, password recovery and phone changes.</span></div></div><button className="secondary" onClick={logout}><LogOut size={15}/> Sign out</button></section>}
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
function AdminLogin({username,password,error,onUsername,onPassword,onSubmit,onCustomerLogin}:{username:string;password:string;error:string;onUsername:(value:string)=>void;onPassword:(value:string)=>void;onSubmit:(event:FormEvent<HTMLFormElement>)=>void;onCustomerLogin:()=>void}){
  return <div className="auth-shell"><form className="auth-card" onSubmit={onSubmit}>
    <div className="brand-mark">B</div><div className="eyebrow">BINGWA SOKONI · ADMIN</div>
    <h1>Administrator sign in</h1><p className="muted">Use the administrator credentials configured securely for this service.</p>
    {error&&<div className="alert">{error}</div>}
    <label>Username</label><input value={username} onChange={e=>onUsername(e.target.value)} autoComplete="username" required maxLength={80}/>
    <label>Password</label><input type="password" value={password} onChange={e=>onPassword(e.target.value)} autoComplete="current-password" required/>
    <button className="primary full" type="submit">Sign in to admin</button>
    <button className="text-button full" type="button" onClick={onCustomerLogin}>Customer sign in</button>
    <div className="auth-foot"><ShieldCheck size={15}/> Administrator access is checked by the API.</div>
  </form></div>;
}
function Metric({icon,label,value,note}:{icon:React.ReactNode;label:string;value:string;note:string}){return <div className="metric-card"><div className="metric-top"><span className="metric-icon">{icon}</span><span className="metric-dots">•••</span></div><span className="metric-label">{label}</span><strong>{value}</strong><small>{note}</small></div>}
function DeviceRow({device}:{device:Device}){return <div className="device-row"><div className="device-icon"><Smartphone size={21}/></div><div className="device-info"><strong>{device.deviceName}</strong><span>{device.model||"Android device"} · {device.appVersion||"App version unknown"}</span></div><div className="device-state"><span className={`state-dot ${device.status==="ONLINE"?"online":""}`}/><span>{device.status==="ONLINE"?"Online":"Offline"}</span></div><div className="device-extra"><span>{device.automationEnabled?"Automation enabled":"Automation stopped"}</span><small>Last seen {time(device.lastSeenAt)}</small></div></div>}
function Transactions({rows}:{rows:Tx[]}){if(!rows.length)return <Empty title="No transactions synced yet" detail="Once a phone is linked and syncs successfully, recent transaction records will appear here."/>;return <div className="table-wrap"><table><thead><tr><th>Customer / Phone</th><th>Package</th><th>Device</th><th>Amount</th><th>Status</th><th>Last synced</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td><strong>{r.phoneNumber}</strong></td><td>{r.packageName}</td><td>{r.device?.deviceName||"Android device"}</td><td>{money(r.amountKes)}</td><td><span className={`tag ${r.status==="COMPLETED"?"success":r.status==="FAILED"?"danger":"pending"}`}>{r.status}</span></td><td>{time(r.lastSyncedAt)}</td></tr>)}</tbody></table></div>}
function Empty({title,detail,action}:{title:string;detail:string;action?:React.ReactNode}){return <div className="empty"><div className="empty-icon"><Database size={21}/></div><strong>{title}</strong><p>{detail}</p>{action}</div>}
