import express from "express";
import { randomInt } from "node:crypto";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { deviceSyncRouter } from "./device-sync.js";
import { AuthRequest, hashPairingCode, issueAdminToken, issueUserToken, randomSecret, requireAdmin, requireAuth, sha256 } from "./security.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: env.WEB_ORIGIN, credentials: false }));
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
  const phone = parsed.data.phone.replace(/^\+/, "");
  if (await prisma.user.findUnique({ where: { phone } })) return res.status(409).json({ error: "PHONE_ALREADY_REGISTERED" });
  const user = await prisma.user.create({ data: { phone, passwordHash: await bcrypt.hash(parsed.data.password, 12) } });
  // Production must require a verified OTP before enabling purchases or device linking.
  return res.status(201).json({ user: { id: user.id, phone: user.phone, role: user.role, phoneVerified: false }, token: issueUserToken(user), warning: "Phone OTP verification provider must be configured before production." });
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = z.object({ phone: z.string().min(9).max(16), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
  const phone = parsed.data.phone.replace(/^\+/, "");
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  return res.json({ user: { id: user.id, phone: user.phone, role: user.role, phoneVerified: Boolean(user.phoneVerifiedAt) }, token: issueUserToken(user) });
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
  const ledger = await prisma.tokenLedgerEntry.findMany({ where: { userId: req.auth!.userId }, orderBy: { createdAt: "desc" }, take: 1 });
  return res.json({ ...user, tokenBalance: ledger[0]?.balanceAfter ?? 0 });
});

app.get("/api/plans", async (_req, res) => {
  res.json(await prisma.plan.findMany({ where: { active: true }, orderBy: { priceKes: "asc" } }));
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

app.get("/api/admin/overview", requireAdmin, async (_req, res) => {
  const [users, devices, pendingPayments, activeSubscriptions, queuedCommands] = await Promise.all([
    prisma.user.count(), prisma.device.count({ where: { revokedAt: null } }),
    prisma.payment.count({ where: { status: "PENDING" } }),
    prisma.subscription.count({ where: { status: "ACTIVE", expiresAt: { gt: new Date() } } }),
    prisma.deviceCommand.count({ where: { status: "QUEUED" } })
  ]);
  res.json({ users, devices, pendingPayments, activeSubscriptions, queuedCommands });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled API error", err instanceof Error ? err.message : "unknown");
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
});

app.listen(env.PORT, () => console.log(`Bingwa Portal API listening on ${env.PORT}`));
