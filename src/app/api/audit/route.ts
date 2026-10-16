import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const serverId = searchParams.get("serverId");
    const limit = parseInt(searchParams.get("limit") || "100", 10);

    let events = StorageService.getAuditEvents();
    if (serverId) {
      events = events.filter((e) => e.targetServerId === serverId);
    }
    events = events.slice(0, limit);

    return NextResponse.json({ success: true, data: events });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
