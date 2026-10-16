import { z } from "zod";

export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";
export type DeploymentStatus = "queued" | "in_progress" | "healthy" | "failed" | "rolled_back";

export interface DeploymentStep {
  id: string;
  name: string;
  command: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  outputLog?: string;
}

export interface DeploymentWorkflow {
  id: string;
  name: string;
  serverId: string;
  serverName: string;
  appDirectory: string;
  environment: "production" | "staging" | "development";
  status: DeploymentStatus;
  steps: DeploymentStep[];
  healthCheckUrl?: string;
  healthCheckExpectedStatus?: number;
  rollbackCommand?: string;
  createdAt: string;
  completedAt?: string;
}

export const TriggerDeploymentSchema = z.object({
  name: z.string().min(1),
  serverId: z.string(),
  appDirectory: z.string().min(1),
  environment: z.enum(["production", "staging", "development"]).default("production"),
  steps: z.array(
    z.object({
      name: z.string(),
      command: z.string(),
    })
  ).min(1),
  healthCheckUrl: z.string().url().optional(),
  rollbackCommand: z.string().optional(),
});
