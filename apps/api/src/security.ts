import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "./env.js";
import { prisma } from "./db.js";

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
export function hashPairingCode(code: string): string {
  return crypto.createHmac("sha256", env.PAIRING_CODE_PEPPER).update(code).digest("hex");
}
export function issueUserToken(user: { id: string; role: string }) {
  return jwt.sign({ sub: user.id, role: user.role, typ: "user" }, env.JWT_ACCESS_SECRET, { expiresIn: "12h" });
}
export function issueAdminToken(username: string) {
  return jwt.sign({ sub: username, role: "ADMIN", typ: "admin" }, env.JWT_ACCESS_SECRET, { expiresIn: "1h" });
}
export function verifyUserToken(token: string) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as jwt.JwtPayload & { sub: string; role: string; typ: string };
}
export interface AuthRequest extends Request { auth?: { userId: string; role: string } }
export function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "AUTH_REQUIRED" });
  try {
    const payload = verifyUserToken(header.slice(7));
    if (payload.typ !== "user" || !payload.sub) return res.status(401).json({ error: "INVALID_TOKEN" });
    req.auth = { userId: payload.sub, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: "INVALID_TOKEN" });
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
    if (payload.role !== "ADMIN" || payload.sub !== env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH) {
      return res.status(403).json({ error: "ADMIN_REQUIRED" });
    }
    req.auth = { userId: payload.sub, role: "ADMIN" };
    return next();
  }

  if (payload.typ !== "user" || !payload.sub) return res.status(401).json({ error: "INVALID_TOKEN" });
  if (payload.role !== "ADMIN") return res.status(403).json({ error: "ADMIN_REQUIRED" });
  try {
    const user = await prisma.user.findUnique({ where: { id: payload.sub }, select: { role: true } });
    if (!user || user.role !== "ADMIN") return res.status(403).json({ error: "ADMIN_REQUIRED" });
    req.auth = { userId: payload.sub, role: user.role };
    return next();
  } catch (error) {
    return next(error);
  }
}
