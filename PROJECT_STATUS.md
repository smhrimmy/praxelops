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
- High-frequency WebSocket server bridge for continuous interactive TUI sessions (`vim`/`htop`).

