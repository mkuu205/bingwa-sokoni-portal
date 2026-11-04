import test from "node:test";
import assert from "node:assert/strict";
import { transitionSubscription } from "../dist/subscription-lifecycle.js";
import { loginRequirement } from "../dist/auth-policy.js";
import { verifiedSubscriptionDuration } from "../dist/billing-logic.js";

const now = new Date("2026-11-04T12:00:00.000Z");
const days = n => n * 24 * 60 * 60 * 1000;

test("admin activation starts now and applies the selected duration", () => {
  const state = transitionSubscription("activate", null, 30, now);
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.startsAt.toISOString(), now.toISOString());
  assert.equal(state.expiresAt.getTime(), now.getTime() + days(30));
});

test("extension stacks from the existing future expiry without changing activation date", () => {
  const start = new Date(now.getTime() - days(10));
  const expires = new Date(now.getTime() + days(5));
  const state = transitionSubscription("extend", { status: "ACTIVE", startsAt: start, expiresAt: expires }, 14, now);
  assert.equal(state.startsAt, start);
  assert.equal(state.expiresAt.getTime(), expires.getTime() + days(14));
});

test("renewal of an expired record begins from now and preserves the original activation date", () => {
  const start = new Date(now.getTime() - days(80));
  const state = transitionSubscription("renew", { status: "EXPIRED", startsAt: start, expiresAt: new Date(now.getTime() - days(2)) }, 30, now);
  assert.equal(state.status, "ACTIVE");
  assert.equal(state.startsAt, start);
  assert.equal(state.expiresAt.getTime(), now.getTime() + days(30));
});

test("deactivation changes status but preserves subscription dates", () => {
  const current = { status: "ACTIVE", startsAt: new Date(now.getTime() - days(2)), expiresAt: new Date(now.getTime() + days(28)) };
  const state = transitionSubscription("deactivate", current, undefined, now);
  assert.equal(state.status, "CANCELLED");
  assert.equal(state.startsAt, current.startsAt);
  assert.equal(state.expiresAt, current.expiresAt);
});

test("extension requires an existing record and durations are bounded", () => {
  assert.throws(() => transitionSubscription("extend", null, 7, now), /SUBSCRIPTION_NOT_FOUND/);
  assert.throws(() => transitionSubscription("activate", null, 0, now), /INVALID_SUBSCRIPTION_DURATION/);
  assert.throws(() => transitionSubscription("renew", null, 3651, now), /INVALID_SUBSCRIPTION_DURATION/);
});

test("verified users authenticate with password only and do not enter an OTP login step", () => {
  assert.equal(loginRequirement({ phoneVerifiedAt: now, suspendedAt: null }), "PASSWORD_ONLY");
});

test("only accounts that have not completed phone verification require registration OTP", () => {
  assert.equal(loginRequirement({ phoneVerifiedAt: null, suspendedAt: null }), "REGISTRATION_OTP");
  assert.equal(loginRequirement({ phoneVerifiedAt: null, suspendedAt: now }), "ACCOUNT_SUSPENDED");
});

test("verified PayHero purchase honors checkout price and duration even after the catalog changes", () => {
  const editedPlan = { id: "plan-1", active: false, priceKes: 999, durationDays: 2 };
  assert.equal(verifiedSubscriptionDuration(editedPlan, "plan-1", { priceKes: 100, durationDays: 30 }, 100), 30);
});

test("legacy pending PayHero purchases require the current active plan and matching amount", () => {
  const activePlan = { id: "plan-2", active: true, priceKes: 250, durationDays: 90 };
  assert.equal(verifiedSubscriptionDuration(activePlan, "plan-2", { planName: "Quarterly" }, 250), 90);
  assert.throws(() => verifiedSubscriptionDuration(activePlan, "plan-2", {}, 300), /SUBSCRIPTION_PLAN_VALIDATION_FAILED/);
});

test("captured PayHero terms with a mismatched price or invalid duration are rejected", () => {
  const plan = { id: "plan-3", active: true, priceKes: 100, durationDays: 30 };
  assert.throws(() => verifiedSubscriptionDuration(plan, "plan-3", { priceKes: 99, durationDays: 30 }, 100), /SUBSCRIPTION_PLAN_VALIDATION_FAILED/);
  assert.throws(() => verifiedSubscriptionDuration(plan, "plan-3", { priceKes: 100, durationDays: 0 }, 100), /SUBSCRIPTION_PLAN_VALIDATION_FAILED/);
});
