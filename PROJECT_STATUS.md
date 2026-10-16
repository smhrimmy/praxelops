# PraxelOps Project Status & Real-Data Verification Audit

## 1. System Overview
- **Project**: PraxelOps
- **Runtime**: Node.js v24.11.0, Next.js 16.4.2 (Turbopack), React 19, TypeScript (strict), Tailwind CSS v4, SSH2, Vitest 5.0.5
- **Governance**: PEOS-v2 Specification (`PEOS.md`, `peos.manifest.json`)
- **Primary Goal**: Verified, portfolio-quality infrastructure platform without mock data or fabricated state.

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

### 2. Partially Implemented Functionality
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
2. `/api/ssh/exec` (`POST`):
   - Validates operator session, rate limits (60/min), verifies server existence in storage.
   - Resolves stored credentials on backend; passwords/private keys are never sent in request bodies from the browser.
3. `/api/ssh/session` (`POST`):
   - Interactive PTY session manager supporting `create`, `resize`, `input`, and `close`.
   - Validates session tokens, window dimensions (`cols`, `rows`), and manages persistent `ssh2.ClientChannel`.
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
  - Each ticket is strictly bound to:
    - Operator Session ID (`operatorSessionId`)
    - Target Server ID (`serverId`)
    - Request Origin (`origin`)
    - Expiration timestamp (strictly 60 seconds from issuance)
  - The ticket can only be consumed **once**. Calling `consumeTicket(ticketId)` atomically validates and deletes the ticket from memory. Any attempt to replay or reuse the ticket is rejected immediately.
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

- `src/lib/security/ticket.test.ts`: 4 tests validating 32-byte cryptographic entropy, atomic single-use consumption, rejection of expired tickets (60s TTL), and periodic memory pruning.
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
  - `ƒ /api/ssh/session`
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

#### D. Environment Variables Reference
| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `NODE_ENV` | `development` | Setting to `production` enforces single-use ticket auth and blocks URL query tokens. |
| `PRAXELOPS_SECRET` | Auto-generated in dev | 256-bit cryptographic signing secret for tokens, HMAC approvals, and ticket signing. |
| `ALLOWED_ORIGINS` | `http://localhost:*` | Comma-separated list of trusted HTTP origins permitted to establish WebSocket terminal connections. |
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
Milestone 5 performed a rigorous production security audit of PraxelOps' dual-process architecture, verified cross-process coordination between the Next.js web runtime and the standalone Terminal Gateway, hardened origin and proxy validation, and confirmed wire-level protocol fidelity against authentic TCP SSH sockets.

### 2. Confirmed Vulnerabilities & Applied Remediations

| Vulnerability / Risk | Severity | Root Cause | Implemented Defense & Verification |
| :--- | :--- | :--- | :--- |
| **Process-Local Ticket Store Isolation** | Critical | Next.js (`port 3000`) and Terminal Gateway (`port 3001`) run as separate OS processes. Memory-only `Map` in `TicketService` caused tickets issued by Next.js to be invisible to Terminal Gateway. | Transitioned `TicketService` (`src/lib/security/ticket.ts`) to a shared, persistent atomic store in `.peos/data/tickets/`. Uses atomic OS rename (`fs.renameSync` from `.json` to `.consuming` followed by `fs.unlinkSync`) to guarantee atomic single-use consumption across process boundaries and survive process restarts. |
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
1. **Multi-Process Ticket Service (`src/lib/security/ticket.test.ts` - 8 tests)**:
   - High-entropy cryptographic ticket issuance with 60s TTL.
   - Atomic consumption and single-use replay prevention.
   - Client Origin binding verification (mismatched origin rejected).
   - Session purpose binding verification (`terminal_shell`).
   - Cross-process persistence across memory wipe (simulated gateway restart).
   - Race-condition handling under concurrent consumption (5 simultaneous consumers, exactly 1 succeeds).
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

- **Status**: **BLOCKED (Awaiting Authorized External Credentials)**
- **Audit Findings**:
  - No external VPS IP addresses, SSH ports, or authorized credentials were provided in the execution context or repository environment.
  - To preserve operational safety and avoid unauthorized network scanning, no arbitrary external hosts were contacted.
  - Full wire-level SSH protocol fidelity was independently verified using an authentic, in-process TCP SSH server fixture (`ssh2.Server`) running real cryptographic key exchange, authentication, and SFTP subsystem protocol wire framing.
  - This in-process wire verification is strictly categorized as an integration test fixture and is explicitly NOT conflated with an external VPS validation.
- **External VPS Unblocking Procedure**:
  When authorized external VPS credentials become available:
  1. Add the VPS to server inventory via `POST /api/servers` or Studio UI.
  2. Initiate connection via Terminal tab; verify host-key fingerprint prompt.
  3. Confirm interactive PTY shell streaming (`htop`, `tmux`, `nano`).
  4. Perform SFTP file browse and file read operations.
  5. Inspect `.peos/data/audit.json` to verify zero secret leakage in logs.

---

### 5. Deployment, Health Checks & Rollback Runbooks

#### A. Multi-Process Startup Runbooks

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

1. **Role-Based Access Control (RBAC)**: Currently single-operator boundary; multi-tenant operator roles with per-server isolation are scheduled for Milestone 6.
2. **WebAuthn / FIDO2 Hardware Tokens**: Hardware key verification (e.g. YubiKey) for AI high-impact command execution.
3. **Audit Log SIEM Export**: Long-term streaming export to enterprise Syslog or SIEM platforms.




