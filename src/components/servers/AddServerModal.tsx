"use client";

import React, { useState, useEffect } from "react";
import { X, Server, Key, Lock, Tag, AlertCircle } from "lucide-react";
import { CreateServerInput, ServerHost } from "@/types/server";
import { apiFetch } from "@/lib/client/api";

interface AddServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onServerCreated: (server: ServerHost) => void;
}

export const AddServerModal: React.FC<AddServerModalProps> = ({
  isOpen,
  onClose,
  onServerCreated,
}) => {
  const [formData, setFormData] = useState<CreateServerInput>({
    name: "",
    host: "",
    port: 22,
    username: "root",
    authType: "password",
    password: "",
    privateKey: "",
    passphrase: "",
    tags: ["production"],
    osType: "linux",
  });

  const [tagInput, setTagInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await apiFetch("/api/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Failed to create server");
      }
      onServerCreated(data.data);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const addTag = () => {
    if (tagInput.trim() && !formData.tags.includes(tagInput.trim())) {
      setFormData({ ...formData, tags: [...formData.tags, tagInput.trim()] });
      setTagInput("");
    }
  };

  const removeTag = (tagToRemove: string) => {
    setFormData({
      ...formData,
      tags: formData.tags.filter((t) => t !== tagToRemove),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-server-title"
        className="w-full max-w-md max-h-[calc(100dvh-1.5rem)] bg-elevated rounded-2xl border border-line shadow-2xl overflow-hidden flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <div className="flex items-center space-x-2">
            <Server className="w-5 h-5 text-info" />
            <h2 id="add-server-title" className="text-sm font-semibold text-fg">
              Add Server Host
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="p-1.5 rounded-lg hover:bg-hover text-fg-muted"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto">
          {error && (
            <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-danger text-xs flex items-center space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label htmlFor="add-server-1" className="block text-xs font-medium text-fg-2 mb-1">
              Server Display Name
            </label>
            <input id="add-server-1"
              type="text"
              required
              value={formData.name}
              onChange={(e) =>
                setFormData({ ...formData, name: e.target.value })
              }
              placeholder="e.g. US-West Production DB"
              className="w-full px-3 py-2 rounded-lg bg-sunken border border-line-strong text-xs text-fg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label htmlFor="add-server-2" className="block text-xs font-medium text-fg-2 mb-1">
                Hostname / IP
              </label>
              <input id="add-server-2"
                type="text"
                required
                value={formData.host}
                onChange={(e) =>
                  setFormData({ ...formData, host: e.target.value })
                }
                placeholder="192.168.1.100 or app.prod"
                className="w-full px-3 py-2 rounded-lg bg-sunken border border-line-strong text-xs text-fg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="add-server-3" className="block text-xs font-medium text-fg-2 mb-1">
                Port
              </label>
              <input id="add-server-3"
                type="number"
                required
                value={formData.port}
                onChange={(e) =>
                  setFormData({ ...formData, port: parseInt(e.target.value) || 22 })
                }
                className="w-full px-3 py-2 rounded-lg bg-sunken border border-line-strong text-xs text-fg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="add-server-4" className="block text-xs font-medium text-fg-2 mb-1">
                SSH Username
              </label>
              <input id="add-server-4"
                type="text"
                required
                value={formData.username}
                onChange={(e) =>
                  setFormData({ ...formData, username: e.target.value })
                }
                placeholder="ubuntu / root"
                className="w-full px-3 py-2 rounded-lg bg-sunken border border-line-strong text-xs text-fg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label htmlFor="add-server-5" className="block text-xs font-medium text-fg-2 mb-1">
                Auth Method
              </label>
              <select id="add-server-5"
                value={formData.authType}
                onChange={(e) =>
                  setFormData({
                    ...formData,
                    authType: e.target.value as "password" | "privateKey" | "agent",
                  })
                }
                className="w-full px-3 py-2 rounded-lg bg-sunken border border-line-strong text-xs text-fg focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="password">Password</option>
                <option value="privateKey">Private Key</option>
                <option value="agent">SSH Agent</option>
              </select>
            </div>
          </div>

          {formData.authType === "password" ? (
            <div>
              <label htmlFor="add-server-6" className="block text-xs font-medium text-fg-2 mb-1">
                Password
              </label>
              <input id="add-server-6"
                type="password"
                value={formData.password}
                onChange={(e) =>
                  setFormData({ ...formData, password: e.target.value })
                }
                placeholder="••••••••••••"
                className="w-full px-3 py-2 rounded-lg bg-sunken border border-line-strong text-xs text-fg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ) : formData.authType === "privateKey" ? (
            <div className="space-y-2">
              <div>
                <label htmlFor="add-server-7" className="block text-xs font-medium text-fg-2 mb-1">
                  Private Key (PEM or OpenSSH)
                </label>
                <textarea id="add-server-7"
                  rows={3}
                  value={formData.privateKey}
                  onChange={(e) =>
                    setFormData({ ...formData, privateKey: e.target.value })
                  }
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
                  className="w-full px-3 py-2 rounded-lg bg-sunken border border-line-strong text-xs font-mono text-fg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label htmlFor="add-server-8" className="block text-xs font-medium text-fg-2 mb-1">
                  Passphrase (Optional)
                </label>
                <input id="add-server-8"
                  type="password"
                  value={formData.passphrase}
                  onChange={(e) =>
                    setFormData({ ...formData, passphrase: e.target.value })
                  }
                  placeholder="Key passphrase if encrypted"
                  className="w-full px-3 py-2 rounded-lg bg-sunken border border-line-strong text-xs text-fg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          ) : null}

          {/* Tags */}
          <div>
            <label htmlFor="add-server-9" className="block text-xs font-medium text-fg-2 mb-1">
              Tags
            </label>
            <div className="flex items-center space-x-2 mb-2">
              <input id="add-server-9"
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTag();
                  }
                }}
                placeholder="Add tag (e.g. database, staging) and press Enter"
                className="w-full px-3 py-1.5 rounded-lg bg-sunken border border-line-strong text-xs text-fg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={addTag}
                className="px-3 py-1.5 rounded-lg bg-sunken-2 hover:bg-hover-strong text-xs font-medium text-fg-2"
              >
                Add
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {formData.tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-md bg-blue-500/10 text-info text-[11px]"
                >
                  <span>{tag}</span>
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="hover:underline"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* Footer Actions */}
          <div className="pt-3 border-t border-line flex items-center justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 rounded-lg hover:bg-hover text-xs text-fg-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium shadow-sm transition disabled:opacity-50"
            >
              {loading ? "Registering..." : "Register Server"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
