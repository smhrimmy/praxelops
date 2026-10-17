"use client";

import React, { useState } from "react";
import { Terminal, Lock, Loader2 } from "lucide-react";
import { login } from "@/lib/client/api";

interface LoginScreenProps {
  onAuthenticated: () => void;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onAuthenticated }) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await login(username.trim(), password);
    setSubmitting(false);
    if (result.ok) {
      setPassword("");
      onAuthenticated();
    } else {
      setError(result.error || "Sign-in failed");
    }
  };

  return (
    <div className="app-bg flex h-dvh w-full items-center justify-center select-none p-4 overflow-y-auto">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm macos-glass rounded-2xl shadow-2xl border border-line overflow-hidden"
      >
        <div className="h-10 px-4 bg-chrome border-b border-line flex items-center justify-center text-xs font-semibold text-fg-2 tracking-tight">
          PraxelOps Studio
        </div>

        <div className="p-6 space-y-4">
          <div className="flex flex-col items-center space-y-2">
            <div className="w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
              <Terminal className="w-6 h-6 text-info" />
            </div>
            <h1 className="text-sm font-semibold text-fg">Operator sign-in</h1>
          </div>

          <div className="space-y-1">
            <label htmlFor="praxel-username" className="text-[11px] font-medium text-fg-2">
              Username
            </label>
            <input
              id="praxel-username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm bg-input border border-line-strong text-fg focus:outline-none focus:ring-2 focus:ring-blue-500 select-text"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="praxel-password" className="text-[11px] font-medium text-fg-2">
              Password
            </label>
            <input
              id="praxel-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg text-sm bg-input border border-line-strong text-fg focus:outline-none focus:ring-2 focus:ring-blue-500 select-text"
            />
          </div>

          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || username.length === 0 || password.length === 0}
            className="w-full flex items-center justify-center space-x-2 px-3 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white transition"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
            <span>{submitting ? "Signing in..." : "Sign in"}</span>
          </button>

          <p className="text-[10px] text-center text-fg-muted">
            Accounts are created on the server with the create-operator CLI.
          </p>
        </div>
      </form>
    </div>
  );
};
