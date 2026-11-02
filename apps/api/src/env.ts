import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  PAIRING_CODE_PEPPER: z.string().min(24),
  PAIRING_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  DEVICE_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(365),
  COMMAND_DEFAULT_TTL_SECONDS: z.coerce.number().int().positive().default(300)
});
export const env = schema.parse(process.env);
