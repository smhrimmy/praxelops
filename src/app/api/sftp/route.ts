import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { AuthService } from "@/lib/security/auth";

export async function GET(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: 401 });
    }

    const rate = AuthService.checkRateLimit(`client-sftp-${auth.operatorId}`, 100, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const { searchParams } = new URL(request.url);
    const serverId = searchParams.get("serverId");
    const remotePath = searchParams.get("path") || "/";
    const action = searchParams.get("action");

    if (!serverId) {
      return NextResponse.json(
        { success: false, error: "serverId parameter is required" },
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

    if (action === "preview") {
      try {
        const content = await SSHAdapter.readSFTPFile(server, remotePath);
        return NextResponse.json({ success: true, data: { content, path: remotePath } });
      } catch (previewErr) {
        return NextResponse.json(
          { success: false, error: (previewErr as Error).message },
          { status: 422 }
        );
      }
    }

    try {
      const result = await SSHAdapter.listSFTPDirectory(server, remotePath);

      StorageService.logAuditEvent({
        actor: auth.operatorId,
        eventType: "sftp_read",
        targetServerId: server.id,
        targetServerName: server.name,
        status: "success",
        details: { path: remotePath, count: result.files.length },
      });

      return NextResponse.json({
        success: true,
        data: result,
      });
    } catch (sftpErr) {
      StorageService.logAuditEvent({
        actor: auth.operatorId,
        eventType: "sftp_read",
        targetServerId: server.id,
        targetServerName: server.name,
        status: "failure",
        details: { path: remotePath, error: (sftpErr as Error).message },
      });

      return NextResponse.json(
        {
          success: false,
          error: (sftpErr as Error).message,
        },
        { status: 502 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
