import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { AuthService } from "@/lib/security/auth";
import { SSHConnectSchema } from "@/types/ssh";

export async function POST(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const action = body.action || "create";

    if (action === "ticket") {
      const { serverId } = body;
      if (!serverId) {
        return NextResponse.json({ success: false, error: "serverId required" }, { status: 400 });
      }
      const { TicketService } = await import("@/lib/security/ticket");
      const server = StorageService.getServerById(serverId);
      if (!server) {
        return NextResponse.json({ success: false, error: "Server not found" }, { status: 404 });
      }
      const ticketObj = TicketService.issueTicket(auth.operatorId, server.id, 60);
      return NextResponse.json({
        success: true,
        ticket: ticketObj.ticket,
        serverId: server.id,
        expiresIn: 60,
      });
    }

    if (action === "resize") {
      const { sessionId, rows, cols } = body;
      if (!sessionId || !rows || !cols) {
        return NextResponse.json(
          { success: false, error: "sessionId, rows, and cols required" },
          { status: 400 }
        );
      }
      const ok = SSHAdapter.resizeSession(sessionId, rows, cols);
      return NextResponse.json({ success: ok });
    }

    if (action === "input") {
      const { sessionId, data } = body;
      if (!sessionId || typeof data !== "string") {
        return NextResponse.json(
          { success: false, error: "sessionId and data string required" },
          { status: 400 }
        );
      }
      const ok = SSHAdapter.sendInput(sessionId, data);
      return NextResponse.json({ success: ok });
    }

    if (action === "close") {
      const { sessionId } = body;
      if (sessionId) {
        SSHAdapter.closeSession(sessionId);
      }
      return NextResponse.json({ success: true });
    }

    // Default: Spawn new interactive session
    const parsed = SSHConnectSchema.parse(body);
    const server = StorageService.getServerById(parsed.serverId);
    if (!server) {
      return NextResponse.json(
        { success: false, error: "Server host not found in inventory" },
        { status: 404 }
      );
    }

    const sessionId = `sess-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    await SSHAdapter.createInteractiveSession(sessionId, server, {
      rows: parsed.rows,
      cols: parsed.cols,
      term: parsed.term,
    });

    StorageService.logAuditEvent({
      actor: auth.operatorId,
      eventType: "ssh_connect",
      targetServerId: server.id,
      targetServerName: server.name,
      status: "success",
      details: { sessionId, term: parsed.term, cols: parsed.cols, rows: parsed.rows },
    });

    return NextResponse.json({
      success: true,
      data: {
        sessionId,
        serverId: server.id,
        serverName: server.name,
        host: server.host,
        status: "connected",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
