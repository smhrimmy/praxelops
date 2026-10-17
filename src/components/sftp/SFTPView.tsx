"use client";

import React, { useState, useEffect } from "react";
import {
  FolderTree,
  Folder,
  FileText,
  FileCode,
  FileArchive,
  Download,
  RefreshCw,
  Eye,
  X,
  AlertCircle,
  Plus,
} from "lucide-react";
import { ServerHost } from "@/types/server";
import { RemoteFileItem } from "@/types/ssh";
import { apiFetch } from "@/lib/client/api";

interface SFTPViewProps {
  servers: ServerHost[];
  selectedServer?: ServerHost;
  onAddServerClick?: () => void;
}

export const SFTPView: React.FC<SFTPViewProps> = ({
  servers,
  selectedServer,
  onAddServerClick,
}) => {
  const [currentServer, setCurrentServer] = useState<ServerHost | undefined>(
    selectedServer || (servers.length > 0 ? servers[0] : undefined)
  );
  const [currentPath, setCurrentPath] = useState<string>("/");
  const [files, setFiles] = useState<RemoteFileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<{ name: string; content: string } | null>(null);

  const fetchFiles = async (path: string, srv: ServerHost) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/sftp?serverId=${srv.id}&path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      if (data.success) {
        setFiles(data.data.files);
        setCurrentPath(data.data.path);
      } else {
        setFiles([]);
        setError(data.error || "Failed to list remote directory.");
      }
    } catch (err) {
      setFiles([]);
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selectedServer) {
      setCurrentServer(selectedServer);
    } else if (!currentServer && servers.length > 0) {
      setCurrentServer(servers[0]);
    }
  }, [selectedServer, servers]);

  useEffect(() => {
    if (currentServer) {
      fetchFiles(currentPath, currentServer);
    }
  }, [currentServer]);

  const handleNavigate = (path: string) => {
    if (currentServer) {
      fetchFiles(path, currentServer);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const getFileIcon = (file: RemoteFileItem) => {
    if (file.isDirectory) {
      return <Folder className="w-4 h-4 text-warning fill-amber-500/20" />;
    }
    if (file.name.endsWith(".tar.gz") || file.name.endsWith(".zip") || file.name.endsWith(".gz")) {
      return <FileArchive className="w-4 h-4 text-violet" />;
    }
    if (
      file.name.endsWith(".yml") ||
      file.name.endsWith(".yaml") ||
      file.name.endsWith(".json") ||
      file.name.endsWith(".conf") ||
      file.name.endsWith(".sh")
    ) {
      return <FileCode className="w-4 h-4 text-info" />;
    }
    return <FileText className="w-4 h-4 text-fg-muted" />;
  };

  const handlePreview = async (file: RemoteFileItem) => {
    if (!currentServer) return;
    try {
      const res = await apiFetch(
        `/api/sftp?action=preview&serverId=${currentServer.id}&path=${encodeURIComponent(file.path)}`
      );
      const data = await res.json();
      if (data.success) {
        setPreviewFile({ name: file.name, content: data.data.content });
      } else {
        setPreviewFile({
          name: file.name,
          content: `Unable to preview file: ${data.error}`,
        });
      }
    } catch (err) {
      setPreviewFile({
        name: file.name,
        content: `Error reading file: ${(err as Error).message}`,
      });
    }
  };

  if (servers.length === 0 || !currentServer) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-amber-500/10 flex items-center justify-center text-warning">
          <FolderTree className="w-6 h-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-semibold text-fg">
            No Active SFTP Session
          </h2>
          <p className="text-xs text-fg-muted leading-relaxed">
            Register a server host in Fleet to explore remote filesystems, inspect logs, and transfer files via genuine SFTP.
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

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden p-3 sm:p-6 space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-fg flex items-center space-x-2">
            <FolderTree className="w-5 h-5 text-warning" />
            <span>Remote SFTP Explorer</span>
          </h1>
          <p className="text-xs text-fg-muted mt-0.5">
            Real SFTP directory exploration on {currentServer.name} ({currentServer.host}).
          </p>
        </div>

        {/* Server Selector & Refresh */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <select
            aria-label="Server"
            value={currentServer.id}
            onChange={(e) => {
              const s = servers.find((srv) => srv.id === e.target.value);
              if (s) setCurrentServer(s);
            }}
            className="px-3 py-1.5 rounded-lg bg-sunken border border-line-strong text-xs font-medium text-fg focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0 flex-1 sm:flex-none"
          >
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.host})
              </option>
            ))}
          </select>

          <button
            onClick={() => fetchFiles(currentPath, currentServer)}
            disabled={loading}
            className="p-2 rounded-lg bg-sunken hover:bg-hover-strong text-fg-2 transition"
            title="Refresh Directory"
            aria-label="Refresh directory"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Path Breadcrumbs */}
      <div className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-sunken border border-line text-xs font-mono text-fg-2">
        <span className="text-fg-muted">Path:</span>
        <div className="flex items-center space-x-1 overflow-x-auto">
          {currentPath.split("/").map((segment, index, arr) => {
            const subPath = arr.slice(0, index + 1).join("/") || "/";
            return (
              <button
                key={index}
                onClick={() => handleNavigate(subPath)}
                className="hover:underline hover:text-info px-1 py-0.5 rounded"
              >
                {segment || "/"}
              </button>
            );
          })}
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-danger text-xs flex items-center space-x-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* File List Table */}
      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-line bg-surface-2 backdrop-blur-md">
        {loading ? (
          <div className="h-48 flex items-center justify-center space-x-2 text-xs text-fg-muted">
            <RefreshCw className="w-4 h-4 animate-spin text-warning" />
            <span>Listing remote directory via SFTP...</span>
          </div>
        ) : files.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-xs text-fg-muted">
            <p>Directory is empty or inaccessible.</p>
          </div>
        ) : (
          <table className="w-full min-w-[22rem] text-left text-xs">
            <thead className="bg-elevated border-b border-line text-fg-muted font-medium select-none sticky top-0 z-10">
              <tr>
                <th className="py-2.5 px-4">Name</th>
                <th className="py-2.5 px-4">Size</th>
                <th className="py-2.5 px-4 hidden sm:table-cell">Permissions</th>
                <th className="py-2.5 px-4 hidden md:table-cell">Modified</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line font-mono">
              {files.map((file, idx) => (
                <tr
                  key={idx}
                  className="hover:bg-hover transition"
                >
                  <td className="py-2 px-4">
                    {file.isDirectory ? (
                      <button
                        type="button"
                        onClick={() => handleNavigate(file.path)}
                        aria-label={`Open folder ${file.name}`}
                        className="flex items-center space-x-2.5 text-info font-semibold hover:underline text-left"
                      >
                        {getFileIcon(file)}
                        <span className="truncate">{file.name}</span>
                      </button>
                    ) : (
                      <div className="flex items-center space-x-2.5 text-fg">
                        {getFileIcon(file)}
                        <span className="truncate">{file.name}</span>
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-4 text-fg-muted">
                    {file.isDirectory ? "—" : formatFileSize(file.size)}
                  </td>
                  <td className="py-2 px-4 text-fg-muted hidden sm:table-cell">
                    {file.permissions}
                  </td>
                  <td className="py-2 px-4 text-fg-muted hidden md:table-cell">
                    {file.modifyTime ? new Date(file.modifyTime).toLocaleString() : "—"}
                  </td>
                  <td className="py-2 px-4 text-right">
                    {!file.isDirectory && (
                      <div className="flex items-center justify-end space-x-1.5">
                        <button
                          onClick={() => handlePreview(file)}
                          title="Preview File Content"
                          aria-label={`Preview ${file.name}`}
                          className="p-1 rounded hover:bg-hover-strong text-fg-muted hover:text-fg"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* File Preview Modal */}
      {previewFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/50 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-label={`Preview of ${previewFile.name}`} className="w-full max-w-2xl bg-elevated rounded-2xl border border-line shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-5 py-3 border-b border-line">
              <span className="text-xs font-semibold font-mono text-fg">
                {previewFile.name}
              </span>
              <button
                onClick={() => setPreviewFile(null)}
                aria-label="Close preview"
                className="p-1.5 rounded hover:bg-hover text-fg-muted"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre data-theme="dark" className="p-4 bg-neutral-950 text-neutral-200 text-xs font-mono overflow-y-auto leading-relaxed flex-1">
              {previewFile.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
