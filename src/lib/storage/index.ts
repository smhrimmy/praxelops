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
  // Server Inventory
  static getServers(): ServerHost[] {
    const servers = readJsonFile<ServerHost[]>("servers.json", []);
    if (servers.length === 0) {
      // Seed initial local & demo cluster nodes
      const seedServers: ServerHost[] = [
        {
          id: "srv-local-01",
          name: "Localhost Hypervisor",
          host: "127.0.0.1",
          port: 22,
          username: "operator",
          authType: "password",
          tags: ["local", "core", "gateway"],
          status: "online",
          osType: "linux",
          osVersion: "Ubuntu 24.04 LTS",
          kernelVersion: "Linux 6.8.0-31-generic",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastChecked: new Date().toISOString(),
          metrics: {
            cpuPercent: 18.4,
            memoryUsedGB: 6.2,
            memoryTotalGB: 16.0,
            memoryPercent: 38.7,
            diskUsedGB: 142.5,
            diskTotalGB: 512.0,
            diskPercent: 27.8,
            networkRxBytes: 104857600,
            networkTxBytes: 52428800,
            uptimeSeconds: 846200,
            loadAverage: [0.42, 0.38, 0.31],
            activeProcesses: 184,
            reportedAt: new Date().toISOString(),
            isStale: false,
          },
          services: [
            { name: "sshd.service", active: true, subState: "running", description: "OpenSSH server daemon" },
            { name: "docker.service", active: true, subState: "running", description: "Docker Application Container Engine" },
            { name: "nginx.service", active: true, subState: "running", description: "A high performance web server and a reverse proxy server" },
          ],
        },
        {
          id: "srv-prod-api-01",
          name: "US-East Prod Gateway",
          host: "10.240.0.12",
          port: 2222,
          username: "sysadmin",
          authType: "privateKey",
          tags: ["production", "api", "us-east"],
          status: "online",
          osType: "linux",
          osVersion: "Debian 12 Bookworm",
          kernelVersion: "Linux 6.1.0-21-amd64",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastChecked: new Date().toISOString(),
          metrics: {
            cpuPercent: 42.1,
            memoryUsedGB: 28.4,
            memoryTotalGB: 32.0,
            memoryPercent: 88.7,
            diskUsedGB: 310.2,
            diskTotalGB: 1000.0,
            diskPercent: 31.0,
            networkRxBytes: 4294967296,
            networkTxBytes: 8589934592,
            uptimeSeconds: 1948200,
            loadAverage: [1.85, 1.42, 1.15],
            activeProcesses: 312,
            reportedAt: new Date().toISOString(),
            isStale: false,
          },
          services: [
            { name: "sshd.service", active: true, subState: "running", description: "OpenSSH server daemon" },
            { name: "envoy.service", active: true, subState: "running", description: "Envoy Proxy Edge Gateway" },
            { name: "redis-server.service", active: true, subState: "running", description: "Advanced key-value store" },
          ],
        },
        {
          id: "srv-db-cluster-01",
          name: "Primary PostgreSQL Primary",
          host: "10.240.1.50",
          port: 22,
          username: "postgres",
          authType: "privateKey",
          tags: ["production", "database", "critical"],
          status: "degraded",
          osType: "linux",
          osVersion: "Ubuntu 22.04 LTS",
          kernelVersion: "Linux 5.15.0-91-generic",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastChecked: new Date().toISOString(),
          metrics: {
            cpuPercent: 87.6,
            memoryUsedGB: 60.1,
            memoryTotalGB: 64.0,
            memoryPercent: 93.9,
            diskUsedGB: 1820.0,
            diskTotalGB: 2000.0,
            diskPercent: 91.0,
            networkRxBytes: 154294967296,
            networkTxBytes: 254294967296,
            uptimeSeconds: 3450200,
            loadAverage: [6.12, 5.48, 4.90],
            activeProcesses: 428,
            reportedAt: new Date().toISOString(),
            isStale: false,
          },
          services: [
            { name: "sshd.service", active: true, subState: "running", description: "OpenSSH server daemon" },
            { name: "postgresql@16-main.service", active: true, subState: "running", description: "PostgreSQL RDBMS Cluster" },
            { name: "wal-g.timer", active: true, subState: "waiting", description: "WAL Archiving Continuous Backup" },
          ],
        },
      ];
      writeJsonFile("servers.json", seedServers);
      return seedServers;
    }
    return servers;
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
    events.unshift(newEvent); // newest first
    // keep up to 2000 events
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
