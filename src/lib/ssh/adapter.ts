import { Client, ConnectConfig, SFTPWrapper, ClientChannel } from "ssh2";
import { ServerHost } from "@/types/server";
import { RemoteFileItem } from "@/types/ssh";
import { KnownHostsService } from "./knownHosts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
}

export interface CreateSessionOptions {
  rows?: number;
  cols?: number;
  term?: string;
  onData?: (data: Buffer) => void;
  onClose?: (code?: number) => void;
  onError?: (err: Error) => void;
}

export interface InteractiveShellSession {
  sessionId: string;
  serverId: string;
  client: Client;
  stream: ClientChannel;
  createdAt: number;
  lastActiveAt: number;
  onData?: (data: Buffer) => void;
  onClose?: (code?: number) => void;
  onError?: (err: Error) => void;
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
      hostVerifier: (keyBuffer: Buffer) => {
        const verification = KnownHostsService.verifyHostKey(
          server.host,
          server.port,
          keyBuffer
        );
        if (!verification.verified) {
          throw new Error(verification.error || "Host key verification rejected");
        }
        return true;
      },
    };

    if (credentials?.password) {
      config.password = credentials.password;
    } else if (credentials?.privateKey) {
      config.privateKey = credentials.privateKey;
    } else if ((server as { password?: string }).password) {
      config.password = (server as { password?: string }).password;
    } else if ((server as { privateKey?: string }).privateKey) {
      config.privateKey = (server as { privateKey?: string }).privateKey;
    }

    return config;
  }

  /**
   * Execute a remote command via genuine SSH connection with host key verification
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
   * Reads a real remote directory via genuine SFTP session with host verification
   */
  static async listSFTPDirectory(
    server: ServerHost,
    remotePath: string,
    credentials?: { password?: string; privateKey?: string }
  ): Promise<{ path: string; files: RemoteFileItem[] }> {
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
   * Spawns an interactive PTY session with streaming channels
   */
  static async createInteractiveSession(
    sessionId: string,
    server: ServerHost,
    options: CreateSessionOptions = {},
    credentials?: { password?: string; privateKey?: string }
  ): Promise<{ sessionId: string; serverId: string }> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let hasResolved = false;

      conn
        .on("ready", () => {
          conn.shell(
            {
              term: options.term || "xterm-256color",
              rows: options.rows || 24,
              cols: options.cols || 80,
            },
            (err, stream) => {
              if (err) {
                conn.end();
                return reject(new Error(`PTY shell allocation failed: ${err.message}`));
              }

              const session: InteractiveShellSession = {
                sessionId,
                serverId: server.id,
                client: conn,
                stream,
                createdAt: Date.now(),
                lastActiveAt: Date.now(),
                onData: options.onData,
                onClose: options.onClose,
                onError: options.onError,
              };

              this.activeSessions.set(sessionId, session);

              stream.on("data", (chunk: Buffer) => {
                const s = this.activeSessions.get(sessionId);
                if (s) {
                  s.lastActiveAt = Date.now();
                }
                options.onData?.(chunk);
              });

              stream.on("close", (code?: number) => {
                options.onClose?.(code);
                this.closeSession(sessionId);
              });

              stream.on("error", (streamErr: Error) => {
                options.onError?.(streamErr);
                this.closeSession(sessionId);
              });

              hasResolved = true;
              resolve({ sessionId, serverId: server.id });
            }
          );
        })
        .on("error", (err) => {
          if (!hasResolved) {
            reject(new Error(`SSH interactive connection failed: ${err.message}`));
          } else {
            options.onError?.(err);
            this.closeSession(sessionId);
          }
        })
        .on("close", () => {
          this.closeSession(sessionId);
        })
        .connect(this.getConnectConfig(server, credentials));
    });
  }

  /**
   * Send stdin input chunk to an active session
   */
  static sendInput(sessionId: string, data: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.stream) return false;
    try {
      session.stream.write(data);
      session.lastActiveAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resize active interactive PTY session window
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
   * Pause stream reading (for backpressure handling)
   */
  static pauseStream(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.stream) return false;
    try {
      session.stream.pause();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resume stream reading (after client drains)
   */
  static resumeStream(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.stream) return false;
    try {
      session.stream.resume();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieve active session reference
   */
  static getSession(sessionId: string): InteractiveShellSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Close active interactive session and terminate underlying client
   */
  static closeSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      this.activeSessions.delete(sessionId);
      try {
        session.stream.removeAllListeners();
        session.stream.end();
        session.stream.destroy();
      } catch {}
      try {
        session.client.removeAllListeners();
        session.client.end();
        session.client.destroy();
      } catch {}
    }
  }

  /**
   * Reaper for inactive/idle interactive sessions
   */
  static cleanIdleSessions(maxIdleMs: number = 900000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, session] of this.activeSessions.entries()) {
      if (now - session.lastActiveAt > maxIdleMs) {
        this.closeSession(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  static getActiveSessionCount(): number {
    return this.activeSessions.size;
  }
}
