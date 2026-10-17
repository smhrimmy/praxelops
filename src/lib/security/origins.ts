/**
 * Pure origin / host allowlist helpers (no I/O, no module state).
 *
 * Used by:
 *  - src/proxy.ts            -> Host allowlist (DNS-rebinding defense) for /api/*
 *  - security/auth.ts        -> Origin allowlist for state-changing requests (CSRF / cross-site POST defense)
 *
 * Every check is an EXACT string comparison against a normalized allowlist. There is
 * deliberately no prefix / suffix / wildcard logic anywhere in this file.
 */

export type EnvLike = Readonly<Record<string, string | undefined>>;

const DEFAULT_PORT = 3000;

/** Port the web app listens on (PORT env, default 3000). */
export function getAppPort(env: EnvLike = process.env): number {
  const raw = env.PORT?.trim();
  if (raw && /^\d{1,5}$/.test(raw)) {
    const port = Number(raw);
    if (port >= 1 && port <= 65535) return port;
  }
  return DEFAULT_PORT;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parses a full origin (scheme://host[:port]) into its canonical form, or undefined if it is not one. */
export function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Origins that may issue state-changing requests:
 *  - ALLOWED_ORIGINS (comma separated full origins, normalized through new URL(x).origin)
 *  - in non-production only: http://localhost:<port> and http://127.0.0.1:<port>
 */
export function getAllowedOrigins(env: EnvLike = process.env): string[] {
  const origins = new Set<string>();
  for (const entry of splitList(env.ALLOWED_ORIGINS)) {
    const normalized = normalizeOrigin(entry);
    if (normalized) origins.add(normalized);
  }
  if (env.NODE_ENV !== "production") {
    const port = getAppPort(env);
    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);
  }
  return Array.from(origins);
}

/** Exact match of an Origin request header against the allowlist. Missing / "null" never match. */
export function isAllowedOrigin(originHeader: string | null | undefined, env: EnvLike = process.env): boolean {
  if (typeof originHeader !== "string" || originHeader.length === 0) return false;
  return getAllowedOrigins(env).includes(originHeader);
}

/**
 * Hosts (the HTTP Host header value, including port when non-default) that may reach /api/*:
 *  - localhost:<port>, 127.0.0.1:<port>, [::1]:<port>
 *  - the host of every ALLOWED_ORIGINS entry
 *  - every ALLOWED_HOSTS entry (comma separated, exact host[:port])
 */
export function getAllowedHosts(env: EnvLike = process.env): string[] {
  const port = getAppPort(env);
  const hosts = new Set<string>([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  for (const entry of splitList(env.ALLOWED_ORIGINS)) {
    try {
      hosts.add(new URL(entry).host.toLowerCase());
    } catch {
      // ignore malformed entries
    }
  }
  for (const entry of splitList(env.ALLOWED_HOSTS)) {
    hosts.add(entry.toLowerCase());
  }
  return Array.from(hosts);
}

/** Exact (case-insensitive) match of the Host header against the allowlist. */
export function isAllowedHost(hostHeader: string | null | undefined, env: EnvLike = process.env): boolean {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
  return getAllowedHosts(env).includes(hostHeader.toLowerCase());
}
