import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clearRefreshCookieHeader,
  previousRefreshTokenInGrace,
  readRefreshCookie,
  refreshCookieHeader,
  sessionLifetime
} from "../dist/auth-sessions.js";
import { paymentReplayMatches, payHeroTerminalStatus } from "../dist/billing-logic.js";

const file = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const server = file("../src/server.ts");
const security = file("../src/security.ts");
const schema = file("../prisma/schema.prisma");
const migration = file("../prisma/migrations/20261104120000_sessions_auth_payment_idempotency/migration.sql");

test("refresh cookie is HttpOnly, scoped, persistent, and Secure/SameSite=None in production", () => {
  const prod = refreshCookieHeader("opaque", 3600, true);
  assert.match(prod, /^bingwa_refresh=opaque;/);
  assert.match(prod, /HttpOnly/);
  assert.match(prod, /Secure/);
  assert.match(prod, /SameSite=None/);
  assert.match(prod, /Path=\/api\/auth/);
  assert.match(prod, /Max-Age=3600/);
  assert.match(clearRefreshCookieHeader(false), /Max-Age=0/);
  assert.equal(readRefreshCookie("a=b; bingwa_refresh=opaque; c=d"), "opaque");
  assert.equal(readRefreshCookie(undefined), null);
});

test("refresh-token concurrency grace and session lifetimes are bounded", () => {
  const now = 100_000;
  assert.equal(previousRefreshTokenInGrace(new Date(now - 10_000), now), true);
  assert.equal(previousRefreshTokenInGrace(new Date(now - 30_000), now), false);
  assert.equal(previousRefreshTokenInGrace(new Date(now + 1), now), false);
  assert.equal(sessionLifetime("user"), 30 * 24 * 60 * 60 * 1000);
  assert.equal(sessionLifetime("admin"), 8 * 60 * 60 * 1000);
});

test("password login is OTP-free while registration and password recovery retain purpose-bound OTP", () => {
  const login = server.match(/app\.post\("\/api\/auth\/login", async \(req, res\) => \{([\s\S]*?)\n\}\);/);
  assert.ok(login, "login route exists");
  assert.doesNotMatch(login[1], /createAndSendOtp|requiresOtp/);
  assert.match(login[1], /createUserSession/);
  assert.match(server, /createAndSendOtp\(phone, user\.id, "REGISTRATION"\)/);
  assert.match(server, /purpose: "PASSWORD_RESET"/);
  assert.match(server, /app\.post\("\/api\/auth\/register\/verify"/);
  assert.match(server, /app\.post\("\/api\/auth\/phone\/change\/request"/);
  assert.match(server, /app\.post\("\/api\/auth\/phone\/change\/verify"/);
});

test("sessions are persisted and access middleware rejects revoked sessions; logout/reset revoke server state", () => {
  assert.match(schema, /model WebSession \{/);
  assert.match(security, /validWebSession\(payload, "user"\)/);
  assert.match(security, /validWebSession\(payload, "admin"\)/);
  assert.match(server, /app\.post\("\/api\/auth\/refresh"/);
  assert.match(server, /One-time compatibility upgrade for still-valid access tokens/);
  assert.match(server, /if \(!payload\.sid && payload\.typ === "user"/);
  assert.match(server, /if \(!payload\.sid && payload\.typ === "admin"/);
  assert.match(server, /app\.post\("\/api\/auth\/logout"[\s\S]*?webSession\.updateMany/);
  assert.match(server, /webSession\.updateMany\(\{ where: \{ userId: challenge\.userId, revokedAt: null \}/);
});

test("session/payment migration is additive and does not reset account or payment data", () => {
  assert.match(migration, /CREATE TABLE "WebSession"/);
  assert.match(migration, /ADD COLUMN "idempotencyKey"/);
  assert.match(migration, /ADD VALUE IF NOT EXISTS 'REGISTRATION'/);
  assert.match(migration, /ADD VALUE IF NOT EXISTS 'PHONE_CHANGE'/);
  assert.doesNotMatch(migration, /\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|UPDATE "User")\b/i);
});

test("PayHero cancellation/failure/reversal are terminal, success stays callback-gated, and duplicate keys cannot change terms", () => {
  assert.equal(payHeroTerminalStatus("CANCELLED"), "FAILED");
  assert.equal(payHeroTerminalStatus("canceled"), "FAILED");
  assert.equal(payHeroTerminalStatus("FAILED"), "FAILED");
  assert.equal(payHeroTerminalStatus("REVERSED"), "REVERSED");
  assert.equal(payHeroTerminalStatus("REFUNDED"), "REVERSED");
  assert.equal(payHeroTerminalStatus("SUCCESS"), null);
  assert.equal(payHeroTerminalStatus("PENDING"), null);
  const terms = { userId: "u1", purpose: "SUBSCRIPTION:p1", amountKes: 180 };
  assert.equal(paymentReplayMatches(terms, { ...terms }), true);
  assert.equal(paymentReplayMatches(terms, { ...terms, amountKes: 350 }), false);
  assert.equal(paymentReplayMatches(terms, { ...terms, purpose: "SUBSCRIPTION:p2" }), false);
  assert.match(server, /if \(providerStatus !== "SUCCESS" \|\| statusData\.success === false\)/);
  assert.match(server, /verifyAndApplyPayHeroPayment\(externalReference, response\.Amount/);
  assert.match(server, /PAYHERO_CALLBACK_URL_NOT_CONFIGURED/);
});
