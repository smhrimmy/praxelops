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
      return <Folder className="w-4 h-4 text-amber-500 fill-amber-500/20" />;
    }
    if (file.name.endsWith(".tar.gz") || file.name.endsWith(".zip") || file.name.endsWith(".gz")) {
      return <FileArchive className="w-4 h-4 text-purple-400" />;
    }
    if (
      file.name.endsWith(".yml") ||
      file.name.endsWith(".yaml") ||
      file.name.endsWith(".json") ||
      file.name.endsWith(".conf") ||
      file.name.endsWith(".sh")
    ) {
      return <FileCode className="w-4 h-4 text-blue-400" />;
    }
    return <FileText className="w-4 h-4 text-neutral-400" />;
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
        <div className="w-12 h-12 rounded-2xl bg-amber-500/10 flex items-center justify-center text-amber-500">
          <FolderTree className="w-6 h-6" />
        </div>
        <div className="max-w-md space-y-1">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            No Active SFTP Session
          </h2>
          <p className="text-xs text-neutral-500 leading-relaxed">
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
    <div className="flex-1 flex flex-col h-full overflow-hidden p-6 space-y-4">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-neutral-900 dark:text-neutral-100 flex items-center space-x-2">
            <FolderTree className="w-5 h-5 text-amber-500" />
            <span>Remote SFTP Explorer</span>
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Real SFTP directory exploration on {currentServer.name} ({currentServer.host}).
          </p>
        </div>

        {/* Server Selector & Refresh */}
        <div className="flex items-center space-x-2">
          <select
            value={currentServer.id}
            onChange={(e) => {
              const s = servers.find((srv) => srv.id === e.target.value);
              if (s) setCurrentServer(s);
            }}
            className="px-3 py-1.5 rounded-lg bg-black/5 dark:bg-white/5 border border-black/10 dark:border-white/10 text-xs font-medium text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            className="p-2 rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-neutral-600 dark:text-neutral-300 transition"
            title="Refresh Directory"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Path Breadcrumbs */}
      <div className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10 text-xs font-mono text-neutral-700 dark:text-neutral-300">
        <span className="text-neutral-400">Path:</span>
        <div className="flex items-center space-x-1 overflow-x-auto">
          {currentPath.split("/").map((segment, index, arr) => {
            const subPath = arr.slice(0, index + 1).join("/") || "/";
            return (
              <button
                key={index}
                onClick={() => handleNavigate(subPath)}
                className="hover:underline hover:text-blue-500 px-1 py-0.5 rounded"
              >
                {segment || "/"}
              </button>
            );
          })}
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-600 dark:text-rose-400 text-xs flex items-center space-x-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* File List Table */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-black/5 dark:border-white/10 bg-white/50 dark:bg-neutral-900/50 backdrop-blur-md">
        {loading ? (
          <div className="h-48 flex items-center justify-center space-x-2 text-xs text-neutral-400">
            <RefreshCw className="w-4 h-4 animate-spin text-amber-500" />
            <span>Listing remote directory via SFTP...</span>
          </div>
        ) : files.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-xs text-neutral-400">
            <p>Directory is empty or inaccessible.</p>
          </div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="bg-black/5 dark:bg-white/5 border-b border-black/5 dark:border-white/10 text-neutral-500 dark:text-neutral-400 font-medium select-none sticky top-0">
              <tr>
                <th className="py-2.5 px-4">Name</th>
                <th className="py-2.5 px-4">Size</th>
                <th className="py-2.5 px-4 hidden sm:table-cell">Permissions</th>
                <th className="py-2.5 px-4 hidden md:table-cell">Modified</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/5 dark:divide-white/5 font-mono">
              {files.map((file, idx) => (
                <tr
                  key={idx}
                  className="hover:bg-black/5 dark:hover:bg-white/5 transition"
                >
                  <td className="py-2 px-4">
                    <div
                      onClick={() => {
                        if (file.isDirectory) handleNavigate(file.path);
                      }}
                      className={`flex items-center space-x-2.5 ${
                        file.isDirectory
                          ? "cursor-pointer text-blue-600 dark:text-blue-400 font-semibold"
                          : "text-neutral-800 dark:text-neutral-200"
                      }`}
                    >
                      {getFileIcon(file)}
                      <span className="truncate">{file.name}</span>
                    </div>
                  </td>
                  <td className="py-2 px-4 text-neutral-500">
                    {file.isDirectory ? "—" : formatFileSize(file.size)}
                  </td>
                  <td className="py-2 px-4 text-neutral-500 hidden sm:table-cell">
                    {file.permissions}
                  </td>
                  <td className="py-2 px-4 text-neutral-500 hidden md:table-cell">
                    {file.modifyTime ? new Date(file.modifyTime).toLocaleString() : "—"}
                  </td>
                  <td className="py-2 px-4 text-right">
                    {!file.isDirectory && (
                      <div className="flex items-center justify-end space-x-1.5">
                        <button
                          onClick={() => handlePreview(file)}
                          title="Preview File Content"
                          className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-2xl bg-white dark:bg-neutral-900 rounded-2xl border border-black/10 dark:border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between px-5 py-3 border-b border-black/5 dark:border-white/10">
              <span className="text-xs font-semibold font-mono text-neutral-900 dark:text-neutral-100">
                {previewFile.name}
              </span>
              <button
                onClick={() => setPreviewFile(null)}
                className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 text-neutral-400"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="p-4 bg-neutral-950 text-neutral-200 text-xs font-mono overflow-y-auto leading-relaxed flex-1">
              {previewFile.content}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
