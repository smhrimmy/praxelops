import fs from "fs";
import path from "path";
import { ServerHost } from "@/types/server";
import { AuditEvent } from "@/types/audit";
import { AIOperationProposal, ServerDiagnosticReport } from "@/types/ai";
import { DeploymentWorkflow } from "@/types/deployment";

const DATA_DIR = path.resolve(process.cwd(), ".peos", "data");

function ensureDirectoryExists(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJsonFile<T>(filename: string, defaultValue: T): T {
  ensureDirectoryExists(DATA_DIR);
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf-8");
    return defaultValue;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

function writeJsonFile<T>(filename: string, data: T): void {
  ensureDirectoryExists(DATA_DIR);
  const filePath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
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
    const servers = this.getServers();
    const index = servers.findIndex((s) => s.id === server.id);
    if (index >= 0) {
      servers[index] = server;
    } else {
      servers.push(server);
    }
    writeJsonFile("servers.json", servers);
  }

  static deleteServer(id: string): boolean {
    const servers = this.getServers();
    const filtered = servers.filter((s) => s.id !== id);
    if (filtered.length !== servers.length) {
      writeJsonFile("servers.json", filtered);
      return true;
    }
    return false;
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
    const events = this.getAuditEvents();
    const newEvent: AuditEvent = {
      ...event,
      id: `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
    };
    events.unshift(newEvent);
    if (events.length > 2000) {
      events.length = 2000;
    }
    writeJsonFile("audit.json", events);
    return newEvent;
  }

  // AI Proposals & Diagnostic Reports
  static getProposals(): AIOperationProposal[] {
    return readJsonFile<AIOperationProposal[]>("proposals.json", []);
  }

  static saveProposal(proposal: AIOperationProposal): void {
    const proposals = this.getProposals();
    const index = proposals.findIndex((p) => p.id === proposal.id);
    if (index >= 0) {
      proposals[index] = proposal;
    } else {
      proposals.unshift(proposal);
    }
    writeJsonFile("proposals.json", proposals);
  }

  static getProposalById(id: string): AIOperationProposal | undefined {
    return this.getProposals().find((p) => p.id === id);
  }

  static getDiagnostics(): ServerDiagnosticReport[] {
    return readJsonFile<ServerDiagnosticReport[]>("diagnostics.json", []);
  }

  static saveDiagnostic(report: ServerDiagnosticReport): void {
    const list = this.getDiagnostics();
    list.unshift(report);
    if (list.length > 100) list.length = 100;
    writeJsonFile("diagnostics.json", list);
  }

  // Deployments
  static getDeployments(): DeploymentWorkflow[] {
    return readJsonFile<DeploymentWorkflow[]>("deployments.json", []);
  }

  static saveDeployment(deployment: DeploymentWorkflow): void {
    const list = this.getDeployments();
    const index = list.findIndex((d) => d.id === deployment.id);
    if (index >= 0) {
      list[index] = deployment;
    } else {
      list.unshift(deployment);
    }
    writeJsonFile("deployments.json", list);
  }
}
