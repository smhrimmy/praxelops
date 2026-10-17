import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { AuthService } from "@/lib/security/auth";
import { CommandExecuteSchema } from "@/types/ssh";

// Uses node:sqlite (via the storage layer), which only exists on the Node.js runtime.
export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const auth = AuthService.authenticateRequest(request);
    if (!auth.authenticated) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status ?? 401 });
    }

    if (!AuthService.checkPayloadSize(request, 65536)) {
      return NextResponse.json({ success: false, error: "Payload too large" }, { status: 413 });
    }

    const rate = AuthService.checkRateLimit(`client-ssh-${auth.operatorId}`, 60, 60);
    if (!rate.allowed) {
      return NextResponse.json({ success: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const body = await request.json();
    const parsed = CommandExecuteSchema.parse(body);

    const server = StorageService.getServerById(parsed.serverId);
    if (!server) {
      return NextResponse.json(
        { success: false, error: "Server host not found in inventory" },
        { status: 404 }
      );
    }

    const result = await SSHAdapter.executeCommand(
      server,
      parsed.command,
      parsed.timeoutMs
    );

    // Audit the command execution with secret-redacted metadata
    StorageService.logAuditEvent({
      actor: auth.operatorId,
      eventType: "command_exec",
      targetServerId: server.id,
      targetServerName: server.name,
      command: parsed.command,
      status: result.code === 0 ? "success" : "failure",
      details: AuthService.redactSecrets({
        code: result.code,
        durationMs: result.durationMs,
        hasStderr: result.stderr.length > 0,
      }),
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
