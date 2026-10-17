"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere. Server snapshot is "Ctrl" (no hydration mismatch risk: client-only tree). */
export function useModKeyLabel(): string {
  return useSyncExternalStore(
    subscribe,
    () => (isApplePlatform() ? "⌘" : "Ctrl"),
    () => "Ctrl"
  );
}

/** Subscribes to a CSS media query. Server snapshot is `false`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}
