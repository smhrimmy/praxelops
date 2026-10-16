import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { AIDiagnosticsEngine } from "@/lib/ai/diagnostics";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const serverId = body.serverId;

    if (!serverId) {
      return NextResponse.json(
        { success: false, error: "serverId is required" },
        { status: 400 }
      );
    }

    const server = StorageService.getServerById(serverId);
    if (!server) {
      return NextResponse.json(
        { success: false, error: "Server host not found" },
        { status: 404 }
      );
    }

    const report = AIDiagnosticsEngine.analyzeServer(server);
    StorageService.saveDiagnostic(report);

    // Save proposals for approval
    for (const proposal of report.proposals) {
      StorageService.saveProposal(proposal);
      StorageService.logAuditEvent({
        actor: "ai-copilot",
        eventType: "ai_proposal_created",
        targetServerId: server.id,
        targetServerName: server.name,
        status: "success",
        details: {
          proposalId: proposal.id,
          title: proposal.title,
          riskLevel: proposal.riskLevel,
        },
      });
    }

    return NextResponse.json({ success: true, data: report });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
