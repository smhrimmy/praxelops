import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { AuthService } from "@/lib/security/auth";
import { getLatestView } from "@/lib/metrics/view";

// Uses node:sqlite (via the storage layer), which only exists on the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The newest successful sample in full (disks, swap, top processes, systemd services), its age, whether it is still
 * fresh (<= 3x the collection interval) and the host health. `sample` is null if the host was never sampled; nothing
 * is invented in that case.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    const rate = AuthService.checkRateLimit(`client-metrics-latest-${auth.operatorId}`, 240, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const { id } = await context.params;
    if (!StorageService.getPublicServerById(id)) {
      return NextResponse.json({ success: false, error: "Server not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: { serverId: id, ...getLatestView(id) } });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
