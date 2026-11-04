import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const app = read("../src/App.tsx");
const client = read("../src/api.ts");

test("browser client includes the HttpOnly refresh cookie, limits requests, and shares concurrent refresh", () => {
  assert.match(client, /credentials: "include"/);
  assert.match(client, /AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/);
  assert.match(client, /let refreshInFlight: Promise<boolean> \| null/);
  assert.match(client, /if \(!refreshInFlight\)/);
  assert.match(client, /response\.status !== 409/);
  assert.match(client, /attempt < 3/);
  assert.match(client, /response\.status === 401 && retryAfterRefresh/);
  assert.match(client, /bingwa:session-expired/);
});

test("normal login does not enter an OTP step; registration verification has a separate form", () => {
  assert.match(app, /registering \? "\/api\/auth\/register" : "\/api\/auth\/login"/);
  assert.match(app, /useState<"credentials" \| "registration-otp"/);
  assert.match(app, /\/api\/auth\/register\/verify/);
  assert.doesNotMatch(app, /\/api\/auth\/login\/verify|verifyLoginOtp|login-otp/);
});

test("PayHero purchase sends plan ID and idempotency key, unlocks after initiation, and polls terminal outcomes", () => {
  assert.match(app, /\/api\/billing\/subscriptions/);
  assert.match(app, /JSON\.stringify\(\{ planId, phoneNumber: billingPhone \|\| me\?\.phone \|\| "", idempotencyKey \}\)/);
  assert.match(app, /checkoutLock\.current/);
  assert.match(app, /finally \{\s*checkoutLock\.current = false; setBillingBusy\(false\); setBillingPlanSubmitting\(""\);\s*\}/);
  assert.match(app, /\/api\/billing\/payments\/\$\{encodeURIComponent\(trackedPayment\.id\)\}/);
  assert.match(app, /payment\.status === "FAILED" \|\| payment\.status === "REVERSED"/);
  assert.match(app, /awaitingVerifiedCallback/);
});

test("payment status polling has a timeout but retains a manual check while payment remains pending", () => {
  assert.match(app, /10 \* 60_000/);
  assert.match(app, /setPaymentPollingTimedOut\(true\)/);
  assert.match(app, /Check payment status/);
  assert.match(app, /No subscription is active until the verified PayHero callback completes/);
});
