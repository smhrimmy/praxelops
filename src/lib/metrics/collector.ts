import { SSHAdapter, SshExecError } from "@/lib/ssh/adapter";
import { KnownHostsService } from "@/lib/ssh/knownHosts";
import { StorageService } from "@/lib/storage";
import { VaultError } from "@/lib/security/vault";
import type { ServerHost } from "@/types/server";
import { DEFAULT_PROBE_TIMEOUT_MS, getRetentionHours } from "./config";
import { MAX_PROBE_OUTPUT_BYTES, parseProbeOutput } from "./parse";
import { PROBE_COMMAND } from "./probe";
import { recordSampleResult, type RecordResult } from "./store";
import type { SampleFailureReason, SampleOutcome } from "./types";

/**
 * Agentless sampling of one server over SSH.
 *
 * Safety rules enforced here (and tested):
 *  - only hosts whose key is ALREADY pinned are contacted: no pin => `host_key_not_pinned`, no connection is made
 *    and nothing is enrolled; the connection itself also uses the adapter's "pinned_only" policy, so even a race
 *    (pin removed between the check and the handshake) cannot enroll a key;
 *  - the only command ever sent is the fixed PROBE_COMMAND;
 *  - credentials are decrypted only inside this call and never appear in results, logs or audit details.
 */

export class ServerNotFoundError extends Error {
  constructor(serverId: string) {
    super(`Server ${serverId} not found`);
    this.name = "ServerNotFoundError";
  }
}

export interface SampleOptions {
  timeoutMs?: number;
}

const MAX_MESSAGE_CHARS = 300;

function clip(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= MAX_MESSAGE_CHARS ? single : `${single.slice(0, MAX_MESSAGE_CHARS - 3)}...`;
}

function failure(
  reason: SampleFailureReason,
  message: string,
  details?: { expectedFingerprint?: string; receivedFingerprint?: string }
): SampleOutcome {
  const outcome: SampleOutcome = { ok: false, reason, message: clip(message), collectedAt: new Date().toISOString() };
  return details === undefined ? outcome : { ...outcome, details };
}

export const HOST_KEY_NOT_PINNED_MESSAGE =
  "Host key not yet verified - open a terminal session to this server first so its host key can be pinned; metrics are never collected from an unverified host.";

function hasCredential(server: ServerHost): boolean {
  const record = server as unknown as Record<string, unknown>;
  return (
    (typeof record.password === "string" && record.password !== "") ||
    (typeof record.privateKey === "string" && record.privateKey !== "")
  );
}

/** Samples one server. Throws ServerNotFoundError if the id is unknown; every other failure is a typed result. */
export async function sampleServer(serverId: string, options: SampleOptions = {}): Promise<SampleOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  let server: ServerHost | undefined;
  try {
    server = StorageService.getServerById(serverId);
  } catch (err) {
    if (err instanceof VaultError) return failure("credential_error", `Stored credentials could not be decrypted: ${err.message}`);
    throw err;
  }
  if (server === undefined) throw new ServerNotFoundError(serverId);

  if (server.osType === "windows") {
    return failure("unsupported_os", "Server is declared as Windows: only Linux hosts are monitored");
  }
  if (!hasCredential(server)) {
    return failure("credential_error", "No stored password or private key is available for this server");
  }

  // Never TOFU-enroll from the collector: no pin means no connection at all.
  let pin;
  try {
    pin = KnownHostsService.getPin(server.host, server.port);
  } catch (err) {
    return failure("host_key_mismatch", `Stored host key for ${server.host}:${server.port} is unreadable: ${(err as Error).message}`);
  }
  if (pin === undefined) return failure("host_key_not_pinned", HOST_KEY_NOT_PINNED_MESSAGE);

  let result;
  try {
    result = await SSHAdapter.executeCommand(server, PROBE_COMMAND, timeoutMs, undefined, {
      hostKeyPolicy: "pinned_only",
      maxOutputBytes: MAX_PROBE_OUTPUT_BYTES,
    });
  } catch (err) {
    if (err instanceof SshExecError) {
      switch (err.kind) {
        case "timeout":
          return failure("timeout", `Probe timed out after ${timeoutMs}ms`);
        case "auth_failed":
          return failure("auth_failed", "SSH authentication failed");
        case "host_key_mismatch":
          return failure("host_key_mismatch", `Host key for ${server.host}:${server.port} does not match the pinned key`, {
            expectedFingerprint: err.expectedFingerprint,
            receivedFingerprint: err.receivedFingerprint,
          });
        case "host_key_not_pinned":
          return failure("host_key_not_pinned", HOST_KEY_NOT_PINNED_MESSAGE);
        case "output_limit":
          return failure("parse_error", "Probe output exceeded the size limit");
        case "exec_error":
          return failure("unreachable", err.message);
        case "unreachable":
          return failure("unreachable", err.message);
      }
    }
    return failure("unreachable", err instanceof Error ? err.message : String(err));
  }

  if (!result.stdout.includes("@@praxel:uname")) {
    const hint = result.stderr.trim() || result.stdout.trim();
    return failure("parse_error", `Probe produced no recognisable output (exit ${result.code})${hint ? `: ${hint}` : ""}`);
  }

  const parsed = parseProbeOutput(result.stdout);
  if (parsed.ok) return { ok: true, sample: parsed.sample, collectedAt: new Date().toISOString() };
  return failure(parsed.reason, parsed.message);
}

// ---------------------------------------------------------------------------------------------
// Sample + persist + audit transitions
// ---------------------------------------------------------------------------------------------

export interface CollectResult {
  outcome: SampleOutcome;
  record: RecordResult | null;
}

export interface CollectOptions extends SampleOptions {
  /** Audit actor for state-transition events (default "system:metrics-collector"). */
  actor?: string;
}

function isForeignKeyError(err: unknown): boolean {
  return err instanceof Error && /FOREIGN KEY constraint failed/i.test(err.message);
}

/**
 * Samples a server, stores the result and updates its health. A health-state TRANSITION (not every sample) is
 * written to the audit log in the same transaction; a host-key mismatch is a `security_alert`. Returns
 * `record: null` when the server was deleted while the probe was in flight (nothing is stored).
 */
export async function collectAndStore(serverId: string, options: CollectOptions = {}): Promise<CollectResult> {
  const actor = options.actor ?? "system:metrics-collector";
  const server = StorageService.getPublicServerById(serverId);
  if (!server) throw new ServerNotFoundError(serverId);

  const outcome = await sampleServer(serverId, options);

  try {
    const record = recordSampleResult(serverId, outcome, {
      retentionHours: getRetentionHours(),
      onTransition: ({ previousState, state }) => {
        // The very first observation of a healthy host is not news; anything else is.
        if (previousState === null && state === "reachable") return;
        if (outcome.ok) {
          StorageService.logAuditEvent({
            actor,
            eventType: "server_health_changed",
            targetServerId: server.id,
            targetServerName: server.name,
            status: "success",
            details: { previousState, state, host: server.host, port: server.port },
          });
        } else if (outcome.reason === "host_key_mismatch") {
          StorageService.logAuditEvent({
            actor,
            eventType: "security_alert",
            targetServerId: server.id,
            targetServerName: server.name,
            status: "denied",
            details: {
              alertType: "host_key_mismatch",
              source: "metrics_collector",
              previousState,
              host: server.host,
              port: server.port,
              expectedFingerprint: outcome.details?.expectedFingerprint,
              receivedFingerprint: outcome.details?.receivedFingerprint,
            },
          });
        } else {
          StorageService.logAuditEvent({
            actor,
            eventType: "server_health_changed",
            targetServerId: server.id,
            targetServerName: server.name,
            status: "failure",
            details: { previousState, state, reason: outcome.reason, message: outcome.message, host: server.host, port: server.port },
          });
        }
      },
    });
    return { outcome, record };
  } catch (err) {
    if (isForeignKeyError(err)) return { outcome, record: null };
    throw err;
  }
}

// One in-flight probe per server: concurrent callers (collector tick + operator refresh) share the same result.
const inFlight = new Map<string, Promise<CollectResult>>();

export function collectAndStoreShared(serverId: string, options: CollectOptions = {}): Promise<CollectResult> {
  const existing = inFlight.get(serverId);
  if (existing) return existing;
  const promise = collectAndStore(serverId, options).finally(() => {
    inFlight.delete(serverId);
  });
  inFlight.set(serverId, promise);
  return promise;
}
