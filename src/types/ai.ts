import { z } from "zod";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface AIOperationProposal {
  id: string;
  targetServerId: string;
  targetServerName: string;
  title: string;
  rationale: string;
  riskLevel: RiskLevel;
  commands: string[];
  commandsHash: string;
  requiresSudo: boolean;
  rollbackPlan?: string;
  expectedOutcome: string;
  isDestructive: boolean;
  status: "pending_approval" | "approved" | "rejected" | "executing" | "executed" | "failed";
  createdAt: string;
  expiresAt: number; // Unix timestamp
  signature: string; // HMAC binding
  approvalToken?: string; // One-time token provided to client
  approvedAt?: string;
  executedAt?: string;
  executionOutput?: string;
}

export interface ServerDiagnosticReport {
  id: string;
  serverId: string;
  serverName: string;
  timestamp: string;
  healthScore: number; // 0 - 100
  summary: string;
  anomalies: {
    category: "cpu" | "memory" | "disk" | "network" | "service" | "security";
    severity: "info" | "warning" | "critical";
    detail: string;
    metricValue?: string | number;
  }[];
  proposals: AIOperationProposal[];
}

export const AIAnalysisRequestSchema = z.object({
  serverId: z.string(),
  userPrompt: z.string().optional(),
  includeMetrics: z.boolean().default(true),
  includeRecentLogs: z.boolean().default(true),
});

export const AIApprovalExecutionSchema = z.object({
  proposalId: z.string().min(1),
  targetServerId: z.string().min(1),
  approvalToken: z.string().min(16),
  confirmedByUser: z.boolean(),
  bypassConfirmation: z.boolean().optional(),
});
