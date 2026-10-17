import { z } from "zod";
import type { SQLInputValue, SQLOutputValue } from "node:sqlite";
import type { AuditEvent, AuditEventType } from "@/types/audit";
import type { ServerHost } from "@/types/server";
// NOTE: only `import type` for "@/..." aliases (erased by type stripping) and relative .ts imports for values, so
// plain node can load this module; erasable-only TypeScript syntax.
import { StorageCorruptError } from "../storage/atomicFile.ts";

/**
 * Pure row <-> record mapping shared by the stores and the legacy JSON import.
 * Everything read back from SQLite is validated here, so a tampered/malformed row throws StorageCorruptError
 * (callers fail closed) instead of being interpreted.
 */

export type SqlRow = Record<string, SQLOutputValue>;

export function corruptRow(table: string, key: string, detail?: unknown): StorageCorruptError {
  return new StorageCorruptError(`praxelops.db: ${table}[${key}]`, detail);
}

const JsonObjectSchema = z.record(z.string(), z.unknown());

function parseJsonObject(text: string, table: string, key: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw corruptRow(table, key, err);
  }
  const parsed = JsonObjectSchema.safeParse(value);
  if (!parsed.success) throw corruptRow(table, key, "JSON column is not an object");
  return parsed.data;
}

function nullable(value: string | undefined): string | null {
  return value === undefined ? null : value;
}

// ---------------------------------------------------------------------------------------------
// servers: secrets live in their own columns (password / private_key / passphrase); everything else is JSON.
// ---------------------------------------------------------------------------------------------

export interface ServerRowParams {
  id: string;
  data: string;
  password: string | null;
  privateKey: string | null;
  passphrase: string | null;
}

function secretOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function serverToRow(server: ServerHost): ServerRowParams {
  const record: Record<string, unknown> = { ...server };
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Server record requires a non-empty string id");
  }
  const password = secretOrNull(record.password);
  const privateKey = secretOrNull(record.privateKey);
  const passphrase = secretOrNull(record.passphrase);
  delete record.id;
  delete record.password;
  delete record.privateKey;
  delete record.passphrase;
  return { id, data: JSON.stringify(record), password, privateKey, passphrase };
}

const ServerRowSchema = z.object({
  id: z.string().min(1),
  data: z.string(),
  password: z.string().nullable(),
  private_key: z.string().nullable(),
  passphrase: z.string().nullable(),
});

/** Returns the stored record including its secret fields (as the JSON store did); callers strip them for API output. */
export function rowToServer(row: SqlRow): ServerHost {
  const parsed = ServerRowSchema.safeParse(row);
  if (!parsed.success) throw corruptRow("servers", String(row.id), parsed.error);
  const r = parsed.data;
  const record = parseJsonObject(r.data, "servers", r.id);
  record.id = r.id;
  if (r.password !== null) record.password = r.password;
  if (r.private_key !== null) record.privateKey = r.private_key;
  if (r.passphrase !== null) record.passphrase = r.passphrase;
  return record as unknown as ServerHost;
}

// ---------------------------------------------------------------------------------------------
// audit_events
// ---------------------------------------------------------------------------------------------

export const AUDIT_INSERT_SQL =
  "INSERT INTO audit_events (id, timestamp, actor, event_type, target_server_id, target_server_name, command, status, ip_address, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function auditToParams(event: AuditEvent): SQLInputValue[] {
  return [
    event.id,
    event.timestamp,
    event.actor,
    event.eventType,
    nullable(event.targetServerId),
    nullable(event.targetServerName),
    nullable(event.command),
    event.status,
    nullable(event.ipAddress),
    event.details === undefined ? null : JSON.stringify(event.details),
  ];
}

const AuditRowSchema = z.object({
  seq: z.number(),
  id: z.string().min(1),
  timestamp: z.string(),
  actor: z.string(),
  event_type: z.string().min(1),
  target_server_id: z.string().nullable(),
  target_server_name: z.string().nullable(),
  command: z.string().nullable(),
  status: z.enum(["success", "failure", "denied"]),
  ip_address: z.string().nullable(),
  details: z.string().nullable(),
});

export function rowToAudit(row: SqlRow): AuditEvent {
  const parsed = AuditRowSchema.safeParse(row);
  if (!parsed.success) throw corruptRow("audit_events", String(row.seq), parsed.error);
  const r = parsed.data;
  const event: AuditEvent = {
    id: r.id,
    timestamp: r.timestamp,
    actor: r.actor,
    eventType: r.event_type as AuditEventType,
    status: r.status,
  };
  if (r.target_server_id !== null) event.targetServerId = r.target_server_id;
  if (r.target_server_name !== null) event.targetServerName = r.target_server_name;
  if (r.command !== null) event.command = r.command;
  if (r.ip_address !== null) event.ipAddress = r.ip_address;
  if (r.details !== null) event.details = parseJsonObject(r.details, "audit_events", String(r.seq));
  return event;
}

// ---------------------------------------------------------------------------------------------
// Generic JSON documents (proposals, deployments, diagnostics)
// ---------------------------------------------------------------------------------------------

const DocRowSchema = z.object({ data: z.string() });

export function rowToDoc<T>(row: SqlRow, table: string, key: string): T {
  const parsed = DocRowSchema.safeParse(row);
  if (!parsed.success) throw corruptRow(table, key, parsed.error);
  return parseJsonObject(parsed.data.data, table, key) as T;
}

export function docString(doc: object, field: string): string | null {
  const value = (doc as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------------------------
// known_hosts
// ---------------------------------------------------------------------------------------------

export interface KnownHostEntry {
  host: string;
  port: number;
  fingerprint: string;
  firstSeenAt: string;
  // Written once at enrollment. Deliberately NOT updated on successful verification.
  lastVerifiedAt: string;
}

const KnownHostRowSchema = z
  .object({
    host_port: z.string().min(1),
    host: z.string(),
    port: z.number(),
    fingerprint: z.string().min(1),
    first_seen_at: z.string(),
    last_verified_at: z.string(),
  })
  .refine((r) => r.host_port === `${r.host}:${r.port}`, "host_port does not match host and port");

export function rowToKnownHost(row: SqlRow): KnownHostEntry {
  const parsed = KnownHostRowSchema.safeParse(row);
  if (!parsed.success) throw corruptRow("known_hosts", String(row.host_port), parsed.error);
  const r = parsed.data;
  return {
    host: r.host,
    port: r.port,
    fingerprint: r.fingerprint,
    firstSeenAt: r.first_seen_at,
    lastVerifiedAt: r.last_verified_at,
  };
}

export const KNOWN_HOST_INSERT_SQL =
  "INSERT INTO known_hosts (host_port, host, port, fingerprint, first_seen_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?)";

export function knownHostToParams(key: string, entry: KnownHostEntry): SQLInputValue[] {
  return [key, entry.host, entry.port, entry.fingerprint, entry.firstSeenAt, entry.lastVerifiedAt];
}
