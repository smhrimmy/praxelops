import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { AIApprovalExecutionSchema } from "@/types/ai";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = AIApprovalExecutionSchema.parse(body);

    if (!parsed.confirmedByUser) {
      return NextResponse.json(
        {
          success: false,
          error: "Explicit human authorization required to execute operational commands.",
        },
        { status: 403 }
      );
    }

    const proposal = StorageService.getProposalById(parsed.proposalId);
    if (!proposal) {
      return NextResponse.json(
        { success: false, error: "Proposal not found or expired" },
        { status: 404 }
      );
    }

    const server = StorageService.getServerById(proposal.targetServerId);
    if (!server) {
      return NextResponse.json(
        { success: false, error: "Target server host not found" },
        { status: 404 }
      );
    }

    // Log approval audit event
    StorageService.logAuditEvent({
      actor: "operator",
      eventType: "ai_proposal_approved",
      targetServerId: server.id,
      targetServerName: server.name,
      status: "success",
      details: {
        proposalId: proposal.id,
        title: proposal.title,
        riskLevel: proposal.riskLevel,
        clientToken: parsed.clientToken.substring(0, 8) + "...",
      },
    });

    // Execute each command sequentially
    const commandOutputs: string[] = [];
    let overallSuccess = true;

    for (const cmd of proposal.commands) {
      try {
        const res = await SSHAdapter.executeCommand(server, cmd);
        commandOutputs.push(`$ ${cmd}\n[exit: ${res.code}]\n${res.stdout || res.stderr}`);
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
      }
    }

    // Update proposal record
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
