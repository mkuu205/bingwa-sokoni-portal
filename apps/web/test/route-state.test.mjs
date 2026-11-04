import test from "node:test";
import assert from "node:assert/strict";
import { resolveRoute } from "../src/route-state.js";

test("unauthenticated visitors see customer login at root and login path", () => {
  assert.deepEqual(resolveRoute("/", null), { view: "customer-login" });
  assert.deepEqual(resolveRoute("/login", null), { view: "customer-login" });
});

test("customers stay in the customer dashboard and cannot enter admin routes", () => {
  assert.deepEqual(resolveRoute("/", "USER"), { view: "customer-dashboard" });
  assert.deepEqual(resolveRoute("/login", "USER"), { view: "redirect", to: "/" });
  assert.deepEqual(resolveRoute("/admin", "USER"), { view: "redirect", to: "/" });
});

test("administrators are directed to the protected admin dashboard", () => {
  assert.deepEqual(resolveRoute("/admin", "ADMIN"), { view: "admin-dashboard" });
  assert.deepEqual(resolveRoute("/", "ADMIN"), { view: "redirect", to: "/admin" });
  assert.deepEqual(resolveRoute("/login", "ADMIN"), { view: "redirect", to: "/admin" });
});

test("unauthenticated admin paths show admin login without redirect loops", () => {
  assert.deepEqual(resolveRoute("/admin", null), { view: "admin-login" });
  assert.deepEqual(resolveRoute("/admin/login", null), { view: "admin-login" });
});

test("unknown roles are invalid and trailing slashes normalize", () => {
  assert.deepEqual(resolveRoute("/admin/", "OWNER"), { view: "invalid-session" });
  assert.deepEqual(resolveRoute("/login/", "USER"), { view: "redirect", to: "/" });
  assert.deepEqual(resolveRoute("///", null), { view: "customer-login" });
});
