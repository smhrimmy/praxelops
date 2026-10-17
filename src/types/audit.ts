import { z } from "zod";

export type AuditEventType =
  | "ssh_connect"
  | "ssh_disconnect"
  | "sftp_read"
  | "sftp_write"
  | "command_exec"
  | "ai_proposal_created"
  | "ai_proposal_approved"
  | "ai_proposal_rejected"
  | "ai_command_executed"
  | "deployment_triggered"
  | "deployment_rollback"
  | "server_created"
  | "server_updated"
  | "server_deleted"
  | "auth_login"
  | "auth_logout"
  | "security_alert";

export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  eventType: AuditEventType;
  targetServerId?: string;
  targetServerName?: string;
  command?: string;
  status: "success" | "failure" | "denied";
  details?: Record<string, unknown>;
  ipAddress?: string;
}

export const AuditQuerySchema = z.object({
  serverId: z.string().optional(),
  eventType: z.string().optional(),
  status: z.enum(["success", "failure", "denied"]).optional(),
  limit: z.number().int().min(1).max(500).default(50),
  offset: z.number().int().min(0).default(0),
});
