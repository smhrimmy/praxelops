"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Terminal as TerminalIcon,
  Trash2,
  Plus,
  X,
  AlertTriangle,
  RotateCcw,
  Wifi,
  WifiOff,
  Loader2,
} from "lucide-react";
import type { FleetServer } from "@/lib/fleet/types";
import { stateInfo, type DisplayState } from "@/lib/fleet/health";
import { cycleIndex, indexAfterClose, nextOrdinal, tabLabel, tabSwitchDirection } from "@/lib/fleet/tabs";
import { StateDot } from "@/components/monitor/ui";
import { apiFetch } from "@/lib/client/api";
import "@xterm/xterm/css/xterm.css";

interface TerminalTab {
  id: string;
  serverId: string;
  serverName: string;
  host: string;
  username: string;
  port: number;
  /** 1-based number among the open tabs of the same server (shown only when there are several). */
  ordinal: number;
}

/** Asks the terminal to open a NEW tab for a server. A new `nonce` is a new request. */
export interface TerminalOpenRequest {
  serverId: string;
  nonce: number;
}

interface TerminalViewProps {
  servers: FleetServer[];
  selectedServer?: FleetServer;
  /** True while the Terminal workspace is on screen. The view stays mounted when hidden so sessions survive navigation. */
  active?: boolean;
  openRequest?: TerminalOpenRequest | null;
  onAddServerClick?: () => void;
}

interface XTermInstance {
  term: import("@xterm/xterm").Terminal;
  fitAddon: import("@xterm/addon-fit").FitAddon;
  ws: WebSocket | null;
}

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

let tabCounter = 0;

function makeTab(server: FleetServer, existing: readonly TerminalTab[]): TerminalTab {
  tabCounter += 1;
  return {
    id: `tab-${server.id}-${tabCounter}-${Date.now()}`,
    serverId: server.id,
    serverName: server.name,
    host: server.host,
    username: server.username,
    port: server.port,
    ordinal: nextOrdinal(existing.filter((t) => t.serverId === server.id).map((t) => t.ordinal)),
  };
}

function serverState(server: FleetServer | undefined): DisplayState {
  if (!server) return "never_checked";
  return server.health ? server.health.state : "never_checked";
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  servers,
  selectedServer,
  active = true,
  openRequest = null,
  onAddServerClick,
}) => {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    const requested = openRequest ? servers.find((s) => s.id === openRequest.serverId) : undefined;
    const initialServer = requested || selectedServer || (servers.length > 0 ? servers[0] : undefined);
    return initialServer ? [makeTab(initialServer, [])] : [];
  });

  const [activeTabId, setActiveTabId] = useState<string>(tabs[0]?.id || "");
  const [connectionStates, setConnectionStates] = useState<Record<string, ConnectionState>>({});
  const [errorMessages, setErrorMessages] = useState<Record<string, string>>({});
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);

  // Container refs for each tab
  const containerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Terminal and WS instances per tab
  const instancesRef = useRef<Record<string, XTermInstance>>({});
  // Tabs whose first session start has been triggered, and tabs that were closed (to abort in-flight starts)
  const startedRef = useRef<Set<string>>(new Set());
  const closedRef = useRef<Set<string>>(new Set());
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const newTabRootRef = useRef<HTMLDivElement>(null);
  const newTabButtonRef = useRef<HTMLButtonElement>(null);
  // Nonce of the last open request that was handled; a request present at mount is already represented by the initial tab.
  const handledNonceRef = useRef<number | null>(openRequest ? openRequest.nonce : null);
  // The default tab is opened at most once automatically (when servers arrive after mount).
  const autoOpenedRef = useRef<boolean>(tabs.length > 0);

  // Mirror of `tabs` so several requests in the same tick each see the previous one.
  const tabsRef = useRef<TerminalTab[]>(tabs);
  const commitTabs = useCallback((next: TerminalTab[]) => {
    tabsRef.current = next;
    setTabs(next);
  }, []);

  const serverById = useCallback((id: string) => servers.find((s) => s.id === id), [servers]);

  const openNewTab = useCallback(
    (server: FleetServer) => {
      const tab = makeTab(server, tabsRef.current);
      commitTabs([...tabsRef.current, tab]);
      setActiveTabId(tab.id);
      setNewTabMenuOpen(false);
    },
    [commitTabs]
  );

  // "Open terminal" from the Fleet, System Monitor, top bar or palette: always a fresh tab for that server.
  useEffect(() => {
    if (!openRequest || handledNonceRef.current === openRequest.nonce) return;
    const server = servers.find((s) => s.id === openRequest.serverId);
    if (!server) return;
    handledNonceRef.current = openRequest.nonce;
    autoOpenedRef.current = true;
    openNewTab(server);
  }, [openRequest, servers, openNewTab]);

  // Servers that arrive after mount (first load, demo sandbox, new host): open one default tab, once.
  useEffect(() => {
    if (autoOpenedRef.current || servers.length === 0 || tabs.length > 0) return;
    autoOpenedRef.current = true;
    openNewTab(selectedServer || servers[0]);
  }, [servers, selectedServer, tabs.length, openNewTab]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];

  // Initialize or re-connect a terminal tab session
  const initTerminalSession = useCallback(async (tab: TerminalTab) => {
    const container = containerRefs.current[tab.id];
    if (!container) return;

    // Clean up existing instance if any
    if (instancesRef.current[tab.id]) {
      try {
        instancesRef.current[tab.id].ws?.close();
        instancesRef.current[tab.id].term.dispose();
      } catch {}
      delete instancesRef.current[tab.id];
    }

    container.innerHTML = "";

    setConnectionStates((prev) => ({ ...prev, [tab.id]: "connecting" }));
    setErrorMessages((prev) => ({ ...prev, [tab.id]: "" }));

    try {
      // Dynamic imports for SSR compatibility
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      const { WebLinksAddon } = await import("@xterm/addon-web-links");
      // The tab may have been closed while the xterm modules were loading.
      if (closedRef.current.has(tab.id) || !containerRefs.current[tab.id]) return;

      const term = new Terminal({
        theme: {
          background: "#0a0a0a",
          foreground: "#e5e5e5",
          cursor: "#22c55e",
          cursorAccent: "#0a0a0a",
          selectionBackground: "rgba(34, 197, 94, 0.35)",
          black: "#171717",
          red: "#ef4444",
          green: "#22c55e",
          yellow: "#eab308",
          blue: "#3b82f6",
          magenta: "#ec4899",
          cyan: "#06b6d4",
          white: "#f5f5f5",
          brightBlack: "#737373",
          brightRed: "#f87171",
          brightGreen: "#4ade80",
          brightYellow: "#facc15",
          brightBlue: "#60a5fa",
          brightMagenta: "#f472b6",
          brightCyan: "#22d3ee",
          brightWhite: "#ffffff",
        },
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.25,
        cursorBlink: true,
        convertEol: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon();

      term.loadAddon(fitAddon);
      term.loadAddon(webLinksAddon);
      term.open(container);

      // Initial layout fit
      setTimeout(() => {
        try {
          fitAddon.fit();
        } catch {}
      }, 50);

      // 1. Request secure single-use ticket from authenticated HTTPS endpoint
      term.write("\x1b[90mAcquiring secure single-use terminal ticket...\x1b[0m\r\n");
      let ticket = "";
      try {
        const ticketRes = await apiFetch("/api/ssh/ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serverId: tab.serverId }),
        });
        const ticketData = await ticketRes.json();
        if (!ticketRes.ok || !ticketData.success || !ticketData.ticket) {
          throw new Error(ticketData.error || "Failed to obtain authorized terminal ticket");
        }
        ticket = ticketData.ticket;
      } catch (tktErr) {
        term.write(`\r\n\x1b[31m[Authentication Error] ${(tktErr as Error).message}\x1b[0m\r\n`);
        setConnectionStates((prev) => ({ ...prev, [tab.id]: "error" }));
        setErrorMessages((prev) => ({ ...prev, [tab.id]: (tktErr as Error).message }));
        return;
      }

      if (closedRef.current.has(tab.id)) {
        term.dispose();
        return;
      }

      // 2. Connect to Authenticated WebSocket Terminal Gateway using single-use ticket
      const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = typeof window !== "undefined" ? window.location.hostname || "127.0.0.1" : "127.0.0.1";
      const gatewayPort = process.env.NEXT_PUBLIC_WS_TERMINAL_PORT || "3001";
      const wsUrl = `${protocol}//${host}:${gatewayPort}/terminal?ticket=${encodeURIComponent(
        ticket
      )}&cols=${term.cols}&rows=${term.rows}`;

      term.write("\x1b[90mConnecting to PraxelOps Terminal Gateway (" + protocol + "//" + host + ":" + gatewayPort + ")...\x1b[0m\r\n");

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        term.write(`\r\n\x1b[31mFailed to create WebSocket: ${(err as Error).message}\x1b[0m\r\n`);
        setConnectionStates((prev) => ({ ...prev, [tab.id]: "error" }));
        return;
      }

      instancesRef.current[tab.id] = { term, fitAddon, ws };

      ws.onopen = () => {
        setConnectionStates((prev) => ({ ...prev, [tab.id]: "connected" }));
        term.write(`\x1b[32m✔ Authenticated PTY session established\x1b[0m\r\n`);
        term.write(`\x1b[90mConnected to ${tab.serverName} (${tab.username}@${tab.host}:${tab.port})\x1b[0m\r\n\r\n`);

        // Send actual fit dimensions
        fitAddon.fit();
        ws.send(
          JSON.stringify({
            type: "resize",
            cols: term.cols,
            rows: term.rows,
          })
        );
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "output" && typeof msg.data === "string") {
            term.write(msg.data);
          } else if (msg.type === "error") {
            term.write(`\r\n\x1b[31m[Gateway Error] ${msg.error}\x1b[0m\r\n`);
            setErrorMessages((prev) => ({ ...prev, [tab.id]: msg.error }));
          } else if (msg.type === "exit") {
            term.write(`\r\n\x1b[33m[Process exited with code ${msg.code}]\x1b[0m\r\n`);
            setConnectionStates((prev) => ({ ...prev, [tab.id]: "disconnected" }));
          } else if (msg.type === "connected") {
            setConnectionStates((prev) => ({ ...prev, [tab.id]: "connected" }));
          }
        } catch {
          term.write(event.data);
        }
      };

      ws.onerror = () => {
        setConnectionStates((prev) => ({ ...prev, [tab.id]: "error" }));
        setErrorMessages((prev) => ({
          ...prev,
          [tab.id]: "Gateway unreachable. Ensure 'npm run terminal:gateway' is active.",
        }));
      };

      ws.onclose = (event) => {
        setConnectionStates((prev) => ({ ...prev, [tab.id]: "disconnected" }));
        if (event.code !== 1000) {
          term.write(
            `\r\n\x1b[90mSession closed (${event.code}: ${event.reason || "Connection closed"})\x1b[0m\r\n`
          );
        }
      };

      // Pipe terminal keystrokes directly to WebSocket
      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });
    } catch (err) {
      setConnectionStates((prev) => ({ ...prev, [tab.id]: "error" }));
      setErrorMessages((prev) => ({ ...prev, [tab.id]: (err as Error).message }));
    }
  }, []);

  // Initialize the terminal when its tab becomes active; re-fit (and tell the PTY) when switching back to a tab or
  // when the workspace becomes visible again. A hidden container has no size, so nothing runs while inactive.
  useEffect(() => {
    if (!active || !activeTab) return;
    if (!startedRef.current.has(activeTab.id)) {
      startedRef.current.add(activeTab.id);
      void initTerminalSession(activeTab);
    }
    const tabId = activeTab.id;
    const timer = setTimeout(() => {
      const instance = instancesRef.current[tabId];
      if (!instance) return;
      try {
        instance.fitAddon.fit();
        if (instance.ws && instance.ws.readyState === WebSocket.OPEN) {
          instance.ws.send(JSON.stringify({ type: "resize", cols: instance.term.cols, rows: instance.term.rows }));
        }
        instance.term.focus();
      } catch {}
    }, 50);
    return () => clearTimeout(timer);
  }, [active, activeTab, initTerminalSession]);

  // Window resize observer to fit active terminal
  useEffect(() => {
    const handleWindowResize = () => {
      if (active && activeTab && instancesRef.current[activeTab.id]) {
        const { fitAddon, term, ws } = instancesRef.current[activeTab.id];
        try {
          fitAddon.fit();
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              })
            );
          }
        } catch {}
      }
    };

    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [active, activeTab]);

  // Dispose every session when the whole view goes away (e.g. sign-out).
  useEffect(() => {
    const instances = instancesRef;
    return () => {
      for (const instance of Object.values(instances.current)) {
        try {
          instance.ws?.close();
          instance.term.dispose();
        } catch {}
      }
      instances.current = {};
    };
  }, []);

  const selectTab = useCallback((tabId: string, focusButton = false) => {
    setActiveTabId(tabId);
    if (focusButton) tabButtonRefs.current[tabId]?.focus();
  }, []);

  // Ctrl/Cmd+Shift+[ and ] switch tabs. Captured before xterm sees them; every other key still reaches the shell.
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const dir = tabSwitchDirection(e);
      if (dir === 0) return;
      const current = tabsRef.current;
      if (current.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const index = current.findIndex((t) => t.id === activeTabId);
      const next = current[cycleIndex(index, current.length, dir)];
      if (next) selectTab(next.id);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active, activeTabId, selectTab]);

  // Close the "new tab" menu on outside press or Escape.
  useEffect(() => {
    if (!newTabMenuOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (newTabRootRef.current && !newTabRootRef.current.contains(e.target as Node)) setNewTabMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setNewTabMenuOpen(false);
        newTabButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [newTabMenuOpen]);

  // Quick preset commands that write directly to active terminal
  const quickCommands = [
    { label: "Sys Info", cmd: "uname -a" },
    { label: "Uptime", cmd: "uptime" },
    { label: "Disk Space", cmd: "df -h" },
    { label: "Memory", cmd: "free -m" },
    { label: "Processes", cmd: "ps aux --sort=-%cpu | head -n 8" },
    { label: "Top Listeners", cmd: "ss -tulpn | head -n 8" },
  ];

  const handleSendPreset = (cmd: string) => {
    if (!activeTab) return;
    const instance = instancesRef.current[activeTab.id];
    if (instance && instance.ws && instance.ws.readyState === WebSocket.OPEN) {
      instance.ws.send(JSON.stringify({ type: "input", data: cmd + "\r" }));
      instance.term.focus();
    }
  };

  const handleClearScreen = () => {
    if (!activeTab) return;
    const instance = instancesRef.current[activeTab.id];
    if (instance) {
      instance.term.clear();
      instance.term.focus();
    }
  };

  const handleReconnect = () => {
    if (!activeTab) return;
    initTerminalSession(activeTab);
  };

  const closeTab = (tabId: string) => {
    closedRef.current.add(tabId);
    startedRef.current.delete(tabId);
    // Dispose terminal and socket
    if (instancesRef.current[tabId]) {
      try {
        instancesRef.current[tabId].ws?.send(JSON.stringify({ type: "close" }));
        instancesRef.current[tabId].ws?.close();
        instancesRef.current[tabId].term.dispose();
      } catch {}
      delete instancesRef.current[tabId];
    }

    const current = tabsRef.current;
    const closedIndex = current.findIndex((t) => t.id === tabId);
    const nextTabs = current.filter((t) => t.id !== tabId);
    commitTabs(nextTabs);
    if (activeTabId === tabId) {
      const nextIndex = indexAfterClose(closedIndex, nextTabs.length);
      setActiveTabId(nextIndex >= 0 ? nextTabs[nextIndex].id : "");
    }
  };

  const onTablistKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const current = tabsRef.current;
    if (current.length === 0) return;
    e.preventDefault();
    const index = current.findIndex((t) => t.id === activeTabId);
    let nextIndex: number;
    if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = current.length - 1;
    else nextIndex = cycleIndex(index, current.length, e.key === "ArrowLeft" ? -1 : 1);
    selectTab(current[nextIndex].id, true);
  };

  if (tabs.length === 0) {
    return (
      <div data-theme="dark" className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4 bg-neutral-950 text-neutral-100">
        <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-400">
          <TerminalIcon className="w-6 h-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-semibold">{servers.length === 0 ? "No Active SSH Terminals" : "No open terminals"}</h2>
          <p className="text-xs text-fg-muted leading-relaxed">
            {servers.length === 0
              ? "Register a server host in the Fleet inventory to launch genuine interactive SSH shell sessions."
              : "Open a terminal on one of your servers. You can keep several tabs per server."}
          </p>
        </div>
        {servers.length > 0 && (
          <ul className="w-full max-w-sm space-y-1.5" aria-label="Open a terminal on">
            {servers.map((s) => {
              const info = stateInfo(serverState(s));
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => openNewTab(s)}
                    className="flex w-full items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-left text-xs hover:bg-white/10"
                  >
                    <StateDot state={serverState(s)} size="sm" />
                    <span className="flex-1 truncate font-medium">{s.name}</span>
                    <span className="text-[11px] text-fg-muted">{info.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {onAddServerClick && (
          <button
            onClick={onAddServerClick}
            className="flex items-center space-x-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium shadow-sm transition"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Server Host</span>
          </button>
        )}
      </div>
    );
  }

  const activeStatus = activeTab ? connectionStates[activeTab.id] || "connecting" : "connecting";

  return (
    <div data-theme="dark" className="flex-1 min-w-0 flex flex-col h-full overflow-hidden bg-neutral-950 text-neutral-100 select-text">
      {/* Tab Bar */}
      <div className="h-10 bg-neutral-900 border-b border-white/10 flex items-center justify-between px-3 shrink-0 select-none">
        <div
          role="tablist"
          aria-label="Terminal sessions"
          onKeyDown={onTablistKeyDown}
          className="flex items-center space-x-1 overflow-x-auto min-w-0 flex-1 mr-2"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab?.id;
            const tabStatus = connectionStates[tab.id] || "connecting";
            const server = serverById(tab.serverId);
            const state = serverState(server);
            const info = stateInfo(state);
            const sameServer = tabs.filter((t) => t.serverId === tab.serverId).length;
            const label = tabLabel(server ? server.name : tab.serverName, tab.ordinal, sameServer);

            return (
              <div
                key={tab.id}
                role="presentation"
                className={`flex items-center shrink-0 rounded-t-lg text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-neutral-950 text-white border-t-2 border-accent shadow-sm"
                    : "text-fg-muted hover:text-white hover:bg-neutral-800"
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  id={`term-tab-${tab.id}`}
                  aria-selected={isActive}
                  aria-controls={`term-panel-${tab.id}`}
                  tabIndex={isActive ? 0 : -1}
                  ref={(el) => {
                    tabButtonRefs.current[tab.id] = el;
                  }}
                  onClick={() => selectTab(tab.id)}
                  title={`${label}: ${tab.username}@${tab.host}:${tab.port}. Host ${info.label.toLowerCase()}; session ${tabStatus}`}
                  className="flex items-center space-x-2 pl-3 pr-1.5 py-1.5"
                >
                  <StateDot state={state} size="sm" />
                  <span className="truncate max-w-[140px]">{label}</span>
                  {tabStatus === "connecting" && <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin text-warning" />}
                  {tabStatus === "error" && <AlertTriangle aria-hidden="true" className="w-3 h-3 text-danger" />}
                  {tabStatus === "disconnected" && <WifiOff aria-hidden="true" className="w-3 h-3 text-fg-muted" />}
                  <span className="sr-only">
                    , host {info.label.toLowerCase()}, session {tabStatus}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  aria-label={`Close ${label} terminal`}
                  className="p-0.5 mr-1.5 rounded hover:bg-white/20 text-fg-muted hover:text-white"
                >
                  <X className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Tab Actions */}
        <div className="flex items-center space-x-2 shrink-0">
          {/* Status Badge */}
          <div className="hidden sm:flex items-center space-x-1.5 px-2 py-0.5 rounded bg-white/5 text-[11px] font-mono border border-white/5">
            {activeStatus === "connected" ? (
              <>
                <Wifi className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-400">Live PTY</span>
              </>
            ) : activeStatus === "connecting" ? (
              <>
                <RotateCcw className="w-3 h-3 text-amber-400 animate-spin" />
                <span className="text-amber-400">Connecting...</span>
              </>
            ) : activeStatus === "error" ? (
              <>
                <AlertTriangle className="w-3 h-3 text-danger" />
                <span className="text-danger">Error</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3 h-3 text-fg-muted" />
                <span className="text-fg-muted">Disconnected</span>
              </>
            )}
          </div>

          <button
            onClick={handleReconnect}
            title="Reconnect Terminal"
            aria-label="Reconnect terminal"
            className="p-1.5 rounded hover:bg-neutral-800 text-fg-muted hover:text-white transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleClearScreen}
            title="Clear Screen"
            aria-label="Clear screen"
            className="p-1.5 rounded hover:bg-neutral-800 text-fg-muted hover:text-white transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* New tab menu: one entry per server */}
          <div ref={newTabRootRef} className="relative">
            <button
              ref={newTabButtonRef}
              type="button"
              onClick={() => setNewTabMenuOpen((o) => !o)}
              title="Open a new terminal tab (choose a server)"
              aria-label="Open a new terminal tab"
              aria-haspopup="menu"
              aria-expanded={newTabMenuOpen}
              aria-controls="term-newtab-menu"
              className="p-1.5 rounded hover:bg-neutral-800 text-fg-muted hover:text-white transition flex items-center space-x-1 text-xs"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span className="text-[11px] hidden md:inline">New tab</span>
            </button>
            {newTabMenuOpen && (
              <div
                id="term-newtab-menu"
                role="menu"
                aria-label="Open a terminal on"
                className="absolute right-0 top-full mt-1 z-30 w-64 max-h-72 overflow-y-auto bg-neutral-900 border border-white/10 rounded-lg shadow-2xl py-1"
              >
                <div role="presentation" className="px-3 py-1 text-[10px] uppercase font-mono text-fg-muted">
                  Open a terminal on
                </div>
                {servers.length === 0 && (
                  <div role="presentation" className="px-3 py-2 text-xs text-fg-muted">
                    No servers registered.
                  </div>
                )}
                {servers.map((s) => {
                  const info = stateInfo(serverState(s));
                  const open = tabs.filter((t) => t.serverId === s.id).length;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="menuitem"
                      onClick={() => openNewTab(s)}
                      className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-xs text-neutral-300 hover:text-white flex items-center space-x-2"
                    >
                      <StateDot state={serverState(s)} size="sm" />
                      <span className="truncate flex-1">{s.name}</span>
                      <span className="shrink-0 text-[10px] text-fg-muted">
                        {info.label}
                        {open > 0 ? ` · ${open} open` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick Presets Bar */}
      <div className="px-3 py-1.5 bg-neutral-900/60 border-b border-white/5 flex items-center space-x-2 overflow-x-auto shrink-0 select-none">
        <span className="text-[10px] font-mono uppercase text-fg-muted shrink-0">
          Presets:
        </span>
        {quickCommands.map((q) => (
          <button
            key={q.cmd}
            onClick={() => handleSendPreset(q.cmd)}
            disabled={activeStatus !== "connected"}
            className="px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-[11px] font-mono text-neutral-300 hover:text-white transition shrink-0 disabled:opacity-40"
          >
            {q.label}
          </button>
        ))}
        <span className="ml-auto hidden shrink-0 pl-3 text-[10px] text-fg-muted lg:inline">
          Ctrl/⌘+Shift+[ / ] switch tab
        </span>
      </div>

      {/* Gateway Offline Banner */}
      {activeStatus === "error" && (
        <div className="px-3 py-2 bg-rose-500/10 border-b border-rose-500/20 text-rose-300 text-xs flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 text-danger shrink-0" />
            <span>
              {errorMessages[activeTab.id] || "Terminal Gateway connection failed."}{" "}
              <span className="text-fg-muted">
                Run <code className="bg-white/10 px-1 py-0.5 rounded">npm run terminal:gateway</code> to start WebSocket gateway on port 3001.
              </span>
            </span>
          </div>
          <button
            onClick={handleReconnect}
            className="px-2 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-xs font-medium transition"
          >
            Retry
          </button>
        </div>
      )}

      {/* Terminal Viewport */}
      <div className="flex-1 relative overflow-hidden bg-neutral-950 p-2">
        {tabs.map((tab) => {
          const isCurrent = tab.id === activeTab?.id;

          return (
            <div
              key={tab.id}
              id={`term-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`term-tab-${tab.id}`}
              ref={(el) => {
                containerRefs.current[tab.id] = el;
              }}
              style={{ display: isCurrent ? "block" : "none" }}
              className="w-full h-full"
            />
          );
        })}
      </div>
    </div>
  );
};
