# PraxelOps Project Status & Real-Data Verification Audit

## 1. System Overview
- **Project**: PraxelOps
- **Runtime**: Node.js v24.11.0, Next.js 16.4.2 (Turbopack), React 19, TypeScript (strict), Tailwind CSS v4, SSH2, Vitest 5.0.5
- **Governance**: PEOS-v2 Specification (`PEOS.md`, `peos.manifest.json`)
- **Primary Goal**: Verified, portfolio-quality infrastructure platform without mock data or fabricated state.

> **Reading guide (updated 2026-10-17, end of Milestone 6).** Sections 2 to 6 are the historical record of Milestones 1 to 5 and are kept as written. Where a later milestone made a statement false or obsolete, it is flagged inline with a blockquote starting "**Superseded in M<n>**" or "**Correction (M6)**" (grep for those words). The current state of the system is described in Section 7 (Milestone 6), including the configuration reference (7.4) and open items (7.6).

---

## 2. Milestone 1 Verification & Audit Results

### 1. Verified Functionality
- **Storage Subsystem**: Persistent JSON storage for servers, audit events, proposals, and deployments. Confirmed clean initialization without fake servers.
- **Strict Domain Contracts**: Typed Zod validation for server inputs, command execution, and AI approvals.
- **macOS Studio Shell**: MenuBar, TrafficLights, Sidebar, CommandPalette (`⌘K`), dark/light theme switching, and responsive zero-scroll layouts.
- **SSH2 Backend Adapter**: Genuine `ssh2.Client` execution with timeout handling, disconnection cleanup, and exact exit-code/stream capture.
- **SFTP Remote Explorer**: Connected directly to `sftp.readdir` and `sftp.createReadStream` with byte-limited buffer streaming for configuration preview.
- **AI Approval Security Gate**: Cryptographic HMAC-SHA256 signature verification, server-host binding, expiration checking, single-use approval tokens, and dangerous command blocklist (`rm -rf /`, fork bombs, `mkfs`, raw disk writes).
- **Tamper-Evident Audit Logging**: Real events logged across all operations with honest status reporting (`success`, `failure`, `denied`).
  > **Correction (M6)**: "Tamper-evident" overstates the implementation. `audit.json` is a plain JSON array written atomically under a file lock (M6.1); there is no hash chain or signature, so tampering is not cryptographically detectable. An append-only hash chain is planned for M7 (see 7.6). The same wording in the M2 `/api/deployments` item and the M3 "Tamper-Evident Audit Trail" bullet should be read with this correction.

### 2. Partially Implemented Functionality
> **Superseded in M3**: the WebSocket PTY bridge listed as partial/next task here (and in item 7 below) was implemented in Milestone 3 (Section 4).

- **Interactive PTY Session Streaming**: Command execution and multi-tab terminal manager are fully integrated with real SSH2 execution; full bidirectional WebSocket raw ANSI byte-streaming remains an extension for ultra-high-frequency TUI interactions (e.g. interactive `htop` cursor movement).
- **Automated Health Polling Daemon**: Telemetry is parsed and reported upon collection; continuous background cron polling across remote nodes requires standing agent deployment.

### 3. Mock or Fabricated Data Removed
- **Fabricated Seed Servers**: Removed `srv-local-01`, `srv-prod-api-01`, and `srv-db-cluster-01` from default storage initialization. Normal production state starts at 0 configured servers.
- **Simulated Localhost Responses**: Removed `executeLocalOrSimulated` in `src/lib/ssh/adapter.ts` which returned fake `uname`, `uptime`, `df`, `free`, and `docker ps` outputs for `127.0.0.1`.
- **Mock SFTP Files**: Removed `mockFiles` array in `src/app/api/sftp/route.ts` which presented fake `nginx.conf`, `docker-compose.yml`, and `.env.production` files as real remote files.
- **Seed Deployment**: Removed `seedDeployment` in `src/app/api/deployments/route.ts` that fabricated a past successful release.
- **Unpolled Telemetry**: Configured honest `"Telemetry unpolled"` states instead of fake gauge numbers when a server has not yet reported metrics.
- **Explicit Demonstration Sandbox**: Added isolated, explicitly labeled `[DEMO]` sandbox loader (`/api/servers/demo`) available strictly on user demand, never auto-injected.

### 4. Security Defects Found and Fixed
- **Defect 1 (Client-Controlled AI Approval)**: The previous `/api/ai/approve` route trusted a client-provided boolean `confirmedByUser: true`.
  - *Fix*: Implemented `ApprovalSecurityService` with server-side HMAC-SHA256 proposal signing, 15-minute expiration, and strict server binding.
- **Defect 2 (Replay & Concurrent Double-Execution)**: Proposals could be replayed or submitted multiple times.
  - *Fix*: Atomic state lock transitions proposals to `"executing"` immediately upon verification and rejects any non-`pending_approval` proposal with HTTP 409.
- **Defect 3 (Command Injection & Destructive Payloads)**: No server-side inspection existed for destructive command execution.
  - *Fix*: Added automated regex safety scanner blocking destructive commands (`rm -rf /`, `mkfs`, `> /dev/sd*`, `dd`, fork bombs, `cat /etc/shadow`).
- **Defect 4 (Path Traversal in SFTP)**: Remote file paths were not sanitized against null bytes.
  - *Fix*: Added null-byte validation and clean path normalization in `SSHAdapter.listSFTPDirectory` and `readSFTPFile`.

### 5. Commands Actually Executed & Verified
1. `npx vitest run`:
   - `src/lib/storage/storage.test.ts` (4 tests passed)
   - `src/lib/ai/diagnostics.test.ts` (4 tests passed)
   - `src/lib/ai/approval.test.ts` (5 tests passed)
   - **Total: 13 passed in 3 test files (100% pass rate)**
2. `npm run typecheck` (`tsc --noEmit`):
   - **0 errors** (Strict TypeScript mode)
3. `npm run build` (`next build`):
   - **Compiled 11 static and dynamic routes successfully** via Turbopack in Next.js 16.4.2

### 6. Remaining External Prerequisites
- Configured remote Linux/macOS host with OpenSSH server running on accessible network/port.
- Valid authentication credentials (password or private key) provided by the operator.

### 7. Next Highest-Priority Implementation Task
- Implement WebSocket terminal bridge for raw bidirectional interactive PTY streaming (`client.shell()`).

---

## 3. Milestone 2 Authentication, Authorization & Hardening Audit Results

### 1. Implemented Authentication & Authorization Model
- **Trust Boundary & Architecture**: Single-tenant operator model designed for self-hosted/dedicated operations management.
- **Session & Token Verification**: All client-to-backend API routes require an operator session token passed via `Authorization: Bearer <token>` or `x-operator-token` header, or secure session cookie. Local development defaults to a secure loopback operator identity (`127.0.0.1` operator scope).
  > **Superseded in M6.3** (765cc6c): this was a Host-header based development bypass (any `Host` starting with `localhost` / `127.0.0.1` authenticated as `local-operator` and skipped CSRF, so look-alike hosts such as `localhost.evil.example` passed) together with a hard-coded `local-operator-token`. Both are removed in every `NODE_ENV`. Authentication is now an operator login (scrypt-hashed accounts, cookie session) in all environments; the `x-operator-token` header and `AuthService.verifyToken` no longer exist. See 7.5.
- **CSRF Protection**: Mutating methods (`POST`, `DELETE`, `PUT`, `PATCH`) enforce double-submit CSRF token validation (`x-csrf-token` header matching session CSRF secret).
- **Secure Master Key Management (`src/lib/security/secret.ts`)**:
  - In production (`NODE_ENV === 'production'`), startup immediately fails safely with a clear configuration error if `PRAXELOPS_SECRET` is unset or too short (<32 chars).
  - In local development, if `PRAXELOPS_SECRET` is unset, PraxelOps securely generates a high-entropy 256-bit cryptographic key stored in `.peos/config/master.key` (with restricted 0600 permissions where supported), ensuring secrets are never hardcoded in git.
- **Rate Limiting & Request Throttling (`src/lib/security/auth.ts`)**:
  - In-memory sliding-window rate limiting (60 requests per minute per client IP for standard endpoints, 10 req/min for AI diagnosis & approval execution).
  - Payload size limits enforced before parsing JSON (maximum 1 MB for command execution/diagnostics; 64 KB for server registrations).
- **Secret Redaction**:
  - `AuthService.redactSecrets` recursively inspects and redacts passwords, private keys, authorization tokens, and passphrase fields before audit log persistence or error emission.

### 2. Audited API Routes & Access-Control Rules
1. `/api/servers` (`GET`, `POST`, `DELETE`):
   - Strict operator authorization verified before retrieving, registering, or removing server nodes.
   - Server registration validates server ownership, validates SSH port range (1-65535), and prevents credential leakage.
   > **Correction (M6.4)** (7f25180): before M6.4 the `/api/servers` GET/POST and `/api/servers/demo` responses returned the stored server records unmodified, which can include `password`, `privateKey` and `passphrase`. They now return `hasPassword` / `hasPrivateKey` / `hasPassphrase` flags instead of the values (`src/lib/servers/publicServer.ts`). The stored secrets themselves are still plaintext at rest (7.6).
2. `/api/ssh/exec` (`POST`):
   - Validates operator session, rate limits (60/min), verifies server existence in storage.
   - Resolves stored credentials on backend; passwords/private keys are never sent in request bodies from the browser.
3. `/api/ssh/session` (`POST`):
   - Interactive PTY session manager supporting `create`, `resize`, `input`, and `close`.
   - Validates session tokens, window dimensions (`cols`, `rows`), and manages persistent `ssh2.ClientChannel`.
   > **Superseded in M6.5** (ab83d6c): this route was deleted (`src/app/api/ssh/session/route.ts`). It bypassed ticket binding and session ownership. The only interactive-terminal path is now the WebSocket gateway with single-use tickets; a regression test (`src/app/api/legacyRoutes.test.ts`) asserts the route file is gone.
4. `/api/sftp` (`POST`):
   - Requires operator authentication, sanitizes paths against null bytes and traversal attacks.
   - Enforces 2 MB read limits to prevent remote memory exhaustion.
5. `/api/ai/diagnose` (`POST`):
   - Redacts credentials before prompt generation; requires operator authorization; rate-limited (10/min).
   - Generates proposals strictly adhering to the typed `OperationPolicyEngine`.
6. `/api/ai/approve` (`POST`):
   - Enforces operator authentication, CSRF validation, and strict proposal HMAC-SHA256 signature verification.
   - Disallows arbitrary shell string execution; commands must match the canonical string computed by `OperationPolicyEngine`.
   - Prevents concurrency via atomic `"executing"` status transition.
7. `/api/deployments` (`GET`, `POST`):
   - Enforces operator authentication; validates target server existence; logs all deployment runs to tamper-evident audit storage.
8. `/api/audit` (`GET`):
   - Operator-only read access with pagination; strips internal secrets.
9. `/api/servers/demo` (`POST`):
   - Operator authorization required; isolated demo mode toggle with explicit `[DEMO]` flags.

### 3. AI Approval Security & Typed Operation Policy
- **Cryptographic Proposal Binding**:
  - HMAC-SHA256 signature computation binds: `proposalId`, `serverId`, `canonicalCommand`, `operationType`, and `expiresAt` (15-minute window).
  - Production master key is loaded strictly from environment or secure filesystem keyfile.
- **Typed Operation Policy Engine (`src/lib/ai/policy.ts`)**:
  - Replaced loose regex-only assumptions with a strict whitelist of typed operations:
    - `SERVICE_ACTION`: Validated system services (e.g., `nginx`, `docker`, `postgresql`) and safe actions (`restart`, `reload`, `status`).
    - `JOURNAL_VACUUM`: Clean systemd journal logs with validated retention (`2d`, `1w`).
    - `CACHE_TRIM`: Safe pagecache drops (`echo 3 > /proc/sys/vm/drop_caches`).
    - `PROCESS_SNAPSHOT`: Inspect resource usage via `ps` or `top`.
    - `CONTAINER_PRUNE`: Safe container pruning (`docker system prune -f`).
    - `PACKAGE_AUDIT`: Package update verification (`apt-get update -s`).
  - Strict parameter validation: Argument injection and shell chaining operators (`&&`, `||`, `;`, `|`, `` ` ``, `$()`, `>`, `<`) are rejected unless explicitly constructed by canonical policy generators.
- **Concurrency & Anti-Replay Safeguards**:
  - Replays and altered parameters fail cryptographic verification immediately.
  - In-flight execution locking prevents double-execution on concurrent clicks.

### 4. SSH & SFTP Integration Verification
- **Host-Key Verification (TOFU & Known-Hosts - `src/lib/ssh/knownHosts.ts`)**:
  - Implemented `KnownHostsService` with Trust-On-First-Use (TOFU) policy.
  - SSH host-key MD5/SHA256 fingerprints are recorded in `.peos/data/known_hosts.json`.
  - When a host key changes (indicating a potential Man-In-The-Middle attack or re-imaged node without operator confirmation), connection is aborted immediately with `SSH_HOST_KEY_MISMATCH`.
- **Interactive PTY vs. Command Execution**:
  - *Distinction*: Command execution (`client.exec()`) executes discrete non-interactive shell commands with stdin/stdout/stderr capture. Interactive terminal sessions require a pseudo-terminal PTY (`client.shell()`) handling window resize signals (`SIGWINCH`), raw ANSI escape streaming, and keystroke events.
  - *Implementation*: Added `SSHAdapter.createInteractiveSession()`, `resizeSession()`, `sendInput()`, and `closeSession()`, surfaced via `/api/ssh/session`.
  - *UI Status*: The current `TerminalView` component dispatches discrete commands via `/api/ssh/exec`. Continuous WebSocket streaming for bidirectional raw TUI (`htop`, `vim`) is scheduled for Milestone 3 desktop/web bridge integration.
  > **Superseded in M3 and M6.5**: `TerminalView` has used the WebSocket gateway with xterm.js since M3, and the `/api/ssh/session` surface mentioned above was removed in M6.5. The `SSHAdapter` session methods remain and are called only by the gateway.
- **SFTP Reliability & Error Handling**:
  - Real `ssh2.SFTP` streaming with null-byte rejection, path normalization, permission-denied error capture, and connection termination cleanup in `finally` blocks.

### 5. Automated Test Suite (30 Tests Passing)
1. `src/lib/security/auth.test.ts` (5 tests):
   - Rate limiting enforcement and window reset.
   - Operator session token verification.
   - CSRF validation on mutating operations.
   - Request size limit enforcement.
   - Recursive credential redaction in audit logs.
2. `src/lib/ssh/knownHosts.test.ts` (3 tests):
   - TOFU auto-enrollment of initial host key.
   - Matching host-key verification success.
   - Immediate rejection on altered host-key fingerprint (MITM prevention).
3. `src/lib/ai/policy.test.ts` (5 tests):
   - Canonical command generation for typed operations.
   - Parameter validation (e.g. valid service names, retention intervals).
   - Rejection of command injection and shell metacharacters.
   - Rejection of unauthorized operation types.
4. `src/lib/ai/approval.test.ts` (6 tests):
   - Valid proposal signing and signature verification.
   - Rejection of tampered command parameters.
   - Rejection of expired proposals (>15 minutes).
   - Rejection of mismatched server bindings.
   - Double-execution prevention via atomic state locking.
   - Destructive command blocklist enforcement.
5. `src/lib/storage/storage.test.ts` (4 tests):
   - Server CRUD, query filtering, and disk persistence.
6. `src/lib/ssh/adapter.test.ts` (3 tests):
   - Connection validation and host-key verification dispatch.
   - Interactive PTY session creation, resize, input, and closure.
   - Connection timeout and cleanup handling.
7. `src/lib/ai/diagnostics.test.ts` (4 tests):
   - Rule-based diagnostic suggestions for high CPU, memory exhaustion, and disk fullness.

### 6. Verification Status & Build Evidence
- `npm run typecheck` (`tsc --noEmit`): **0 errors** (Strict TypeScript).
- `npx vitest run`: **30 passed in 7 test files (100% pass rate)**.
- `npm run build` (`next build`): **12 static and dynamic routes compiled successfully via Turbopack**.

### 7. Remaining External Prerequisites
- Network connectivity to actual target OpenSSH servers.
- Operator private keys or passphrases for target servers.

---

## 4. Milestone 3 Real-Time Interactive SSH Terminal Implementation & Verification

### 1. System Architecture & Transport Decision
- **Dedicated Authenticated WebSocket Gateway (`src/server/terminalGateway.ts`)**:
  - Rather than emulating interactivity through repetitive HTTP polling or unstable streaming hacks in standard HTTP route handlers, PraxelOps provides a dedicated, persistent WebSocket terminal gateway service.
  - The gateway handles HTTP upgrade requests on `/terminal` (and `/ssh`), authenticates the operator session, resolves credentials from the backend inventory, allocates a genuine interactive PTY (`client.shell()`), and bridges bidirectional raw byte streams directly to the browser.
- **Frontend xterm.js Terminal (`src/components/terminal/TerminalView.tsx`)**:
  - Replaced simulated history line rendering with genuine `@xterm/xterm` (v5.5.0), `@xterm/addon-fit` (v0.10.0), and `@xterm/addon-web-links` (v0.11.0).
  - Every keystroke, Tab completion, arrow navigation, Ctrl+C interrupt, and ANSI cursor movement streams directly to the remote PTY.
  - Dynamic module loading ensures full Next.js SSR / Turbopack compatibility.
- **Multi-Tab Session Isolation**:
  - Operators can open multiple simultaneous terminal sessions across different fleet nodes.
  - Each tab maintains an independent persistent WebSocket connection and distinct `ssh2.ClientChannel` PTY session.
  - Switching between tabs preserves terminal buffers and connection states without session termination.

### 2. PTY Features & Stream Capabilities
- **Bidirectional Streaming**: Full-duplex raw stdin/stdout streaming via WebSocket JSON protocol (`{ type: "input", data }` and `{ type: "output", data }`).
- **Interactive PTY Shell (`client.shell()`)**: Configured with `xterm-256color` terminal emulation for full curses and interactive CLI application support (`htop`, `vim`, `nano`, `top`).
- **Terminal Window Resizing**: `ResizeObserver` monitors terminal viewport dimensions, invokes `FitAddon.fit()`, and sends `{ type: "resize", cols, rows }` to the backend, triggering `stream.setWindow(rows, cols)` on the remote PTY.
- **ANSI Escape Sequences & Unicode Fidelity**: Full 24-bit truecolor, standard 16-color ANSI formatting, bold/underline/dim styles, and multi-byte UTF-8 Unicode (e.g. emojis, East Asian characters) render without truncation or corruption.
- **Backpressure & Buffer Management**: Backpressure monitoring (`ws.bufferedAmount > 1MB`) pauses the remote SSH channel stream (`stream.pause()`) and automatically resumes on buffer drain (`stream.resume()`).
- **Quick Presets**: Command presets (`Sys Info`, `Uptime`, `Disk Space`, `Memory`, `Processes`) write directly to the active terminal stdin stream.

### 3. Security Hardening & Isolation
- **Authentication on Connection**: Every connection requires a valid operator session token passed via URL query parameter, `Authorization: Bearer` header, or initial `{ type: "auth", token }` frame. Verified strictly via `AuthService.verifyToken()`.
  > **Superseded in M4 and M6.3**: M4 introduced single-use tickets and forbade query tokens in production; M6.3 removed token authentication from the gateway in every environment and deleted `AuthService.verifyToken`. Today only a single-use ticket (`?ticket=` or the first `{ type: "auth", ticket }` frame) is accepted; anything else closes with 1008.
- **Target Server Authorization & Backend Credential Isolation**:
  - The client specifies only the target `serverId`.
  - Passwords, private keys, and passphrases are retrieved strictly from server-side storage and never accepted from client payloads.
- **Host-Key Verification**: Enforced via `KnownHostsService` with Trust-On-First-Use (TOFU) policy. If a remote host key changes, connection is aborted immediately (`SSH_HOST_KEY_MISMATCH`), preventing Man-In-The-Middle attacks.
- **Session Bounds & Payload Limits**:
  - Clamped window resize bounds (`10 <= cols <= 500`, `2 <= rows <= 200`).
  - Max inbound message frame size limit (64 KB). Payloads exceeding the limit are rejected.
  - Max concurrent terminal sessions per gateway (25 sessions).
- **Idle Timeout & Resource Cleanup**:
  - Inactive sessions exceeding the 15-minute idle threshold are reaped automatically.
  - When a WebSocket client disconnects or closes a tab, `SSHAdapter.closeSession()` terminates the SSH channel and underlying client immediately, preventing dangling sockets or memory leaks.
- **Tamper-Evident Audit Trail**:
  - Connect and disconnect events are logged to `.peos/data/audit.json` with duration metrics.

### 4. Automated Test Suite (39 Tests Passing)
1. `src/server/terminalGateway.test.ts` (9 tests passed):
   - Rejection of unauthorized connections with invalid/missing tokens (Code 1008).
   - Rejection of connections to non-existent servers (Code 1008).
   - Bidirectional input and output streaming between WebSocket client and remote SSH PTY.
   - Dynamic terminal resize propagation with boundary validation clamping.
   - ANSI escape sequence and multi-byte Unicode string transfer fidelity.
   - Multiple simultaneous independent terminal sessions without cross-session leakage.
   - Inbound message payload size limit enforcement (>64 KB rejected).
   - Host-key verification mismatch rejection and graceful termination (Code 1011).
   - Session closure and disconnect cleanup freeing SSH channels and logging audit records.
2. `src/lib/security/auth.test.ts` (5 tests passed): Session tokens, CSRF, rate limits, size limits, secret redaction.
3. `src/lib/ssh/knownHosts.test.ts` (3 tests passed): TOFU auto-enrollment, matching verification, MITM mismatch rejection.
4. `src/lib/ssh/adapter.test.ts` (3 tests passed): Connection handling, SFTP null-byte rejection, session resize/close.
5. `src/lib/ai/policy.test.ts` (5 tests passed): Typed operations, canonical command generation, metacharacter rejection.
6. `src/lib/ai/approval.test.ts` (6 tests passed): HMAC signatures, expiration, concurrency locks, destructive blocklist.
7. `src/lib/storage/storage.test.ts` (4 tests passed): JSON database CRUD and persistence.
8. `src/lib/ai/diagnostics.test.ts` (4 tests passed): Telemetry heuristics and rule-based diagnostic proposals.

### 5. Verification Status & Build Evidence
- `npm run typecheck` (`tsc --noEmit`): **0 errors** (Strict TypeScript).
- `npx vitest run`: **39 passed in 8 test files (100% pass rate)**.
- `npm run build` (`next build`): **12 static and dynamic routes compiled successfully via Turbopack**.

### 6. Deployment & Operational Runbook
- **Development**:
  ```bash
  # Terminal 1: Next.js Studio Desktop & API
  npm run dev

  # Terminal 2: Authenticated SSH Terminal WebSocket Gateway
  npm run terminal:gateway
  ```
- **Production**:
  ```bash
  # Build optimized production assets
  npm run build

  # Start Next.js web application
  npm run start

  # Run Terminal Gateway service (runs on port 3001 or TERMINAL_GATEWAY_PORT)
  npm run terminal:gateway
  ```
- **Configuration Flags**:
  - `TERMINAL_GATEWAY_PORT`: Port for the WebSocket gateway (default: `3001`).
  - `NEXT_PUBLIC_WS_TERMINAL_PORT`: Frontend port configuration for browser connections (default: `3001`).
  - `PRAXELOPS_SECRET`: Master 256-bit cryptographic signing key (mandatory in production).

---

## 5. Milestone 4 End-to-End Verification and Deployment Readiness

### 1. Executive Summary & Verification Scope
Milestone 4 established rigorous end-to-end verification and production deployment readiness across PraxelOps:
- **Zero Token Leakage**: Completely eradicated long-lived operator tokens from WebSocket connection query strings.
- **Single-Use Ticket Authentication**: Deployed an atomic, short-lived (60s TTL) cryptographic ticket exchange service via authenticated HTTPS.
- **Cross-Origin WebSocket Hijacking (CSWSH) Defense**: Enforced strict `Origin` header validation against an explicit allowlist and loopback bindings.
- **Authentic Wire-Level SSH Protocol Verification**: Executed comprehensive integration tests against an authentic, in-process TCP SSH server daemon (`ssh2.Server`) running real cryptographic key exchange, authentication, PTY shell streaming, and SFTP subsystem transactions.
- **Complete Test Suite Health**: All 50 tests across 10 test suites pass with 100% success rate, 0 TypeScript errors, and clean Next.js 16 (Turbopack) production compilation.

---

### 2. WebSocket Security Hardening & Threat Mitigations

#### A. Elimination of URL Token Exposure
- **Vulnerability**: Standard browser `WebSocket` APIs do not permit setting arbitrary HTTP request headers (such as `Authorization: Bearer <token>`). Passing long-lived session tokens in URL query strings exposes secrets to HTTP server access logs, reverse-proxy request logs, browser history, and shoulder-surfing.
- **Remediation**: Implemented `POST /api/ssh/ticket` (`src/app/api/ssh/ticket/route.ts`).
  - Operators request a single-use connection ticket over authenticated HTTPS with full CSRF protection, rate limiting, and server inventory authorization.
  - The ticket payload is generated using 32 bytes of cryptographically secure random entropy (`crypto.randomBytes(32).toString("hex")`).
    > **Correction (code as of M5/M6)**: a ticket is `"tkt_" + crypto.randomBytes(24).toString("base64url")` (24 random bytes), not 32 bytes of hex (`src/lib/security/ticket.ts`). It is an opaque random identifier looked up in a store, **not a signed token**; `PRAXELOPS_SECRET` is not used for tickets.
  - Each ticket is strictly bound to:
    - Operator Session ID (`operatorSessionId`)
    - Target Server ID (`serverId`)
    - Request Origin (`origin`)
    - Expiration timestamp (strictly 60 seconds from issuance)
  - The ticket can only be consumed **once**. Calling `consumeTicket(ticketId)` atomically validates and deletes the ticket from memory. Any attempt to replay or reuse the ticket is rejected immediately.
    > **Superseded in M5**: the store is not memory-only. Since M5 a ticket is a file under `<data dir>/tickets/` (`.json`, mode 0600, exclusive create) claimed by renaming it to `.consuming` and unlinking it, so the web process and the gateway process share it. Known caveat on Windows under heavy contention: see 7.6.
  - In production (`NODE_ENV === "production"`), passing raw operator tokens in query parameters is explicitly forbidden and rejected with WebSocket close code `1008`.

#### B. CSWSH (Cross-Origin WebSocket Hijacking) Defense
- **Vulnerability**: Unlike HTTP XMLHttpRequests/fetch, WebSocket connections do not enforce the browser Same-Origin Policy (SOP). Malicious third-party websites can open WebSockets to internal gateways if origin checks are absent.
- **Remediation**: Integrated `isValidOrigin(req)` in `src/server/terminalGateway.ts`.
  - Parses and validates the HTTP `Origin` header during the HTTP Upgrade handshake.
  - Compares origin against `ALLOWED_ORIGINS` (comma-separated list) or local loopback patterns (`http://localhost:*`, `http://127.0.0.1:*`).
  - If the origin is untrusted or missing (when an origin is required), the gateway immediately aborts the connection with HTTP `403 Forbidden` prior to socket upgrade.

#### C. Anti-Proxy Lockdown
- The WebSocket gateway strictly accepts a target `serverId` bound to the verified ticket.
- The client cannot supply arbitrary IP addresses, hostnames, ports, or credentials.
- All credentials (private keys, passphrases, passwords) are resolved directly from backend storage. This guarantees the terminal gateway cannot be leveraged as an open or unrestricted SSH proxy.

---

### 3. Wire-Level SSH Protocol Verification

To eliminate any risk of mocked-only test fidelity, PraxelOps incorporates an authentic, wire-level TCP SSH server daemon test fixture (`src/lib/ssh/testSshServer.ts`) and integration suite (`src/server/realSshIntegration.test.ts`):

1. **Genuine Cryptographic Key Exchange & Host-Key Verification**:
   - The test SSH daemon dynamically generates an authentic 2048-bit RSA host private key.
   - The client connects via TCP loopback, receives the real public key fingerprint, and verifies it against `KnownHostsService`.
   - First connection triggers Trust-On-First-Use (TOFU) automatic enrollment.
   - Subsequent connections verify the enrolled fingerprint.
   - When a modified host key is presented, `SSHAdapter.connect()` immediately halts with `SSH_HOST_KEY_MISMATCH`, thwarting MITM threats.
2. **Credential Authentication**:
   - Tested real password authentication over SSH protocol wire format. Invalid passwords result in explicit rejection without hanging sockets.
3. **Interactive PTY Streaming**:
   - Allocates genuine `xterm-256color` PTY shell (`client.shell()`).
   - Streams input commands (`echo "HELLO_PRAXELOPS_WIRE"`) and receives expected output over TCP data packets.
   - Exercises dynamic window resize signals (`stream.setWindow(rows, cols)`).
4. **Authentic SFTP Subsystem**:
   - Initiates genuine `sftp` channel session.
   - Performs remote directory listing (`readdir`), verifying file entry metadata, permissions, and timestamps.
   - Performs remote file reading (`readFile`), reading authentic buffer contents over the SFTP wire protocol.
5. **End-to-End WebSocket to SSH Daemon Bridge**:
   - Complete chain: Mock browser WebSocket client -> TerminalGateway (ticket consumption + CSWSH check) -> SSHAdapter -> authentic TCP socket SSH server daemon.
   - Full-duplex streaming verified under real TCP socket conditions.

---

### 4. Automated Test Suite (50 Tests Passing across 10 Test Files)

```
✓ src/lib/security/auth.test.ts (5 tests)
✓ src/server/terminalGateway.test.ts (9 tests)
✓ src/lib/ssh/knownHosts.test.ts (3 tests)
✓ src/server/realSshIntegration.test.ts (7 tests)
✓ src/lib/ai/policy.test.ts (5 tests)
✓ src/lib/storage/storage.test.ts (4 tests)
✓ src/lib/ssh/adapter.test.ts (3 tests)
✓ src/lib/ai/approval.test.ts (6 tests)
✓ src/lib/ai/diagnostics.test.ts (4 tests)
✓ src/lib/security/ticket.test.ts (4 tests)

Test Files  10 passed (10)
     Tests  50 passed (50)
```

- `src/lib/security/ticket.test.ts`: 4 tests validating (as written in M4; the code actually uses 24 random bytes, see correction above) 32-byte cryptographic entropy, atomic single-use consumption, rejection of expired tickets (60s TTL), and periodic memory pruning.
- `src/server/realSshIntegration.test.ts`: 7 tests validating authentic TCP wire connections, invalid credential rejection, TOFU enrollment, MITM host-key rejection, interactive PTY shell streaming, SFTP subsystem operations, and end-to-end WebSocket-to-daemon bridging.
- All prior unit and integration suites maintained at 100% pass rate.

---

### 5. Build & Compilation Verification
- **TypeScript**: `npm run typecheck` (`tsc --noEmit`) passes with **0 errors** in strict mode with zero `any` types.
- **Vitest Suite**: `npx vitest run` passes **50/50 tests (100% pass rate)** in 10.53 seconds.
- **Next.js Production Build**: `npm run build` compiles 13 static and dynamic routes cleanly with Turbopack:
  - `○ /` (Desktop Studio dashboard)
  - `ƒ /api/ai/approve`
  - `ƒ /api/ai/diagnose`
  - `ƒ /api/audit`
  - `ƒ /api/deployments`
  - `ƒ /api/servers`
  - `ƒ /api/servers/demo`
  - `ƒ /api/sftp`
  - `ƒ /api/ssh/exec`
  - `ƒ /api/ssh/session` (**Superseded in M6.5**: route removed)
  - `ƒ /api/ssh/ticket` (New Milestone 4 endpoint)

---

### 6. Production Deployment Topology & Runbook

#### A. Architecture & Traffic Routing
In production, PraxelOps runs as a coordinated dual-process architecture fronted by a TLS-terminating reverse proxy (Nginx, Caddy, or Cloudflare):

```
                       [ HTTPS (Port 443) / WSS ]
                                   │
                                   ▼
                   ┌──────────────────────────────┐
                   │ Reverse Proxy (Nginx / Caddy)│
                   └──────────────┬───────────────┘
                                  │
          ┌───────────────────────┴───────────────────────┐
          │ HTTP Requests                                 │ WebSocket Upgrade
          │ (HTML, JS, /api/*)                            │ (/terminal, /ssh)
          ▼                                               ▼
┌───────────────────────────┐                   ┌───────────────────────────┐
│ Next.js Web App           │                   │ Terminal Gateway          │
│ (Port 3000)               │                   │ (Port 3001)               │
│ - Studio Dashboard        │                   │ - Ticket Validation       │
│ - REST APIs               │                   │ - PTY Allocation          │
│ - Ticket Issuance         │                   │ - SSH2 Client Bridge      │
└─────────────┬─────────────┘                   └─────────────┬─────────────┘
              │                                               │
              └───────────────────────┬───────────────────────┘
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │ Target Infrastructure     │
                        │ (Remote SSH Servers)      │
                        │ - Port 22 / SFTP          │
                        └───────────────────────────┘
```

#### B. Reverse Proxy Configuration (Nginx Example)
```nginx
upstream praxelops_web {
    server 127.0.0.1:3000;
}

upstream praxelops_terminal {
    server 127.0.0.1:3001;
}

server {
    listen 443 ssl http2;
    server_name ops.example.com;

    ssl_certificate /etc/letsencrypt/live/ops.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ops.example.com/privkey.pem;

    # Next.js web application and REST endpoints
    location / {
        proxy_pass http://praxelops_web;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Dedicated WebSocket terminal upgrade
    location /terminal {
        proxy_pass http://praxelops_terminal;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

#### C. Process Supervision (systemd Example)

1. **Next.js Web Service** (`/etc/systemd/system/praxelops-web.service`):
```ini
[Unit]
Description=PraxelOps Web Application
After=network.target

[Service]
Type=simple
User=praxelops
WorkingDirectory=/opt/praxelops
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=PRAXELOPS_SECRET=YOUR_SECURE_256BIT_SECRET_KEY
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

2. **Terminal Gateway Service** (`/etc/systemd/system/praxelops-gateway.service`):
```ini
[Unit]
Description=PraxelOps SSH Terminal WebSocket Gateway
After=network.target praxelops-web.service

[Service]
Type=simple
User=praxelops
WorkingDirectory=/opt/praxelops
Environment=NODE_ENV=production
Environment=TERMINAL_GATEWAY_PORT=3001
Environment=ALLOWED_ORIGINS=https://ops.example.com
Environment=PRAXELOPS_SECRET=YOUR_SECURE_256BIT_SECRET_KEY
ExecStart=/usr/bin/npm run terminal:gateway
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

> **Superseded in M6.3 / M6.1**: these example units are incomplete for the current code. The web unit also needs `ALLOWED_ORIGINS` (and `ALLOWED_HOSTS` if the proxy forwards an internal Host), otherwise state-changing requests and non-loopback Host headers are refused in production. Both units must point at the same `PRAXELOPS_DATA_DIR` (it defaults to `.peos/data` under each process's working directory; the examples share `/opt/praxelops`). At least one operator must exist (`scripts/create-operator.ts`) before anyone can sign in. Neither unit was exercised with systemd or a TLS reverse proxy; the verified topology is the two-process E2E in 7.2. See 7.4.

#### D. Environment Variables Reference
| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Setting to `production` enforces single-use ticket auth and blocks URL query tokens. |
| `PRAXELOPS_SECRET` | Auto-generated in dev | 256-bit cryptographic signing secret for tokens, HMAC approvals, and ticket signing. **Correction (M6)**: it is used for the CSRF token HMAC and AI proposal HMAC only (`getMasterSecret()`); tickets are not signed and there is no token signing or credential encryption yet. |
| `ALLOWED_ORIGINS` | `http://localhost:*` | Comma-separated list of trusted HTTP origins permitted to establish WebSocket terminal connections. **Superseded in M6.3**: also governs the web app (exact-match Origin check, Host allowlist) and the gateway refuses to start in production when it is empty. See 7.4. |
| `TERMINAL_GATEWAY_PORT` | `3001` | TCP port on which the WebSocket terminal gateway listens for inbound connections. |
| `NEXT_PUBLIC_WS_TERMINAL_PORT`| `3001` | Frontend configuration for browser WebSocket endpoint resolution. |

---

### 7. Known Limitations & Recommended Future Enhancements
1. **WebAuthn / FIDO2 Integration**: Extend the operator authentication service to support hardware security keys (e.g., YubiKey) for high-impact AI operation approvals.
2. **Multi-Tenant RBAC & Server Tags**: Expand single-operator mode into role-based access control with granular per-server and per-command execution policies.
3. **Native Desktop Distribution**: Package the verified Next.js and Terminal Gateway runtime into a lightweight cross-platform native bundle using Tauri or Electron.

---

## 6. Milestone 5 Production Security Audit & Real VPS Validation Status

### 1. Executive Summary & Audit Scope
Milestone 5 performed a rigorous production security audit of PraxelOps' dual-process architecture, verified cross-process coordination between the Next.js web runtime and the standalone Terminal Gateway (**Correction (M6)**: the M5 unit tests exercised the shared ticket store inside a single test process; real separate-process proof only arrived with M6.1 (6-process lock test) and M6.7 (web + gateway as two OS processes). See 7.3), hardened origin and proxy validation, and confirmed wire-level protocol fidelity against authentic TCP SSH sockets.

### 2. Confirmed Vulnerabilities & Applied Remediations

| Vulnerability / Risk | Severity | Root Cause | Implemented Defense & Verification |
| :--- | :--- | :--- | :--- |
| **Process-Local Ticket Store Isolation** | Critical | Next.js (`port 3000`) and Terminal Gateway (`port 3001`) run as separate OS processes. Memory-only `Map` in `TicketService` caused tickets issued by Next.js to be invisible to Terminal Gateway. | Transitioned `TicketService` (`src/lib/security/ticket.ts`) to a shared, persistent atomic store in `.peos/data/tickets/`. Uses atomic OS rename (`fs.renameSync` from `.json` to `.consuming` followed by `fs.unlinkSync`) to guarantee atomic single-use consumption across process boundaries and survive process restarts. (**Correction (M6)**: the multi-process claim was not demonstrated by the M5 tests, see below; it is demonstrated by the M6.7 E2E. On Windows a multi-winner rename was later observed under heavy contention, see 7.6.) |
| **Missing Origin Header in Production** | High | `isValidOrigin()` in Milestone 4 allowed requests with missing `Origin` headers, creating a bypass vector for non-browser WebSocket clients or automated CSRF/CSWSH tools. | Upgraded `isValidOrigin()`: In production (`NODE_ENV === "production"`), missing `Origin` headers are strictly rejected with HTTP `403 Forbidden` prior to socket upgrade. |
| **Untrusted Proxy Header IP Spoofing** | Medium | Reverse-proxy headers (`X-Forwarded-For`) could be forged by untrusted remote peers to bypass rate limits or falsify audit trails. | Added `isTrustedProxy()` and `getClientIp()`. `X-Forwarded-For` is strictly ignored unless the direct peer socket (`req.socket.remoteAddress`) matches `TRUSTED_PROXIES` (default `127.0.0.1,::1`). Proxy headers can never override the browser's native `Origin` header. |
| **Missing First-Time TOFU Audit Records** | Low | First-time host-key enrollment in `KnownHostsService` was recorded to disk but did not generate an explicit, auditable security log event. | Updated `KnownHostsService` (`src/lib/ssh/knownHosts.ts`) to log an explicit `security_alert` event (`alertType: "tofu_host_key_enrolled"`) upon initial host-key trust, and `alertType: "host_key_mismatch"` upon MITM detection. |
| **Unbounded Ticket Scope** | Medium | Tickets previously lacked explicit context binding beyond server ID. | Bound tickets strictly to operator ID, target server ID, client Origin, session purpose (`terminal_shell`), and 60s TTL. Consumption verifies that the connection's origin matches the ticket's bound origin. |

---

### 3. Automated Verification Evidence (57 Tests Passing)

```
Test Files  10 passed (10)
     Tests  57 passed (57)
  Duration  15.15s
```

#### Detailed Test Suites Breakdown
> **Correction (M6)**: the "cross-process" and "5 simultaneous consumers" descriptions below overstate what those two tests do. Both run inside one Vitest worker process. The "process B" is simulated by clearing the in-memory `Map`, and the "5 simultaneous consumers" are five `Promise.resolve().then(...)` calls of a *synchronous* function, which run one after another on a single thread. They do prove file-backed single-use semantics and replay rejection, but not behaviour under true concurrency across OS processes. That proof is now provided by `atomicFile.multiprocess.test.ts` (M6.1, store locking) and `e2e/twoProcess.e2e.test.ts` (M6.7, ticket issued by one process and consumed by another). Test-level labelling is in 7.3.

1. **Multi-Process Ticket Service (`src/lib/security/ticket.test.ts` - 8 tests)**:
   - High-entropy cryptographic ticket issuance with 60s TTL.
   - Atomic consumption and single-use replay prevention.
   - Client Origin binding verification (mismatched origin rejected).
   - Session purpose binding verification (`terminal_shell`).
   - Cross-process persistence across memory wipe (simulated gateway restart). *(Superseded in M6: single-process simulation; see correction above.)*
   - Race-condition handling under concurrent consumption (5 simultaneous consumers, exactly 1 succeeds). *(Superseded in M6: five sequential calls in one process, not concurrent processes; see correction above.)*
   - Rejection of expired tickets.
   - Dual memory and filesystem TTL pruning.
2. **Terminal Gateway Transport Security (`src/server/terminalGateway.test.ts` - 12 tests)**:
   - Rejection of unauthorized connections with invalid/missing tokens.
   - Rejection of connections to non-existent servers in inventory.
   - Bidirectional PTY input/output streaming.
   - Terminal window resize clamping and bounds validation.
   - ANSI escape sequence and UTF-8 multi-byte Unicode transfer fidelity.
   - Multiple concurrent independent sessions without cross-session bleed.
   - Message frame payload size limit enforcement (64 KB).
   - Host-key verification failure rejection and socket cleanup.
   - Session cleanup and disconnect audit logging.
   - Rejection of WebSocket upgrade when Origin is missing in production mode (HTTP 403).
   - Enforcement of single-use tickets and rejection of raw query tokens in production (Code 1008).
   - Trusted proxy validation for `X-Forwarded-For`.
3. **Authentic Wire-Level SSH Integration (`src/server/realSshIntegration.test.ts` - 7 tests)**:
   - Command execution over authentic TCP loopback SSH daemon (`ssh2.Server`).
   - Wire credential authentication and rejection of incorrect passwords.
   - TOFU host-key verification and SHA-256 fingerprint enrollment.
   - Man-In-The-Middle (MITM) changed-key detection and connection abortion.
   - Interactive `xterm-256color` PTY shell streaming over real TCP socket.
   - Real SFTP subsystem directory listing (`readdir`) and file reading (`readFile`).
   - End-to-end WebSocket client -> Terminal Gateway -> SSHAdapter -> authentic TCP SSH daemon bridging.
4. **Known Hosts & Security (`src/lib/ssh/knownHosts.test.ts` - 3 tests)**:
   - First-time TOFU trust and auditable security alert logging.
   - Subsequent connection fingerprint verification.
   - MITM rejection and security alert generation.
5. **Authentication, Policy, Storage, Diagnostics, and Approvals (27 tests)**:
   - `src/lib/security/auth.test.ts` (5 tests)
   - `src/lib/ai/approval.test.ts` (6 tests)
   - `src/lib/ai/policy.test.ts` (5 tests)
   - `src/lib/ai/diagnostics.test.ts` (4 tests)
   - `src/lib/storage/storage.test.ts` (4 tests)
   - `src/lib/ssh/adapter.test.ts` (3 tests)

---

### 4. Real VPS Validation Status

- **Status**: **BLOCKED (Awaiting Authorized External Credentials)** *(unchanged at the end of M6: no external host has been contacted; see 7.3 and 7.6)*
- **Audit Findings**:
  - No external VPS IP addresses, SSH ports, or authorized credentials were provided in the execution context or repository environment.
  - To preserve operational safety and avoid unauthorized network scanning, no arbitrary external hosts were contacted.
  - Full wire-level SSH protocol fidelity was independently verified using an authentic, in-process TCP SSH server fixture (`ssh2.Server`) running real cryptographic key exchange, authentication, and SFTP subsystem protocol wire framing.
  - This in-process wire verification is strictly categorized as an integration test fixture and is explicitly NOT conflated with an external VPS validation.
- **External VPS Unblocking Procedure**:
  When authorized external VPS credentials become available:
  1. Add the VPS to server inventory via `POST /api/servers` or Studio UI.
  2. Initiate connection via Terminal tab; verify host-key fingerprint prompt.
     > **Correction (M6)**: there is no fingerprint prompt. Enrollment is automatic Trust-On-First-Use: the first key seen is pinned and audited (`tofu_host_key_enrolled`). Verify the pinned fingerprint out of band by reading `known_hosts.json` / the audit log. An explicit confirmation UI is on the open-items list (7.6).
  3. Confirm interactive PTY shell streaming (`htop`, `tmux`, `nano`).
  4. Perform SFTP file browse and file read operations.
  5. Inspect `.peos/data/audit.json` to verify zero secret leakage in logs.

---

### 5. Deployment, Health Checks & Rollback Runbooks

#### A. Multi-Process Startup Runbooks

> **Superseded in M6.3**: a first-time setup now also requires creating an operator (`node --experimental-strip-types scripts/create-operator.ts <user>`) and signing in at the login screen. Gateway and web must share `PRAXELOPS_DATA_DIR`. See 7.4.

**Windows Local Development**:
```powershell
# Terminal 1: Next.js Web Studio & REST APIs (Port 3000)
npm run dev

# Terminal 2: Authenticated SSH Terminal WebSocket Gateway (Port 3001)
npm run terminal:gateway
```

**Ubuntu Production Deployment**:
```bash
# 1. Build optimized Next.js production bundle
npm run build

# 2. Start Next.js web application (managed by systemd: praxelops-web)
sudo systemctl start praxelops-web

# 3. Start Terminal Gateway service (managed by systemd: praxelops-gateway)
sudo systemctl start praxelops-gateway

# 4. Verify systemd status
sudo systemctl status praxelops-web praxelops-gateway
```

#### B. Health-Check Procedures

1. **Terminal Gateway Health Check**:
   ```bash
   curl -s http://127.0.0.1:3001/
   # Expected response:
   # {"service":"PraxelOps Authenticated SSH Terminal Gateway","status":"healthy","activeSessions":0}
   ```
2. **Next.js Web Application Health Check**:
   ```bash
   curl -s -I http://127.0.0.1:3000/
   # Expected response: HTTP/1.1 200 OK
   ```

#### C. Rollback Procedure

> **Superseded in M6**: `2725a01` is the **Milestone 4** commit, not "the previous checkpoint" for the current code, and rolling back to it (or to any pre-M6 commit) re-introduces the issues fixed in M6 (the Host/`local-operator-token` bypass, the legacy `/api/ssh/session` route, credentials in server API responses, non-atomic stores). The current procedure is in 7.7. Original text, kept for history:

If a deployment anomaly is detected:
```bash
# 1. Roll back working tree to previous checkpoint commit (2725a01)
git checkout 2725a01

# 2. Rebuild production bundle
npm run build

# 3. Restart supervised services
sudo systemctl restart praxelops-web praxelops-gateway

# 4. Verify health endpoints
curl -s http://127.0.0.1:3001/
```

---

### 6. Remaining Security Limitations & Roadmap

1. **Role-Based Access Control (RBAC)**: Currently single-operator boundary; multi-tenant operator roles with per-server isolation are scheduled for Milestone 6. *(Superseded in M6: not delivered in Milestone 6, which was hardening and topology. Still open; see 7.6.)*
2. **WebAuthn / FIDO2 Hardware Tokens**: Hardware key verification (e.g. YubiKey) for AI high-impact command execution.
3. **Audit Log SIEM Export**: Long-term streaming export to enterprise Syslog or SIEM platforms.





---

## 7. Milestone 6 — Hardening & Real Topology

Milestone 6 turned the Milestone 1 to 5 feature set into something that can run as the intended two-process production topology (`next start` web app plus standalone terminal gateway sharing one data directory) without the known authentication bypasses, with multi-process-safe storage, and with a test that actually runs both processes. It did not add product features (SFTP, telemetry, deployments and the AI copilot are unchanged). Branch: `m6-hardening`; checkpoint commit: `4ff6a56`.

### 7.1 What each step changed

| Step | Commit | Change |
| :--- | :--- | :--- |
| M6.1 | `4156e53` | **Storage.** `PRAXELOPS_DATA_DIR` via `getDataDir()` (read on every call, default `<cwd>/.peos/data`). New `src/lib/storage/atomicFile.ts`: `atomicWriteFileSync` (temp file + fsync + rename, retry on transient Windows errors), `withFileLockSync` (cross-process lock file `<file>.lock` created with `O_EXCL`, owner token, stale-lock breaking), `readJsonStrict` (throws `StorageCorruptError`, never substitutes defaults). All storage read-modify-writes run under the lock. **Known hosts fail closed**: a corrupt store rejects verification instead of silently re-enrolling; TOFU enrollment re-reads under the lock and is audited *before* the key is pinned; successful verifications no longer rewrite the file. Ticket dir mode 0700, ticket files 0600 with exclusive create. Every test file runs in its own temp data dir (`src/test/setupDataDir.ts`). `.peos/data` runtime state is no longer tracked by git (it is in `.gitignore`). Added `docs/PRAXELOPS_MASTER_PROMPT.md`. |
| M6.2 | `65ea358` | `npm run terminal:gateway` now runs `tsx src/server/terminalGateway.ts` (`tsx` 4.23.15 added as a devDependency) so the `@/` path aliases resolve. |
| M6.3 | `765cc6c` | **Authentication.** Real operator login (scrypt-hashed accounts in `operators.json`, `scripts/create-operator.ts`), `/api/auth/login`, `/session`, `/logout`, HttpOnly SameSite=Strict cookie, idle (8h sliding) and absolute (24h) expiry. State-changing requests need an exact `Origin` allowlist match plus an HMAC CSRF token. The Host-header loopback bypass and the hard-coded `local-operator-token` were removed. `src/proxy.ts` enforces an exact Host allowlist on `/api/*` (421 otherwise). The gateway accepts single-use tickets only and refuses to start in production without `ALLOWED_ORIGINS`. Login screen, `apiFetch` helper (adds CSRF header), sign-out. Detail in 7.5. |
| deps | `15036c1` | `package-lock.json` added to pin the dependency tree. |
| M6.5 | `ab83d6c` | Deleted the legacy `POST /api/ssh/session` route, which bypassed ticket binding and session ownership. `legacyRoutes.test.ts` asserts it stays gone. |
| M6.4 | `7f25180` | Server API responses (`GET`/`POST /api/servers`, `POST /api/servers/demo`) no longer contain `password`, `privateKey`, `passphrase`; they carry `hasPassword` / `hasPrivateKey` / `hasPassphrase` flags (`src/lib/servers/publicServer.ts`). Stored secrets are unchanged, so SSH still authenticates. |
| M6.6 | `2f751bf` | **Gateway hardening.** Per-socket auth state machine (a second auth attempt is refused). Session slots are reserved before connecting (global cap 25, per-operator cap default 5) and the SSH session is torn down if the client left mid-connect, so no orphaned sessions. Pre-auth DoS limits: `ws` `maxPayload` 64 KiB plus a byte-accurate frame check, 5 s auth deadline, no pre-auth ping, caps on unauthenticated sockets (50 global, 10 per client IP). `X-Forwarded-For` is honoured only when the TCP peer is in `TRUSTED_PROXIES`, walked right to left and validated with `net.isIP`. cols/rows clamped, `TERM` allowlisted, one backpressure timer per session. Audit events for ticket rejections, origin denials, auth timeouts, session open/close and SSH connect failures; the gateway fails closed if the session-open audit write fails. |
| test | `50a701e` | Test-only: more time headroom for the full-cost scrypt rate-limit test under parallel load. |
| M6.7 | `4ff6a56` | **Two-process production E2E** (`e2e/twoProcess.e2e.test.ts`, `npm run test:e2e`): `next start` and the tsx gateway as separate OS processes (`NODE_ENV=production`, shared `PRAXELOPS_DATA_DIR`) against a real `ssh2` server. Excluded from the default suite via `vitest.config.ts`; own config `vitest.e2e.config.ts`. |

### 7.2 Verification evidence

Recorded by the reviewer from their own runs on 2026-10-17 (Windows 10, Node 24). Nothing below was run on Linux or in CI.

- `npx tsc --noEmit`: exit 0. `npm run build`: succeeds.
- `npx vitest run`: **20 files, 172/172 tests passed** (run twice consecutively). The per-file counts in 7.3 come from a JSON-reporter run of the same suite on the same checkout (also 172/172).
- `E2E_REBUILD=1 npm run test:e2e`: **1 file, 7/7 passed**. Scenarios:
  1. production auth / Host / CSRF preconditions;
  2. add server, real PTY shell round-trip, TOFU pin, and the audit log contains no password or ticket;
  3. ticket replay is refused (close code 1008);
  4. wrong or missing `Origin` gets 403;
  5. gateway process restart;
  6. web process restart (old cookie gets 401, re-login works);
  7. host-key mismatch is rejected and audited, and the pinned fingerprint is unchanged.
- Multi-process store test (`src/lib/storage/atomicFile.multiprocess.test.ts`): 6 writer processes x 150 locked increments plus 1 concurrent reader gave count 900 and 0 parse errors.

What this evidence does **not** cover: any external SSH host (the E2E's SSH server is the in-repo `ssh2` fixture running in the test process), a TLS reverse proxy, a real browser (the login screen was not browser-tested), Linux, or systemd.

### 7.3 Test-level breakdown

Levels used: **Unit** (pure logic, or direct function/route-handler calls, possibly on a real temp-dir filesystem), **Unit (mocked SSH)** (real `ws` sockets on loopback into the gateway, but `SSHAdapter` / `StorageService` are replaced with `vi.spyOn` mocks, so no SSH connection exists), **In-process SSH protocol** (real `ssh2` client against the `ssh2.Server` fixture `src/lib/ssh/testSshServer.ts`, same OS process as the test), **Multi-process** (separate OS processes), **Real external host** (none).

| File | Tests | Level | Notes |
| :--- | ---: | :--- | :--- |
| `src/lib/ai/approval.test.ts` | 6 | Unit | HMAC proposal signing, expiry, locking |
| `src/lib/ai/diagnostics.test.ts` | 4 | Unit | rule-based diagnostics |
| `src/lib/ai/policy.test.ts` | 5 | Unit | typed operation policy |
| `src/lib/security/auth.test.ts` | 16 | Unit | sessions, CSRF/Origin matrix, bypass regressions; fake timers |
| `src/lib/security/authRoutes.test.ts` | 14 | Unit | login/session/logout handlers called directly, real scrypt; audit spy is pass-through |
| `src/lib/security/operators.test.ts` | 9 | Unit | real temp-dir filesystem |
| `src/lib/security/origins.test.ts` | 7 | Unit | pure |
| `src/lib/security/ticket.test.ts` | 9 | Unit | real temp-dir filesystem, **single process** (see M5 correction) |
| `src/lib/servers/publicServer.test.ts` | 4 | Unit | pure |
| `src/app/api/servers/serversRoute.test.ts` | 2 | Unit | route handlers called directly |
| `src/app/api/legacyRoutes.test.ts` | 1 | Unit | asserts removed route file is absent |
| `src/proxy.test.ts` | 3 | Unit | Host allowlist |
| `src/lib/ssh/adapter.test.ts` | 3 | Unit | negative paths only: connect to an unused loopback port, null-byte path rejection; no SSH server involved |
| `src/lib/ssh/knownHosts.test.ts` | 10 | Unit | real temp-dir filesystem; spies force audit-write failures |
| `src/lib/storage/atomicFile.test.ts` | 11 | Unit | real temp-dir filesystem, single process |
| `src/lib/storage/storage.test.ts` | 8 | Unit | real temp-dir filesystem, single process |
| `src/server/terminalGateway.test.ts` | 18 | Unit (mocked SSH) | `SSHAdapter` and `StorageService.getServerById` spied/mocked |
| `src/server/terminalGateway.hardening.test.ts` | 34 | Unit (mocked SSH), 1 test In-process SSH | 33 tests mock `SSHAdapter`/storage; 1 test ("tears down a session whose client disconnected while SSH was still connecting") uses a real `ssh2` server |
| `src/server/realSshIntegration.test.ts` | 7 | In-process SSH protocol | real key exchange, password auth, TOFU, MITM rejection, PTY shell, SFTP `readdir`/`readFile`, WebSocket to gateway to SSH; gateway, client and SSH server all in one process |
| `src/lib/storage/atomicFile.multiprocess.test.ts` | 1 | Multi-process | 6 writer processes + 1 reader, child processes spawned with `node --experimental-strip-types` |
| `e2e/twoProcess.e2e.test.ts` (`npm run test:e2e`) | 7 | Multi-process | `next start` and tsx gateway as two OS processes; SSH server is still the in-process `ssh2` fixture |
| *(none)* | 0 | Real external host | **BLOCKED**: no authorized external host; none contacted |

Totals for the default suite (172 tests, 20 files): 112 Unit, 51 Unit (mocked SSH), 8 In-process SSH protocol, 1 Multi-process. Plus 7 Multi-process E2E tests that run only via `npm run test:e2e`. Real external host: 0.

### 7.4 Configuration and command reference

#### Environment variables

| Variable | Read by | Default | Purpose |
| :--- | :--- | :--- | :--- |
| `PRAXELOPS_DATA_DIR` | web, gateway, scripts | `<cwd>/.peos/data` | Directory for all JSON stores (`servers.json`, `audit.json`, `known_hosts.json`, `proposals.json`, `diagnostics.json`, `deployments.json`, `operators.json`) and `tickets/`. Evaluated on every call. **Web and gateway must point at the same directory.** Tests set it to a per-file temp dir. |
| `PRAXELOPS_SECRET` | web | none | Master secret, at least 32 characters after trimming. Used for the CSRF token HMAC and the AI proposal HMAC (`getMasterSecret()`). If unset, a `.peos/config/master.key` file (relative to the process working directory, **not** the data dir) is used if present and at least 32 chars; otherwise production throws at first use and development generates a 256-bit key into that file. Not used for tickets (tickets are random identifiers, not signed) and nothing is encrypted with it yet. |
| `ALLOWED_ORIGINS` | web, gateway | empty | Comma list of full origins (`https://ops.example.com`), normalized with `new URL(x).origin`. Web: exact-match `Origin` required on POST/PUT/PATCH/DELETE; their hosts are also added to the Host allowlist. Gateway: checked on the WebSocket upgrade (falls back to `NEXT_PUBLIC_APP_URL` when unset); with `NODE_ENV=production` the standalone gateway **exits at startup** if it is empty, and a missing `Origin` is refused. Outside production, `http://localhost:<PORT>` and `http://127.0.0.1:<PORT>` are added automatically. |
| `ALLOWED_HOSTS` | web (`src/proxy.ts`) | empty | Extra exact `Host` header values (`host[:port]`) accepted for `/api/*`. Always allowed: `localhost:<PORT>`, `127.0.0.1:<PORT>`, `[::1]:<PORT>`, and the host of each `ALLOWED_ORIGINS` entry. Anything else gets 421. |
| `PORT` | web | `3000` | Port used to derive the default loopback origins/hosts. (`next start` also reads it; the E2E additionally passes `-p`.) |
| `TERMINAL_GATEWAY_PORT` | gateway | `3001` | TCP port of the WebSocket gateway. |
| `NEXT_PUBLIC_WS_TERMINAL_PORT` | browser bundle | `3001` | Gateway port the browser connects to (build-time `NEXT_PUBLIC_` variable). |
| `TERMINAL_MAX_SESSIONS_PER_OPERATOR` | gateway | `5` | Concurrent terminal sessions per operator (non-positive or invalid values fall back to 5). |
| `TERMINAL_AUTH_TIMEOUT_MS` | gateway | `5000` | How long an unauthenticated WebSocket may stay open before it is closed (invalid values fall back to 5000). |
| `TRUSTED_PROXIES` | gateway only | `127.0.0.1,::1` | Comma list of proxy IPs whose `X-Forwarded-For` is honoured by the gateway. The web process does **not** read it (see 7.6). |
| `NODE_ENV` | all | unset | `production` enables mandatory Origin, Secure cookie, secret requirement, and the gateway startup guard. |
| `PRAXELOPS_OPERATOR_PASSWORD` | `create-operator` | prompt on TTY | Password input for scripted operator creation. |
| `E2E_REBUILD` | `npm run test:e2e` | unset | `1` forces `next build` before the E2E; otherwise it builds only if `.next/BUILD_ID` is missing. |

Not environment-configurable (constructor defaults in `TerminalGateway`): 25 total sessions, 15 minute idle timeout, 64 KiB max frame, 1 MiB backpressure threshold, 50 unauthenticated sockets (10 per IP).

#### Commands

| Command | What it does |
| :--- | :--- |
| `node --experimental-strip-types scripts/create-operator.ts <user> [--reset]` | Create an operator (or replace the password with `--reset`). Password from `PRAXELOPS_OPERATOR_PASSWORD` or a hidden prompt on a TTY. Run with the same `PRAXELOPS_DATA_DIR` as the web server. Add `--no-warnings` to hide the harmless `MODULE_TYPELESS_PACKAGE_JSON` warning. There is no npm script for it. |
| `npm run dev` / `npm run build` / `npm run start` | `next dev` / `next build` / `next start`. |
| `npm run terminal:gateway` | `tsx src/server/terminalGateway.ts`: the standalone gateway (health JSON on `GET /`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | `vitest run` (default suite; excludes `e2e/**`). |
| `npm run test:e2e` | `vitest run --config vitest.e2e.config.ts`: two-process production E2E. Starts `next start` and the tsx gateway on free ports with its own temp data dir; file parallelism off, 120 s test timeout, 900 s hook timeout (for the one-time build). |

First-run order for a new environment: set `PRAXELOPS_SECRET` (production), set `ALLOWED_ORIGINS`, create an operator, start the web app and the gateway with the same `PRAXELOPS_DATA_DIR`, then sign in.

### 7.5 M6.3 Authentication detail (operator login, CSRF/Origin, Host allowlist, ticket-only gateway)

#### What changed

- **Removed the dev bypasses.** `AuthService.authenticateRequest` no longer inspects the `Host` header (the old `startsWith("localhost")` / `startsWith("127.0.0.1")` check let `localhost.evil.example` and `127.0.0.1.nip.io` authenticate as `local-operator` and skip CSRF) and the hard-coded `local-operator-token` is gone in every `NODE_ENV`. `AuthService.verifyToken` was deleted with it.
- **Operator accounts** (`src/lib/security/operators.ts`): `operators.json` in the data dir (atomic + locked writes, strict reads). Record `{ id, username, passwordHash, createdAt }`, hash format `scrypt$N$r$p$saltB64$hashB64` (N=2^15, r=8, p=1, 32-byte salt, 64-byte key), verified with `timingSafeEqual`; an unknown username still runs a dummy scrypt. Usernames `^[a-z0-9_.-]{3,32}$`, passwords at least 12 characters (Zod).
- **Sessions** (`src/lib/security/auth.ts`): 32-byte random token, 8h idle timeout (sliding), 24h absolute cap, logout deletes. CSRF token = `base64url(HMAC-SHA256(masterSecret, sessionToken))`. Sessions are in-memory (see limitation below). Session store and rate-limit table are pinned to `globalThis` so all Next route bundles share them.
- **Routes**: `POST /api/auth/login` (Zod body, 4 KB cap, 5/min per IP and per username plus a 30/min global bucket, generic `Invalid username or password`, audit for success and failure, never logs the password; cookie `praxel_session`, HttpOnly, SameSite=Strict, Path=/, Max-Age=86400, Secure in production), `GET /api/auth/session` (`{authenticated, operatorId?, csrfToken?}`), `POST /api/auth/logout` (requires CSRF; clears cookie + session; audit). New audit event types `auth_login`, `auth_logout`.
- **Every non-GET/HEAD/OPTIONS request** now needs: a valid Origin (exact match against the allowlist; missing or `null` is rejected) and, for cookie sessions, a matching `x-csrf-token` (constant-time compare). `Authorization: Bearer <session token>` clients skip CSRF but any Origin they send must still be allowed. Auth failures return `auth.status` (401 no/invalid session, 403 Origin/CSRF) from all routes.
- **Allowed origins** = `ALLOWED_ORIGINS` (comma list, each normalized with `new URL(x).origin`) plus, outside production only, `http://localhost:<PORT>` and `http://127.0.0.1:<PORT>` (`PORT` default 3000).
- **Host allowlist (DNS-rebinding defense)**: `src/proxy.ts` (Next 16 `proxy` convention, matcher `/api/:path*`) returns 421 unless `Host` exactly equals `localhost:<PORT>`, `127.0.0.1:<PORT>`, `[::1]:<PORT>`, the host of an `ALLOWED_ORIGINS` entry, or an `ALLOWED_HOSTS` entry. Pure logic lives in `src/lib/security/origins.ts` (unit tested).
- **Terminal gateway**: query/header token authentication removed in all environments; only single-use tickets (`?ticket=` or the first `auth` frame) are accepted. Any `?token=`, `Authorization` or `x-operator-token` without a ticket is closed with 1008. `getGatewayStartupError()` makes the standalone entrypoint log a fatal error and `process.exit(1)` when `NODE_ENV=production` and `ALLOWED_ORIGINS` is empty (not enforced by the constructor, so tests are unaffected).
- **Frontend**: root page calls `/api/auth/session` on load and shows `LoginScreen` when unauthenticated (also on any later 401); `src/lib/client/api.ts` `apiFetch` sends `credentials: "same-origin"` plus `x-csrf-token` on mutations and is used by every client `fetch("/api...")` including the TerminalView ticket request; a Sign out button sits in the menu bar.
- `tsconfig.json` gained `allowImportingTsExtensions` so `operators.ts` can import `../storage/*.ts` with explicit extensions (required for plain-node type stripping).

#### Creating an operator

```bash
# password from env (CI / scripted) ...
PRAXELOPS_OPERATOR_PASSWORD='a long passphrase' \
  node --experimental-strip-types scripts/create-operator.ts alice
# ... or omit it on a terminal to be prompted twice with echo off
node --experimental-strip-types scripts/create-operator.ts alice
# replace the password of an existing operator
node --experimental-strip-types scripts/create-operator.ts alice --reset
```

An existing username is never overwritten without `--reset`. The file lands in `PRAXELOPS_DATA_DIR` (default `./.peos/data/operators.json`), so run the command with the same data dir as the web server. Node prints a harmless `MODULE_TYPELESS_PACKAGE_JSON` warning; add `--no-warnings` to hide it. No npm script was added (package.json untouched in this step).

#### Environment variables

> **Superseded**: the consolidated and complete reference is 7.4. This table is kept as written at M6.3; its `PRAXELOPS_SECRET` row says "and encryption", which is incorrect: nothing is encrypted yet (credentials are plaintext at rest, see 7.6).

| Variable | Purpose |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma list of full origins (`https://ops.example.com`) allowed to make state-changing requests; their hosts are also allowed in the `Host` check. Required in production (the gateway refuses to start without it). |
| `ALLOWED_HOSTS` | Extra exact `Host` header values (`host[:port]`) accepted for `/api/*`, e.g. an internal name behind a proxy. |
| `PORT` | Port used to derive the default loopback origins/hosts (default 3000). |
| `PRAXELOPS_SECRET` | 32+ char master secret used for the CSRF HMAC (and encryption); mandatory in production. |
| `PRAXELOPS_DATA_DIR` | Location of `operators.json` and the other stores. |
| `PRAXELOPS_OPERATOR_PASSWORD` | Password input for `create-operator`. |

Browsing the dev server by any other hostname/IP (for example a LAN address) now needs both `ALLOWED_HOSTS` (Host check) and `ALLOWED_ORIGINS` (mutations).

#### Test evidence

> Historical, as of the M6.3 commit (130 tests / 16 files). Final Milestone 6 numbers are in 7.2 (172 tests / 20 files, plus 7 E2E).

- `npx tsc --noEmit`: exit 0.
- `npx vitest run`: 16 files, 130 tests passing (baseline 81). New coverage: auth bypass regression (look-alike Hosts, `local-operator-token` in development/test/production), CSRF/Origin matrix for POST/PUT/PATCH/DELETE, bearer path, idle/absolute expiry with fake timers, operator hashing/validation/timing, login/session/logout route handlers (cookie flags, generic failure, per-user and per-IP rate limiting, audit), host/origin allowlist units, `proxy()` unit test, gateway `?token=` rejection (dev literal, bogus, and a *valid* session token in production, with `createInteractiveSession` asserted not called), ticket flow in production including replay refusal, gateway startup guard.
- `npm run build`: succeeds; routes include `/api/auth/login`, `/api/auth/logout`, `/api/auth/session`, and `ƒ Proxy (Middleware)`.
- Smoke test against `next start`: look-alike `Host` headers get 421; unauthenticated `/api/servers` 401; login sets the hardened cookie; mutation without CSRF 403, without/with foreign Origin 403, correct 400-class validation response; logout invalidates the session.

#### Known limitations (as written at M6.3; the current list is 7.6)

- Sessions live in web-process memory: restarting (or running several web processes) means operators must sign in again, and sessions are not shared across processes. The ticket store remains file-backed, so the gateway process is unaffected.
- Login rate limiting is also in-memory per process, and the client IP comes from `X-Forwarded-For`/`X-Real-IP` (spoofable unless a trusted reverse proxy overwrites it); the per-username and global buckets are the backstop. A burst of failures can temporarily lock a username out (5/min).
- **Superseded in M6.2 (65ea358, which actually precedes this commit; the bullet was already stale when written):** `npm run terminal:gateway` now runs `tsx src/server/terminalGateway.ts`, which resolves the `@/` alias, and the script is exercised by the M6.7 E2E. Original text: `npm run terminal:gateway` currently cannot start under plain `node --experimental-strip-types`: `terminalGateway.ts` (and `ssh/adapter`, `storage`) still import via the `@/` alias, which only Next/Vitest resolve. This predates M6.3; the production startup guard is implemented and unit tested but not exercisable through that script until those imports are made relative.
- Single operator role; no password-change UI (use `--reset`).

### 7.6 Known limitations / open items (input for the next milestone)

Security and correctness:

1. **Web sessions are in memory.** A web-process restart (or a second web process) means every operator signs in again; sessions are not shared across processes. The ticket store is file-backed, so a web restart does not invalidate tickets already issued (design property; the E2E restarts the web process and checks that the old cookie is refused and a new login works).
2. **Login rate limiting trusts spoofable headers.** `AuthService.getClientIp` (web process) takes the first `X-Forwarded-For` entry or `X-Real-IP` and does not consult `TRUSTED_PROXIES`. The first entry is client-controlled even behind the sample nginx config (`$proxy_add_x_forwarded_for` appends). The per-username (5/min) and global (30/min) buckets are the backstop; a burst of failed logins can temporarily lock a username out. Rate-limit state is also per process and in memory.
3. **Credentials are plaintext at rest** in `servers.json` (passwords, private keys, passphrases). They are stripped from API responses (M6.4) but not encrypted on disk. Encryption is planned for M7. `PRAXELOPS_SECRET` is not used for this yet.
4. **The audit log is a JSON array under a file lock**, not tamper-evident. An append-only hash chain is planned for M7. The `immutableAuditLog: true` flag in `peos.manifest.json` describes the target, not the current state.
5. **TOFU host-key enrollment is automatic.** The first key seen is pinned and audited with no operator confirmation. An explicit confirmation UI is planned. (A changed key is rejected and audited; the E2E covers it.)
6. **Ticket claim uses `rename`.** On Windows, under heavy contention, more than one `renameSync` of the same ticket file was observed to succeed; reads were still single-winner in that observation. An exclusive-create (`wx`) claim marker is planned. Linux behaviour has not been observed.
7. **`consumeTicket` returns only `null` on failure**, so the gateway cannot distinguish replay, expiry, origin mismatch or purpose mismatch in its rejection audit.
8. **Single operator role.** No per-server RBAC, no password-change UI (use `--reset`), no WebAuthn. (The M5 plan to deliver RBAC in M6 was not carried out.)

Verification gaps:

9. **TLS / WSS reverse proxy not verified.** The nginx and systemd samples in Sections 5 and 6 have not been run against the current code (and are incomplete for it, see the note under the systemd units).
10. **Login UI not browser-tested.** `LoginScreen`, `apiFetch` and the sign-out button were exercised only through HTTP-level tests and the E2E API flow.
11. **External VPS validation BLOCKED** pending authorized access; no external host has been contacted. In-process and two-process tests use the `ssh2` fixture, which is not an external validation.
12. **Linux CI not yet run.** All evidence is Windows 10 / Node 24.

Feature gaps visible in code (unchanged by M6):

13. Nothing populates `server.metrics` from a real host (only the explicit demo loader sets them), so there is no live telemetry collector; diagnostics are rule-based on stored metrics with no LLM provider adapter.
14. The Section 5 roadmap items remain open: WebAuthn/FIDO2, SIEM export, native desktop packaging.

### 7.7 Rollback runbook (current; supersedes the `2725a01` procedure in Section 6)

**Back up runtime state first. It is no longer in git.** Since `4156e53`, `.peos/data` is untracked, so `git checkout` does not restore or protect it.

```bash
# 0. Back up runtime state (location = $PRAXELOPS_DATA_DIR, default <app dir>/.peos/data)
cp -r "${PRAXELOPS_DATA_DIR:-.peos/data}" "../praxelops-data-backup-$(date +%Y%m%d%H%M%S)"
cp .peos/config/master.key ../praxelops-master.key.bak   # only if you rely on the key file instead of PRAXELOPS_SECRET

# 1. Pick a checkpoint (see table), then:
git checkout <commit>
npm ci            # package-lock.json exists from 15036c1 onward; use npm install for 4156e53 and 765cc6c
npm run build

# 2. Restart both supervised services, then check health
sudo systemctl restart praxelops-web praxelops-gateway
curl -s http://127.0.0.1:3001/
curl -s -I http://127.0.0.1:3000/
```

M6 checkpoints:

| Commit | State |
| :--- | :--- |
| `4ff6a56` | M6.7, end of Milestone 6 (current head of `m6-hardening`) |
| `2f751bf` | M6.6 gateway hardening (before the E2E and the scrypt test headroom fix) |
| `7f25180` | M6.4 credentials stripped from API responses |
| `765cc6c` | M6.3 operator login; earlier than this has the auth bypasses |
| `4156e53` | M6.1 atomic stores, runtime data untracked |

Rolling back past `4156e53` (to `9213501` = M5, `2725a01` = M4 or earlier) is **not recommended**: those commits track `.peos/data/*.json`, so the checkout may be refused or may replace your local runtime files, and they contain the bypasses and the legacy route fixed in M6. It was not tested whether data written by M6 code is readable by older code.

