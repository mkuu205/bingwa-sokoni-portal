export type SubscriptionAction = "activate" | "extend" | "renew" | "deactivate";
export type SubscriptionStatus = "ACTIVE" | "EXPIRED" | "CANCELLED" | "PENDING";

export type SubscriptionState = {
  status: SubscriptionStatus;
  startsAt: Date | null;
  expiresAt: Date | null;
};

/** Apply lifecycle date semantics without touching persistence; callers serialize and audit the resulting update. */
export function transitionSubscription(
  action: SubscriptionAction,
  current: SubscriptionState | null,
  durationDays: number | undefined,
  now: Date
): SubscriptionState {
  if (action === "deactivate") {
    if (!current) throw new Error("SUBSCRIPTION_NOT_FOUND");
    return { status: "CANCELLED", startsAt: current.startsAt, expiresAt: current.expiresAt };
  }

  if (!durationDays || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) {
    throw new Error("INVALID_SUBSCRIPTION_DURATION");
  }
  if (action === "extend" && !current) throw new Error("SUBSCRIPTION_NOT_FOUND");

  if (action === "activate") {
    return { status: "ACTIVE", startsAt: now, expiresAt: new Date(now.getTime() + durationDays * 86400000) };
  }

  const base = current?.expiresAt && current.expiresAt > now ? current.expiresAt : now;
  return {
    status: "ACTIVE",
    startsAt: current?.startsAt ?? now,
    expiresAt: new Date(base.getTime() + durationDays * 86400000)
  };
}
