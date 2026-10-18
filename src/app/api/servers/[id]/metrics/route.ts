import { NextResponse } from "next/server";
import { z } from "zod";
import { StorageService } from "@/lib/storage";
import { AuthService } from "@/lib/security/auth";
import { getHealthView, getHistory, MAX_HISTORY_POINTS } from "@/lib/metrics/view";

// Uses node:sqlite (via the storage layer), which only exists on the Node.js runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HoursSchema = z.coerce.number().int().min(1).max(24);

/** History of successful samples for the last `hours` (1..24, default 1), downsampled to at most 360 points. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    const rate = AuthService.checkRateLimit(`client-metrics-history-${auth.operatorId}`, 120, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const rawHours = new URL(request.url).searchParams.get("hours");
    const hours = HoursSchema.safeParse(rawHours === null || rawHours === "" ? 1 : rawHours);
    if (!hours.success) {
      return NextResponse.json({ success: false, error: "hours must be an integer between 1 and 24" }, { status: 400 });
    }

    const { id } = await context.params;
    if (!StorageService.getPublicServerById(id)) {
      return NextResponse.json({ success: false, error: "Server not found" }, { status: 404 });
    }

    const { points, rawCount } = getHistory(id, hours.data);
    return NextResponse.json({
      success: true,
      data: {
        serverId: id,
        hours: hours.data,
        maxPoints: MAX_HISTORY_POINTS,
        rawCount,
        points,
        health: getHealthView(id),
      },
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: (error as Error).message }, { status: 500 });
  }
}
