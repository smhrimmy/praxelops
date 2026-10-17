import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ServerHost } from "@/types/server";
import type { AuditEvent } from "@/types/audit";
import type { AIOperationProposal, ServerDiagnosticReport } from "@/types/ai";
import type { DeploymentWorkflow } from "@/types/deployment";
// NOTE: only `import type` for "@/..." aliases and relative .ts imports for values, so plain node
// (`--experimental-strip-types`, used by the multi-process test fixtures) can load this module.
import { getDb, prepare, withTransaction } from "../db/database.ts";
import {
  AUDIT_INSERT_SQL,
  auditToParams,
  docString,
  rowToAudit,
  rowToDoc,
  rowToServer,
  serverToRow,
  type SqlRow,
} from "../db/records.ts";

const MAX_DIAGNOSTICS = 100;

const UPSERT_SERVER_SQL =
  "INSERT INTO servers (id, data, password, private_key, passphrase) VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(id) DO UPDATE SET data = excluded.data, password = excluded.password, " +
  "private_key = excluded.private_key, passphrase = excluded.passphrase";

export interface AuditQueryOptions {
  /** Only events whose targetServerId equals this. */
  serverId?: string;
  /** Maximum number of events to return (newest first). Omitted = all. */
  limit?: number;
  offset?: number;
}

function upsertServer(db: DatabaseSync, server: ServerHost): void {
  const row = serverToRow(server);
  prepare(db, UPSERT_SERVER_SQL).run(row.id, row.data, row.password, row.privateKey, row.passphrase);
}

export class StorageService {
  /**
   * Returns servers from persistent storage (insertion order).
   * NEVER injects hardcoded fake servers into normal production state.
   */
  static getServers(): ServerHost[] {
    const db = getDb();
    const rows = prepare(db, "SELECT id, data, password, private_key, passphrase FROM servers ORDER BY rowid").all();
    return rows.map((row) => rowToServer(row as SqlRow));
  }

  static getServerById(id: string): ServerHost | undefined {
    const db = getDb();
    const row = prepare(db, "SELECT id, data, password, private_key, passphrase FROM servers WHERE id = ?").get(id);
    return row === undefined ? undefined : rowToServer(row as SqlRow);
  }

  static saveServer(server: ServerHost): void {
    withTransaction((db) => {
      upsertServer(db, server);
    });
  }

  static deleteServer(id: string): boolean {
    return withTransaction((db) => {
      const result = prepare(db, "DELETE FROM servers WHERE id = ?").run(id);
      return Number(result.changes) > 0;
    });
  }

  /**
   * Explicitly labeled demonstration data loader.
   * Can only be triggered by deliberate user action, never automatically.
   */
  static loadDemoEnvironment(): ServerHost[] {
    const demoServers: ServerHost[] = [
      {
        id: "srv-demo-sandbox-01",
        name: "[DEMO] Localhost Sandbox",
        host: "127.0.0.1",
        port: 22,
        username: "operator",
        authType: "password",
        tags: ["demo", "sandbox"],
        status: "offline",
        osType: "linux",
        osVersion: "Simulated Ubuntu 24.04",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastChecked: new Date().toISOString(),
        metrics: {
          cpuPercent: 0,
          memoryUsedGB: 0,
          memoryTotalGB: 16.0,
          memoryPercent: 0,
          diskUsedGB: 0,
          diskTotalGB: 512.0,
          diskPercent: 0,
          networkRxBytes: 0,
          networkTxBytes: 0,
          uptimeSeconds: 0,
          loadAverage: [0, 0, 0],
          activeProcesses: 0,
          reportedAt: new Date().toISOString(),
          isStale: true,
        },
      },
    ];

    withTransaction((db) => {
      prepare(db, "DELETE FROM servers").run();
      for (const server of demoServers) upsertServer(db, server);
    });
    return demoServers;
  }

  static clearAllServers(): void {
    withTransaction((db) => {
      prepare(db, "DELETE FROM servers").run();
    });
  }

  // Audit Events (append-only; newest first on read; no retention cap)
  static getAuditEvents(options: AuditQueryOptions = {}): AuditEvent[] {
    const db = getDb();
    const limit = options.limit === undefined ? -1 : Math.max(0, Math.floor(options.limit));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const columns =
      "seq, id, timestamp, actor, event_type, target_server_id, target_server_name, command, status, ip_address, details";
    const rows =
      options.serverId === undefined
        ? prepare(db, `SELECT ${columns} FROM audit_events ORDER BY seq DESC LIMIT ? OFFSET ?`).all(limit, offset)
        : prepare(
            db,
            `SELECT ${columns} FROM audit_events WHERE target_server_id = ? ORDER BY seq DESC LIMIT ? OFFSET ?`
          ).all(options.serverId, limit, offset);
    return rows.map((row) => rowToAudit(row as SqlRow));
  }

  static logAuditEvent(event: Omit<AuditEvent, "id" | "timestamp">): AuditEvent {
    const newEvent: AuditEvent = {
      ...event,
      id: `audit-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      timestamp: new Date().toISOString(),
    };
    withTransaction((db) => {
      prepare(db, AUDIT_INSERT_SQL).run(...auditToParams(newEvent));
    });
    return newEvent;
  }

  // AI Proposals & Diagnostic Reports (newest-created first; updates keep their position)
  static getProposals(): AIOperationProposal[] {
    const db = getDb();
    const rows = prepare(db, "SELECT id, data FROM proposals ORDER BY rowid DESC").all();
    return rows.map((row) => rowToDoc<AIOperationProposal>(row as SqlRow, "proposals", String(row.id)));
  }

  static saveProposal(proposal: AIOperationProposal): void {
    withTransaction((db) => {
      prepare(
        db,
        "INSERT INTO proposals (id, target_server_id, status, created_at, data) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET target_server_id = excluded.target_server_id, status = excluded.status, " +
          "created_at = excluded.created_at, data = excluded.data"
      ).run(
        proposal.id,
        docString(proposal, "targetServerId"),
        docString(proposal, "status"),
        docString(proposal, "createdAt"),
        JSON.stringify(proposal)
      );
    });
  }

  static getProposalById(id: string): AIOperationProposal | undefined {
    const db = getDb();
    const row = prepare(db, "SELECT id, data FROM proposals WHERE id = ?").get(id);
    return row === undefined ? undefined : rowToDoc<AIOperationProposal>(row as SqlRow, "proposals", id);
  }

  static getDiagnostics(): ServerDiagnosticReport[] {
    const db = getDb();
    const rows = prepare(db, "SELECT seq, data FROM diagnostics ORDER BY seq DESC").all();
    return rows.map((row) => rowToDoc<ServerDiagnosticReport>(row as SqlRow, "diagnostics", String(row.seq)));
  }

  static saveDiagnostic(report: ServerDiagnosticReport): void {
    withTransaction((db) => {
      prepare(db, "INSERT INTO diagnostics (id, server_id, timestamp, data) VALUES (?, ?, ?, ?)").run(
        report.id,
        docString(report, "serverId"),
        docString(report, "timestamp"),
        JSON.stringify(report)
      );
      prepare(
        db,
        "DELETE FROM diagnostics WHERE seq NOT IN (SELECT seq FROM diagnostics ORDER BY seq DESC LIMIT ?)"
      ).run(MAX_DIAGNOSTICS);
    });
  }

  // Deployments (newest-created first; updates keep their position)
  static getDeployments(): DeploymentWorkflow[] {
    const db = getDb();
    const rows = prepare(db, "SELECT id, data FROM deployments ORDER BY rowid DESC").all();
    return rows.map((row) => rowToDoc<DeploymentWorkflow>(row as SqlRow, "deployments", String(row.id)));
  }

  static saveDeployment(deployment: DeploymentWorkflow): void {
    withTransaction((db) => {
      prepare(
        db,
        "INSERT INTO deployments (id, server_id, status, created_at, data) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET server_id = excluded.server_id, status = excluded.status, " +
          "created_at = excluded.created_at, data = excluded.data"
      ).run(
        deployment.id,
        docString(deployment, "serverId"),
        docString(deployment, "status"),
        docString(deployment, "createdAt"),
        JSON.stringify(deployment)
      );
    });
  }
}
