export type RouteDecision =
  | { view: "redirect"; to: string }
  | { view: "customer-dashboard" }
  | { view: "admin-dashboard" }
  | { view: "customer-login" }
  | { view: "admin-login" }
  | { view: "invalid-session" };

export function resolveRoute(path: string, role: string | null): RouteDecision;
