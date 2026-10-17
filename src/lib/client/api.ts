/**
 * Browser-side fetch wrapper for same-origin API calls.
 *
 *  - always sends the session cookie (credentials: "same-origin")
 *  - attaches the CSRF token (x-csrf-token) to every state-changing request
 *  - raises a window event on 401 so the shell can drop back to the login screen
 *
 * The CSRF token is kept in module memory only (never localStorage); it is re-fetched from
 * /api/auth/session on every page load.
 */

export const CSRF_HEADER = "x-csrf-token";
export const UNAUTHORIZED_EVENT = "praxel:unauthorized";

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!SAFE_METHODS.has(method) && csrfToken && !headers.has(CSRF_HEADER)) {
    headers.set(CSRF_HEADER, csrfToken);
  }

  const response = await fetch(input, { ...init, method, headers, credentials: "same-origin" });

  if (response.status === 401 && typeof window !== "undefined" && !input.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return response;
}

export interface SessionInfo {
  authenticated: boolean;
  operatorId?: string;
  csrfToken?: string;
}

/** Loads the current session (and primes the CSRF token). Never throws; network failure => unauthenticated. */
export async function fetchSession(): Promise<SessionInfo> {
  try {
    const res = await apiFetch("/api/auth/session");
    const data = (await res.json()) as SessionInfo;
    if (data.authenticated && data.csrfToken) {
      setCsrfToken(data.csrfToken);
      return data;
    }
  } catch {
    // fall through
  }
  setCsrfToken(null);
  return { authenticated: false };
}

export interface LoginResult {
  ok: boolean;
  operatorId?: string;
  error?: string;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  try {
    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = (await res.json()) as { success?: boolean; operatorId?: string; csrfToken?: string; error?: string };
    if (res.ok && data.success && data.csrfToken) {
      setCsrfToken(data.csrfToken);
      return { ok: true, operatorId: data.operatorId };
    }
    return { ok: false, error: data.error || "Sign-in failed" };
  } catch {
    return { ok: false, error: "Unable to reach the server" };
  }
}

export async function logout(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
  } catch {
    // The cookie is HttpOnly; if the call failed the session will simply expire server-side.
  } finally {
    setCsrfToken(null);
  }
}
