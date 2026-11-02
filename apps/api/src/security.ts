import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "./env.js";

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
  return jwt.sign({ sub: user.id, role: user.role, typ: "user" }, env.JWT_SECRET, { expiresIn: "12h" });
}
export function verifyUserToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload & { sub: string; role: string; typ: string };
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
export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  if (req.auth?.role !== "ADMIN") return res.status(403).json({ error: "ADMIN_REQUIRED" });
  next();
}
