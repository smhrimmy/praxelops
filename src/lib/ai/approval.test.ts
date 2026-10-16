import { describe, it, expect } from "vitest";
import { ApprovalSecurityService } from "./approval";
import { AIOperationProposal } from "@/types/ai";

describe("ApprovalSecurityService", () => {
  const proposalId = "prop-sec-01";
  const serverId = "srv-cluster-01";
  const commands = ["systemctl reload nginx", "journalctl --vacuum-time=2d"];
  const commandsHash = ApprovalSecurityService.hashCommands(commands);
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const signature = ApprovalSecurityService.signProposal(
    proposalId,
    serverId,
    commandsHash,
    expiresAt
  );

  const validProposal: AIOperationProposal = {
    id: proposalId,
    targetServerId: serverId,
    targetServerName: "Cluster Node 01",
    title: "Reload Nginx and vacuum logs",
    rationale: "Clean logs",
    riskLevel: "medium",
    commands,
    commandsHash,
    requiresSudo: true,
    expectedOutcome: "Freed space",
    isDestructive: false,
    status: "pending_approval",
    createdAt: new Date().toISOString(),
    expiresAt,
    signature,
    approvalToken: "token-sample-secure-12345678",
  };

  it("validates a genuine signed proposal successfully", () => {
    const res = ApprovalSecurityService.verifyProposal(validProposal, serverId);
    expect(res.valid).toBe(true);
  });

  it("rejects proposal when target server ID does not match", () => {
    const res = ApprovalSecurityService.verifyProposal(validProposal, "srv-rogue-99");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("Server host mismatch");
  });

  it("rejects proposal if commands are modified after signature", () => {
    const tamperedProposal: AIOperationProposal = {
      ...validProposal,
      commands: ["rm -rf /", "reboot"], // Modified commands
    };
    const res = ApprovalSecurityService.verifyProposal(tamperedProposal, serverId);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("Commands integrity violation");
  });

  it("rejects proposal if expiration window has elapsed", () => {
    const expiredProposal: AIOperationProposal = {
      ...validProposal,
      expiresAt: Date.now() - 5000, // Expired 5 seconds ago
    };
    const res = ApprovalSecurityService.verifyProposal(expiredProposal, serverId);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("expired");
  });

  it("catches and flags dangerous destructive commands", () => {
    const dangerousCmds = ["rm -rf /", "echo hello"];
    const check1 = ApprovalSecurityService.validateCommandsSafety(dangerousCmds);
    expect(check1.safe).toBe(false);
    expect(check1.reason).toContain("Root");

    const forkBomb = [":(){ :|:& };:"];
    const check2 = ApprovalSecurityService.validateCommandsSafety(forkBomb);
    expect(check2.safe).toBe(false);

    const safeCmds = ["systemctl status sshd", "df -h", "free -m"];
    const check3 = ApprovalSecurityService.validateCommandsSafety(safeCmds);
    expect(check3.safe).toBe(true);
  });
});
