"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Terminal as TerminalIcon,
  Play,
  RotateCcw,
  Trash2,
  Plus,
  X,
  Server,
  CornerDownLeft,
  ChevronRight,
  Maximize2,
  Copy,
  Check,
} from "lucide-react";
import { ServerHost } from "@/types/server";

interface TerminalTab {
  id: string;
  serverId: string;
  serverName: string;
  host: string;
  username: string;
  history: Array<{ type: "input" | "output" | "error" | "system"; text: string }>;
  commandHistory: string[];
  historyIndex: number;
}

interface TerminalViewProps {
  servers: ServerHost[];
  selectedServer?: ServerHost;
}

export const TerminalView: React.FC<TerminalViewProps> = ({
  servers,
  selectedServer,
}) => {
  const initialServer = selectedServer || servers[0];

  const [tabs, setTabs] = useState<TerminalTab[]>([
    {
      id: "tab-1",
      serverId: initialServer?.id || "srv-local-01",
      serverName: initialServer?.name || "Localhost Hypervisor",
      host: initialServer?.host || "127.0.0.1",
      username: initialServer?.username || "operator",
      history: [
        {
          type: "system",
          text: `SSH-2.0-OpenSSH_9.6p1 PraxelOps Terminal Multiplexer\nAuthenticated to ${initialServer?.name || "Localhost"} (${initialServer?.host || "127.0.0.1"})\nType 'help' or click quick commands below.`,
        },
      ],
      commandHistory: [],
      historyIndex: -1,
    },
  ]);

  const [activeTabId, setActiveTabId] = useState<string>("tab-1");
  const [currentInput, setCurrentInput] = useState<string>("");
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll on output
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeTab?.history]);

  // Focus input on tab switch
  useEffect(() => {
    inputRef.current?.focus();
  }, [activeTabId]);

  // Quick preset commands
  const quickCommands = [
    { label: "Sys Info", cmd: "uname -a" },
    { label: "Uptime", cmd: "uptime" },
    { label: "Disk Space", cmd: "df -h" },
    { label: "Memory", cmd: "free -m" },
    { label: "Containers", cmd: "docker ps" },
    { label: "Service Health", cmd: "systemctl status sshd" },
  ];

  const handleExecute = async (commandToRun?: string) => {
    const cmd = (commandToRun ?? currentInput).trim();
    if (!cmd || isExecuting || !activeTab) return;

    setCurrentInput("");
    setIsExecuting(true);

    // Append user input to history
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id === activeTab.id) {
          return {
            ...tab,
            history: [...tab.history, { type: "input", text: cmd }],
            commandHistory: [...tab.commandHistory, cmd],
            historyIndex: -1,
          };
        }
        return tab;
      })
    );

    try {
      if (cmd.toLowerCase() === "clear") {
        setTabs((prevTabs) =>
          prevTabs.map((tab) =>
            tab.id === activeTab.id ? { ...tab, history: [] } : tab
          )
        );
        setIsExecuting(false);
        return;
      }

      if (cmd.toLowerCase() === "help") {
        setTabs((prevTabs) =>
          prevTabs.map((tab) =>
            tab.id === activeTab.id
              ? {
                  ...tab,
                  history: [
                    ...tab.history,
                    {
                      type: "system",
                      text: "PraxelOps Interactive SSH Shell:\n- Run any standard Linux command (e.g. uname, df, free, docker ps, htop)\n- Use 'clear' to wipe terminal output\n- Use quick action chips for instant health inspection",
                    },
                  ],
                }
              : tab
          )
        );
        setIsExecuting(false);
        return;
      }

      const res = await fetch("/api/ssh/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: activeTab.serverId,
          command: cmd,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Execution failed");
      }

      const output = data.data.stdout || data.data.stderr || "(No output returned)";
      const isErr = data.data.code !== 0;

      setTabs((prevTabs) =>
        prevTabs.map((tab) => {
          if (tab.id === activeTab.id) {
            return {
              ...tab,
              history: [
                ...tab.history,
                {
                  type: isErr ? "error" : "output",
                  text: output,
                },
              ],
            };
          }
          return tab;
        })
      );
    } catch (err) {
      setTabs((prevTabs) =>
        prevTabs.map((tab) => {
          if (tab.id === activeTab.id) {
            return {
              ...tab,
              history: [
                ...tab.history,
                { type: "error", text: `Error: ${(err as Error).message}` },
              ],
            };
          }
          return tab;
        })
      );
    } finally {
      setIsExecuting(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleExecute();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!activeTab || activeTab.commandHistory.length === 0) return;
      const newIndex =
        activeTab.historyIndex === -1
          ? activeTab.commandHistory.length - 1
          : Math.max(0, activeTab.historyIndex - 1);
      setCurrentInput(activeTab.commandHistory[newIndex] || "");
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab.id ? { ...t, historyIndex: newIndex } : t
        )
      );
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!activeTab || activeTab.historyIndex === -1) return;
      const newIndex = activeTab.historyIndex + 1;
      if (newIndex >= activeTab.commandHistory.length) {
        setCurrentInput("");
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTab.id ? { ...t, historyIndex: -1 } : t
          )
        );
      } else {
        setCurrentInput(activeTab.commandHistory[newIndex] || "");
        setTabs((prev) =>
          prev.map((t) =>
            t.id === activeTab.id ? { ...t, historyIndex: newIndex } : t
          )
        );
      }
    }
  };

  const openNewTab = (server: ServerHost) => {
    const newTabId = `tab-${Date.now()}`;
    const newTab: TerminalTab = {
      id: newTabId,
      serverId: server.id,
      serverName: server.name,
      host: server.host,
      username: server.username,
      history: [
        {
          type: "system",
          text: `SSH-2.0-OpenSSH_9.6p1 PraxelOps Terminal Multiplexer\nConnected to ${server.name} (${server.host})\nReady for interactive input.`,
        },
      ],
      commandHistory: [],
      historyIndex: -1,
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(newTabId);
  };

  const closeTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (tabs.length === 1) return; // Keep at least one tab
    const nextTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(nextTabs);
    if (activeTabId === tabId) {
      setActiveTabId(nextTabs[0].id);
    }
  };

  const copyTerminalOutput = () => {
    if (!activeTab) return;
    const text = activeTab.history
      .map((h) => (h.type === "input" ? `$ ${h.text}` : h.text))
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const clearActiveTab = () => {
    if (!activeTab) return;
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTab.id ? { ...t, history: [] } : t))
    );
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-neutral-950 text-neutral-100 select-text">
      {/* Tab Bar */}
      <div className="h-10 bg-neutral-900 border-b border-white/10 flex items-center justify-between px-3 shrink-0 select-none">
        <div className="flex items-center space-x-1 overflow-x-auto max-w-[80%]">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded-t-lg text-xs font-medium cursor-pointer transition ${
                  isActive
                    ? "bg-neutral-950 text-white border-t-2 border-blue-500 shadow-sm"
                    : "text-neutral-400 hover:text-white hover:bg-neutral-800"
                }`}
              >
                <TerminalIcon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
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
        <div className="flex items-center space-x-1.5">
          {/* Quick new tab dropdown */}
          <div className="relative group">
            <button
              title="Open Session to Another Server"
              className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white transition flex items-center space-x-1 text-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="text-[11px] hidden sm:inline">New Session</span>
            </button>
            <div className="absolute right-0 top-full mt-1 hidden group-hover:block w-48 bg-neutral-900 border border-white/10 rounded-lg shadow-2xl py-1 z-30">
              <div className="px-3 py-1 text-[10px] uppercase font-mono text-neutral-500">
                Select Target Node
              </div>
              {servers.map((s) => (
                <button
                  key={s.id}
                  onClick={() => openNewTab(s)}
                  className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-xs text-neutral-300 hover:text-white truncate"
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={copyTerminalOutput}
            title="Copy Terminal Output"
            className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white transition"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            onClick={clearActiveTab}
            title="Clear Screen (Ctrl+L)"
            className="p-1.5 rounded hover:bg-neutral-800 text-neutral-400 hover:text-white transition"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Quick Command Chips */}
      <div className="px-3 py-1.5 bg-neutral-900/60 border-b border-white/5 flex items-center space-x-2 overflow-x-auto shrink-0 select-none">
        <span className="text-[10px] font-mono uppercase text-neutral-500 shrink-0">
          Presets:
        </span>
        {quickCommands.map((q) => (
          <button
            key={q.cmd}
            onClick={() => handleExecute(q.cmd)}
            disabled={isExecuting}
            className="px-2 py-0.5 rounded bg-white/5 hover:bg-white/10 text-[11px] font-mono text-neutral-300 hover:text-white transition shrink-0 disabled:opacity-50"
          >
            {q.label}
          </button>
        ))}
      </div>

      {/* Terminal Screen Body */}
      <div className="flex-1 overflow-y-auto p-4 font-mono text-xs space-y-2 leading-relaxed">
        {activeTab?.history.map((h, i) => {
          if (h.type === "input") {
            return (
              <div key={i} className="flex items-start space-x-2 text-neutral-300">
                <span className="text-emerald-400 font-semibold select-none">
                  {activeTab.username}@{activeTab.host}:~$
                </span>
                <span className="text-white font-medium">{h.text}</span>
              </div>
            );
          }
          if (h.type === "system") {
            return (
              <div
                key={i}
                className="text-neutral-500 bg-white/5 p-2 rounded-md border border-white/5 whitespace-pre-wrap"
              >
                {h.text}
              </div>
            );
          }
          if (h.type === "error") {
            return (
              <div
                key={i}
                className="text-rose-400 bg-rose-500/10 p-2 rounded border border-rose-500/20 whitespace-pre-wrap"
              >
                {h.text}
              </div>
            );
          }
          return (
            <div
              key={i}
              className="text-neutral-300 whitespace-pre-wrap pl-2 border-l border-white/10"
            >
              {h.text}
            </div>
          );
        })}

        {isExecuting && (
          <div className="flex items-center space-x-2 text-blue-400 animate-pulse">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-xs">Executing remote command...</span>
          </div>
        )}

        <div ref={terminalEndRef} />
      </div>

      {/* Input Prompt Footer */}
      <div className="p-3 bg-neutral-900 border-t border-white/10 flex items-center space-x-2 shrink-0">
        <span className="text-emerald-400 font-mono text-xs font-semibold select-none shrink-0">
          {activeTab ? `${activeTab.username}@${activeTab.host}:~$` : "$"}
        </span>

        <input
          ref={inputRef}
          type="text"
          value={currentInput}
          onChange={(e) => setCurrentInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isExecuting}
          placeholder={
            isExecuting
              ? "Running command..."
              : "Enter shell command (e.g. htop, ls -la, ping, docker)..."
          }
          className="flex-1 bg-transparent border-none text-xs font-mono text-white placeholder-neutral-600 focus:outline-none"
        />

        <button
          onClick={() => handleExecute()}
          disabled={isExecuting || !currentInput.trim()}
          className="p-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-40 transition"
        >
          <CornerDownLeft className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
