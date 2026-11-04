import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = relative => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
const customerApp = source("../src/App.tsx");
const adminPanel = source("../src/AdminPanel.tsx");

test("customer subscription and admin activation both load the shared plan API", () => {
  assert.match(customerApp, /api<BillingPlan\[]>\("\/api\/plans"\)/);
  assert.match(adminPanel, /api<Plan\[]>\("\/api\/plans"\)/);
  assert.doesNotMatch(adminPanel, /api<Plan\[]>\("\/api\/admin\/plans"\)/);
});

test("both plan pickers expose catalogue loading or failure feedback", () => {
  assert.match(customerApp, /Loading available subscription plans/);
  assert.match(customerApp, /billingPlansError/);
  assert.match(adminPanel, /Loading active plans from the shared catalogue/);
  assert.match(adminPanel, /activationPlansError/);
});
