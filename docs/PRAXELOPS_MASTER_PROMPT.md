# Build PRAXELOPS — The Unified AI Server Operations Platform

> Master implementation prompt for the coding agent (Antigravity) and the reviewing agent (Claude).
> Read this whole document before writing code. It supersedes earlier drafts of the "master prompt".

---

## 0. Read first — this is an existing codebase, not a greenfield build

PraxelOps already exists at `C:\Users\dlpra\sshos` (Milestones 1–5, HEAD `9213501`):

- Next.js 16 App Router + React 19 + strict TypeScript + Tailwind + Zod.
- `ssh2` SSH/SFTP adapter with host-key verification and TOFU known-hosts.
- Standalone `ws` terminal gateway (port 3001) + xterm.js, single-use connection tickets.
- Typed operation policy, HMAC-signed approvals, audit log, PEOS governance (`PEOS.md`, `peos.manifest.json`, `PROJECT_STATUS.md`), frozen contracts in `src/types/*`.

**Non-negotiable rules for every change:**

1. Extend; do not rebuild. Never replace a working module because a different stack is preferred. Any architecture change needs a written defect, migration scope, risk and rollback plan, approved before code.
2. Respect PEOS governance and the frozen contracts in `src/types/`. Changing a frozen contract is a versioned, reviewed change.
3. **Milestone 6 (Hardening & Real Topology, §11) must be finished and reviewed before any new feature module starts.** The Milestone 5 review found that the gateway does not start via its npm script, there is no production login, the JSON stores can tear under two processes (known-hosts fails open), and the tests mutate real tracked data.
4. One narrowly scoped change per milestone step → tests + typecheck + build → evidence recorded in `PROJECT_STATUS.md` → Claude review → fixes → Git checkpoint.
5. Never claim something works without evidence (command, output, test name). Mark untested items **UNVERIFIED** or **BLOCKED**.

---

## 1. Product objective and positioning

PraxelOps is a local-first, macOS-inspired **server operations command center**: SSH, terminal, files, monitoring, Docker/PM2, deployments, security, automation and an AI operations copilot in one workspace.

Use CtrlOps (https://ctrlops.io/) only as a feature-research reference. Build an original identity, UI and implementation. Do not copy proprietary code, branding, copy or exact layouts.

**Core loop — every operational feature follows it:**

```
Understand → Diagnose → Plan → Approve → Execute → Verify → Record
```

### What makes PraxelOps better than a conventional SSH manager

| Area | Typical SSH/server manager | PraxelOps differentiator |
|---|---|---|
| AI | Generates shell commands | **Evidence-backed diagnosis**: every claim cites collected output; facts vs hypotheses; remediation is a typed, policy-checked plan; result is re-verified with fresh evidence |
| Execution | Run command on a server | **Change plans** with dry-run / preview, blast-radius view, risk tier, signed approval, and **fleet rollout** (canary → batches, stop on failure) |
| Audit | Activity list | **Tamper-evident hash-chained audit log** + redacted **session recordings** (asciicast) replayable in-app |
| Access | Store keys | **Just-in-time access**: short-lived SSH certificates from a local SSH CA, access requests with expiry, key-rotation tracking |
| Config | Edit files | **Drift detection**: snapshot `sshd_config`, nginx, systemd units, crontabs, firewall; diff over time; alert on unexpected change |
| Incidents | Charts | **Incident timeline** correlating metrics, deploys, commands, alerts and AI findings; one-click **postmortem draft** from evidence |
| Runbooks | Saved scripts | **Executable runbooks** (notebook-style steps with parameters, checks and approvals), reusable by humans and the AI |
| Integrations | Fixed | **MCP server** exposing PraxelOps operations as tools — still gated by the same policy and approval engine |

These are the resume-defining features. Build them on top of a solid core; do not start with them.

---

## 2. Product principles

- Real integrations only. No fabricated servers, metrics, logs, files or success toasts. Demo data must be visibly labeled **DEMO** and isolated from real data.
- Empty states are honest: an empty inventory stays empty until a server is added.
- Strict host-key verification. Never weaken it to make a test pass.
- AI is advisory. It never silently executes anything. Model output is never passed directly to a shell.
- Explicit approval for sensitive operations; a second, typed confirmation for destructive ones.
- Secrets never reach the browser, logs, audit records, AI prompts, Git, or API responses.
- Predictable failure: every operation has defined timeout, cancellation, partial-failure and retry behavior.
- Desktop-first, keyboard-first, dark mode default, light mode supported.
- Unsupported capabilities are shown as unsupported — never as buttons that do nothing.

---

## 3. Architecture

### 3.1 Runtime modes (one product, three deployments)

| Mode | What it is | Who holds SSH credentials | Status |
|---|---|---|---|
| **Local Studio** | Current Next.js app + terminal gateway, bound to loopback on the operator's machine | Local encrypted vault on that machine | Exists — harden in M6 |
| **Desktop** | Tauri 2 shell around the same React UI | Desktop privileged backend + OS keychain | M9 |
| **Hosted Web (Team)** | Control plane for inventory metadata, dashboards, reports, runbooks, approvals, audit | **Nobody centrally.** Execution happens through a user-run **PraxelOps Runner** (relay) that dials *out* to the control plane | M13+ (optional) |

The browser must never be presented as able to read local SSH keys or run local processes. Direct SSH, local filesystem access and credential storage belong only in a privileged backend (Local Studio server process, Desktop backend, or Runner).

### 3.2 Engine contract

Define one `OpsEngine` interface (TypeScript, Zod-validated) covering: connect/disconnect, PTY sessions, exec of **typed operations**, SFTP, tunnels, metrics sampling, host-key management. Implementations:

1. **Node engine** (existing `ssh2` adapter) — used by Local Studio, by the Desktop app as a sidecar in its first release, and by the Runner.
2. **Rust engine** (`russh`) — optional, later, only if a measured need exists (binary size, performance, sandboxing). Must pass the same contract test suite before it can replace the Node engine.

Do not rewrite the SSH layer in Rust as part of the desktop milestone.

### 3.3 Repository layout target (incremental, no big-bang move)

```
src/app/            Next.js routes and API (existing)
src/server/         terminal gateway, workers (existing)
src/lib/            engine, security, storage, ai, policy (existing)
src/types/          frozen contracts (existing)
packages/ui/        shared design system (extract when Desktop starts)
packages/contracts/ Zod schemas shared by web, desktop, runner (extract when Desktop starts)
apps/desktop/       Tauri 2 shell (M9)
apps/runner/        outbound relay (M13)
```

Move code only when a second consumer needs it.

### 3.4 Persistence

Replace ad-hoc JSON files with **SQLite** (WAL mode, single writer per process, migrations, foreign keys) behind the existing `StorageService` API, so callers do not change:

- `servers`, `server_groups`, `tags`, `credentials` (encrypted), `known_hosts`, `sessions`, `tickets`, `operations`, `approvals`, `audit_events` (hash-chained, append-only), `recordings`, `metrics_samples`, `alerts`, `deployments`, `releases`, `runbooks`, `runbook_runs`, `schedules`, `drift_snapshots`, `incidents`, `settings`.
- Data dir from `PRAXELOPS_DATA_DIR`; tests always use a temp dir.
- Secrets encrypted with a key held in the OS keychain (Desktop) or derived from `PRAXELOPS_SECRET` (Local Studio / server). Envelope encryption so the key can rotate.
- Hosted mode uses PostgreSQL for metadata only — never server credentials.

---

## 4. Navigation and layout

Collapsible sidebar, grouped:

- **Overview:** Home (Command Center), Incidents, Activity & Audit
- **Fleet:** Servers, Groups & Tags, Monitoring, Alerts
- **Workspace:** Terminal, Files, Logs, Port Forwarding
- **Runtime:** Docker, Processes (PM2 / systemd), Cron & Schedules
- **Delivery:** Deployments, Releases, Backups
- **Automation:** Runbooks, Scripts, Workflows
- **Security:** Security Center, SSH Access & Keys, Access Requests, Drift
- **AI:** AI Operations
- **Settings:** Profile, AI providers, Integrations (MCP, Slack, Telegram, email, webhooks), Appearance, Data & Backup

Workspace rules:

- Primary workspace fits the viewport; tables, logs and trees scroll internally.
- Draggable split panes and tabs; layouts persist per workspace.
- Global command palette (`⌘K` / `Ctrl+K`) for navigation, server quick-connect, actions and runbooks.
- Breadcrumbs, contextual actions, notifications center, persistent connection-status indicator.
- Every screen has real loading, empty, error, permission-denied and stale-data states.

---

## 5. Feature modules

Each module lists **scope** and **acceptance criteria**. A module is not done until its criteria are demonstrated with tests or recorded manual evidence.

### 01 — SSH & Terminal

Scope:

- Connection profiles: host, port, username, environment (prod/staging/dev), tags, groups, notes, color label.
- Auth: password, private key (OpenSSH/PEM, encrypted keys with passphrase), SSH agent (Desktop/Local), keyboard-interactive (incl. OTP prompts), and SSH certificates (§07).
- Import from `~/.ssh/config` (Host, HostName, User, Port, IdentityFile, ProxyJump) with a preview before import.
- Host-key verification: explicit first-use enrollment showing the fingerprint (SHA256) for operator confirmation; mismatch blocks the connection and raises a security alert; known-hosts screen to view, re-verify, and revoke.
- Interactive PTY sessions with streaming I/O, resize, UTF-8 and ANSI correctness, bracketed paste.
- Multiple tabs, split panes, broadcast input to selected panes (with a visible warning banner).
- Reconnect with backoff; clear distinction between "network lost" and "session ended".
- Jump hosts / ProxyJump chains, connect timeout, keep-alive interval, per-profile settings.
- Searchable scrollback, copy/paste, command history per server, clickable links.
- Session recording (asciicast v2) with secret redaction, replay in-app, retention policy.
- Session limits per operator and globally; idle timeout; clean teardown on close.

Acceptance:

- Real PTY against a Docker `sshd` fixture: `vim`, `htop`, `top`, Unicode, 256-color, resize all render correctly.
- Host-key mismatch blocks before credentials are sent (proved by test).
- Closing a tab mid-connect leaves zero orphaned SSH connections (proved by test).

### 02 — SFTP File Explorer

Scope:

- Remote browsing with breadcrumbs, sort, filter, hidden-file toggle; local pane in Desktop mode.
- Upload, download, drag-and-drop, directory transfer, transfer queue with progress, pause/cancel/retry, resumable transfers where supported.
- Create, rename, move, delete (trash-style confirm), chmod/chown where authorized.
- Text preview and in-app editor (Monaco) with size limit, encoding detection, conflict detection on save (mtime/hash check — never silently overwrite).
- Archive extract/compress via typed operations, file search, side-by-side compare.

Acceptance: path traversal and symlink-escape tests; overwrite requires confirmation; interrupted upload leaves no corrupt target (write to temp + rename).

### 03 — AI Operations Copilot

See §6 for the full specification. Scope summary: natural language → typed operation plans; explain errors, logs and scripts; diagnose CPU, memory, disk, network, DNS, TLS and services; generate configs and runbooks; configurable providers (Anthropic, OpenAI-compatible, local models via Ollama) with per-provider data-sharing settings.

### 04 — Infrastructure Monitoring

Scope:

- Agentless sampling over SSH (`/proc`, `df`, `ss`, `systemctl`, `uptime`) at configurable intervals with backoff; optional lightweight agent later.
- CPU, memory, swap, load, disk (space + inodes), network throughput, open ports, uptime, top processes.
- Historical charts (downsampled retention: raw 24h, 5-min 30d, hourly 1y).
- Threshold and anomaly alerts with hysteresis, silencing, and acknowledgement.
- Fleet overview: health grid by group/environment, compare servers side by side.
- Stale data is labeled with its age; a failed sample is shown as failed, not as zero.

### 05 — Docker & Process Manager

Scope:

- Detect Docker / Compose / PM2 / systemd availability and permissions; explain missing access instead of failing silently.
- Containers, images, volumes, networks, Compose projects; logs (follow), exec shell, start/stop/restart, resource stats.
- PM2: list, restart, reload, stop, logs, ecosystem file view.
- systemd: unit status, start/stop/restart/enable, journal view.
- Every mutating action is a typed operation through the policy engine.

### 06 — Deployment Center

Scope:

- Projects: Git repo + branch/tag, build commands, env vars (encrypted), target servers/groups, strategy.
- Presets: Node.js, Next.js, static site, PHP, Docker Compose.
- Release directories with atomic symlink switch (`releases/<id>` → `current`), keep N releases.
- Pipeline: preflight → plan display → approval → build → upload/pull → switch → health check → finalize; streaming logs.
- **Health verification is not "exit code 0"**: HTTP check (status, body match, latency), process check, and log-error scan within a window.
- Automatic rollback on failed health check; manual one-click rollback to any kept release.
- Fleet rollout: canary server → batches with configurable size and pause; stop on first failure.
- Nginx site config generation with `nginx -t` validation before reload; TLS certificate status and expiry alerts (Let's Encrypt guidance).
- Release history with who/what/when, linked to audit and incidents.

### 07 — Security & Access

Scope:

- Key inventory: which public keys are authorized on which servers/users, age, last use where determinable, rotation reminders.
- `authorized_keys` management via typed operations with backup and diff before change.
- **Local SSH CA**: issue short-lived user certificates (e.g. 1–8h) for just-in-time access; configure servers to trust the CA via a reviewed plan.
- **Access requests**: request → approve → time-boxed certificate → automatic expiry, all audited.
- Hardening checks (CIS-inspired): sshd settings, password auth, root login, firewall (ufw/nftables), unattended upgrades, open ports, sudoers, world-writable files, failed-login spikes.
- Findings with severity, evidence, remediation plan (typed operations), and exportable report (PDF/Markdown).
- **Drift detection**: scheduled snapshots of key config files; diffs; alert on unapproved changes; link drift to the audit event that caused it if one exists.

### 08 — Automation & Operations

Scope:

- Scripts library with typed parameters, validation, and risk classification.
- **Runbooks**: ordered steps (check, operation, approval gate, wait, branch on result), parameters, dry-run mode, per-step output capture, resumable runs.
- Schedules: cron management on servers (view/diff/edit through typed ops) and PraxelOps-side schedules for runbooks.
- Backups: files and databases (MySQL/Postgres dumps), retention, encryption, offsite targets (S3-compatible), **restore verification** runs.
- Alerts routing: email, Slack, Telegram, generic webhook; per-route severity filters; delivery audit.
- Saved SSH tunnels (local, remote, dynamic SOCKS) with auto-start and health indicator.

### 09 — Incidents & Timeline

Scope: open an incident from an alert or manually; auto-assemble a timeline from metrics, deploys, commands, approvals, alerts and AI findings in the window; notes; resolution; **postmortem draft** generated from recorded evidence only (with citations to audit event IDs).

### 10 — Audit & Compliance

Scope:

- Append-only audit events with a **hash chain** (`hash = H(prev_hash || canonical_event)`), periodic chain verification, and visible integrity status.
- Events: auth, ticket issue/reject, session open/close, host-key enroll/mismatch, every operation (plan, approval, execution, result, verification), config/drift changes, AI proposals, settings changes.
- Redaction pipeline applied before persistence; never store credentials, private keys, tokens or full command output flagged as sensitive.
- Filters, search, export (JSONL, CSV), retention.

### 11 — Integrations

Scope: **MCP server** exposing read operations freely and mutating operations only as *proposals* that land in the PraxelOps approval queue; outbound webhooks; Git provider webhooks for deploy-on-push (opt-in); plugin interface for new typed operations (manifest + Zod schema + policy).

### 12 — Settings & Data

Scope: profile and session management, AI providers and data-sharing controls, appearance, keyboard shortcuts, data export/import, encrypted backup of the PraxelOps database, telemetry opt-in (off by default).

---

## 6. AI Operations Copilot — detailed specification

### 6.1 Evidence model

1. **Collect**: the AI may only request **read-only typed probes** (e.g. `service.status`, `journal.tail`, `disk.usage`, `net.listening`, `dns.resolve`, `tls.inspect`). Probes run without approval only if policy marks them read-only; output is redacted before it reaches the model.
2. **Diagnose**: response schema (Zod-validated) separates `facts[]` (each with `evidenceId` pointing at captured output), `hypotheses[]` (with confidence and the evidence that would confirm/refute), and `unknowns[]`.
3. **Plan**: remediation is a list of **typed operations** with parameters, risk tier, expected effect, and rollback step. Free-form shell is allowed only as a `custom.command` operation: highest risk tier, shown verbatim, editable, double-confirmed, and blockable by policy per environment.
4. **Approve**: server generates the canonical command from the typed operation; the operator approves exactly that; approval is HMAC-signed, bound to operator, server(s), plan hash and expiry, single-use.
5. **Execute**: only the approved canonical commands run. Streaming output captured.
6. **Verify**: re-run the relevant probes; the AI must state whether the evidence shows the problem resolved. "Command succeeded" is not verification.
7. **Record**: diagnosis, evidence, plan, approval, execution and verification are linked in audit and the incident timeline.

### 6.2 Hard rules

- The model never receives secrets, private keys, environment variable values, or unredacted output.
- The model cannot approve, cannot raise its own risk tier ceiling, and cannot call mutating operations directly.
- If the model references evidence that was not collected, reject the response and show an error — do not render invented logs.
- Prompt-injection defense: content from servers (logs, files, command output) is delimited as untrusted data; instructions inside it are never followed.
- Provider failures and timeouts surface as errors, never as fabricated answers.

### 6.3 Risk tiers

| Tier | Examples | Gate |
|---|---|---|
| 0 Read | status, logs, metrics, file read | None (policy can still restrict) |
| 1 Low | restart a non-critical service, clear app cache | Single approval |
| 2 Medium | config change with backup, package update, deploy | Approval + plan preview/diff |
| 3 High | firewall/sshd change, user/key changes, prod deploy | Approval + typed confirmation + lockout-safety check (e.g. keep a second session open for sshd changes) |
| 4 Destructive | delete data, drop DB, `custom.command` in prod | Approval + typed server name + optional second operator |

---

## 7. Security model

- **Threat model document** (`docs/THREAT_MODEL.md`): assets, actors (remote attacker, malicious web page / DNS rebinding, local unprivileged user, compromised server output, malicious AI output), trust boundaries, mitigations, residual risk.
- **Auth**: real operator login (Argon2id password and/or WebAuthn passkey), HttpOnly SameSite=Strict session cookie, CSRF token on all mutations, exact Origin checks, session expiry and revocation. No Host-header-based bypasses; any insecure dev mode requires an explicit `PRAXELOPS_INSECURE_DEV=1` and shows a red banner.
- **Local Studio binding**: loopback only by default; DNS-rebinding defense by validating Host against an exact allowlist.
- **Gateway**: tickets only (single-use, 60s, bound to operator/server/origin/purpose); `maxPayload` limits; auth deadline; per-operator and global session caps; fail closed if production config is incomplete.
- **RBAC** (Team mode): roles (viewer, operator, approver, admin) × scopes (server group, environment); approvals can require a different user than the requester for tier ≥ 3.
- **Secrets**: encrypted at rest, never returned by APIs (write-only fields), redacted from logs, excluded from Git (`.peos/data/` untracked).
- **Supply chain**: lockfile committed, `npm audit` / Dependabot in CI, Tauri capabilities least-privilege, signed desktop builds.
- **Rate limits and request size limits** on every API route.

---

## 8. Desktop application (Tauri 2)

- Same React UI; Tauri commands are narrowly scoped and Zod/serde-validated on both sides.
- First release runs the existing Node engine as a sidecar bound to a random loopback port with a per-launch secret; later evaluate `russh` behind the `OpsEngine` contract.
- OS keychain for the vault key (macOS Keychain, Windows Credential Manager, libsecret).
- Native SSH agent support, local file pane for SFTP, local port forwarding.
- Auto-update with signature verification; crash-safe session restore.
- Capabilities file reviewed in every PR that touches it.

---

## 9. Design system

- macOS-inspired: translucent sidebar/toolbars (restrained blur, only on chrome), rounded surfaces, subtle shadows, SF-like system font stack, monospace for terminals.
- Dark default, light supported; design tokens as CSS variables; WCAG AA contrast.
- Motion: short, GPU-friendly (transform/opacity), respects `prefers-reduced-motion`.
- Components (shadcn/ui-based): sidebar, tabs, split panes, data table with virtualization, log viewer with virtualization, command palette, toasts, approval dialog, diff viewer, risk badge, status pill, empty/error states, chart cards (Recharts).
- Risk is always communicated by text + icon, not color alone.

---

## 10. Testing and quality gates

Required before any milestone is checkpointed:

- `npm run typecheck`, `npm test`, `npm run build` all pass; `git status` is clean after tests (tests never touch real data).
- **Unit tests** for policy, approvals, redaction, ticket store, parsers.
- **Contract tests** for `OpsEngine` that any engine implementation must pass.
- **Real-protocol integration** against Docker `sshd` fixtures (Ubuntu, Debian, Alpine) via Testcontainers or docker-compose: PTY, SFTP, host-key mismatch, auth failures, disconnects.
- **Multi-process tests** that start the web server and gateway as separate OS processes and exercise the full ticket → WebSocket → SSH flow, including independent restarts.
- **Concurrency tests** with real OS processes for every shared store.
- **E2E (Playwright)**: add server → verify fingerprint → open terminal → run command → SFTP upload/download → AI diagnosis with approval → audit entry visible.
- **Security tests**: CSRF, Origin, DNS-rebinding Host values, replayed tickets/approvals, path traversal, oversize payloads, redaction of secrets in logs/audit.
- CI on GitHub Actions (Linux + Windows), coverage report, dependency audit.

Label every test in `PROJECT_STATUS.md` as: unit (mocked) / in-process protocol / multi-process / real external host.

---

## 11. Milestone roadmap

| # | Milestone | Exit criteria (evidence required) |
|---|---|---|
| **M6** | **Hardening & Real Topology** (from M5 review) | Tests use temp `PRAXELOPS_DATA_DIR`; `.peos/data` untracked; atomic writes with no empty-fallback on parse error; dev bypass and hard-coded token removed; gateway starts via npm script; real login + CSRF; credentials redacted from APIs; gateway `maxPayload`/auth deadline/orphan fixes; legacy `/api/ssh/session` removed; multi-process E2E ticket flow passes under `NODE_ENV=production` |
| M7 | SQLite persistence + audit hash chain + encrypted vault | Migration from JSON with backup; chain verification test; secrets unreadable in DB file |
| M8 | Terminal & SFTP completion | Split panes, recordings, ssh-config import, jump hosts, transfer queue, editor with conflict detection; Docker sshd fixture suite |
| M9 | Desktop app (Tauri 2 + Node sidecar) | Signed build on Windows/macOS; keychain vault; agent auth; local file pane |
| M10 | Monitoring & alerts | Agentless sampling, history, thresholds, fleet grid, Slack/Telegram/webhook routing |
| M11 | Deployment Center | Release dirs, health-verified deploy, auto-rollback, canary/batch rollout, nginx validate |
| M12 | AI Operations (evidence model) | Probe catalog, Zod diagnosis schema with evidence IDs, plan→approve→execute→verify loop, injection tests, provider config incl. local model |
| M13 | Security Center, JIT access, drift | SSH CA certificates, access requests, hardening report export, drift diffs |
| M14 | Runbooks, incidents, MCP, Team mode (optional) | Executable runbooks, incident timeline + postmortem draft, MCP server via approval queue, Runner relay + RBAC |

**External VPS validation** (blocked until the owner provides authorized access): add a real Ubuntu VPS through the UI, verify fingerprint, interactive session, ANSI/Unicode/resize, multiple sessions, disconnect/reconnect, SFTP, independent process restarts, audit leak check. Record environment, steps and results; never invent a host or claim a pass without evidence.

---

## 12. Definition of done (per feature)

- Works against a real SSH endpoint (fixture or authorized server), not mocks only.
- Loading, empty, error, permission and stale states implemented.
- Policy-gated and audited if it changes anything remotely.
- No secrets in responses, logs, audit, AI prompts or Git.
- Tests at the right level (§10) and recorded evidence in `PROJECT_STATUS.md`.
- Keyboard accessible; works in dark and light mode.
- Reviewed by Claude; confirmed findings fixed; Git checkpoint created.

---

## 13. Portfolio deliverables

Produce these alongside the code so the project reads well as a portfolio piece:

- `README.md` with a 60-second demo GIF/video, feature list (only implemented features), architecture diagram, and quick start.
- `docs/ARCHITECTURE.md` (runtime modes, engine contract, process topology, data model).
- `docs/THREAT_MODEL.md` and `docs/SECURITY.md` (reporting, model, known limitations).
- `docs/ADR/` architecture decision records (e.g. "SQLite over JSON", "Node engine before Rust", "Runner relay instead of central credentials").
- CI badges, test-level breakdown, and a short write-up of measured results (e.g. session latency, concurrent sessions sustained, deploy rollback time) — measured, not estimated.
