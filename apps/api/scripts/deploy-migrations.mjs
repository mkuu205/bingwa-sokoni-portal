import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const apiDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselineMigration = "20261102190000_initial_schema";
const baselineMigrationFile = path.join(
  apiDirectory,
  "prisma",
  "migrations",
  baselineMigration,
  "migration.sql",
);

function runPrisma(args) {
  const result = spawnSync("prisma", args, {
    cwd: apiDirectory,
    env: process.env,
    encoding: "utf8",
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(`Could not run Prisma CLI: ${result.error.message}`);

  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function parseBaseline(sql) {
  const tables = new Map();
  const createTable = /CREATE TABLE "([^"]+)" \(([\s\S]*?)\);/g;

  for (const match of sql.matchAll(createTable)) {
    const [, tableName, definition] = match;
    const columns = [...definition.matchAll(/^\s+"([^"]+)"\s+/gm)].map(
      ([, columnName]) => columnName,
    );
    tables.set(tableName, columns);
  }

  const enums = new Map();
  const createEnum = /CREATE TYPE "([^"]+)" AS ENUM \(([^)]+)\);/g;
  for (const [, enumName, definition] of sql.matchAll(createEnum)) {
    const values = [...definition.matchAll(/'((?:[^']|'')*)'/g)].map(([, value]) => value);
    enums.set(enumName, values);
  }

  if (tables.size === 0 || enums.size === 0) {
    throw new Error(`Could not parse baseline migration at ${baselineMigrationFile}`);
  }

  return { tables, enums };
}

async function assertExistingSchemaMatchesBaseline() {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    const sql = await readFile(baselineMigrationFile, "utf8");
    const expected = parseBaseline(sql);
    const actualColumns = await prisma.$queryRaw`
      SELECT table_name AS "tableName", column_name AS "columnName"
      FROM information_schema.columns
      WHERE table_schema = current_schema()
    `;
    const actualEnums = await prisma.$queryRaw`
      SELECT t.typname AS "enumName", e.enumlabel AS "enumValue"
      FROM pg_type AS t
      JOIN pg_namespace AS n ON n.oid = t.typnamespace
      JOIN pg_enum AS e ON e.enumtypid = t.oid
      WHERE n.nspname = current_schema() AND t.typtype = 'e'
    `;

    const columnsByTable = new Map();
    for (const { tableName, columnName } of actualColumns) {
      if (!columnsByTable.has(tableName)) columnsByTable.set(tableName, new Set());
      columnsByTable.get(tableName).add(columnName);
    }

    const enumValuesByName = new Map();
    for (const { enumName, enumValue } of actualEnums) {
      if (!enumValuesByName.has(enumName)) enumValuesByName.set(enumName, new Set());
      enumValuesByName.get(enumName).add(enumValue);
    }
    const missingTablesOrColumns = [];
    for (const [tableName, expectedColumns] of expected.tables) {
      const actualTableColumns = columnsByTable.get(tableName);
      if (!actualTableColumns) {
        missingTablesOrColumns.push(`${tableName} (table missing)`);
        continue;
      }

      for (const columnName of expectedColumns) {
        if (!actualTableColumns.has(columnName)) {
          missingTablesOrColumns.push(`${tableName}.${columnName}`);
        }
      }
    }

    const missingEnums = [];
    for (const [enumName, expectedValues] of expected.enums) {
      const actualValues = enumValuesByName.get(enumName);
      if (!actualValues) {
        missingEnums.push(`${enumName} (type missing)`);
        continue;
      }

      for (const enumValue of expectedValues) {
        if (!actualValues.has(enumValue)) missingEnums.push(`${enumName}.${enumValue}`);
      }
    }
    if (missingTablesOrColumns.length > 0 || missingEnums.length > 0) {
      const details = [
        ...missingTablesOrColumns.map((entry) => `  - ${entry}`),
        ...missingEnums.map((entry) => `  - enum ${entry}`),
      ].join("\n");
      throw new Error(
        `The existing database does not match the initial Prisma migration; refusing to baseline it. Missing:\n${details}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const deploy = runPrisma(["migrate", "deploy"]);
  if (deploy.status === 0) return;

  if (!deploy.output.includes("P3005")) {
    process.exitCode = deploy.status;
    return;
  }

  console.log(
    `Existing database detected without Prisma migration history. Validating against ${baselineMigration} before baselining...`,
  );
  await assertExistingSchemaMatchesBaseline();

  const resolve = runPrisma(["migrate", "resolve", "--applied", baselineMigration]);
  if (resolve.status !== 0) {
    process.exitCode = resolve.status;
    return;
  }

  const followUpDeploy = runPrisma(["migrate", "deploy"]);
  if (followUpDeploy.status !== 0) process.exitCode = followUpDeploy.status;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
