import fs from "fs";
import path from "path";
import { ServerHost } from "@/types/server";
import { AuditEvent } from "@/types/audit";
import { AIOperationProposal, ServerDiagnosticReport } from "@/types/ai";
import { DeploymentWorkflow } from "@/types/deployment";
import { getDataDir } from "./dataDir";
import {
  atomicWriteFileSync,
  readJsonStrict,
  StorageCorruptError,
  withFileLockSync,
} from "./atomicFile";

function ensureDirectoryExists(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function resolveStorePath(filename: string): string {
  const dir = getDataDir();
  ensureDirectoryExists(dir);
  return path.join(dir, filename);
}

/**
 * Reads a store without taking the lock. Safe because writes are atomic renames.
 * Returns undefined when the file does not exist yet.
 * Throws StorageCorruptError (never a default) on unparseable or wrong-shaped contents.
 */
function readExisting<T>(filePath: string, defaultValue: T): T | undefined {
  const parsed = readJsonStrict<T>(filePath);
  if (parsed === undefined) return undefined;
  if (Array.isArray(defaultValue) !== Array.isArray(parsed) || parsed === null) {
    throw new StorageCorruptError(filePath, "unexpected JSON shape");
  }
  return parsed;
}

/** Must be called while holding the lock for filePath. */
function readOrInitLocked<T>(filePath: string, defaultValue: T): T {
  const existing = readExisting(filePath, defaultValue);
  if (existing !== undefined) return existing;
  atomicWriteFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  return defaultValue;
}

function readJsonFile<T>(filename: string, defaultValue: T): T {
  const filePath = resolveStorePath(filename);
  const existing = readExisting(filePath, defaultValue);
  if (existing !== undefined) return existing;
  // Missing: create the default under the lock, re-checking so we never clobber a concurrent first write.
  return withFileLockSync(filePath, () => readOrInitLocked(filePath, defaultValue));
}

function writeJsonFile<T>(filename: string, data: T): void {
  const filePath = resolveStorePath(filename);
  withFileLockSync(filePath, () => {
    atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
  });
}

/**
 * Locked read-modify-write. The mutator receives the current contents (re-read inside the lock)
 * and returns the next contents (or null to skip the write) plus a result to hand back.
 */
function updateJsonFile<T, R>(
  filename: string,
  defaultValue: T,
  mutate: (current: T) => { next: T | null; result: R }
): R {
  const filePath = resolveStorePath(filename);
  return withFileLockSync(filePath, () => {
    const current = readOrInitLocked(filePath, defaultValue);
    const { next, result } = mutate(current);
    if (next !== null) {
      atomicWriteFileSync(filePath, JSON.stringify(next, null, 2));
    }
    return result;
  });
}

export class StorageService {
  /**
   * Returns servers from persistent storage.
   * NEVER injects hardcoded fake servers into normal production state.
   */
  static getServers(): ServerHost[] {
    return readJsonFile<ServerHost[]>("servers.json", []);
  }

  static getServerById(id: string): ServerHost | undefined {
    return this.getServers().find((s) => s.id === id);
  }

  static saveServer(server: ServerHost): void {
    updateJsonFile<ServerHost[], void>("servers.json", [], (servers) => {
      const index = servers.findIndex((s) => s.id === server.id);
      if (index >= 0) {
        servers[index] = server;
      } else {
        servers.push(server);
      }
      return { next: servers, result: undefined };
    });
  }

  static deleteServer(id: string): boolean {
    return updateJsonFile<ServerHost[], boolean>("servers.json", [], (servers) => {
      const filtered = servers.filter((s) => s.id !== id);
      if (filtered.length !== servers.length) {
        return { next: filtered, result: true };
      }
      return { next: null, result: false };
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

    writeJsonFile("servers.json", demoServers);
    return demoServers;
  }

  static clearAllServers(): void {
    writeJsonFile("servers.json", []);
  }

  // Audit Events
  static getAuditEvents(): AuditEvent[] {
    return readJsonFile<AuditEvent[]>("audit.json", []);
  }

  static logAuditEvent(event: Omit<AuditEvent, "id" | "timestamp">): AuditEvent {
    const newEvent: AuditEvent = {
      ...event,
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
    };
    return updateJsonFile<AuditEvent[], AuditEvent>("audit.json", [], (events) => {
      events.unshift(newEvent);
      if (events.length > 2000) {
        events.length = 2000;
      }
      return { next: events, result: newEvent };
    });
  }

  // AI Proposals & Diagnostic Reports
  static getProposals(): AIOperationProposal[] {
    return readJsonFile<AIOperationProposal[]>("proposals.json", []);
  }

  static saveProposal(proposal: AIOperationProposal): void {
    updateJsonFile<AIOperationProposal[], void>("proposals.json", [], (proposals) => {
      const index = proposals.findIndex((p) => p.id === proposal.id);
      if (index >= 0) {
        proposals[index] = proposal;
      } else {
        proposals.unshift(proposal);
      }
      return { next: proposals, result: undefined };
    });
  }

  static getProposalById(id: string): AIOperationProposal | undefined {
    return this.getProposals().find((p) => p.id === id);
  }

  static getDiagnostics(): ServerDiagnosticReport[] {
    return readJsonFile<ServerDiagnosticReport[]>("diagnostics.json", []);
  }

  static saveDiagnostic(report: ServerDiagnosticReport): void {
    updateJsonFile<ServerDiagnosticReport[], void>("diagnostics.json", [], (list) => {
      list.unshift(report);
      if (list.length > 100) list.length = 100;
      return { next: list, result: undefined };
    });
  }

  // Deployments
  static getDeployments(): DeploymentWorkflow[] {
    return readJsonFile<DeploymentWorkflow[]>("deployments.json", []);
  }

  static saveDeployment(deployment: DeploymentWorkflow): void {
    updateJsonFile<DeploymentWorkflow[], void>("deployments.json", [], (list) => {
      const index = list.findIndex((d) => d.id === deployment.id);
      if (index >= 0) {
        list[index] = deployment;
      } else {
        list.unshift(deployment);
      }
      return { next: list, result: undefined };
    });
  }
}
