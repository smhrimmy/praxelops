import { describe, it, expect } from "vitest";
import { ApprovalSecurityService } from "./approval";
import { getMasterSecret } from "@/lib/security/secret";
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

  it("rejects proposal if commands are substituted post-approval", () => {
    const tamperedProposal: AIOperationProposal = {
      ...validProposal,
      commands: ["rm -rf /", "reboot"], // Substituted commands
    };
    const res = ApprovalSecurityService.verifyProposal(tamperedProposal, serverId);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("Commands integrity violation");
  });

  it("rejects proposal if expiration window has elapsed", () => {
    const expiredProposal: AIOperationProposal = {
      ...validProposal,
      expiresAt: Date.now() - 5000,
    };
    const res = ApprovalSecurityService.verifyProposal(expiredProposal, serverId);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("expired");
  });

  it("enforces operation policy and rejects arbitrary shell injection", () => {
    const dangerousCmds = ["rm -rf /", "echo hello"];
    const check1 = ApprovalSecurityService.validateCommandsSafety(dangerousCmds);
    expect(check1.safe).toBe(false);

    const injectedCmds = ["systemctl status sshd; cat /etc/passwd"];
    const check2 = ApprovalSecurityService.validateCommandsSafety(injectedCmds);
    expect(check2.safe).toBe(false);

    const safeCmds = ["systemctl status sshd", "journalctl --vacuum-time=3d"];
    const check3 = ApprovalSecurityService.validateCommandsSafety(safeCmds);
    expect(check3.safe).toBe(true);
  });

  it("retrieves a secure master secret without plaintext fallbacks", () => {
    const secret = getMasterSecret();
    expect(secret).toBeDefined();
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });
});
