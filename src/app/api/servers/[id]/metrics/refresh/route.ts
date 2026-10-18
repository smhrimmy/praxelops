import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { AuthService } from "@/lib/security/auth";
import { collectAndStoreShared, ServerNotFoundError } from "@/lib/metrics/collector";
import { DEFAULT_PROBE_TIMEOUT_MS } from "@/lib/metrics/config";
import { getHealthView, sampleToSystemMetrics } from "@/lib/metrics/view";

// Uses node:sqlite and ssh2, which only exist on the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sample one server right now (fixed read-only probe, 10s timeout), store the result and return it.
 * Only hosts whose SSH host key is already pinned are contacted; this route never enrolls a host key.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    // Non-GET: authenticateRequest also enforces CSRF token + Origin for cookie sessions.
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    const rate = AuthService.checkRateLimit(`client-metrics-refresh-${auth.operatorId}`, 30, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const { id } = await context.params;
    const server = StorageService.getPublicServerById(id);
    if (!server) {
      return NextResponse.json({ success: false, error: "Server not found" }, { status: 404 });
    }

    const { outcome, record } = await collectAndStoreShared(id, {
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      actor: auth.operatorId,
    });

    const health = getHealthView(id);
    if (outcome.ok) {
      return NextResponse.json({
        success: true,
        data: {
          ok: true,
          collectedAt: outcome.collectedAt,
          sample: outcome.sample,
          metrics: sampleToSystemMetrics(outcome.sample, outcome.collectedAt),
          stored: record !== null,
          health,
        },
      });
    }
    return NextResponse.json({
      success: true,
      data: {
        ok: false,
        reason: outcome.reason,
        message: outcome.message,
        collectedAt: outcome.collectedAt,
        stored: record !== null,
        health,
      },
    });
  } catch (error) {
    if (error instanceof ServerNotFoundError) {
      return NextResponse.json({ success: false, error: "Server not found" }, { status: 404 });
    }
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
