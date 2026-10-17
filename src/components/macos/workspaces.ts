import {
  Server,
  Terminal,
  FolderTree,
  Bot,
  Rocket,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

export type WorkspaceId =
  | "fleet"
  | "terminal"
  | "sftp"
  | "ai-ops"
  | "deployments"
  | "audit";

export interface Workspace {
  id: WorkspaceId;
  /** Full label used in the sidebar, palette and window title. */
  label: string;
  /** Compact label used in the menu bar. */
  shortLabel: string;
  icon: LucideIcon;
  /** Semantic text-colour token class for the idle icon tint. */
  tint: string;
}

/** Order matters: index + 1 is the Ctrl/Cmd+N shortcut. */
export const WORKSPACES: readonly Workspace[] = [
  { id: "fleet", label: "Server Fleet", shortLabel: "Fleet", icon: Server, tint: "text-info" },
  { id: "terminal", label: "Interactive SSH", shortLabel: "Terminal", icon: Terminal, tint: "text-success" },
  { id: "sftp", label: "Remote SFTP", shortLabel: "SFTP", icon: FolderTree, tint: "text-warning" },
  { id: "ai-ops", label: "AI Copilot", shortLabel: "AI Copilot", icon: Bot, tint: "text-violet" },
  { id: "deployments", label: "Deployments", shortLabel: "Deploy", icon: Rocket, tint: "text-orange" },
  { id: "audit", label: "Security Audit", shortLabel: "Audit", icon: ShieldCheck, tint: "text-teal" },
];

export function workspaceLabel(id: string): string {
  return WORKSPACES.find((w) => w.id === id)?.label ?? id;
}
