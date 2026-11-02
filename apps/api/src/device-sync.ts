import { Router } from "express";
import { z } from "zod";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { hashPairingCode, randomSecret, sha256 } from "./security.js";

export const deviceSyncRouter = Router();

const t = (name: string) => z.object({ json: z.unknown().optional() }).passthrough();
function unwrap(body: unknown): any {
  if (!body || typeof body !== "object") return {};
  const b = body as any;
  return b.json ?? b;
}
function response(res: any, data: unknown) {
  return res.json({ result: { data: { json: data } } });
}
async function authDevice(input: any) {
  if (!input?.deviceId || !input?.deviceToken) return null;
  const device = await prisma.device.findUnique({ where: { id: String(input.deviceId) } });
  if (!device || device.revokedAt || device.status === "REVOKED") return null;
  if (device.deviceKeyHash !== sha256(String(input.deviceToken))) return null;
  return device;
}

deviceSyncRouter.post("/pairDevice", async (req, res) => {
  const input = unwrap(req.body);
  const parsed = z.object({
    code: z.string().regex(/^[0-9]{8}$/),
    device: z.object({
      deviceId: z.string().optional(),
      deviceName: z.string().min(1).max(120).optional(),
      model: z.string().max(120).optional(),
      manufacturer: z.string().max(120).optional(),
      androidVersion: z.string().max(80).optional(),
      appVersion: z.string().max(80).optional(),
      appBuild: z.string().max(80).optional(),
      phoneNumber: z.string().max(40).optional()
    }).passthrough().default({})
  }).safeParse(input);
  if (!parsed.success) return response(res, { accepted: false, reason: "INVALID_PAIRING_REQUEST" });

  const codeHash = hashPairingCode(parsed.data.code.trim().toUpperCase());
  const pairing = await prisma.pairingCode.findUnique({ where: { codeHash }, include: { user: { include: { subscriptions: { include: { plan: true } } } } } });
  if (!pairing || pairing.consumedAt || pairing.expiresAt <= new Date()) {
    return response(res, { accepted: false, reason: "PAIRING_CODE_INVALID_OR_EXPIRED" });
  }
  const activeSub = pairing.user.subscriptions.find(s => s.status === "ACTIVE" && s.expiresAt && s.expiresAt > new Date());
  if (!activeSub) return response(res, { accepted: false, reason: "ACTIVE_SUBSCRIPTION_REQUIRED" });
  const maxDevices = activeSub.plan.maxDevices;
  const deviceCount = await prisma.device.count({ where: { userId: pairing.userId, revokedAt: null, status: { not: "REVOKED" } } });
  if (maxDevices !== null && deviceCount >= maxDevices) return response(res, { accepted: false, reason: "DEVICE_LIMIT_REACHED" });

  const deviceToken = randomSecret(36);
  const device = await prisma.$transaction(async tx => {
    // Atomic conditional consumption prevents two concurrent requests from redeeming one code.
    const consumed = await tx.pairingCode.updateMany({
      where: { id: pairing.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() }
    });
    if (consumed.count !== 1) return null;
    return tx.device.create({
      data: {
        userId: pairing.userId,
        deviceName: parsed.data.device.deviceName ?? parsed.data.device.model ?? "Bingwa Android device",
        deviceKeyHash: sha256(deviceToken),
        status: "ONLINE",
        model: parsed.data.device.model,
        manufacturer: parsed.data.device.manufacturer,
        androidVersion: parsed.data.device.androidVersion,
        appVersion: parsed.data.device.appVersion,
        phoneNumber: parsed.data.device.phoneNumber,
        lastSeenAt: new Date()
      }
    });
  });
  if (!device) return response(res, { accepted: false, reason: "PAIRING_CODE_INVALID_OR_EXPIRED" });
  return response(res, { accepted: true, deviceId: device.id, deviceToken });
});

deviceSyncRouter.post("/heartbeat", async (req, res) => {
  const input = unwrap(req.body);
  const device = await authDevice(input);
  if (!device) return response(res, { accepted: false, reason: "DEVICE_AUTH_FAILED" });
  const snap = input.device ?? {};
  const recentTransactions = Array.isArray(input.transactions) ? input.transactions.slice(0, 100) : [];
  await prisma.$transaction(async tx => {
    await tx.device.update({
      where: { id: device.id },
      data: {
        status: "ONLINE",
        lastSeenAt: new Date(),
        deviceName: typeof snap.deviceName === "string" ? snap.deviceName.slice(0, 120) : device.deviceName,
        appVersion: snap.appVersion ?? device.appVersion,
        model: snap.model ?? device.model,
        manufacturer: snap.manufacturer ?? device.manufacturer,
        androidVersion: snap.androidVersion ?? device.androidVersion,
        phoneNumber: snap.phoneNumber ?? device.phoneNumber,
        simSlot: Number.isInteger(snap.simSlot) ? snap.simSlot : device.simSlot,
        carrierName: snap.carrierName ?? device.carrierName,
        automationEnabled: Boolean(snap.automationEnabled),
        executionState: typeof snap.executionState === "string" ? snap.executionState.slice(0, 40) : "IDLE",
        lastHeartbeat: { ...snap, operationalStatus: input.operationalStatus ?? null }
      }
    });
    const incomingPlans = Array.isArray(input.dataPlans) ? input.dataPlans.slice(0, 500) : [];
    for (const row of incomingPlans) {
      if (!row || typeof row !== "object" || row.androidPlanId == null || !row.packageName || !row.ussdCode) continue;
      const androidPlanId = String(row.androidPlanId).slice(0, 80);
      const current = await tx.portalDataPlan.findUnique({ where: { deviceId_androidPlanId: { deviceId: device.id, androidPlanId } } });
      const snapshot = {
        androidPlanId, packageName: String(row.packageName).slice(0,160), description: String(row.description ?? "").slice(0,500),
        ussdCode: String(row.ussdCode).slice(0,300), ussdSteps: row.ussdSteps == null ? null : String(row.ussdSteps).slice(0,2000),
        priceKes: Math.max(0, Number(row.price) || 0), validity: String(row.validity ?? "").slice(0,100),
        dataAmount: String(row.dataAmount ?? "").slice(0,100), category: String(row.category ?? "OTHER").slice(0,80),
        isActive: Boolean(row.isActive), commissionPerSale: Math.max(0, Number(row.commissionPerSale) || 0),
        executeSim: Number.isInteger(row.executeSim) ? row.executeSim : -1,
        ussdMode: String(row.ussdMode ?? "SIMPLE").toUpperCase() === "ADVANCED" ? "ADVANCED" : "SIMPLE",
        source: String(row.source ?? "SYSTEM").slice(0,80)
      };
      if (!current) {
        await tx.portalDataPlan.create({ data: { userId: device.userId, deviceId: device.id, androidPlanId, packageName: snapshot.packageName, description: snapshot.description, ussdCode: snapshot.ussdCode, ussdSteps: snapshot.ussdSteps, priceKes: snapshot.priceKes, validity: snapshot.validity, dataAmount: snapshot.dataAmount, category: snapshot.category, isActive: snapshot.isActive, commissionPerSale: snapshot.commissionPerSale, executeSim: snapshot.executeSim, ussdMode: snapshot.ussdMode, source: snapshot.source, deviceSnapshot: snapshot as any, desiredConfig: null, syncStatus: "SYNCED", lastDeviceSyncAt: new Date() } });
      } else {
        await tx.portalDataPlan.update({ where: { id: current.id }, data: { deviceSnapshot: snapshot as any, lastDeviceSyncAt: new Date(), ...(current.syncStatus === "PENDING_SYNC" ? {} : { packageName: snapshot.packageName, description: snapshot.description, ussdCode: snapshot.ussdCode, ussdSteps: snapshot.ussdSteps, priceKes: snapshot.priceKes, validity: snapshot.validity, dataAmount: snapshot.dataAmount, category: snapshot.category, isActive: snapshot.isActive, commissionPerSale: snapshot.commissionPerSale, executeSim: snapshot.executeSim, ussdMode: snapshot.ussdMode, source: snapshot.source, syncStatus: "SYNCED" }) } });
      }
    }
    for (const row of recentTransactions) {
      if (!row || typeof row !== "object" || !row.phoneNumber || !row.packageName || !row.androidTransactionId) continue;
      const androidTransactionId = String(row.androidTransactionId).slice(0, 160);
      await tx.portalTransaction.upsert({
        where: { deviceId_androidTransactionId: { deviceId: device.id, androidTransactionId } },
        create: {
          deviceId: device.id, androidTransactionId,
          executionId: row.executionId ? String(row.executionId).slice(0, 160) : null,
          operationId: row.operationId ? String(row.operationId).slice(0, 160) : null,
          customerName: row.customerName ? String(row.customerName).slice(0, 160) : null,
          phoneNumber: String(row.phoneNumber).slice(0, 40),
          packageName: String(row.packageName).slice(0, 160),
          amountKes: Math.max(0, Number(row.amount) || 0),
          paymentMethod: row.paymentMethod ? String(row.paymentMethod).slice(0, 60) : null,
          status: normalizeTransactionStatus(row.status),
          verificationStatus: row.verificationStatus ? String(row.verificationStatus).slice(0, 60) : null,
          verificationMessage: row.verificationMessage ? String(row.verificationMessage).slice(0, 500) : null,
          receiptCode: row.receiptCode ? String(row.receiptCode).slice(0, 100) : null,
          issue: row.issue ? String(row.issue).slice(0, 500) : null,
          executedAt: row.executedAt ? safeDate(row.executedAt) : null,
          lastSyncedAt: new Date()
        },
        update: {
          status: normalizeTransactionStatus(row.status),
          verificationStatus: row.verificationStatus ? String(row.verificationStatus).slice(0, 60) : null,
          verificationMessage: row.verificationMessage ? String(row.verificationMessage).slice(0, 500) : null,
          receiptCode: row.receiptCode ? String(row.receiptCode).slice(0, 100) : null,
          issue: row.issue ? String(row.issue).slice(0, 500) : null,
          lastSyncedAt: new Date()
        }
      });
    }
  });
  const queued = await prisma.deviceCommand.findMany({
    where: { deviceId: device.id, status: "QUEUED", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" }, take: 20
  });
  return response(res, { accepted: true, receivedAt: new Date().toISOString(), commandIds: queued.map(c => c.id) });
});

deviceSyncRouter.post("/pollCommands", async (req, res) => {
  const input = unwrap(req.body);
  const device = await authDevice(input);
  if (!device) return response(res, { accepted: false, reason: "DEVICE_AUTH_FAILED", commands: [] });
  const now = new Date();
  await prisma.deviceCommand.updateMany({
    where: { deviceId: device.id, status: "QUEUED", expiresAt: { lte: now } },
    data: { status: "EXPIRED" }
  });
  const commands = await prisma.$transaction(async tx => {
    const queued = await tx.deviceCommand.findMany({
      where: { deviceId: device.id, status: "QUEUED", expiresAt: { gt: now } },
      orderBy: { createdAt: "asc" }, take: 10
    });
    const result = [];
    for (const cmd of queued) {
      const changed = await tx.deviceCommand.updateMany({
        where: { id: cmd.id, status: "QUEUED" },
        data: { status: "DELIVERED", deliveredAt: now }
      });
      if (changed.count) result.push({ id: cmd.id, commandType: cmd.commandType, payload: cmd.payload, expiresAt: cmd.expiresAt.toISOString() });
    }
    return result;
  });
  return response(res, { accepted: true, commands });
});

deviceSyncRouter.post("/reportCommand", async (req, res) => {
  const input = unwrap(req.body);
  const device = await authDevice(input);
  if (!device) return response(res, { accepted: false, reason: "DEVICE_AUTH_FAILED" });
  const parsed = z.object({
    commandId: z.coerce.number().int().positive(),
    status: z.enum(["DELIVERED", "RECEIVED", "EXECUTING", "COMPLETED", "FAILED"]).optional(),
    resultMessage: z.string().max(1000).optional()
  }).safeParse(input);
  if (!parsed.success) return response(res, { accepted: false, reason: "INVALID_REPORT" });
  const command = await prisma.deviceCommand.findFirst({ where: { id: parsed.data.commandId, deviceId: device.id } });
  if (!command) return response(res, { accepted: false, reason: "COMMAND_NOT_FOUND" });
  const status = parsed.data.status === "RECEIVED" ? "DELIVERED" : (parsed.data.status ?? "DELIVERED");
  if (["COMPLETED", "FAILED"].includes(command.status) && status !== command.status) {
    return response(res, { accepted: false, reason: "COMMAND_ALREADY_TERMINAL" });
  }
  const update: any = { status };
  if (status === "EXECUTING") update.startedAt = new Date();
  if (status === "COMPLETED" || status === "FAILED") update.completedAt = new Date();
  if (parsed.data.resultMessage) { update.result = { message: parsed.data.resultMessage }; if (status === "FAILED") update.errorMessage = parsed.data.resultMessage; }
  await prisma.deviceCommand.update({ where: { id: command.id }, data: update });
  return response(res, { accepted: true });
});

function safeDate(value: unknown): Date | null {
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}
function normalizeTransactionStatus(value: unknown): any {
  const s = String(value ?? "").toUpperCase();
  if (s.includes("COMPLETE") || s === "SUCCESS" || s === "SUCCESSFUL") return "COMPLETED";
  if (s.includes("FAIL") || s === "ERROR") return "FAILED";
  if (s.includes("PROCESS")) return "PROCESSING";
  if (s.includes("PENDING") || s === "QUEUED") return "PENDING";
  if (s.includes("RECEIV")) return "RECEIVED";
  return "UNKNOWN";
}
