import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { ACCESS_TOKEN_LIFETIME } from "./auth-sessions.js";

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
export function hashPairingCode(code: string): string {
  return crypto.createHmac("sha256", env.PAIRING_CODE_PEPPER).update(code).digest("hex");
}
export function issueUserToken(user: { id: string; role: string }, sessionId: string) {
  return jwt.sign({ sub: user.id, role: user.role, typ: "user", sid: sessionId }, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_LIFETIME });
}
export function issueAdminToken(username: string, sessionId: string) {
  return jwt.sign({ sub: username, role: "ADMIN", typ: "admin", sid: sessionId }, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TOKEN_LIFETIME });
}
export function verifyUserToken(token: string) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & { sub: string; role: string; typ: string; sid: string };
}
export interface AuthRequest extends Request { auth?: { userId: string; role: string; tokenType: "user" | "admin"; sessionId: string }; requestId?: string }

async function validWebSession(payload: ReturnType<typeof verifyUserToken>, tokenType: "user" | "admin") {
  if (!payload.sid) return null;
  const session = await prisma.webSession.findUnique({ where: { id: payload.sid } });
  if (!session || session.tokenType !== tokenType || session.revokedAt || session.expiresAt <= new Date()) return null;
  if (tokenType === "user" && session.userId !== payload.sub) return null;
  if (tokenType === "admin" && session.adminUsername !== payload.sub) return null;
  return session;
}
export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "AUTH_REQUIRED" });
  let payload: ReturnType<typeof verifyUserToken>;
  try {
    payload = verifyUserToken(header.slice(7));
  } catch {
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }
  if (payload.typ !== "user" || !payload.sub || !payload.sid) return res.status(401).json({ error: "INVALID_TOKEN" });
  try {
    const session = await validWebSession(payload, "user");
    if (!session) return res.status(401).json({ error: "SESSION_EXPIRED" });
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { id: true, role: true, suspendedAt: true } });
    if (!user) return res.status(401).json({ error: "INVALID_TOKEN" });
    if (user.suspendedAt) return res.status(403).json({ error: "ACCOUNT_SUSPENDED" });
    req.auth = { userId: user.id, role: user.role, tokenType: "user", sessionId: session.id };
    return next();
  } catch (error) {
    return next(error);
  }
}
export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "AUTH_REQUIRED" });

  let payload: ReturnType<typeof verifyUserToken>;
  try {
    payload = verifyUserToken(header.slice(7));
  } catch {
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }

  if (payload.typ === "admin") {
    try {
      if (!payload.sid || !(await validWebSession(payload, "admin"))) return res.status(401).json({ error: "SESSION_EXPIRED" });
      if (payload.role !== "ADMIN" || payload.sub !== env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH) {
        return res.status(403).json({ error: "ADMIN_REQUIRED" });
      }
      req.auth = { userId: payload.sub, role: "ADMIN", tokenType: "admin", sessionId: payload.sid };
      return next();
    } catch (error) {
      return next(error);
    }
  }

  if (payload.typ !== "user" || !payload.sub || !payload.sid) return res.status(401).json({ error: "INVALID_TOKEN" });
  if (payload.role !== "ADMIN") return res.status(403).json({ error: "ADMIN_REQUIRED" });
  try {
    const session = await validWebSession(payload, "user");
    if (!session) return res.status(401).json({ error: "SESSION_EXPIRED" });
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { role: true, suspendedAt: true } });
    if (!user || user.role !== "ADMIN") return res.status(403).json({ error: "ADMIN_REQUIRED" });
    if (user.suspendedAt) return res.status(403).json({ error: "ACCOUNT_SUSPENDED" });
    req.auth = { userId: payload.sub, role: user.role, tokenType: "user", sessionId: session.id };
    return next();
  } catch (error) {
    return next(error);
  }
}
