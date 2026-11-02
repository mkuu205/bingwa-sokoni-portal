import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  ADMIN_USERNAME: z.string().min(1).max(80).default("kish"),
  ADMIN_PASSWORD_HASH: z.preprocess(
    value => value === "" ? undefined : value,
    z.string().regex(/^\$2[aby]\$(1[2-9]|2\d|3[01])\$[./A-Za-z0-9]{53}$/).optional()
  ),
  PAIRING_CODE_PEPPER: z.string().min(24),
  PAIRING_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  DEVICE_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(365),
  COMMAND_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(300)
});
// JWT_ACCESS_SECRET is canonical; JWT_SECRET remains a temporary fallback for existing Render deployments.
export const env = schema.parse({
  ...process.env,
  JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? process.env.JWT_SECRET
});
