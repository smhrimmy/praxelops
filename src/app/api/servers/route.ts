import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { AuthService } from "@/lib/security/auth";
import { ServerHostSchema } from "@/types/server";
import { toPublicServer } from "@/lib/servers/publicServer";

// Uses node:sqlite (via the storage layer), which only exists on the Node.js runtime.
export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    const rate = AuthService.checkRateLimit("client-servers-get", 120, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    // Never decrypts credentials: the listing only needs presence flags.
    return NextResponse.json({ success: true, data: StorageService.getPublicServers() });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    if (!AuthService.checkPayloadSize(request, 65536)) {
      return NextResponse.json({ success: false, error: "Payload too large" }, { status: 413 });
    }

    const rate = AuthService.checkRateLimit("client-servers-post", 30, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const body = await request.json();
    const parsed = ServerHostSchema.parse(body);

    const newServer = {
      ...parsed,
      id: parsed.id || `srv-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      status: "checking" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: parsed.tags || [],
    };

    StorageService.saveServer(newServer);

    StorageService.logAuditEvent({
      actor: auth.operatorId,
      eventType: "server_created",
      targetServerId: newServer.id,
      targetServerName: newServer.name,
      status: "success",
      details: { host: newServer.host, port: newServer.port },
    });

    return NextResponse.json({ success: true, data: toPublicServer(newServer) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Server ID is required" }, { status: 400 });
    }

    const server = StorageService.getPublicServerById(id);
    const removed = StorageService.deleteServer(id);
    if (!removed) {
      return NextResponse.json({ success: false, error: "Server not found" }, { status: 404 });
    }

    StorageService.logAuditEvent({
      actor: auth.operatorId,
      eventType: "server_deleted",
      targetServerId: id,
      targetServerName: server?.name,
      status: "success",
    });

    return NextResponse.json({ success: true, data: { id } });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
