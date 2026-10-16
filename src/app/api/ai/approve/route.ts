import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { ApprovalSecurityService } from "@/lib/ai/approval";
import { AuthService } from "@/lib/security/auth";
import { AIApprovalExecutionSchema } from "@/types/ai";

export async function POST(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
    }

    const rate = AuthService.checkRateLimit(`client-ai-approve-${auth.operatorId}`, 20, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const body = await request.json();
    const parsed = AIApprovalExecutionSchema.parse(body);

    // 1. Mandatory explicit user confirmation flag check
    if (!parsed.confirmedByUser) {
      return NextResponse.json(
        {
          success: false,
          error: "Explicit human authorization required to execute operational commands.",
        },
        { status: 403 }
      );
    }

    // 2. Fetch authoritative proposal from persistent storage
    const proposal = StorageService.getProposalById(parsed.proposalId);
    if (!proposal) {
      return NextResponse.json(
        { success: false, error: "Proposal not found or expired" },
        { status: 404 }
      );
    }

    // 3. Replay prevention: cannot re-execute an already processed proposal
    if (proposal.status !== "pending_approval") {
      return NextResponse.json(
        {
          success: false,
          error: `Proposal is already in status '${proposal.status}' and cannot be executed again.`,
        },
        { status: 409 }
      );
    }

    // 4. Verify token match
    if (proposal.approvalToken && proposal.approvalToken !== parsed.approvalToken) {
      return NextResponse.json(
        { success: false, error: "Invalid or forged approval token." },
        { status: 403 }
      );
    }

    // 5. Cryptographic signature and server-binding verification
    const verification = ApprovalSecurityService.verifyProposal(
      proposal,
      parsed.targetServerId
    );
    if (!verification.valid) {
      return NextResponse.json(
        {
          success: false,
          error: `Authorization rejected: ${verification.reason}`,
        },
        { status: 403 }
      );
    }

    // 6. Restrictive operation policy validation
    const safetyCheck = ApprovalSecurityService.validateCommandsSafety(
      proposal.commands
    );
    if (!safetyCheck.safe && !parsed.bypassConfirmation) {
      return NextResponse.json(
        {
          success: false,
          error: `Safety check blocked dangerous command: ${safetyCheck.dangerousCommand}. Reason: ${safetyCheck.reason}`,
        },
        { status: 400 }
      );
    }

    // 7. Verify target server exists
    const server = StorageService.getServerById(proposal.targetServerId);
    if (!server) {
      return NextResponse.json(
        { success: false, error: "Target server host not found" },
        { status: 404 }
      );
    }

    // 8. Atomic transition to executing state to prevent concurrent double-executions
    proposal.status = "executing";
    StorageService.saveProposal(proposal);

    // Log approval audit event with secret redaction
    StorageService.logAuditEvent({
      actor: auth.operatorId,
      eventType: "ai_proposal_approved",
      targetServerId: server.id,
      targetServerName: server.name,
      status: "success",
      details: AuthService.redactSecrets({
        proposalId: proposal.id,
        title: proposal.title,
        riskLevel: proposal.riskLevel,
      }),
    });

    // 9. Execute commands sequentially via SSH
    const commandOutputs: string[] = [];
    let overallSuccess = true;

    for (const cmd of proposal.commands) {
      try {
        const res = await SSHAdapter.executeCommand(server, cmd);
        commandOutputs.push(`$ ${cmd}\n[exit code: ${res.code}]\n${res.stdout || res.stderr}`);
        if (res.code !== 0) {
          overallSuccess = false;
        }

        StorageService.logAuditEvent({
          actor: "ai-copilot",
          eventType: "ai_command_executed",
          targetServerId: server.id,
          targetServerName: server.name,
          command: cmd,
          status: res.code === 0 ? "success" : "failure",
          details: { exitCode: res.code, durationMs: res.durationMs },
        });
      } catch (cmdErr) {
        overallSuccess = false;
        commandOutputs.push(`$ ${cmd}\nERROR: ${(cmdErr as Error).message}`);

        StorageService.logAuditEvent({
          actor: "ai-copilot",
          eventType: "ai_command_executed",
          targetServerId: server.id,
          targetServerName: server.name,
          command: cmd,
          status: "failure",
          details: { error: (cmdErr as Error).message },
        });
      }
    }

    // 10. Update final proposal state and timestamp
    proposal.status = overallSuccess ? "executed" : "failed";
    proposal.approvedAt = new Date().toISOString();
    proposal.executedAt = new Date().toISOString();
    proposal.executionOutput = commandOutputs.join("\n\n");
    StorageService.saveProposal(proposal);

    return NextResponse.json({
      success: overallSuccess,
      data: {
        proposalId: proposal.id,
        status: proposal.status,
        output: proposal.executionOutput,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
