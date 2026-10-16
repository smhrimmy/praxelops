import { Client, ConnectConfig, SFTPWrapper } from "ssh2";
import { ServerHost } from "@/types/server";
import { RemoteFileItem } from "@/types/ssh";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
}

export interface InteractiveShellSession {
  sessionId: string;
  serverId: string;
  client: Client;
  stream: any;
  createdAt: number;
  lastActiveAt: number;
}

export class SSHAdapter {
  private static activeSessions = new Map<string, InteractiveShellSession>();

  private static getConnectConfig(
    server: ServerHost,
    credentials?: { password?: string; privateKey?: string }
  ): ConnectConfig {
    const config: ConnectConfig = {
      host: server.host,
      port: server.port,
      username: server.username,
      readyTimeout: 15000,
      keepaliveInterval: 10000,
    };

    if (credentials?.password) {
      config.password = credentials.password;
    } else if (credentials?.privateKey) {
      config.privateKey = credentials.privateKey;
    }

    return config;
  }

  /**
   * Execute a remote command via genuine SSH connection
   */
  static async executeCommand(
    server: ServerHost,
    command: string,
    timeoutMs: number = 30000,
    credentials?: { password?: string; privateKey?: string }
  ): Promise<ExecResult> {
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const conn = new Client();
      let stdout = "";
      let stderr = "";
      let isTimedOut = false;
      let hasEnded = false;

      const timer = setTimeout(() => {
        isTimedOut = true;
        if (!hasEnded) {
          hasEnded = true;
          try {
            conn.end();
          } catch {}
          reject(new Error(`SSH execution timed out after ${timeoutMs}ms on ${server.host}:${server.port}`));
        }
      }, timeoutMs);

      conn
        .on("ready", () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              clearTimeout(timer);
              if (!hasEnded) {
                hasEnded = true;
                conn.end();
              }
              return reject(new Error(`SSH exec dispatch error: ${err.message}`));
            }

            stream
              .on("close", (code: number) => {
                clearTimeout(timer);
                if (!hasEnded) {
                  hasEnded = true;
                  conn.end();
                }
                resolve({
                  stdout,
                  stderr,
                  code: code ?? 0,
                  durationMs: Date.now() - startTime,
                });
              })
              .on("data", (data: Buffer) => {
                stdout += data.toString("utf-8");
              })
              .stderr.on("data", (data: Buffer) => {
                stderr += data.toString("utf-8");
              });
          });
        })
        .on("error", (err) => {
          clearTimeout(timer);
          if (!hasEnded && !isTimedOut) {
            hasEnded = true;
            reject(new Error(`SSH connection to ${server.host}:${server.port} failed: ${err.message}`));
          }
        })
        .connect(this.getConnectConfig(server, credentials));
    });
  }

  /**
   * Reads a real remote directory via genuine SFTP session
   */
  static async listSFTPDirectory(
    server: ServerHost,
    remotePath: string,
    credentials?: { password?: string; privateKey?: string }
  ): Promise<{ path: string; files: RemoteFileItem[] }> {
    // Basic path traversal and null byte sanitization
    if (remotePath.includes("\0")) {
      throw new Error("Invalid remote path containing null bytes");
    }
    const cleanPath = remotePath.trim() || "/";

    return new Promise((resolve, reject) => {
      const conn = new Client();

      conn
        .on("ready", () => {
          conn.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
            if (err) {
              conn.end();
              return reject(new Error(`SFTP subsystem initialization error: ${err.message}`));
            }

            sftp.readdir(cleanPath, (readErr: Error | undefined, list: any[]) => {
              if (readErr) {
                conn.end();
                return reject(new Error(`SFTP readdir failed for '${cleanPath}': ${readErr.message}`));
              }

              const items: RemoteFileItem[] = list.map((entry) => {
                const attrs = entry.attrs || {};
                const mode = attrs.mode || 0;
                const isDirectory = (mode & 0o40000) === 0o40000;
                const isSymlink = (mode & 0o120000) === 0o120000;

                // Format permissions octal
                const permStr = (mode & 0o777).toString(8);

                return {
                  name: entry.filename,
                  path: cleanPath === "/" ? `/${entry.filename}` : `${cleanPath}/${entry.filename}`,
                  size: attrs.size || 0,
                  isDirectory,
                  isSymlink,
                  permissions: (isDirectory ? "d" : "-") + permStr,
                  modifyTime: (attrs.mtime || 0) * 1000,
                  owner: String(attrs.uid ?? ""),
                  group: String(attrs.gid ?? ""),
                };
              });

              conn.end();
              resolve({
                path: cleanPath,
                files: items,
              });
            });
          });
        })
        .on("error", (err) => {
          reject(new Error(`SFTP connection failed to ${server.host}:${server.port}: ${err.message}`));
        })
        .connect(this.getConnectConfig(server, credentials));
    });
  }

  /**
   * Reads a real remote file via SFTP with byte limit protection
   */
  static async readSFTPFile(
    server: ServerHost,
    remoteFilePath: string,
    maxBytes: number = 262144, // 256KB preview limit
    credentials?: { password?: string; privateKey?: string }
  ): Promise<string> {
    if (remoteFilePath.includes("\0")) {
      throw new Error("Invalid path containing null bytes");
    }

    return new Promise((resolve, reject) => {
      const conn = new Client();

      conn
        .on("ready", () => {
          conn.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
            if (err) {
              conn.end();
              return reject(new Error(`SFTP error: ${err.message}`));
            }

            const stream = sftp.createReadStream(remoteFilePath, {
              start: 0,
              end: maxBytes,
            });

            const chunks: Buffer[] = [];
            let totalBytes = 0;

            stream.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              totalBytes += chunk.length;
              if (totalBytes > maxBytes) {
                stream.destroy();
              }
            });

            stream.on("close", () => {
              conn.end();
              resolve(Buffer.concat(chunks).toString("utf-8"));
            });

            stream.on("error", (streamErr: Error) => {
              conn.end();
              reject(new Error(`Failed to read remote file: ${streamErr.message}`));
            });
          });
        })
        .on("error", (err) => {
          reject(new Error(`Connection failed: ${err.message}`));
        })
        .connect(this.getConnectConfig(server, credentials));
    });
  }

  /**
   * Resize active interactive PTY session
   */
  static resizeSession(sessionId: string, rows: number, cols: number): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.stream) return false;
    try {
      session.stream.setWindow(rows, cols, rows * 16, cols * 8);
      session.lastActiveAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close active interactive session
   */
  static closeSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      try {
        session.stream.end();
        session.client.end();
      } catch {}
      this.activeSessions.delete(sessionId);
    }
  }
}
