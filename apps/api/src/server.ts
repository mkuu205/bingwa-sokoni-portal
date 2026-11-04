import express from "express";
import { randomInt, randomUUID } from "node:crypto";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { deviceSyncRouter } from "./device-sync.js";
import { adminRouter } from "./admin.js";
import { AuthRequest, hashPairingCode, issueAdminToken, issueUserToken, randomSecret, requireAuth, sha256 } from "./security.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: env.WEB_ORIGIN, credentials: false }));
app.use((req: AuthRequest, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
});
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "bingwa-sokoni-portal-api" }));

// Android tRPC-compatible contract. Keep endpoint names and request envelope from PortalApi.kt.
app.use(/^\/api\/trpc\/deviceSync\.(pairDevice|heartbeat|pollCommands|reportCommand)$/, (req, res, next) => {
  const match = req.originalUrl.match(/deviceSync\.(pairDevice|heartbeat|pollCommands|reportCommand)/);
  if (!match) return res.status(404).json({ error: "PROCEDURE_NOT_FOUND" });
  req.url = `/${match[1]}`;
  deviceSyncRouter(req, res, next);
});

app.post("/api/auth/register", async (req, res) => {
  const parsed = z.object({ phone: z.string().regex(/^\+?[0-9]{9,15}$/), password: z.string().min(10).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
  const phone = normalizeAuthPhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "INVALID_PHONE" });
  if (await prisma.user.findUnique({ where: { phone } })) return res.status(409).json({ error: "PHONE_ALREADY_REGISTERED" });
  const user = await prisma.user.create({ data: { phone, passwordHash: await bcrypt.hash(parsed.data.password, 12) } });
  try { await createAndSendOtp(phone, user.id, "LOGIN"); }
  catch (e: any) {
    await prisma.user.delete({ where: { id: user.id } });
    return res.status(503).json({ error: e?.message === "TALKSASA_NOT_CONFIGURED" ? "OTP_PROVIDER_NOT_CONFIGURED" : "OTP_DELIVERY_FAILED" });
  }
  return res.status(201).json({ requiresOtp: true, phone: `${phone.slice(0, 5)}••••${phone.slice(-2)}`, message: "A verification code has been sent." });
});

function normalizeAuthPhone(value: string): string | null {
  const digits = value.replace(/[\s()+-]/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  return null;
}
function otpDigest(code: string, phone: string, purpose: string) {
  return sha256(`${env.OTP_HASH_SECRET || env.PAIRING_CODE_PEPPER}:${phone}:${purpose}:${code}`);
}
async function sendTalkSasaOtp(phone: string, code: string, purpose: "LOGIN" | "PASSWORD_RESET") {
  if (!env.TALKSASA_API_KEY || !env.TALKSASA_SENDER_ID) throw new Error("TALKSASA_NOT_CONFIGURED");
  const message = purpose === "LOGIN"
    ? `Bingwa Sokoni login code: ${code}. Expires in 5 minutes. Do not share this code.`
    : `Bingwa Sokoni password reset code: ${code}. Expires in 5 minutes. Do not share this code.`;
  const base = env.TALKSASA_API_URL.endsWith("/") ? env.TALKSASA_API_URL : `${env.TALKSASA_API_URL}/`;
  const response = await fetch(new URL("sms/send", base), {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TALKSASA_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ recipient: `+${phone}`, sender_id: env.TALKSASA_SENDER_ID, type: "plain", message })
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || data?.status === false || data?.success === false) {
    throw new Error(`TALKSASA_SEND_FAILED_${response.status}`);
  }
}
async function createAndSendOtp(phone: string, userId: string | null, purpose: "LOGIN" | "PASSWORD_RESET") {
  const recent = await prisma.otpChallenge.findFirst({ where: { phone, purpose, createdAt: { gt: new Date(Date.now() - 60_000) } }, orderBy: { createdAt: "desc" } });
  if (recent) throw new Error("OTP_COOLDOWN");
  const code = String(randomInt(100000, 1000000));
  const challenge = await prisma.otpChallenge.create({ data: { phone, userId, purpose, codeHash: otpDigest(code, phone, purpose), expiresAt: new Date(Date.now() + 5 * 60_000) } });
  try { await sendTalkSasaOtp(phone, code, purpose); }
  catch (error) { await prisma.otpChallenge.delete({ where: { id: challenge.id } }); throw error; }
}
app.post("/api/auth/login", async (req, res) => {
  const parsed = z.object({ phone: z.string().min(9).max(16), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
  const phone = normalizeAuthPhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "INVALID_PHONE" });
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  if (user.suspendedAt) return res.status(403).json({ error: "ACCOUNT_SUSPENDED" });
  try { await createAndSendOtp(phone, user.id, "LOGIN"); }
  catch (e: any) {
    if (e?.message === "OTP_COOLDOWN") return res.status(429).json({ error: "OTP_COOLDOWN", message: "Please wait before requesting another code." });
    return res.status(503).json({ error: e?.message === "TALKSASA_NOT_CONFIGURED" ? "OTP_PROVIDER_NOT_CONFIGURED" : "OTP_DELIVERY_FAILED" });
  }
  return res.json({ requiresOtp: true, phone: `${phone.slice(0, 5)}••••${phone.slice(-2)}`, message: "A verification code has been sent." });
});
app.post("/api/auth/login/verify", async (req, res) => {
  const parsed = z.object({ phone: z.string().min(9).max(16), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
  const phone = normalizeAuthPhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "INVALID_PHONE" });
  const challenge = await prisma.otpChallenge.findFirst({ where: { phone, purpose: "LOGIN", consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
  if (!challenge || challenge.attempts >= 5) return res.status(400).json({ error: "OTP_INVALID_OR_EXPIRED" });
  if (challenge.codeHash !== otpDigest(parsed.data.code, phone, "LOGIN")) {
    await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    return res.status(400).json({ error: "OTP_INVALID_OR_EXPIRED" });
  }
  const user = await prisma.user.findUnique({ where: { id: challenge.userId || "" } });
  if (!user || user.suspendedAt) return res.status(403).json({ error: "ACCOUNT_UNAVAILABLE" });
  await prisma.$transaction([prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } }), prisma.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: user.phoneVerifiedAt ?? new Date() } })]);
  return res.json({ user: { id: user.id, phone: user.phone, role: user.role, phoneVerified: true }, token: issueUserToken(user) });
});
app.post("/api/auth/password/forgot", async (req, res) => {
  const parsed = z.object({ phone: z.string().min(9).max(16) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
  const phone = normalizeAuthPhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "INVALID_PHONE" });
  const user = await prisma.user.findUnique({ where: { phone } });
  // Always return the same success response to avoid account enumeration.
  if (user && !user.suspendedAt) {
    try { await createAndSendOtp(phone, user.id, "PASSWORD_RESET"); }
    catch (e: any) {
      if (e?.message === "OTP_COOLDOWN") return res.status(429).json({ error: "OTP_COOLDOWN", message: "Please wait before requesting another code." });
      return res.status(503).json({ error: "OTP_DELIVERY_FAILED" });
    }
  }
  return res.json({ ok: true, message: "If an account exists for that number, a recovery code has been sent." });
});
app.post("/api/auth/password/reset", async (req, res) => {
  const parsed = z.object({ phone: z.string().min(9).max(16), code: z.string().regex(/^\d{6}$/), newPassword: z.string().min(10).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
  const phone = normalizeAuthPhone(parsed.data.phone);
  if (!phone) return res.status(400).json({ error: "INVALID_PHONE" });
  const challenge = await prisma.otpChallenge.findFirst({ where: { phone, purpose: "PASSWORD_RESET", consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } });
  if (!challenge || challenge.attempts >= 5 || challenge.codeHash !== otpDigest(parsed.data.code, phone, "PASSWORD_RESET")) {
    if (challenge && challenge.attempts < 5) await prisma.otpChallenge.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    return res.status(400).json({ error: "OTP_INVALID_OR_EXPIRED" });
  }
  if (!challenge.userId) return res.status(400).json({ error: "OTP_INVALID_OR_EXPIRED" });
  await prisma.$transaction([prisma.user.update({ where: { id: challenge.userId }, data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 12) } }), prisma.otpChallenge.update({ where: { id: challenge.id }, data: { consumedAt: new Date() } }), prisma.otpChallenge.updateMany({ where: { userId: challenge.userId, consumedAt: null }, data: { consumedAt: new Date() } })]);
  return res.json({ ok: true, message: "Password reset successfully. Please sign in again." });
});

app.post("/api/auth/admin/login", async (req, res) => {
  if (!env.ADMIN_PASSWORD_HASH) return res.status(503).json({ error: "ADMIN_LOGIN_NOT_CONFIGURED" });
  const parsed = z.object({ username: z.string().min(1).max(80), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
  const passwordMatches = await bcrypt.compare(parsed.data.password, env.ADMIN_PASSWORD_HASH);
  if (parsed.data.username !== env.ADMIN_USERNAME || !passwordMatches) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  return res.json({ user: { username: env.ADMIN_USERNAME, role: "ADMIN" }, token: issueAdminToken(env.ADMIN_USERNAME) });
});

app.get("/api/me", requireAuth, async (req: AuthRequest, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.auth!.userId },
    select: { id: true, phone: true, role: true, phoneVerifiedAt: true, createdAt: true,
      devices: { where: { revokedAt: null }, orderBy: { createdAt: "desc" }, select: { id: true, deviceName: true, status: true, lastSeenAt: true, appVersion: true, model: true, automationEnabled: true, executionState: true } },
      subscriptions: { include: { plan: true }, orderBy: { createdAt: "desc" }, take: 5 }
    }
  });
  const now = new Date();
  const [ledger, activeSubscription, latestSubscription] = await Promise.all([
    prisma.tokenLedgerEntry.findMany({ where: { userId: req.auth!.userId }, orderBy: { createdAt: "desc" }, take: 1 }),
    prisma.subscription.findFirst({ where: { userId: req.auth!.userId, status: "ACTIVE", expiresAt: { gt: now } }, include: { plan: true }, orderBy: [{ expiresAt: "desc" }, { id: "desc" }] }),
    prisma.subscription.findFirst({ where: { userId: req.auth!.userId }, include: { plan: true }, orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }] })
  ]);
  const selected = activeSubscription ?? latestSubscription;
  const subscription = selected ? { ...selected, status: selected.status === "ACTIVE" && selected.expiresAt && selected.expiresAt <= now ? "EXPIRED" : selected.status } : null;
  return res.json({ ...user, subscription, tokenBalance: ledger[0]?.balanceAfter ?? 0 });
});

app.get("/api/plans", async (_req, res) => {
  res.json(await prisma.plan.findMany({ where: { active: true }, orderBy: [{ priceKes: "asc" }, { code: "asc" }] }));
});

app.post("/api/devices/pairing-code", requireAuth, async (req: AuthRequest, res) => {
  // Code-only user experience: the code is one-time, short-lived and stored hashed.
  // Use eight digits to make guessing harder; the device token is still issued only
  // after successful pairing and remains hidden from the user.
  const code = String(randomInt(10000000, 100000000));
  const codeHash = hashPairingCode(code);
  const expiresAt = new Date(Date.now() + env.PAIRING_CODE_TTL_SECONDS * 1000);
  await prisma.pairingCode.create({ data: { userId: req.auth!.userId, codeHash, secretHash: null, expiresAt } });
  return res.status(201).json({ code, expiresAt, instructions: "Enter this one-time code in Bingwa Sokoni Automation. It expires in 5 minutes and can be used once." });
});

app.get("/api/devices", requireAuth, async (req: AuthRequest, res) => {
  const devices = await prisma.device.findMany({ where: { userId: req.auth!.userId, revokedAt: null }, orderBy: { createdAt: "desc" } });
  res.json(devices.map(d => ({ id: d.id, deviceName: d.deviceName, status: d.status, appVersion: d.appVersion, model: d.model, phoneNumber: d.phoneNumber, automationEnabled: d.automationEnabled, executionState: d.executionState, lastSeenAt: d.lastSeenAt, createdAt: d.createdAt })));
});

app.post("/api/devices/:id/revoke", requireAuth, async (req: AuthRequest, res) => {
  const device = await prisma.device.findFirst({ where: { id: req.params.id, userId: req.auth!.userId, revokedAt: null } });
  if (!device) return res.status(404).json({ error: "DEVICE_NOT_FOUND" });
  await prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date(), status: "REVOKED" } });
  await prisma.deviceCommand.updateMany({ where: { deviceId: device.id, status: "QUEUED" }, data: { status: "CANCELLED" } });
  res.json({ ok: true });
});

// Plans reported by the phone. Portal edits are versioned desired configs;
// Android must download/apply/acknowledge them before they affect execution.
app.get("/api/data-plans", requireAuth, async (req: AuthRequest, res) => {
  const rows = await prisma.portalDataPlan.findMany({
    where: { userId: req.auth!.userId },
    include: { device: { select: { id: true, deviceName: true, status: true, lastSeenAt: true } } },
    orderBy: [{ ussdMode: "asc" }, { packageName: "asc" }]
  });
  res.json(rows.map(row => ({ ...row, priceKes: Number(row.priceKes), commissionPerSale: Number(row.commissionPerSale), effectiveConfig: row.desiredConfig ?? row.deviceSnapshot, isPendingSync: row.syncStatus === "PENDING_SYNC" })));
});

app.put("/api/data-plans/:id", requireAuth, async (req: AuthRequest, res) => {
  const parsed = z.object({
    packageName: z.string().min(1).max(160), description: z.string().max(500).default(""),
    ussdCode: z.string().min(1).max(300), ussdSteps: z.string().max(2000).nullable().optional(),
    priceKes: z.number().finite().min(0).max(100000), validity: z.string().max(100).default(""),
    dataAmount: z.string().max(100).default(""), category: z.string().min(1).max(80),
    isActive: z.boolean(), commissionPerSale: z.number().finite().min(0).max(100000).default(0),
    executeSim: z.number().int().min(-1).max(4).default(-1), ussdMode: z.enum(["SIMPLE", "ADVANCED"]),
    source: z.string().max(80).default("CUSTOM"), expectedVersion: z.number().int().positive()
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PLAN", details: parsed.error.flatten() });
  const existing = await prisma.portalDataPlan.findFirst({ where: { id: req.params.id, userId: req.auth!.userId } });
  if (!existing) return res.status(404).json({ error: "PLAN_NOT_FOUND" });
  if (existing.version !== parsed.data.expectedVersion) return res.status(409).json({ error: "PLAN_VERSION_CONFLICT", message: "This plan changed elsewhere. Refresh before saving." });
  const { expectedVersion, ...config } = parsed.data;
  const updated = await prisma.portalDataPlan.update({ where: { id: existing.id }, data: { ...config, desiredConfig: config as any, version: { increment: 1 }, syncStatus: "PENDING_SYNC" } });
  await prisma.auditEvent.create({ data: { actorId: req.auth!.userId, action: "DATA_PLAN_EDITED_IN_PORTAL", targetType: "PortalDataPlan", targetId: updated.id, metadata: { version: updated.version, ussdMode: updated.ussdMode, packageName: updated.packageName } } });
  res.json({ ...updated, priceKes: Number(updated.priceKes), commissionPerSale: Number(updated.commissionPerSale), isPendingSync: true });
});

app.get("/api/transactions", requireAuth, async (req: AuthRequest, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId : undefined;
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : undefined;
  const where: any = { device: { userId: req.auth!.userId } };
  if (deviceId) where.deviceId = deviceId;
  if (status && ["RECEIVED", "PENDING", "PROCESSING", "COMPLETED", "FAILED", "UNKNOWN"].includes(status)) where.status = status;
  const rows = await prisma.portalTransaction.findMany({ where, include: { device: { select: { id: true, deviceName: true } } }, orderBy: { lastSyncedAt: "desc" }, take: 500 });
  const sub = await prisma.subscription.findFirst({ where: { userId: req.auth!.userId, status: "ACTIVE", expiresAt: { gt: new Date() } }, include: { plan: true }, orderBy: { expiresAt: "desc" } });
  const days = sub?.plan.transactionHistoryDays ?? 0;
  const cutoff = new Date(Date.now() - days * 86400000);
  res.json(rows.filter(row => row.createdAt >= cutoff));
});

app.get("/api/commands", requireAuth, async (req: AuthRequest, res) => {
  const deviceId = typeof req.query.deviceId === "string" ? req.query.deviceId : undefined;
  if (deviceId) {
    const owned = await prisma.device.findFirst({ where: { id: deviceId, userId: req.auth!.userId } });
    if (!owned) return res.status(404).json({ error: "DEVICE_NOT_FOUND" });
  }
  res.json(await prisma.deviceCommand.findMany({
    where: { device: { userId: req.auth!.userId }, ...(deviceId ? { deviceId } : {}) },
    orderBy: { createdAt: "desc" }, take: 100
  }));
});

const commandTypes = new Set(["START_AUTOMATION", "STOP_AUTOMATION", "CHECK_AIRTIME", "QUEUE_PAYMENT", "BUY_TOKENS", "EXECUTE_USSD"]);
app.post("/api/devices/:id/commands", requireAuth, async (req: AuthRequest, res) => {
  const parsed = z.object({ commandType: z.string().min(1).max(50), payload: z.record(z.unknown()).default({}), idempotencyKey: z.string().min(8).max(120).optional(), ttlSeconds: z.number().int().min(15).max(900).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT", details: parsed.error.flatten() });
  if (!commandTypes.has(parsed.data.commandType)) return res.status(400).json({ error: "UNSUPPORTED_COMMAND" });
  const device = await prisma.device.findFirst({ where: { id: req.params.id, userId: req.auth!.userId, revokedAt: null, status: { not: "REVOKED" } } });
  if (!device) return res.status(404).json({ error: "DEVICE_NOT_FOUND" });
  const active = await prisma.subscription.findFirst({ where: { userId: req.auth!.userId, status: "ACTIVE", expiresAt: { gt: new Date() } } });
  if (!active) return res.status(403).json({ error: "ACTIVE_SUBSCRIPTION_REQUIRED" });
  if (device.status !== "ONLINE" || !device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > 120000) return res.status(409).json({ error: "DEVICE_OFFLINE", message: "This command was not queued because the device is offline." });
  if (["QUEUE_PAYMENT", "BUY_TOKENS", "EXECUTE_USSD"].includes(parsed.data.commandType)) {
    return res.status(403).json({ error: "HIGH_RISK_COMMAND_DISABLED", message: "Financial/USSD remote commands are disabled until explicit per-command safeguards and device-level execution tests are completed." });
  }
  try {
    const command = await prisma.deviceCommand.create({ data: {
      deviceId: device.id, commandType: parsed.data.commandType, payload: parsed.data.payload as any,
      expiresAt: new Date(Date.now() + (parsed.data.ttlSeconds ?? env.COMMAND_DEFAULT_TTL_SECONDS) * 1000),
      idempotencyKey: parsed.data.idempotencyKey
    }});
    await prisma.auditEvent.create({ data: { actorId: req.auth!.userId, action: "DEVICE_COMMAND_QUEUED", targetType: "DeviceCommand", targetId: String(command.id), metadata: { deviceId: device.id, commandType: command.commandType } } });
    res.status(201).json(command);
  } catch (e: any) {
    if (e?.code === "P2002") return res.status(409).json({ error: "DUPLICATE_IDEMPOTENCY_KEY" });
    throw e;
  }
});


// PayHero billing integration. Provider credentials stay on the API server.
type TokenPackage = { code: string; name: string; amountKes: number; tokens: number };
// Keep the Portal catalog identical to TokenManagementScreen.getTokenPackages()
// in the linked Android app. Do not configure a second, independent token catalog.
function tokenPackages(): TokenPackage[] {
  return [
    { code: "TOKENS_100", name: "100 Tokens", amountKes: 10, tokens: 100 },
    { code: "TOKENS_200", name: "200 Tokens", amountKes: 20, tokens: 200 },
    { code: "TOKENS_300", name: "300 Tokens", amountKes: 30, tokens: 300 },
    { code: "TOKENS_400", name: "400 Tokens", amountKes: 40, tokens: 400 },
    { code: "TOKENS_500", name: "500 Tokens", amountKes: 50, tokens: 500 },
    { code: "TOKENS_1000", name: "1,000 Tokens", amountKes: 100, tokens: 1000 },
  ];
}
function payHeroAuthorization(): string | null {
  const token = env.PAYHERO_AUTHORIZATION_TOKEN;
  if (!token) return null;
  return token.toLowerCase().startsWith("basic ") ? token : `Basic ${token}`;
}
function normalizeKenyanPhone(value: string): string | null {
  const digits = value.replace(/[\s()+-]/g, "");
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^254[17]\d{8}$/.test(digits)) return digits;
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`;
  return null;
}
async function payHeroRequest(path: string, init: RequestInit = {}) {
  const authorization = payHeroAuthorization();
  if (!authorization || !env.PAYHERO_CHANNEL_ID) throw new Error("PAYHERO_NOT_CONFIGURED");
  const response = await fetch(`https://backend.payhero.co.ke/api/v2${path}`, {
    ...init,
    headers: { Authorization: authorization, "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Do not expose provider headers or credentials to clients.
    const error = new Error(`PAYHERO_REQUEST_FAILED_${response.status}`);
    (error as any).status = response.status;
    throw error;
  }
  return data;
}
async function initiatePayHeroPayment(userId: string, phoneInput: string, amountKes: number, purpose: string, details: Record<string, unknown>) {
  if (!env.PAYHERO_CALLBACK_URL) throw new Error("PAYHERO_CALLBACK_URL_NOT_CONFIGURED");
  const phone = normalizeKenyanPhone(phoneInput);
  if (!phone) throw new Error("INVALID_KENYAN_PHONE");
  const externalReference = `BSP-${randomUUID()}`;
  const payment = await prisma.payment.create({
    data: { userId, provider: "PAYHERO", externalReference, purpose, amountKes, status: "PENDING",
      providerPayload: { phone, details } as any }
  });
  try {
    const result: any = await payHeroRequest("/payments", {
      method: "POST",
      body: JSON.stringify({
        amount: amountKes, phone_number: phone, channel_id: env.PAYHERO_CHANNEL_ID,
        provider: "m-pesa", external_reference: externalReference, callback_url: env.PAYHERO_CALLBACK_URL
      })
    });
    const providerReference = typeof result.reference === "string" ? result.reference : null;
    const checkoutRequestId = typeof result.CheckoutRequestID === "string" ? result.CheckoutRequestID : null;
    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerReference, checkoutRequestId, providerPayload: { phone, details, initiation: result } as any }
    });
    return { paymentId: payment.id, externalReference, status: "PENDING", providerStatus: String(result.status ?? "QUEUED") };
  } catch (error) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "FAILED", providerPayload: { phone, details, initiationError: error instanceof Error ? error.message : "unknown" } as any } });
    throw error;
  }
}
async function verifyAndApplyPayHeroPayment(externalReference: string, callbackAmount: unknown, callbackPhone: unknown) {
  const payment = await prisma.payment.findUnique({ where: { externalReference } });
  if (!payment || payment.provider !== "PAYHERO") return { result: "NOT_FOUND" as const };
  if (payment.status === "SUCCESS") return { result: "ALREADY_PROCESSED" as const };
  if (!payment.providerReference) return { result: "AWAITING_PROVIDER_REFERENCE" as const };
  const amount = Number(callbackAmount);
  if (!Number.isFinite(amount) || amount !== payment.amountKes) return { result: "AMOUNT_MISMATCH" as const };

  const statusData: any = await payHeroRequest(`/transaction-status?reference=${encodeURIComponent(payment.providerReference)}`, { method: "GET" });
  const providerStatus = String(statusData.status ?? "").toUpperCase();
  if (providerStatus === "QUEUED" || providerStatus === "PENDING") return { result: "PENDING" as const };
  if (providerStatus !== "SUCCESS" || statusData.success === false) {
    if (providerStatus === "FAILED") await prisma.payment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "FAILED", providerPayload: { callback: { amount, phone: callbackPhone }, statusCheck: statusData } as any } });
    return { result: providerStatus === "FAILED" ? "FAILED" as const : "UNVERIFIED" as const };
  }

  const details = (payment.providerPayload && typeof payment.providerPayload === "object" ? (payment.providerPayload as any).details : {}) ?? {};
  const applied = await prisma.$transaction(async tx => {
    const changed = await tx.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: "SUCCESS", verifiedAt: new Date(), providerPayload: { ...((payment.providerPayload as any) ?? {}), callback: { amount, phone: callbackPhone }, statusCheck: statusData } as any }
    });
    if (changed.count === 0) return false;

    if (payment.purpose.startsWith("SUBSCRIPTION:")) {
      const planId = payment.purpose.slice("SUBSCRIPTION:".length);
      const plan = await tx.plan.findUnique({ where: { id: planId } });
      if (!plan || !plan.active || plan.priceKes !== payment.amountKes) throw new Error("SUBSCRIPTION_PLAN_VALIDATION_FAILED");
      const now = new Date();
      const current = await tx.subscription.findFirst({ where: { userId: payment.userId, status: "ACTIVE", expiresAt: { gt: now } }, orderBy: { expiresAt: "desc" } });
      const startsAt = now;
      const base = current?.expiresAt && current.expiresAt > now ? current.expiresAt : now;
      const expiresAt = new Date(base.getTime() + plan.durationDays * 86400000);
      await tx.subscription.create({ data: { userId: payment.userId, planId: plan.id, paymentId: payment.id, status: "ACTIVE", startsAt, expiresAt } });
    } else if (payment.purpose.startsWith("TOKENS:")) {
      const packCode = payment.purpose.slice("TOKENS:".length);
      const pack = tokenPackages().find(p => p.code === packCode);
      if (!pack || pack.amountKes !== payment.amountKes) throw new Error("TOKEN_PACKAGE_VALIDATION_FAILED");
      const prior = await tx.tokenLedgerEntry.findUnique({ where: { reference: `payhero:${payment.id}` } });
      if (!prior) {
        const latest = await tx.tokenLedgerEntry.findFirst({ where: { userId: payment.userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { balanceAfter: true } });
        const balance = (latest?.balanceAfter ?? 0) + pack.tokens;
        await tx.tokenLedgerEntry.create({ data: { userId: payment.userId, paymentId: payment.id, delta: pack.tokens, balanceAfter: balance, reason: `PayHero token purchase: ${pack.name}`, reference: `payhero:${payment.id}` } });
      }
    }
    return true;
  });
  return { result: applied ? "SUCCESS" as const : "ALREADY_PROCESSED" as const };
}

// Public catalog is informational; all prices and token quantities are validated again server-side.
app.get("/api/billing/token-packages", requireAuth, (_req, res) => {
  res.json(tokenPackages().map(({ code, name, amountKes, tokens }) => ({ code, name, amountKes, tokens })));
});
app.post("/api/billing/subscriptions", requireAuth, async (req: AuthRequest, res) => {
  const parsed = z.object({ planId: z.string().min(1), phoneNumber: z.string().min(9).max(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
  const plan = await prisma.plan.findUnique({ where: { id: parsed.data.planId } });
  if (!plan || !plan.active) return res.status(404).json({ error: "PLAN_NOT_AVAILABLE" });
  try {
    const result = await initiatePayHeroPayment(req.auth!.userId, parsed.data.phoneNumber, plan.priceKes, `SUBSCRIPTION:${plan.id}`, { planId: plan.id, planName: plan.name });
    return res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "PAYMENT_INITIATION_FAILED";
    const status = message === "INVALID_KENYAN_PHONE" ? 400 : message.includes("NOT_CONFIGURED") ? 503 : 502;
    return res.status(status).json({ error: message });
  }
});
app.post("/api/billing/tokens", requireAuth, async (req: AuthRequest, res) => {
  const parsed = z.object({ packageCode: z.string().min(2).max(60), phoneNumber: z.string().min(9).max(20) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
  const pack = tokenPackages().find(p => p.code === parsed.data.packageCode);
  if (!pack) return res.status(404).json({ error: "TOKEN_PACKAGE_NOT_AVAILABLE" });
  try {
    const result = await initiatePayHeroPayment(req.auth!.userId, parsed.data.phoneNumber, pack.amountKes, `TOKENS:${pack.code}`, { packageCode: pack.code, tokens: pack.tokens });
    return res.status(201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "PAYMENT_INITIATION_FAILED";
    const status = message === "INVALID_KENYAN_PHONE" ? 400 : message.includes("NOT_CONFIGURED") ? 503 : 502;
    return res.status(status).json({ error: message });
  }
});
app.get("/api/billing/payments", requireAuth, async (req: AuthRequest, res) => {
  const rows = await prisma.payment.findMany({ where: { userId: req.auth!.userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, provider: true, externalReference: true, providerReference: true, purpose: true, amountKes: true, status: true, verifiedAt: true, createdAt: true } });
  res.json(rows);
});
app.get("/api/billing/payments/:id", requireAuth, async (req: AuthRequest, res) => {
  const payment = await prisma.payment.findFirst({ where: { id: req.params.id, userId: req.auth!.userId }, select: { id: true, externalReference: true, providerReference: true, purpose: true, amountKes: true, status: true, verifiedAt: true, createdAt: true } });
  if (!payment) return res.status(404).json({ error: "PAYMENT_NOT_FOUND" });
  if (payment.status === "PENDING" && payment.providerReference) {
    try {
      const statusData: any = await payHeroRequest(`/transaction-status?reference=${encodeURIComponent(payment.providerReference)}`, { method: "GET" });
      if (String(statusData.status ?? "").toUpperCase() === "SUCCESS" && statusData.success !== false) {
        // Status polling alone does not include a reliably documented amount in all responses;
        // wait for the callback amount before applying financial effects.
      }
    } catch { /* A transient provider error must not change payment state. */ }
  }
  return res.json(payment);
});
app.get("/api/billing/token-ledger", requireAuth, async (req: AuthRequest, res) => {
  const rows = await prisma.tokenLedgerEntry.findMany({ where: { userId: req.auth!.userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100 });
  res.json(rows);
});
app.post("/api/payhero/callback", async (req, res) => {
  const body: any = req.body ?? {};
  const response = body.response ?? body;
  const externalReference = response.ExternalReference ?? body.ExternalReference ?? body.external_reference;
  if (typeof externalReference !== "string" || !externalReference.startsWith("BSP-")) return res.status(400).json({ error: "INVALID_CALLBACK" });
  try {
    const result = await verifyAndApplyPayHeroPayment(externalReference, response.Amount ?? body.amount, response.Phone ?? body.phone);
    if (result.result === "NOT_FOUND") return res.status(404).json({ error: "PAYMENT_NOT_FOUND" });
    if (result.result === "AMOUNT_MISMATCH") return res.status(400).json({ error: "AMOUNT_MISMATCH" });
    return res.status(200).json({ ok: true, result: result.result });
  } catch (error) {
    console.error("PayHero callback verification failed", error instanceof Error ? error.message : "unknown");
    return res.status(502).json({ error: "PAYMENT_VERIFICATION_UNAVAILABLE" });
  }
});

app.use("/api/admin", adminRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled API error", err instanceof Error ? err.message : "unknown");
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
});

app.listen(env.PORT, () => console.log(`Bingwa Portal API listening on ${env.PORT}`));
