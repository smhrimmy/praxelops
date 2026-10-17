import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { AIDiagnosticsEngine } from "@/lib/ai/diagnostics";
import { AuthService } from "@/lib/security/auth";

// Uses node:sqlite (via the storage layer), which only exists on the Node.js runtime.
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    const rate = AuthService.checkRateLimit(`client-ai-diag-${auth.operatorId}`, 30, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
    }

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
        { success: false, error: "Server host not found in inventory" },
        { status: 404 }
      );
    }

    const report = AIDiagnosticsEngine.analyzeServer(server);
    StorageService.saveDiagnostic(report);

    for (const proposal of report.proposals) {
      StorageService.saveProposal(proposal);
      StorageService.logAuditEvent({
        actor: auth.operatorId,
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
