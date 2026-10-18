import { apiFetch } from "@/lib/client/api";
import type { ApiEnvelope } from "./types";

/** Calls a JSON API route and unwraps `{ success, data }`; throws an Error with the server's message on failure. */
export async function fetchApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(url, init);
  let body: ApiEnvelope<T> | null = null;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    body = null;
  }
  if (!res.ok || !body || !body.success || body.data === undefined) {
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return body.data;
}
