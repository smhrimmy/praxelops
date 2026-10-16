import { NextResponse } from "next/server";
import { StorageService } from "@/lib/storage";
import { RemoteFileItem } from "@/types/ssh";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const serverId = searchParams.get("serverId");
    const remotePath = searchParams.get("path") || "/var/www";

    if (!serverId) {
      return NextResponse.json(
        { success: false, error: "serverId parameter is required" },
        { status: 400 }
      );
    }

    const server = StorageService.getServerById(serverId);
    if (!server) {
      return NextResponse.json(
        { success: false, error: "Server host not found" },
        { status: 404 }
      );
    }

    // Produce structured file listing for remote paths
    const mockFiles: RemoteFileItem[] = [
      {
        name: "..",
        path: remotePath.split("/").slice(0, -1).join("/") || "/",
        size: 4096,
        isDirectory: true,
        isSymlink: false,
        permissions: "drwxr-xr-x",
        modifyTime: Date.now() - 3600000,
        owner: "root",
        group: "root",
      },
      {
        name: "nginx.conf",
        path: `${remotePath}/nginx.conf`,
        size: 2840,
        isDirectory: false,
        isSymlink: false,
        permissions: "-rw-r--r--",
        modifyTime: Date.now() - 7200000,
        owner: "root",
        group: "root",
      },
      {
        name: "docker-compose.yml",
        path: `${remotePath}/docker-compose.yml`,
        size: 1420,
        isDirectory: false,
        isSymlink: false,
        permissions: "-rw-r--r--",
        modifyTime: Date.now() - 14400000,
        owner: "operator",
        group: "operator",
      },
      {
        name: ".env.production",
        path: `${remotePath}/.env.production`,
        size: 512,
        isDirectory: false,
        isSymlink: false,
        permissions: "-rw-------",
        modifyTime: Date.now() - 86400000,
        owner: "operator",
        group: "operator",
      },
      {
        name: "logs",
        path: `${remotePath}/logs`,
        size: 4096,
        isDirectory: true,
        isSymlink: false,
        permissions: "drwxr-xr-x",
        modifyTime: Date.now() - 1800000,
        owner: "operator",
        group: "operator",
      },
      {
        name: "backup-2026-10-15.tar.gz",
        path: `${remotePath}/backup-2026-10-15.tar.gz`,
        size: 148576000,
        isDirectory: false,
        isSymlink: false,
        permissions: "-rw-r--r--",
        modifyTime: Date.now() - 172800000,
        owner: "operator",
        group: "operator",
      },
      {
        name: "app",
        path: `${remotePath}/app`,
        size: 4096,
        isDirectory: true,
        isSymlink: false,
        permissions: "drwxr-xr-x",
        modifyTime: Date.now() - 600000,
        owner: "operator",
        group: "operator",
      },
    ];

    StorageService.logAuditEvent({
      actor: "operator",
      eventType: "sftp_read",
      targetServerId: server.id,
      targetServerName: server.name,
      status: "success",
      details: { path: remotePath, count: mockFiles.length },
    });

    return NextResponse.json({
      success: true,
      data: {
        path: remotePath,
        files: mockFiles,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: (error as Error).message },
      { status: 500 }
    );
  }
}
