import { Router } from "express";
import { z } from "zod";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { AuthRequest, requireAdmin } from "./security.js";
import { transitionSubscription } from "./subscription-lifecycle.js";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) });
function pagination(query: any) {
  const parsed = pageSchema.safeParse({ page: query.page, pageSize: query.pageSize });
  if (!parsed.success) return null;
  return { ...parsed.data, skip: (parsed.data.page - 1) * parsed.data.pageSize };
}
function paged<T>(items: T[], page: number, pageSize: number, total: number) { return { items, page, pageSize, total }; }
function queryString(value: unknown, max = 160): string | undefined { return typeof value === "string" && value.length <= max && value.trim() ? value.trim() : undefined; }
function failInput(res: any) { return res.status(400).json({ error: "INVALID_INPUT" }); }
function selectActor(req: AuthRequest) {
  return req.auth?.tokenType === "admin" ? { actorId: null, actorLabel: req.auth.userId } : { actorId: req.auth?.userId ?? null, actorLabel: null };
}
async function audit(tx: any, req: AuthRequest, data: { action: string; targetType: string; targetId: string; metadata?: Record<string, unknown>; idempotencyKey?: string }) {
  await tx.auditEvent.create({ data: { ...selectActor(req), action: data.action, targetType: data.targetType, targetId: data.targetId, metadata: data.metadata as any, idempotencyKey: data.idempotencyKey, requestId: req.requestId, ipAddress: req.ip } });
}
function safeMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const allowed = new Set(["reason", "days", "direction", "amount", "delta", "balanceAfter", "expiresAt", "previousExpiresAt", "startsAt", "previousStartsAt", "planId", "requestedPlanId", "previousPlanId", "planName", "name", "code", "priceKes", "durationDays", "requestedDurationDays", "maxDevices", "transactionHistoryDays", "active", "suspended", "version", "status", "previousStatus", "action", "userId"]);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    if (val === null || ["string", "number", "boolean"].includes(typeof val)) out[key] = val;
  }
  return out;
}
function safeAudit(row: any) { return { id: row.id, actorId: row.actorId, actorLabel: row.actorLabel, action: row.action, targetType: row.targetType, targetId: row.targetId, requestId: row.requestId, idempotencyKey: row.idempotencyKey, metadata: safeMetadata(row.metadata), createdAt: row.createdAt }; }
const userSelect = { id: true, phone: true, role: true, phoneVerifiedAt: true, suspendedAt: true, suspensionReason: true, createdAt: true, updatedAt: true } as const;
const planSelect = { id: true, code: true, name: true, priceKes: true, durationDays: true, maxDevices: true, transactionHistoryDays: true, active: true, createdAt: true, updatedAt: true } as const;
const paymentSelect = { id: true, userId: true, provider: true, providerReference: true, externalReference: true, checkoutRequestId: true, purpose: true, amountKes: true, status: true, verifiedAt: true, createdAt: true, updatedAt: true } as const;
const subscriptionSelect = { id: true, userId: true, planId: true, status: true, startsAt: true, expiresAt: true, paymentId: true, createdAt: true, updatedAt: true } as const;
const deviceSelect = { id: true, userId: true, deviceName: true, status: true, appVersion: true, model: true, manufacturer: true, androidVersion: true, phoneNumber: true, simSlot: true, carrierName: true, automationEnabled: true, executionState: true, lastSeenAt: true, revokedAt: true, createdAt: true, updatedAt: true } as const;

adminRouter.get("/overview", async (_req, res) => {
  const now = new Date();
  const [users, devices, pendingPayments, activeSubscriptions, queuedCommands] = await Promise.all([
    prisma.user.count(), prisma.device.count({ where: { revokedAt: null, status: { not: "REVOKED" } } }),
    prisma.payment.count({ where: { status: "PENDING" } }),
    prisma.subscription.count({ where: { status: "ACTIVE", expiresAt: { gt: now } } }),
    prisma.deviceCommand.count({ where: { status: "QUEUED", expiresAt: { gt: now } } })
  ]);
  res.json({ users, devices, pendingPayments, activeSubscriptions, queuedCommands });
});

adminRouter.get("/users", async (req, res) => {
  const p = pagination(req.query); if (!p) return failInput(res);
  const input = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]).optional(), subscriptionStatus: z.enum(["ACTIVE", "EXPIRED", "CANCELLED", "PENDING", "NONE"]).optional(), sort: z.enum(["asc", "desc"]).default("desc") }).safeParse({ status: req.query.status, subscriptionStatus: req.query.subscriptionStatus, sort: req.query.sort ?? "desc" });
  if (!input.success) return failInput(res);
  const search = queryString(req.query.search, 160);
  const where: any = {};
  const now = new Date();
  if (search) where.OR = [{ id: { contains: search, mode: "insensitive" } }, { phone: { contains: search } }];
  if (input.data.status === "ACTIVE") where.suspendedAt = null;
  if (input.data.status === "SUSPENDED") where.suspendedAt = { not: null };
  if (input.data.subscriptionStatus === "NONE") where.subscriptions = { none: {} };
  else if (input.data.subscriptionStatus === "ACTIVE") where.subscriptions = { some: { status: "ACTIVE", expiresAt: { gt: now } } };
  else if (input.data.subscriptionStatus === "EXPIRED") where.subscriptions = { some: { OR: [{ status: "EXPIRED" }, { status: "ACTIVE", expiresAt: { lte: now } }] } };
  else if (input.data.subscriptionStatus) where.subscriptions = { some: { status: input.data.subscriptionStatus } };
  const [rows, total] = await Promise.all([prisma.user.findMany({ where, select: { ...userSelect, _count: { select: { devices: true } }, subscriptions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { status: true, expiresAt: true } } }, orderBy: [{ createdAt: input.data.sort }, { id: input.data.sort }], skip: p.skip, take: p.pageSize }), prisma.user.count({ where })]);
  res.json(paged(rows.map(({ _count, subscriptions, ...user }) => ({ ...user, devicesCount: _count.devices, subscriptionStatus: subscriptions[0]?.status === "ACTIVE" && subscriptions[0]?.expiresAt && subscriptions[0].expiresAt <= now ? "EXPIRED" : subscriptions[0]?.status ?? null, subscriptionExpiresAt: subscriptions[0]?.expiresAt ?? null })), p.page, p.pageSize, total));
});

adminRouter.get("/users/:id", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { ...userSelect,
    _count: { select: { devices: true } },
    devices: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: deviceSelect },
    subscriptions: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { ...subscriptionSelect, plan: { select: planSelect }, payment: { select: paymentSelect } } },
    payments: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: paymentSelect },
    tokenLedger: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, paymentId: true, delta: true, balanceAfter: true, reason: true, reference: true, createdAt: true } },
    auditEvents: { where: { targetType: "User", targetId: req.params.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, actorId: true, actorLabel: true, action: true, targetType: true, targetId: true, requestId: true, idempotencyKey: true, metadata: true, createdAt: true } }
  } });
  if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
  const { devices, _count, ...rest } = user;
  res.json({ ...rest, devicesCount: _count.devices, subscriptionStatus: user.subscriptions[0]?.status ?? null, devices, auditEvents: user.auditEvents.map(safeAudit) });
});

adminRouter.patch("/users/:id/suspension", async (req: AuthRequest, res) => {
  const parsed = z.object({ suspended: z.boolean(), reason: z.string().trim().min(3).max(500) }).safeParse(req.body);
  if (!parsed.success) return failInput(res);
  const existing = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, suspendedAt: true, suspensionReason: true } });
  if (!existing) return res.status(404).json({ error: "USER_NOT_FOUND" });
  const at = parsed.data.suspended ? new Date() : null;
  const updated = await prisma.$transaction(async tx => {
    const result = await tx.user.update({ where: { id: existing.id }, data: { suspendedAt: at, suspensionReason: parsed.data.suspended ? parsed.data.reason : null }, select: userSelect });
    await audit(tx, req, { action: parsed.data.suspended ? "USER_SUSPENDED" : "USER_UNSUSPENDED", targetType: "User", targetId: existing.id, metadata: { suspended: parsed.data.suspended, reason: parsed.data.reason } });
    return result;
  });
  res.json(updated);
});

adminRouter.get("/devices", async (req, res) => {
  const p = pagination(req.query); if (!p) return failInput(res);
  const parsed = z.object({ status: z.enum(["ONLINE", "OFFLINE", "REVOKED"]).optional(), ownerId: z.string().max(160).optional(), sort: z.enum(["asc", "desc"]).default("desc") }).safeParse({ status: req.query.status, ownerId: req.query.ownerId, sort: req.query.sort ?? "desc" });
  if (!parsed.success) return failInput(res);
  const search = queryString(req.query.search, 160); const where: any = {};
  if (parsed.data.status) where.status = parsed.data.status;
  if (parsed.data.ownerId) where.userId = parsed.data.ownerId;
  if (search) where.OR = [{ id: { contains: search, mode: "insensitive" } }, { deviceName: { contains: search, mode: "insensitive" } }, { user: { phone: { contains: search } } }];
  const [items, total] = await Promise.all([prisma.device.findMany({ where, select: { ...deviceSelect, user: { select: { id: true, phone: true } } }, orderBy: [{ createdAt: parsed.data.sort }, { id: parsed.data.sort }], skip: p.skip, take: p.pageSize }), prisma.device.count({ where })]);
  res.json(paged(items, p.page, p.pageSize, total));
});
adminRouter.get("/devices/:id", async (req, res) => {
  const item = await prisma.device.findUnique({ where: { id: req.params.id }, select: { ...deviceSelect, user: { select: { id: true, phone: true } }, commands: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, commandType: true, status: true, expiresAt: true, deliveredAt: true, startedAt: true, completedAt: true, errorMessage: true, createdAt: true } } } });
  if (!item) return res.status(404).json({ error: "DEVICE_NOT_FOUND" });
  res.json(item);
});
adminRouter.post("/devices/:id/revoke", async (req: AuthRequest, res) => {
  const parsed = z.object({ reason: z.string().trim().min(3).max(500) }).safeParse(req.body); if (!parsed.success) return failInput(res);
  const existing = await prisma.device.findUnique({ where: { id: req.params.id }, select: { id: true, revokedAt: true } });
  if (!existing) return res.status(404).json({ error: "DEVICE_NOT_FOUND" });
  const result = await prisma.$transaction(async tx => {
    const device = await tx.device.update({ where: { id: existing.id }, data: { revokedAt: existing.revokedAt ?? new Date(), status: "REVOKED" }, select: deviceSelect });
    const cancelled = await tx.deviceCommand.updateMany({ where: { deviceId: existing.id, status: "QUEUED" }, data: { status: "CANCELLED" } });
    await audit(tx, req, { action: "DEVICE_REVOKED", targetType: "Device", targetId: existing.id, metadata: { reason: parsed.data.reason, cancelledCommands: cancelled.count } });
    return { device, cancelledCommands: cancelled.count };
  });
  res.json(result);
});

adminRouter.get("/subscriptions", async (req, res) => {
  const p = pagination(req.query); if (!p) return failInput(res);
  const parsed = z.object({ status: z.enum(["ACTIVE", "EXPIRED", "CANCELLED", "PENDING"]).optional(), sort: z.enum(["asc", "desc"]).default("desc") }).safeParse({ status: req.query.status, sort: req.query.sort ?? "desc" }); if (!parsed.success) return failInput(res);
  const search = queryString(req.query.search, 160); const where: any = {};
  if (parsed.data.status === "EXPIRED") where.AND = [{ OR: [{ status: "EXPIRED" }, { status: "ACTIVE", expiresAt: { lte: new Date() } }] }];
  else if (parsed.data.status === "ACTIVE") { where.status = "ACTIVE"; where.expiresAt = { gt: new Date() }; }
  else if (parsed.data.status) where.status = parsed.data.status;
  if (search) where.OR = [{ id: { contains: search, mode: "insensitive" } }, { user: { phone: { contains: search } } }, { plan: { name: { contains: search, mode: "insensitive" } } }];
  const [items, total] = await Promise.all([prisma.subscription.findMany({ where, select: { ...subscriptionSelect, user: { select: { id: true, phone: true } }, plan: { select: planSelect } }, orderBy: [{ createdAt: parsed.data.sort }, { id: parsed.data.sort }], skip: p.skip, take: p.pageSize }), prisma.subscription.count({ where })]);
  const now = new Date();
  res.json(paged(items.map(item => ({ ...item, status: item.status === "ACTIVE" && item.expiresAt && item.expiresAt <= now ? "EXPIRED" : item.status })), p.page, p.pageSize, total));
});
adminRouter.get("/subscriptions/:id", async (req, res) => {
  const item = await prisma.subscription.findUnique({ where: { id: req.params.id }, select: { ...subscriptionSelect, user: { select: { id: true, phone: true } }, plan: { select: planSelect }, payment: { select: paymentSelect } } });
  if (!item) return res.status(404).json({ error: "SUBSCRIPTION_NOT_FOUND" });
  const auditRows = await prisma.auditEvent.findMany({ where: { targetType: "Subscription", targetId: item.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, actorId: true, actorLabel: true, action: true, targetType: true, targetId: true, requestId: true, idempotencyKey: true, metadata: true, createdAt: true } });
  const status = item.status === "ACTIVE" && item.expiresAt && item.expiresAt <= new Date() ? "EXPIRED" : item.status;
  res.json({ ...item, status, auditEvents: auditRows.map(safeAudit) });
});

const subscriptionActionSchema = z.object({
  action: z.enum(["activate", "extend", "renew", "deactivate"]),
  planId: z.string().min(1).optional(),
  durationDays: z.number().int().min(1).max(3650).optional(),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.string().trim().min(8).max(120)
}).strict();

async function applySubscriptionAction(req: AuthRequest, userId: string, subscriptionId: string | null, input: z.infer<typeof subscriptionActionSchema>) {
  return prisma.$transaction(async tx => {
    const lockedUser = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (!lockedUser.length) return { failure: "USER_NOT_FOUND" as const };

    let current = subscriptionId
      ? await tx.subscription.findFirst({ where: { id: subscriptionId, userId }, select: subscriptionSelect })
      : await tx.subscription.findFirst({ where: { userId }, select: subscriptionSelect, orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }] });
    if (subscriptionId && !current) return { failure: "SUBSCRIPTION_NOT_FOUND" as const };

    const auditAction = `SUBSCRIPTION_ADMIN_${input.action.toUpperCase()}`;
    if (current) {
      const prior = await tx.auditEvent.findFirst({ where: { action: auditAction, targetType: "Subscription", targetId: current.id, idempotencyKey: input.idempotencyKey }, select: { metadata: true } });
      if (prior) {
        const metadata: any = prior.metadata ?? {};
        if (metadata.reason !== input.reason || metadata.requestedPlanId !== (input.planId ?? null) || metadata.requestedDurationDays !== (input.durationDays ?? null)) return { failure: "IDEMPOTENCY_KEY_CONFLICT" as const };
        const subscription = await tx.subscription.findUnique({ where: { id: current.id }, select: { ...subscriptionSelect, plan: { select: planSelect } } });
        return { subscription, replayed: true as const };
      }
    }

    const needsPlan = input.action === "activate" || input.action === "renew";
    if (needsPlan && !input.planId) return { failure: "PLAN_REQUIRED" as const };
    const plan = input.planId ? await tx.plan.findUnique({ where: { id: input.planId }, select: planSelect }) : null;
    if (input.planId && !plan) return { failure: "PLAN_NOT_FOUND" as const };
    if ((input.action === "activate" || input.action === "renew") && !plan) return { failure: "PLAN_REQUIRED" as const };
    if (input.action === "extend" && !current) return { failure: "SUBSCRIPTION_NOT_FOUND" as const };
    if (input.action === "deactivate" && !current) return { failure: "SUBSCRIPTION_NOT_FOUND" as const };

    const now = new Date();
    const durationDays = input.durationDays ?? plan?.durationDays ?? undefined;
    if ((input.action === "activate" || input.action === "renew") && !durationDays) return { failure: "DURATION_REQUIRED" as const };
    if (input.action === "extend" && !durationDays) return { failure: "DURATION_REQUIRED" as const };

    const currentPlanId = input.planId ?? current?.planId;
    const previousState = current ? { planId: current.planId, status: current.status, startsAt: current.startsAt, expiresAt: current.expiresAt } : null;
    const next = transitionSubscription(input.action, current, durationDays, now);
    const { status, startsAt, expiresAt } = next;

    if (!current) {
      current = await tx.subscription.create({ data: { userId, planId: currentPlanId!, status, startsAt, expiresAt }, select: subscriptionSelect });
    } else {
      current = await tx.subscription.update({ where: { id: current.id }, data: { planId: currentPlanId!, status, startsAt, expiresAt }, select: subscriptionSelect });
    }
    await audit(tx, req, {
      action: auditAction, targetType: "Subscription", targetId: current.id, idempotencyKey: input.idempotencyKey,
      metadata: {
        action: input.action, userId, reason: input.reason,
        planId: currentPlanId, requestedPlanId: input.planId ?? null, planName: plan?.name ?? undefined,
        durationDays: durationDays ?? null, requestedDurationDays: input.durationDays ?? null,
        previousPlanId: previousState?.planId ?? null, previousStatus: previousState?.status ?? null,
        previousStartsAt: previousState?.startsAt?.toISOString() ?? null, previousExpiresAt: previousState?.expiresAt?.toISOString() ?? null,
        status, startsAt: startsAt?.toISOString() ?? null, expiresAt: expiresAt?.toISOString() ?? null
      }
    });
    const subscription = await tx.subscription.findUnique({ where: { id: current.id }, select: { ...subscriptionSelect, plan: { select: planSelect } } });
    return { subscription, replayed: false as const };
  });
}

function parseSubscriptionAction(body: unknown) {
  const parsed = subscriptionActionSchema.safeParse(body);
  if (!parsed.success) return null;
  if ((parsed.data.action === "activate" || parsed.data.action === "renew") && !parsed.data.planId) return null;
  if ((parsed.data.action === "extend" || parsed.data.action === "renew") && !parsed.data.durationDays && !parsed.data.planId) return null;
  return parsed.data;
}

function sendSubscriptionActionResult(res: any, result: any) {
  if ("failure" in result) {
    const status = result.failure === "USER_NOT_FOUND" || result.failure === "SUBSCRIPTION_NOT_FOUND" || result.failure === "PLAN_NOT_FOUND" ? 404 : result.failure === "IDEMPOTENCY_KEY_CONFLICT" ? 409 : 400;
    return res.status(status).json({ error: result.failure });
  }
  return res.json(result);
}

adminRouter.post("/users/:id/subscription", async (req: AuthRequest, res) => {
  const input = parseSubscriptionAction(req.body);
  if (!input) return failInput(res);
  const result = await applySubscriptionAction(req, req.params.id, null, input);
  return sendSubscriptionActionResult(res, result);
});

adminRouter.post("/subscriptions/:id/actions", async (req: AuthRequest, res) => {
  const input = parseSubscriptionAction(req.body);
  if (!input) return failInput(res);
  const existing = await prisma.subscription.findUnique({ where: { id: req.params.id }, select: { userId: true } });
  if (!existing) return res.status(404).json({ error: "SUBSCRIPTION_NOT_FOUND" });
  const result = await applySubscriptionAction(req, existing.userId, req.params.id, input);
  return sendSubscriptionActionResult(res, result);
});

adminRouter.get("/plans", async (_req, res) => {
  res.json(await prisma.plan.findMany({ select: planSelect, orderBy: [{ active: "desc" }, { priceKes: "asc" }, { id: "asc" }] }));
});
adminRouter.post("/subscriptions/:id/extend", async (req: AuthRequest, res) => {
  const parsed = z.object({ days: z.number().int().min(1).max(365), reason: z.string().trim().min(3).max(500), idempotencyKey: z.string().trim().min(8).max(120) }).safeParse(req.body); if (!parsed.success) return failInput(res);
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Subscription" WHERE "id" = ${req.params.id} FOR UPDATE`;
    const current = await tx.subscription.findUnique({ where: { id: req.params.id }, select: subscriptionSelect });
    if (!current) return { failure: "NOT_FOUND" as const };
    if (current.status !== "ACTIVE" && current.status !== "EXPIRED") return { failure: "NOT_EXTENDABLE" as const };
    const prior = await tx.auditEvent.findFirst({ where: { action: "SUBSCRIPTION_EXTENDED", targetType: "Subscription", targetId: current.id, idempotencyKey: parsed.data.idempotencyKey }, select: { metadata: true } });
    if (prior) {
      const metadata: any = prior.metadata ?? {};
      if (metadata.days !== parsed.data.days || metadata.reason !== parsed.data.reason) return { failure: "IDEMPOTENCY_KEY_CONFLICT" as const };
      const subscription = await tx.subscription.findUnique({ where: { id: current.id }, select: { ...subscriptionSelect, plan: { select: planSelect } } });
      return { subscription: { ...subscription!, expiresAt: metadata.expiresAt ? new Date(metadata.expiresAt) : subscription!.expiresAt }, replayed: true };
    }
    const now = new Date(); const base = current.expiresAt && current.expiresAt > now ? current.expiresAt : now; const expiresAt = new Date(base.getTime() + parsed.data.days * 86400000);
    const subscription = await tx.subscription.update({ where: { id: current.id }, data: { status: "ACTIVE", startsAt: current.startsAt ?? now, expiresAt }, select: { ...subscriptionSelect, plan: { select: planSelect } } });
    await audit(tx, req, { action: "SUBSCRIPTION_EXTENDED", targetType: "Subscription", targetId: current.id, idempotencyKey: parsed.data.idempotencyKey, metadata: { days: parsed.data.days, reason: parsed.data.reason, previousExpiresAt: current.expiresAt?.toISOString() ?? null, expiresAt: expiresAt.toISOString() } });
    return { subscription, replayed: false };
  });
  if ("failure" in result) {
    if (result.failure === "NOT_FOUND") return res.status(404).json({ error: "SUBSCRIPTION_NOT_FOUND" });
    return res.status(409).json({ error: result.failure });
  }
  res.json(result);
});

adminRouter.get("/payments", async (req, res) => {
  const p = pagination(req.query); if (!p) return failInput(res);
  const parsed = z.object({ status: z.enum(["PENDING", "SUCCESS", "FAILED", "REVERSED"]).optional(), sort: z.enum(["asc", "desc"]).default("desc") }).safeParse({ status: req.query.status, sort: req.query.sort ?? "desc" }); if (!parsed.success) return failInput(res);
  const search = queryString(req.query.search, 160); const where: any = {};
  if (parsed.data.status) where.status = parsed.data.status;
  if (search) where.OR = [{ id: { contains: search, mode: "insensitive" } }, { user: { phone: { contains: search } } }, { externalReference: { contains: search, mode: "insensitive" } }, { providerReference: { contains: search, mode: "insensitive" } }];
  const [items, total] = await Promise.all([prisma.payment.findMany({ where, select: { ...paymentSelect, user: { select: { id: true, phone: true } } }, orderBy: [{ createdAt: parsed.data.sort }, { id: parsed.data.sort }], skip: p.skip, take: p.pageSize }), prisma.payment.count({ where })]);
  res.json(paged(items, p.page, p.pageSize, total));
});
adminRouter.get("/payments/:id", async (req, res) => {
  const item = await prisma.payment.findUnique({ where: { id: req.params.id }, select: { ...paymentSelect, user: { select: { id: true, phone: true } }, subscription: { select: { id: true, status: true, startsAt: true, expiresAt: true, plan: { select: planSelect } } }, tokenLedgerEntries: { select: { id: true, userId: true, delta: true, balanceAfter: true, reason: true, reference: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] } } });
  if (!item) return res.status(404).json({ error: "PAYMENT_NOT_FOUND" });
  res.json(item);
});

adminRouter.get("/tokens", async (req, res) => {
  const p = pagination(req.query); if (!p) return failInput(res);
  const search = queryString(req.query.search, 160); const where: any = search ? { OR: [{ id: { contains: search, mode: "insensitive" } }, { phone: { contains: search } }] } : {};
  const [users, total] = await Promise.all([prisma.user.findMany({ where, select: { id: true, phone: true, tokenLedger: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { balanceAfter: true, createdAt: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: p.skip, take: p.pageSize }), prisma.user.count({ where })]);
  res.json(paged(users.map(({ tokenLedger, ...user }) => ({ ...user, balance: tokenLedger[0]?.balanceAfter ?? 0, balanceUpdatedAt: tokenLedger[0]?.createdAt ?? null })), p.page, p.pageSize, total));
});
adminRouter.get("/tokens/:userId/ledger", async (req, res) => {
  const p = pagination(req.query); if (!p) return failInput(res);
  const user = await prisma.user.findUnique({ where: { id: req.params.userId }, select: { id: true } }); if (!user) return res.status(404).json({ error: "USER_NOT_FOUND" });
  const [items, total] = await Promise.all([prisma.tokenLedgerEntry.findMany({ where: { userId: user.id }, select: { id: true, paymentId: true, delta: true, balanceAfter: true, reason: true, reference: true, createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: p.skip, take: p.pageSize }), prisma.tokenLedgerEntry.count({ where: { userId: user.id } })]);
  res.json(paged(items, p.page, p.pageSize, total));
});
adminRouter.post("/tokens/:userId/adjustments", async (req: AuthRequest, res) => {
  const parsed = z.object({ direction: z.enum(["CREDIT", "DEBIT"]), amount: z.number().int().min(1).max(100000000), reason: z.string().trim().min(10).max(500), idempotencyKey: z.string().trim().min(8).max(120) }).safeParse(req.body); if (!parsed.success) return failInput(res);
  const userId = req.params.userId; const delta = parsed.data.direction === "CREDIT" ? parsed.data.amount : -parsed.data.amount; const reference = `admin-adjustment:${parsed.data.idempotencyKey}`;
  try {
    const result = await prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      if (!locked.length) return null;
      const prior = await tx.tokenLedgerEntry.findUnique({ where: { reference }, select: { id: true, userId: true, delta: true, balanceAfter: true, reason: true, reference: true, createdAt: true } });
      if (prior) {
        if (prior.userId !== userId || prior.delta !== delta || prior.reason !== parsed.data.reason) throw new Error("IDEMPOTENCY_KEY_CONFLICT");
        return { entry: prior, replayed: true };
      }
      const latest = await tx.tokenLedgerEntry.findFirst({ where: { userId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { balanceAfter: true } });
      const balance = (latest?.balanceAfter ?? 0) + delta;
      if (balance < 0) throw new Error("INSUFFICIENT_TOKEN_BALANCE");
      const entry = await tx.tokenLedgerEntry.create({ data: { userId, delta, balanceAfter: balance, reason: parsed.data.reason, reference }, select: { id: true, userId: true, delta: true, balanceAfter: true, reason: true, reference: true, createdAt: true } });
      await audit(tx, req, { action: "TOKEN_BALANCE_ADJUSTED", targetType: "User", targetId: userId, idempotencyKey: parsed.data.idempotencyKey, metadata: { direction: parsed.data.direction, amount: parsed.data.amount, delta, balanceAfter: balance, reason: parsed.data.reason } });
      return { entry, replayed: false };
    });
    if (!result) return res.status(404).json({ error: "USER_NOT_FOUND" });
    return res.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "IDEMPOTENCY_KEY_CONFLICT") return res.status(409).json({ error: "IDEMPOTENCY_KEY_CONFLICT" });
    if (error instanceof Error && error.message === "INSUFFICIENT_TOKEN_BALANCE") return res.status(409).json({ error: "INSUFFICIENT_TOKEN_BALANCE" });
    throw error;
  }
});

adminRouter.get("/audit-logs", async (req, res) => {
  const p = pagination(req.query); if (!p) return failInput(res);
  const parsed = z.object({ action: z.string().min(1).max(100).optional(), targetType: z.string().min(1).max(100).optional(), actorId: z.string().min(1).max(160).optional(), sort: z.enum(["asc", "desc"]).default("desc") }).safeParse({ action: req.query.action, targetType: req.query.targetType, actorId: req.query.actorId, sort: req.query.sort ?? "desc" }); if (!parsed.success) return failInput(res);
  const search = queryString(req.query.search, 160); const where: any = {};
  if (parsed.data.action) where.action = parsed.data.action;
  if (parsed.data.targetType) where.targetType = parsed.data.targetType;
  if (parsed.data.actorId) where.actorId = parsed.data.actorId;
  if (search) where.OR = [{ action: { contains: search, mode: "insensitive" } }, { targetType: { contains: search, mode: "insensitive" } }, { targetId: { contains: search, mode: "insensitive" } }, { actorLabel: { contains: search, mode: "insensitive" } }];
  const [rows, total] = await Promise.all([prisma.auditEvent.findMany({ where, select: { id: true, actorId: true, actorLabel: true, action: true, targetType: true, targetId: true, requestId: true, idempotencyKey: true, metadata: true, createdAt: true }, orderBy: [{ createdAt: parsed.data.sort }, { id: parsed.data.sort }], skip: p.skip, take: p.pageSize }), prisma.auditEvent.count({ where })]);
  res.json(paged(rows.map(safeAudit), p.page, p.pageSize, total));
});

adminRouter.get("/settings", async (_req, res) => {
  const plans = await prisma.plan.findMany({ select: planSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  res.json({ runtime: { WEB_ORIGIN: env.WEB_ORIGIN, PAIRING_CODE_TTL_SECONDS: env.PAIRING_CODE_TTL_SECONDS, DEVICE_TOKEN_TTL_DAYS: env.DEVICE_TOKEN_TTL_DAYS, COMMAND_DEFAULT_TTL_SECONDS: env.COMMAND_DEFAULT_TTL_SECONDS }, plans });
});
adminRouter.put("/plans/:id", async (req: AuthRequest, res) => {
  const parsed = z.object({ code: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(120), priceKes: z.number().int().min(0).max(100000000), durationDays: z.number().int().min(1).max(3650), maxDevices: z.number().int().min(1).max(1000).nullable(), transactionHistoryDays: z.number().int().min(0).max(3650), active: z.boolean() }).strict().safeParse(req.body);
  if (!parsed.success) return failInput(res);
  const existing = await prisma.plan.findUnique({ where: { id: req.params.id }, select: planSelect }); if (!existing) return res.status(404).json({ error: "PLAN_NOT_FOUND" });
  try {
    const updated = await prisma.$transaction(async tx => {
      const plan = await tx.plan.update({ where: { id: existing.id }, data: parsed.data, select: planSelect });
      await audit(tx, req, { action: "PLAN_EDITED", targetType: "Plan", targetId: existing.id, metadata: { code: plan.code, name: plan.name, priceKes: plan.priceKes, durationDays: plan.durationDays, maxDevices: plan.maxDevices, transactionHistoryDays: plan.transactionHistoryDays, active: plan.active } });
      return plan;
    });
    res.json(updated);
  } catch (error: any) { if (error?.code === "P2002") return res.status(409).json({ error: "PLAN_CODE_CONFLICT" }); throw error; }
});
