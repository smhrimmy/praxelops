import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { ServerHostSchema } from "@/types/server";

export async function GET() {
  try {
    const servers = StorageService.getServers();
    return NextResponse.json({ success: true, data: servers });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
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
      actor: "operator",
      eventType: "server_created",
      targetServerId: newServer.id,
      targetServerName: newServer.name,
      status: "success",
      details: { host: newServer.host, port: newServer.port },
    });

    return NextResponse.json({ success: true, data: newServer }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) {
      return NextResponse.json({ success: false, error: "Server ID is required" }, { status: 400 });
    }

    const server = StorageService.getServerById(id);
    const removed = StorageService.deleteServer(id);
    if (!removed) {
      return NextResponse.json({ success: false, error: "Server not found" }, { status: 404 });
    }

    StorageService.logAuditEvent({
      actor: "operator",
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
