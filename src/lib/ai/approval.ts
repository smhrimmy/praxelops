import crypto from "crypto";
import { AIOperationProposal } from "@/types/ai";

// Persistent server-side secret for operational approval tokens
const SERVER_SECRET =
  process.env.PRAXELOPS_SECRET ||
  "praxelops_internal_secure_hmac_secret_v2_9f82c4e17b84";

export class ApprovalSecurityService {
  /**
   * Hashes the list of proposed commands deterministically
   */
  static hashCommands(commands: string[]): string {
    return crypto
      .createHash("sha256")
      .update(commands.map((c) => c.trim()).join("\n"))
      .digest("hex");
  }

  /**
   * Generates a cryptographically bound signature for a proposal
   */
  static signProposal(
    proposalId: string,
    serverId: string,
    commandsHash: string,
    expiresAt: number
  ): string {
    return crypto
      .createHmac("sha256", SERVER_SECRET)
      .update(`${proposalId}:${serverId}:${commandsHash}:${expiresAt}`)
      .digest("hex");
  }

  /**
   * Verifies the authenticity, server binding, commands integrity and expiration of a proposal
   */
  static verifyProposal(
    proposal: AIOperationProposal,
    claimedServerId: string
  ): { valid: boolean; reason?: string } {
    // 1. Expiration check
    if (Date.now() > proposal.expiresAt) {
      return { valid: false, reason: "Proposal approval window has expired" };
    }

    // 2. Server host binding check
    if (proposal.targetServerId !== claimedServerId) {
      return {
        valid: false,
        reason: "Server host mismatch: Proposal cannot be applied to another server",
      };
    }

    // 3. Command tampering check
    const currentCommandsHash = this.hashCommands(proposal.commands);
    if (currentCommandsHash !== proposal.commandsHash) {
      return {
        valid: false,
        reason: "Commands integrity violation: Proposed commands were modified post-generation",
      };
    }

    // 4. HMAC signature check
    const expectedSig = this.signProposal(
      proposal.id,
      proposal.targetServerId,
      proposal.commandsHash,
      proposal.expiresAt
    );
    if (expectedSig !== proposal.signature) {
      return {
        valid: false,
        reason: "Cryptographic signature mismatch: Proposal record is invalid or forged",
      };
    }

    return { valid: true };
  }

  /**
   * Strict command validation against forbidden destructive and malicious patterns
   */
  static validateCommandsSafety(commands: string[]): {
    safe: boolean;
    dangerousCommand?: string;
    reason?: string;
  } {
    const forbiddenPatterns = [
      { pattern: /rm\s+-rf\s+(\/|\/\*|~\/|\.\/)/i, reason: "Root or home recursive deletion" },
      { pattern: /mkfs(\.[a-z0-9]+)?\s+/i, reason: "Filesystem creation / disk format" },
      { pattern: />\s*\/dev\/(sd[a-z]|nvme[0-9]n[0-9]|hd[a-z])/i, reason: "Direct write to raw block device" },
      { pattern: /dd\s+if=.*of=\/dev\//i, reason: "Raw disk overwrite using dd" },
      { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/i, reason: "Fork bomb pattern" },
      { pattern: /cat\s+\/etc\/shadow/i, reason: "Direct shadow password hash extraction" },
      { pattern: /chmod\s+(-R\s+)?777\s+\//i, reason: "Full root permission wipe (777)" },
    ];

    for (const cmd of commands) {
      const trimmed = cmd.trim();
      for (const rule of forbiddenPatterns) {
        if (rule.pattern.test(trimmed)) {
          return {
            safe: false,
            dangerousCommand: trimmed,
            reason: rule.reason,
          };
        }
      }
    }

    return { safe: true };
  }
}
