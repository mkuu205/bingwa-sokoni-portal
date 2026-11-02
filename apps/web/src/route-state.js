const normalizePath = (path) => {
  const trimmed = String(path || "/").replace(/\/+$/, "");
  return trimmed || "/";
};

export function resolveRoute(path, role) {
  const pathname = normalizePath(path);

  if (role === "USER") {
    return pathname === "/admin" || pathname === "/admin/login" || pathname === "/login"
      ? { view: "redirect", to: "/" }
      : { view: "customer-dashboard" };
  }

  if (role === "ADMIN") {
    return pathname === "/admin"
      ? { view: "admin-dashboard" }
      : { view: "redirect", to: "/admin" };
  }

  if (role == null) {
    return pathname.startsWith("/admin")
      ? { view: "admin-login" }
      : { view: "customer-login" };
  }

  return { view: "invalid-session" };
}
