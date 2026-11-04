export type TerminalPaymentStatus = "FAILED" | "REVERSED";

export function payHeroTerminalStatus(status: unknown): TerminalPaymentStatus | null {
  const normalized = String(status ?? "").trim().toUpperCase();
  if (["CANCELLED", "CANCELED", "FAILED"].includes(normalized)) return "FAILED";
  if (["REVERSED", "REFUNDED"].includes(normalized)) return "REVERSED";
  return null;
}

export function paymentReplayMatches(
  existing: { userId: string; purpose: string; amountKes: number },
  requested: { userId: string; purpose: string; amountKes: number },
): boolean {
  return existing.userId === requested.userId && existing.purpose === requested.purpose && existing.amountKes === requested.amountKes;
}
