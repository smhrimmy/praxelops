import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { AuthService } from "@/lib/security/auth";
import { TicketService } from "@/lib/security/ticket";

export async function POST(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    const rate = AuthService.checkRateLimit(`ticket:${auth.operatorId}`, 60, 60);
    if (!rate.allowed) {
      return NextResponse.json(
        { success: false, error: "Rate limit exceeded for ticket issuance" },
        { status: 429 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const { serverId } = body;

    if (!serverId || typeof serverId !== "string") {
      return NextResponse.json(
        { success: false, error: "Target serverId is required" },
        { status: 400 }
      );
    }

    const server = StorageService.getServerById(serverId);
    if (!server) {
      return NextResponse.json(
        { success: false, error: `Server '${serverId}' not found in fleet inventory` },
        { status: 404 }
      );
    }

    const origin = request.headers.get("origin") || undefined;
    const purpose = typeof body.purpose === "string" ? body.purpose : "terminal_shell";

    // Issue short-lived, single-use ticket (60s TTL) bound to operator, server, origin, purpose
    const ticketObj = TicketService.issueTicket(auth.operatorId, server.id, {
      ttlSeconds: 60,
      origin,
      purpose,
    });

    StorageService.logAuditEvent({
      actor: auth.operatorId,
      eventType: "ssh_connect",
      targetServerId: server.id,
      targetServerName: server.name,
      status: "success",
      details: { action: "ticket_issued", expiresIn: 60, purpose },
    });

    return NextResponse.json({
      success: true,
      ticket: ticketObj.ticket,
      serverId: server.id,
      serverName: server.name,
      expiresIn: 60,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
