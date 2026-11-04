import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationPath = new URL("../prisma/migrations/20261104110000_seed_subscription_plan_catalogue/migration.sql", import.meta.url);
const sql = readFileSync(fileURLToPath(migrationPath), "utf8");
const server = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
const apiPackage = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

test("plan catalogue migration inserts the configured Starter, Pro, and Unlimited plans", () => {
  assert.match(sql, /'STARTER', 'Starter', 80, 30, 2, 3, TRUE/);
  assert.match(sql, /'PRO', 'Pro', 180, 30, 5, 7, TRUE/);
  assert.match(sql, /'UNLIMITED', 'Unlimited', 350, 30, NULL, 7, TRUE/);
});

test("plan catalogue migration is idempotent and preserves existing terms", () => {
  assert.match(sql, /ON CONFLICT \("code"\) DO UPDATE/);
  const conflictUpdate = sql.split(/ON CONFLICT \("code"\) DO UPDATE/i)[1];
  assert.match(conflictUpdate, /SET "name" = EXCLUDED\."name"/);
  assert.match(conflictUpdate, /"active" = TRUE/);
  assert.doesNotMatch(conflictUpdate, /"(?:priceKes|durationDays|maxDevices|transactionHistoryDays)"\s*=/);
});

test("the shared plans endpoint returns active database plans in a stable order", () => {
  assert.match(server, /app\.get\("\/api\/plans", async \(_req, res\) => \{\s*res\.json\(await prisma\.plan\.findMany\(\{ where: \{ active: true \}, orderBy: \[\{ priceKes: "asc" \}, \{ code: "asc" \}\] \}\)\);/);
});

test("API startup and db:deploy run the guarded migration bootstrap", () => {
  assert.match(apiPackage.scripts.start, /deploy-migrations\.mjs/);
  assert.match(apiPackage.scripts["db:deploy"], /deploy-migrations\.mjs/);
});
