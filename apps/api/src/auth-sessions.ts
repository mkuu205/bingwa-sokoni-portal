export const REFRESH_COOKIE_NAME = "bingwa_refresh";
export const ACCESS_TOKEN_LIFETIME = "15m";
export const USER_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const ADMIN_SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
export const ROTATION_GRACE_MS = 20_000;

export function readRefreshCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== REFRESH_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

export function refreshCookieHeader(secret: string, maxAgeSeconds: number, production: boolean): string {
  const sameSite = production ? "None" : "Lax";
  const secure = production ? "; Secure" : "";
  return `${REFRESH_COOKIE_NAME}=${secret}; HttpOnly${secure}; SameSite=${sameSite}; Path=/api/auth; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;
}

export function clearRefreshCookieHeader(production: boolean): string {
  return refreshCookieHeader("", 0, production);
}

export function previousRefreshTokenInGrace(previousTokenAt: Date | null | undefined, now = Date.now()): boolean {
  return Boolean(previousTokenAt && now - previousTokenAt.getTime() >= 0 && now - previousTokenAt.getTime() <= ROTATION_GRACE_MS);
}

export function sessionLifetime(tokenType: "user" | "admin"): number {
  return tokenType === "admin" ? ADMIN_SESSION_LIFETIME_MS : USER_SESSION_LIFETIME_MS;
}
