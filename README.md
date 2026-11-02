# Bingwa Sokoni Portal — full source project

Target domain: `portal.bingwasokoni.top`.

Contains the React/TypeScript frontend, Express API, PostgreSQL/Prisma schema, Android-compatible device pairing and sync endpoints, transaction projections, command queue safeguards, subscription model, admin overview, and Simple/Advanced plan view/editor.

## Critical Android boundary
The phone remains the USSD execution engine. The currently uploaded Android `PortalDataPlan` contract uploads a subset of plan fields and is read-only. This portal stores phone-reported snapshots and versioned portal edits, but **two-way application of portal edits requires a matching Android update** that downloads, validates, applies and acknowledges desired plan versions. Until then, edits are marked `PENDING_SYNC` and must not be relied on for live purchases. Live PayHero payments and phone OTP are not enabled by default; high-risk remote USSD/purchase commands remain blocked.

## Local setup
Requirements: Node.js 20+, npm 10+, Docker Compose. Copy `.env.example` to `.env`, replace secrets, run `docker compose up -d db`, `npm install`, `npm run db:generate`, `npm run db:migrate`, `npm run db:seed`, then `npm run dev`. Web is at `http://localhost:5173`; API health at `http://localhost:4000/health`.

## Deployment
Deploy API with managed PostgreSQL; deploy `apps/web` as a Vite static site. The Render API start command runs `prisma migrate deploy` before launching the server, so committed migrations are applied before requests are served. Set Vercel `VITE_API_BASE_URL` to `https://bingwa-sokoni-portal.onrender.com` and Render `WEB_ORIGIN` to `https://portal.bingwasokoni.top`; configure DNS with the frontend provider. Configure Android `PORTAL_API_BASE_URL` in a compatible app build.

### Administrator access

The customer portal is served at `/` and `/login`; the administrator login and dashboard are at `/admin`. Render must have `JWT_ACCESS_SECRET` set to a random secret of at least 32 characters, `ADMIN_USERNAME=kish`, and `ADMIN_PASSWORD_HASH` set to a bcrypt hash (cost 12 or higher) of the bootstrap password. Keep the hash in Render's secret environment settings; never commit the password or hash. To generate a hash locally without echoing the entered password, run `read -s -p 'Admin password: ' ADMIN_INPUT; printf '\n'; ADMIN_INPUT="$ADMIN_INPUT" node -e 'require("bcryptjs").hash(process.env.ADMIN_INPUT, 12).then(console.log)'; unset ADMIN_INPUT` from the repository after installing dependencies, then put the printed hash in Render as `ADMIN_PASSWORD_HASH`. The supplied bootstrap password is weak: use it only for initial access and replace the hash with one for a strong, unique password before production. Password rotation is done by replacing `ADMIN_PASSWORD_HASH` in Render and redeploying. The Render API service also requires `DATABASE_URL`, `PAIRING_CODE_PEPPER` (at least 24 characters), and `WEB_ORIGIN`.

## Before production
Configure phone OTP and password recovery, verified PayHero callbacks, backups, rate limiting, monitoring, security review, and Android desired-plan download/apply/acknowledge. Test pairing, revocation, offline/expired commands and version conflicts on a non-production phone. Do not enable remote financial or USSD commands before end-to-end device tests.


### Device linking

Portal device linking uses a single 8-digit one-time code; no separate pairing secret is shown or entered. The code expires after the configured TTL (5 minutes by default) and is consumed once. After a valid pairing, the server issues a device token to the Android app for background API authentication; users do not need to copy or manage that token. The companion Android source update removes the secret field and submits only the code. Both projects still need a successful build and live pairing test before production linking.
