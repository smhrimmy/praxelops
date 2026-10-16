import { z } from "zod";

export type ServerStatus = "online" | "offline" | "degraded" | "checking";
export type OSType = "linux" | "darwin" | "windows";
export type AuthType = "password" | "privateKey" | "agent";

export interface SystemMetrics {
  cpuPercent: number;
  memoryUsedGB: number;
  memoryTotalGB: number;
  memoryPercent: number;
  diskUsedGB: number;
  diskTotalGB: number;
  diskPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  uptimeSeconds: number;
  loadAverage: [number, number, number];
  activeProcesses: number;
  reportedAt: string;
  isStale?: boolean;
}

export interface ServiceStatus {
  name: string;
  active: boolean;
  subState: string;
  description: string;
}

export interface ServerHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  privateKeyPath?: string;
  tags: string[];
  status: ServerStatus;
  osType: OSType;
  osVersion?: string;
  kernelVersion?: string;
  createdAt: string;
  updatedAt: string;
  lastChecked?: string;
  metrics?: SystemMetrics;
  services?: ServiceStatus[];
}

export const ServerHostSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1, "Server name is required"),
  host: z.string().min(1, "Hostname or IP is required"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1, "Username is required"),
  authType: z.enum(["password", "privateKey", "agent"]).default("password"),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  privateKeyPath: z.string().optional(),
  passphrase: z.string().optional(),
  tags: z.array(z.string()).default([]),
  osType: z.enum(["linux", "darwin", "windows"]).default("linux"),
});

export type CreateServerInput = z.infer<typeof ServerHostSchema>;
