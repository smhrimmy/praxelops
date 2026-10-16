"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Terminal as TerminalIcon,
  Trash2,
  Plus,
  X,
  Server,
  Copy,
  Check,
  AlertTriangle,
  RotateCcw,
  Wifi,
  WifiOff,
  Maximize2,
} from "lucide-react";
import { ServerHost } from "@/types/server";
import "@xterm/xterm/css/xterm.css";

interface TerminalTab {
  id: string;
  serverId: string;
  serverName: string;
  host: string;
  username: string;
  port: number;
}

interface TerminalViewProps {
  servers: ServerHost[];
  selectedServer?: ServerHost;
  onAddServerClick?: () => void;
}

interface XTermInstance {
  term: import("@xterm/xterm").Terminal;
  fitAddon: import("@xterm/addon-fit").FitAddon;
  ws: WebSocket | null;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  servers,
  selectedServer,
  onAddServerClick,
}) => {
  const initialServer = selectedServer || (servers.length > 0 ? servers[0] : undefined);

  const [tabs, setTabs] = useState<TerminalTab[]>(
    initialServer
      ? [
          {
            id: `tab-${initialServer.id}-1`,
            serverId: initialServer.id,
            serverName: initialServer.name,
            host: initialServer.host,
            username: initialServer.username,
            port: initialServer.port,
          },
        ]
      : []
  );

  const [activeTabId, setActiveTabId] = useState<string>(tabs[0]?.id || "");
  const [copied, setCopied] = useState<boolean>(false);
  const [connectionStates, setConnectionStates] = useState<
    Record<string, "connecting" | "connected" | "disconnected" | "error">
  >({});
  const [errorMessages, setErrorMessages] = useState<Record<string, string>>({});

  // Container refs for each tab
  const containerRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Terminal and WS instances per tab
  const instancesRef = useRef<Record<string, XTermInstance>>({});

  // Sync tabs when selectedServer changes from parent
  useEffect(() => {
    if (selectedServer) {
      const existing = tabs.find((t) => t.serverId === selectedServer.id);
      if (existing) {
        setActiveTabId(existing.id);
      } else {
        const newTabId = `tab-${selectedServer.id}-${Date.now()}`;
        setTabs((prev) => [
          ...prev,
          {
            id: newTabId,
            serverId: selectedServer.id,
            serverName: selectedServer.name,
            host: selectedServer.host,
            username: selectedServer.username,
            port: selectedServer.port,
          },
        ]);
        setActiveTabId(newTabId);
      }
    }
  }, [selectedServer]);

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

      // Connect to Authenticated WebSocket Terminal Gateway
      const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = typeof window !== "undefined" ? window.location.hostname || "localhost" : "localhost";
      const gatewayPort = process.env.NEXT_PUBLIC_WS_TERMINAL_PORT || "3001";
      const wsUrl = `${protocol}//${host}:${gatewayPort}/terminal?serverId=${encodeURIComponent(
        tab.serverId
      )}&token=local-operator-token&cols=${term.cols}&rows=${term.rows}`;

      term.write("\x1b[90mConnecting to PraxelOps Terminal Gateway (" + wsUrl + ")...\x1b[0m\r\n");

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

  // Initialize terminal when tab changes or mounts
  useEffect(() => {
    if (activeTab) {
      if (!instancesRef.current[activeTab.id]) {
        initTerminalSession(activeTab);
      } else {
        // Re-fit when switching back to tab
        setTimeout(() => {
          try {
            instancesRef.current[activeTab.id]?.fitAddon.fit();
          } catch {}
        }, 50);
      }
    }
  }, [activeTab, initTerminalSession]);

  // Window resize observer to fit active terminal
  useEffect(() => {
    const handleWindowResize = () => {
      if (activeTab && instancesRef.current[activeTab.id]) {
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
  }, [activeTab]);

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

  const openNewTab = (server: ServerHost) => {
    const newTabId = `tab-${server.id}-${Date.now()}`;
    const newTab: TerminalTab = {
      id: newTabId,
      serverId: server.id,
      serverName: server.name,
      host: server.host,
      username: server.username,
      port: server.port,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTabId);
  };

  const closeTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Dispose terminal and socket
    if (instancesRef.current[tabId]) {
      try {
        instancesRef.current[tabId].ws?.send(JSON.stringify({ type: "close" }));
        instancesRef.current[tabId].ws?.close();
        instancesRef.current[tabId].term.dispose();
      } catch {}
      delete instancesRef.current[tabId];
    }

    const nextTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(nextTabs);
    if (activeTabId === tabId && nextTabs.length > 0) {
      setActiveTabId(nextTabs[0].id);
    }
  };

  if (servers.length === 0 || tabs.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4 bg-neutral-950 text-neutral-100">
        <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 flex items-center justify-center text-emerald-400">
          <TerminalIcon className="w-6 h-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-semibold">No Active SSH Terminals</h2>
          <p className="text-xs text-neutral-400 leading-relaxed">
            Register a server host in the Fleet inventory to launch genuine interactive SSH shell sessions.
          </p>
        </div>
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
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-neutral-950 text-neutral-100 select-text">
      {/* Tab Bar */}
      <div className="h-10 bg-neutral-900 border-b border-white/10 flex items-center justify-between px-3 shrink-0 select-none">
        <div className="flex items-center space-x-1 overflow-x-auto max-w-[70%]">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const tabStatus = connectionStates[tab.id] || "connecting";

            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded-t-lg text-xs font-medium cursor-pointer transition ${
                  isActive
                    ? "bg-neutral-950 text-white border-t-2 border-emerald-500 shadow-sm"
                    : "text-neutral-400 hover:text-white hover:bg-neutral-800"
                }`}
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    tabStatus === "connected"
                      ? "bg-emerald-500"
                      : tabStatus === "connecting"
                      ? "bg-amber-400 animate-pulse"
                      : tabStatus === "error"
                      ? "bg-rose-500"
                      : "bg-neutral-600"
                  }`}
                />
                <span className="truncate max-w-[140px]">{tab.serverName}</span>
                {tabs.length > 1 && (
                  <button
                    onClick={(e) => closeTab(tab.id, e)}
                    className="p-0.5 rounded hover:bg-white/20 text-neutral-400 hover:text-white"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Tab Actions */}
        <div className="flex items-center space-x-2">
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
                <AlertTriangle className="w-3 h-3 text-rose-400" />
                <span className="text-rose-400">Error</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3 h-3 text-neutral-400" />
                <span className="text-neutral-400">Disconnected</span>
              </>
            )}
          </div>

          <button
            onClick={handleReconnect}
            title="Reconnect Terminal"
            className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white transition"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={handleClearScreen}
            title="Clear Screen"
            className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* New Tab Dropdown */}
          <div className="relative group">
            <button
              title="Open Session to Another Server"
              className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white transition flex items-center space-x-1 text-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="text-[11px] hidden md:inline">New PTY</span>
            </button>
            <div className="absolute right-0 top-full mt-1 hidden group-hover:block w-48 bg-neutral-900 border border-white/10 rounded-lg shadow-2xl py-1 z-30">
              <div className="px-3 py-1 text-[10px] uppercase font-mono text-neutral-500">
                Target Node
              </div>
              {servers.map((s) => (
                <button
                  key={s.id}
                  onClick={() => openNewTab(s)}
                  className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-xs text-neutral-300 hover:text-white truncate flex items-center space-x-2"
                >
                  <Server className="w-3 h-3 text-neutral-400 shrink-0" />
                  <span className="truncate">{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Quick Presets Bar */}
      <div className="px-3 py-1.5 bg-neutral-900/60 border-b border-white/5 flex items-center space-x-2 overflow-x-auto shrink-0 select-none">
        <span className="text-[10px] font-mono uppercase text-neutral-500 shrink-0">
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
      </div>

      {/* Gateway Offline Banner */}
      {activeStatus === "error" && (
        <div className="px-3 py-2 bg-rose-500/10 border-b border-rose-500/20 text-rose-300 text-xs flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>
              {errorMessages[activeTab.id] || "Terminal Gateway connection failed."}{" "}
              <span className="text-neutral-400">
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
          const isCurrent = tab.id === activeTabId;

          return (
            <div
              key={tab.id}
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
