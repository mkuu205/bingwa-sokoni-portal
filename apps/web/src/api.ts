const API = (import.meta.env.VITE_API_BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 15_000;
const AUTH_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/register/verify",
  "/api/auth/admin/login",
  "/api/auth/refresh",
  "/api/auth/logout"
]);
let refreshInFlight: Promise<boolean> | null = null;
let refreshController: AbortController | null = null;

export function token() { return localStorage.getItem("bingwa_token"); }
export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

function emitSessionExpired() {
  localStorage.removeItem("bingwa_token");
  localStorage.removeItem("bingwa_admin_username");
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("bingwa:session-expired"));
}

async function refreshAccessToken(notifyExpired = true): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const controller = new AbortController();
      refreshController = controller;
      const timeout = window.setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), REQUEST_TIMEOUT_MS);
      try {
        const legacyAccessToken = token();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (legacyAccessToken) headers.Authorization = `Bearer ${legacyAccessToken}`;
        let response: Response | null = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          response = await fetch(`${API}/api/auth/refresh`, {
            method: "POST",
            credentials: "include",
            headers,
            signal: controller.signal
          });
          if (response.status !== 409 || attempt === 2) break;
          await new Promise(resolve => window.setTimeout(resolve, 100 * (attempt + 1)));
        }
        if (!response) return false;
        if (!response.ok) {
          if (notifyExpired && (response.status === 401 || response.status === 403)) emitSessionExpired();
          return false;
        }
        const data = await response.json();
        if (typeof data.token !== "string" || !data.token) return false;
        localStorage.setItem("bingwa_token", data.token);
        if (data.user?.role === "ADMIN" && data.user?.username) localStorage.setItem("bingwa_admin_username", data.user.username);
        else localStorage.removeItem("bingwa_admin_username");
        return true;
      } catch {
        // A transient network timeout must not destroy a potentially valid refresh cookie.
        return false;
      } finally {
        window.clearTimeout(timeout);
        if (refreshController === controller) refreshController = null;
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

export function restoreSessionFromCookie(): Promise<boolean> {
  return refreshAccessToken(false);
}

export function logoutSession(): void {
  refreshController?.abort();
  const accessToken = token();
  localStorage.removeItem("bingwa_token");
  localStorage.removeItem("bingwa_admin_username");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  void fetch(`${API}/api/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers,
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }).catch(() => undefined);
}

async function request<T>(path: string, init: RequestInit, retryAfterRefresh: boolean): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const currentToken = token();
  if (currentToken) headers.set("Authorization", `Bearer ${currentToken}`);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers,
      credentials: "include",
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") throw new ApiError("The request timed out. Please try again.", 408);
    throw error;
  }

  if (response.status === 401 && retryAfterRefresh && currentToken && !AUTH_PATHS.has(path)) {
    if (await refreshAccessToken()) return request<T>(path, init, false);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error || `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return data as T;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init, true);
}
