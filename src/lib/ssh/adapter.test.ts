import { describe, it, expect } from "vitest";
import { SSHAdapter } from "./adapter";
import { ServerHost } from "@/types/server";

describe("SSHAdapter", () => {
  const unreachableServer: ServerHost = {
    id: "srv-unreachable-01",
    name: "Unreachable Host",
    host: "127.0.0.1",
    port: 54321, // No daemon listening on this port
    username: "testuser",
    authType: "password",
    tags: ["test"],
    status: "offline",
    osType: "linux",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("handles unreachable connection failures honestly without mock fallback", async () => {
    await expect(
      SSHAdapter.executeCommand(unreachableServer, "uname -a", 2000)
    ).rejects.toThrow(/SSH connection to 127\.0\.0\.1:54321 failed/);
  });

  it("rejects SFTP paths containing null bytes", async () => {
    await expect(
      SSHAdapter.listSFTPDirectory(unreachableServer, "/var/log\0/malicious")
    ).rejects.toThrow("Invalid remote path containing null bytes");

    await expect(
      SSHAdapter.readSFTPFile(unreachableServer, "/etc/shadow\0.txt")
    ).rejects.toThrow("Invalid path containing null bytes");
  });

  it("handles non-existent session resizing and closure gracefully", () => {
    const resized = SSHAdapter.resizeSession("non-existent-session-id", 24, 80);
    expect(resized).toBe(false);

    expect(() => SSHAdapter.closeSession("non-existent-session-id")).not.toThrow();
  });
});
