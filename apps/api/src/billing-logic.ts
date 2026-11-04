export type BillingPlanTerms = { id: string; active: boolean; priceKes: number; durationDays: number };

/** Returns the duration paid for, validating captured checkout terms or legacy current-plan terms. */
export function verifiedSubscriptionDuration(
  plan: BillingPlanTerms | null,
  paymentPlanId: string,
  details: Record<string, unknown>,
  amountKes: number
): number {
  if (!plan || plan.id !== paymentPlanId) throw new Error("SUBSCRIPTION_PLAN_VALIDATION_FAILED");
  const hasCapturedTerms = Object.prototype.hasOwnProperty.call(details, "priceKes") || Object.prototype.hasOwnProperty.call(details, "durationDays");
  if (hasCapturedTerms) {
    const price = Number(details.priceKes);
    const duration = Number(details.durationDays);
    if (!Number.isInteger(duration) || duration < 1 || duration > 3650 || price !== amountKes) {
      throw new Error("SUBSCRIPTION_PLAN_VALIDATION_FAILED");
    }
    return duration;
  }
  if (!plan.active || plan.priceKes !== amountKes || !Number.isInteger(plan.durationDays) || plan.durationDays < 1) {
    throw new Error("SUBSCRIPTION_PLAN_VALIDATION_FAILED");
  }
  return plan.durationDays;
}
