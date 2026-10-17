import crypto from "node:crypto";
import { Server, ServerChannel, Session } from "ssh2";

export interface TestSshServerInstance {
  server: Server;
  port: number;
  hostKeyPem: string;
  close: () => Promise<void>;
}

export interface TestSshServerOptions {
  username?: string;
  password?: string;
  hostKeyPem?: string;
  /** Fixed listen port (default 0 = ephemeral). Lets tests restart a server on the same port. */
  port?: number;
}

export function generateTestRsaKey(): string {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return privateKey;
}

export function startTestSshServer(options: TestSshServerOptions = {}): Promise<TestSshServerInstance> {
  const validUser = options.username || "testuser";
  const validPass = options.password || "secret123";
  const hostKey = options.hostKeyPem || generateTestRsaKey();

  return new Promise((resolve, reject) => {
    const server = new Server(
      {
        hostKeys: [hostKey],
      },
      (client) => {
        client.on("authentication", (ctx) => {
          if (ctx.method === "password") {
            if (ctx.username === validUser && ctx.password === validPass) {
              ctx.accept();
            } else {
              ctx.reject(["password"]);
            }
          } else {
            ctx.reject(["password"]);
          }
        });

        client.on("ready", () => {
          client.on("session", (acceptSession) => {
            const session: Session = acceptSession();

            // PTY Allocation
            session.on("pty", (acceptPty) => {
              acceptPty();
            });

            // Window change (Resize)
            session.on("window-change", (acceptWin) => {
              if (typeof acceptWin === "function") {
                acceptWin();
              }
            });

            // Interactive Shell
            session.on("shell", (acceptShell) => {
              const stream: ServerChannel = acceptShell();

              // Banner
              stream.write("\x1b[32mPraxelOps Controlled Test Shell\x1b[0m\r\n$ ");

              stream.on("data", (data: Buffer) => {
                const input = data.toString("utf-8");
                // Echo characters back
                if (input === "\r") {
                  stream.write("\r\n$ ");
                } else if (input.includes("uname")) {
                  stream.write("Linux praxelops-test-node 6.8.0 #1 SMP x86_64 GNU/Linux\r\n$ ");
                } else if (input.includes("echo")) {
                  stream.write(input.replace("echo", "").trim() + "\r\n$ ");
                } else {
                  stream.write(input);
                }
              });

              stream.on("close", () => {
                // Shell closed
              });
            });

            // Exec command
            session.on("exec", (acceptExec, _rejectExec, info) => {
              const stream: ServerChannel = acceptExec();
              const cmd = info.command.trim();

              if (cmd.startsWith("uname")) {
                stream.write("Linux praxelops-test-node 6.8.0 #1 SMP x86_64 GNU/Linux\n");
                stream.exit(0);
                stream.end();
              } else if (cmd.startsWith("echo")) {
                stream.write(cmd.substring(5).trim() + "\n");
                stream.exit(0);
                stream.end();
              } else {
                stream.write(`Executed: ${cmd}\n`);
                stream.exit(0);
                stream.end();
              }
            });

            // SFTP subsystem
            session.on("sftp", (acceptSftp) => {
              const sftp = acceptSftp();
              const openHandles = new Map<string, string>();

              sftp.on("REALPATH", (reqid, path) => {
                sftp.name(reqid, [
                  {
                    filename: path === "." ? "/" : path,
                    longname: path === "." ? "/" : path,
                    attrs: { mode: 0o040755, uid: 1000, gid: 1000, size: 4096, atime: 0, mtime: 0 },
                  },
                ]);
              });

              sftp.on("STAT", (reqid) => {
                sftp.attrs(reqid, {
                  mode: 0o040755,
                  uid: 1000,
                  gid: 1000,
                  size: 4096,
                  atime: Math.floor(Date.now() / 1000),
                  mtime: Math.floor(Date.now() / 1000),
                });
              });

              sftp.on("OPENDIR", (reqid, path) => {
                const handle = Buffer.from(`dir-${Date.now()}`);
                openHandles.set(handle.toString("hex"), path);
                sftp.handle(reqid, handle);
              });

              sftp.on("READDIR", (reqid, handle) => {
                const path = openHandles.get(handle.toString("hex"));
                if (path) {
                  openHandles.delete(handle.toString("hex")); // return once
                  sftp.name(reqid, [
                    {
                      filename: "app.conf",
                      longname: "-rw-r--r-- 1 operator operator 128 Oct 16 12:00 app.conf",
                      attrs: { mode: 0o100644, uid: 1000, gid: 1000, size: 128, atime: 1729080000, mtime: 1729080000 },
                    },
                    {
                      filename: "logs",
                      longname: "drwxr-xr-x 2 operator operator 4096 Oct 16 12:00 logs",
                      attrs: { mode: 0o040755, uid: 1000, gid: 1000, size: 4096, atime: 1729080000, mtime: 1729080000 },
                    },
                  ]);
                } else {
                  sftp.status(reqid, 1); // SSH_FX_EOF
                }
              });

              sftp.on("OPEN", (reqid, path) => {
                const handle = Buffer.from(`file-${Date.now()}`);
                openHandles.set(handle.toString("hex"), path);
                sftp.handle(reqid, handle);
              });

              sftp.on("READ", (reqid, handle) => {
                const path = openHandles.get(handle.toString("hex"));
                if (path) {
                  const content = Buffer.from(`# PraxelOps Configuration File\r\nNODE_ENV=production\r\nPORT=8080\r\n`);
                  openHandles.delete(handle.toString("hex"));
                  sftp.data(reqid, content);
                } else {
                  sftp.status(reqid, 1); // SSH_FX_EOF
                }
              });

              sftp.on("CLOSE", (reqid, handle) => {
                openHandles.delete(handle.toString("hex"));
                sftp.status(reqid, 0); // SSH_FX_OK
              });
            });
          });
        });
      }
    );

    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        port,
        hostKeyPem: hostKey,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });

    server.on("error", (err: Error) => {
      reject(err);
    });
  });
}
