export type LoginRequirement = "ACCOUNT_SUSPENDED" | "REGISTRATION_OTP" | "PASSWORD_ONLY";

export function loginRequirement(user: { suspendedAt: Date | null; phoneVerifiedAt: Date | null }): LoginRequirement {
  if (user.suspendedAt) return "ACCOUNT_SUSPENDED";
  return user.phoneVerifiedAt ? "PASSWORD_ONLY" : "REGISTRATION_OTP";
}
