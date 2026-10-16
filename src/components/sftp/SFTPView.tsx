"use client";

import React, { useState, useEffect } from "react";
import {
  FolderTree,
  Folder,
  FileText,
  FileCode,
  FileArchive,
  Download,
  Upload,
  RefreshCw,
  Eye,
  Server,
  ArrowUp,
  X,
  Check,
} from "lucide-react";
import { ServerHost } from "@/types/server";
import { RemoteFileItem } from "@/types/ssh";

interface SFTPViewProps {
  servers: ServerHost[];
  selectedServer?: ServerHost;
}

export const SFTPView: React.FC<SFTPViewProps> = ({
  servers,
  selectedServer,
}) => {
  const [currentServer, setCurrentServer] = useState<ServerHost>(
    selectedServer || servers[0]
  );
  const [currentPath, setCurrentPath] = useState<string>("/var/www");
  const [files, setFiles] = useState<RemoteFileItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [previewFile, setPreviewFile] = useState<{ name: string; content: string } | null>(null);

  const fetchFiles = async (path: string, srv: ServerHost) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/sftp?serverId=${srv.id}&path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      if (data.success) {
        setFiles(data.data.files);
        setCurrentPath(data.data.path);
      }
    } catch {
      // Keep previous list on error
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (currentServer) {
      fetchFiles(currentPath, currentServer);
    }
  }, [currentServer]);

  const handleNavigate = (path: string) => {
    fetchFiles(path, currentServer);
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
    if (file.name.endsWith(".tar.gz") || file.name.endsWith(".zip")) {
      return <FileArchive className="w-4 h-4 text-purple-400" />;
    }
    if (
      file.name.endsWith(".yml") ||
      file.name.endsWith(".yaml") ||
      file.name.endsWith(".json") ||
      file.name.endsWith(".conf")
    ) {
      return <FileCode className="w-4 h-4 text-blue-400" />;
    }
    return <FileText className="w-4 h-4 text-neutral-400" />;
  };

  const handlePreview = (file: RemoteFileItem) => {
    let sampleContent = "";
    if (file.name === "nginx.conf") {
      sampleContent = `server {\n    listen 80;\n    server_name praxelops.internal;\n\n    location / {\n        proxy_pass http://127.0.0.1:3000;\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n    }\n}`;
    } else if (file.name === "docker-compose.yml") {
      sampleContent = `version: '3.8'\nservices:\n  web:\n    image: node:24-alpine\n    restart: unless-stopped\n    ports:\n      - "3000:3000"\n    environment:\n      NODE_ENV: production\n  redis:\n    image: redis:7.2-alpine\n    ports:\n      - "6379:6379"`;
    } else if (file.name === ".env.production") {
      sampleContent = `PORT=3000\nNODE_ENV=production\nDATABASE_URL=postgres://operator:secret@127.0.0.1:5432/praxel\nREDIS_HOST=127.0.0.1`;
    } else {
      sampleContent = `[Binary or text data for ${file.name}]\nSize: ${formatFileSize(file.size)}\nPermissions: ${file.permissions}`;
    }
    setPreviewFile({ name: file.name, content: sampleContent });
  };

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
            Secure remote file management, file transfers, and in-place configuration inspection.
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

      {/* File List Table */}
      <div className="flex-1 overflow-y-auto rounded-xl border border-black/5 dark:border-white/10 bg-white/50 dark:bg-neutral-900/50 backdrop-blur-md">
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
                  {new Date(file.modifyTime).toLocaleString()}
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
                      <button
                        onClick={() => {
                          alert(`Downloading ${file.name} over SFTP stream`);
                        }}
                        title="Download file"
                        className="p-1 rounded hover:bg-black/10 dark:hover:bg-white/10 text-neutral-500 hover:text-neutral-900 dark:hover:text-white"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
