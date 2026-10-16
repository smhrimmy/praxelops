# PEOS — Praxel Enterprise Operating System & PraxelOps

## 1. System Identity & Mission
PraxelOps is an AI-powered infrastructure operations platform delivering a refined, macOS-inspired desktop and web interface for modern server fleets.
It combines:
- Interactive SSH & resilient terminal management (xterm.js + robust backend session multiplexer).
- Remote SFTP file browser with safe upload/download buffers.
- Real-time telemetry, server inventory, and health tracking.
- AI-assisted server diagnostics, telemetry analysis, and automated operational recommendations.
- Non-negotiable explicit approval gates prior to executing any AI-proposed or mutating command.
- Production deployment workflows, structured streaming logs, and automated rollback pathways.
- Complete security verification, audit logging, and credential isolation.

---

## 2. Architectural Invariants (Non-Negotiable)

1. **Security Isolation & Secret Hygiene**:
   - Private keys, SSH passwords, and API credentials MUST NEVER be emitted in client-side code, browser storage (LocalStorage/SessionStorage), logs, or AI prompt contexts.
   - All SSH, SFTP, and remote commands are executed exclusively behind an authenticated backend boundary.

2. **Explicit Human Approval Gate**:
   - The AI Copilot is strictly advisory.
   - Every AI-proposed action must detail:
     - Target host / cluster
     - Proposed command / playbook
     - Risk level (Low / Medium / High / Critical)
     - Rationale and impact assessment
   - Execution requires explicit user confirmation via an authorized UI interaction. The backend independently re-validates permissions and tokens before dispatch.

3. **Honest Observability & Fallbacks**:
   - Stale or cached telemetry must be explicitly labeled as such (`Cached`, `Offline`, `Stale`).
   - Mock data is prohibited in production paths; real system metrics (CPU, RAM, Disk, Load, Network) must be polled or streamed from authorized hosts or the host node.

4. **Interface Quality & macOS Design Language**:
   - Traffic lights (`close`, `minimize`, `maximize` / full-screen).
   - Translucent glassmorphism surfaces (`backdrop-blur`), subtle borders, consistent typography, and fluid spring animations.
   - Global Command Palette (`Cmd/Ctrl+K`).
   - Split panes / terminal drawers with zero unnecessary full-page scrolling.
   - Flawless dark and light theme switching.

5. **TypeScript Strictness**:
   - Zero usage of `any`.
   - Comprehensive domain contracts and runtime schema validation with Zod.

---

## 3. Directory Layout
```
/
├── .peos/                   # PEOS governance, graph storage, and local audit database
├── src/
│   ├── app/                 # Next.js App Router (Studio Shell, API routes)
│   │   ├── api/             # Authenticated REST & streaming endpoints
│   │   │   ├── ssh/         # SSH connection, session management, terminal bridge
│   │   │   ├── sftp/        # SFTP remote file browser & file transfer
│   │   │   ├── servers/     # Server inventory & status
│   │   │   ├── metrics/     # Telemetry collection & health metrics
│   │   │   ├── ai/          # AI diagnostics, copilot analysis & command generator
│   │   │   └── deployments/ # Deployments, runner jobs & audit trail
│   │   ├── layout.tsx       # Root layout with ThemeProvider, Global Command Palette
│   │   └── page.tsx         # Main macOS Studio Desktop Shell
│   ├── components/          # Reusable UI & macOS design components
│   │   ├── macos/           # WindowChrome, TitleBar, Dock, MenuBar, TrafficLights
│   │   ├── terminal/        # XTerm terminal view, multi-tab session manager
│   │   ├── sftp/            # File tree, file preview, transfer queue
│   │   ├── servers/         # Server list, card grid, resource charts, server drawer
│   │   ├── ai/              # Copilot chat, diagnostic reports, approval modal
│   │   ├── deployments/     # Pipeline viewer, log streamer, rollback triggers
│   │   └── ui/              # Button, Modal, Card, Badge, Input, Tabs, Tooltip
│   ├── lib/                 # Core utilities, state management & adapters
│   │   ├── ssh/             # ssh2 adapter, connection pooling, pty multiplexing
│   │   ├── sftp/            # SFTP client wrapper & file streaming
│   │   ├── telemetry/       # Metric parsers (top, vmstat, df, ip, ps)
│   │   ├── ai/              # LLM provider adapter & structured prompt generators
│   │   ├── security/        # Credential encryption, token verification, audit logger
│   │   └── storage/         # Persisted JSON graph & server repository
│   └── types/               # Authoritative TypeScript domain interfaces & Zod schemas
└── public/                  # Static assets & icons
```
