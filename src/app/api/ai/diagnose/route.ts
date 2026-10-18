import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { AIDiagnosticsEngine } from "@/lib/ai/diagnostics";
import { AuthService } from "@/lib/security/auth";
import { getFreshTelemetry, getHealthView } from "@/lib/metrics/view";

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

    // Analyse REAL telemetry only: the latest fresh collected sample (same mapping as GET /api/servers). Metrics
    // stored inside the server record (demo seed data) are ignored; with no fresh sample the engine takes its honest
    // "no telemetry" path and is told why (health reason) instead of being given invented numbers.
    const telemetry = getFreshTelemetry(server.id);
    const { metrics: _storedMetrics, ...serverWithoutStoredMetrics } = server;
    void _storedMetrics;
    const analysed = telemetry ? { ...serverWithoutStoredMetrics, metrics: telemetry.metrics } : serverWithoutStoredMetrics;
    const health = telemetry ? undefined : getHealthView(server.id);
    const healthReason = telemetry
      ? undefined
      : (health?.reason ??
        (health
          ? `the last successful sample is ${health.sampleAgeSeconds ?? "unknown"}s old, which is too old to analyse; check that the metrics collector is running`
          : "no metrics sample has been collected for this host yet; run the metrics collector (npm run collector) or refresh its metrics"));
    const report = AIDiagnosticsEngine.analyzeServer(analysed, { healthReason });
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
