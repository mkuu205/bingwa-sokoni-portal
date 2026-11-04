-- Populate missing subscription catalogue records without duplicating codes or overwriting
-- administrator-configured prices, durations, device limits, or history limits.
INSERT INTO "Plan" (
  "id", "code", "name", "priceKes", "durationDays", "maxDevices",
  "transactionHistoryDays", "active", "createdAt", "updatedAt"
) VALUES
  ('plan_catalogue_starter', 'STARTER', 'Starter', 80, 30, 2, 3, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_catalogue_pro', 'PRO', 'Pro', 180, 30, 5, 7, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('plan_catalogue_unlimited', 'UNLIMITED', 'Unlimited', 350, 30, NULL, 7, TRUE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO UPDATE
SET "name" = EXCLUDED."name",
    "active" = TRUE,
    "updatedAt" = CURRENT_TIMESTAMP;
