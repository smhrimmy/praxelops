import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { SSHAdapter } from "@/lib/ssh/adapter";
import { CommandExecuteSchema } from "@/types/ssh";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = CommandExecuteSchema.parse(body);

    const server = StorageService.getServerById(parsed.serverId);
    if (!server) {
      return NextResponse.json(
        { success: false, error: "Server host not found" },
        { status: 404 }
      );
    }

    const result = await SSHAdapter.executeCommand(
      server,
      parsed.command,
      parsed.timeoutMs
    );

    // Audit the command execution
    StorageService.logAuditEvent({
      actor: "operator",
      eventType: "command_exec",
      targetServerId: server.id,
      targetServerName: server.name,
      command: parsed.command,
      status: result.code === 0 ? "success" : "failure",
      details: {
        code: result.code,
        durationMs: result.durationMs,
        hasStderr: result.stderr.length > 0,
      },
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
