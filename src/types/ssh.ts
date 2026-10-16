import { z } from "zod";

export interface SSHSessionInfo {
  sessionId: string;
  serverId: string;
  serverName: string;
  host: string;
  username: string;
  status: "connecting" | "connected" | "disconnected" | "error";
  startedAt: string;
  lastActiveAt: string;
  terminalRows: number;
  terminalCols: number;
}

export interface TerminalResizePayload {
  sessionId: string;
  rows: number;
  cols: number;
}

export interface RemoteFileItem {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  isSymlink: boolean;
  permissions: string;
  modifyTime: number;
  owner?: string;
  group?: string;
}

export interface SFTPTransferProgress {
  id: string;
  filename: string;
  remotePath: string;
  type: "upload" | "download";
  transferredBytes: number;
  totalBytes: number;
  percentage: number;
  status: "queued" | "transferring" | "completed" | "failed";
  error?: string;
}

export const SSHConnectSchema = z.object({
  serverId: z.string(),
  cols: z.number().int().min(10).max(500).default(80),
  rows: z.number().int().min(5).max(200).default(24),
  term: z.string().default("xterm-256color"),
});

export const CommandExecuteSchema = z.object({
  serverId: z.string(),
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000),
});
