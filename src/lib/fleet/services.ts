import type { ServiceInfo } from "@/lib/metrics/types";

export type ServiceFilter = "all" | "active" | "failed";

export function serviceCounts(services: readonly ServiceInfo[]): Record<ServiceFilter, number> {
  let active = 0;
  let failed = 0;
  for (const s of services) {
    if (s.active === "active") active += 1;
    if (s.active === "failed") failed += 1;
  }
  return { all: services.length, active, failed };
}

/**
 * Text filter (unit name or description, case-insensitive) plus the state filter. Failed units come first, then
 * alphabetically by unit name, so a broken service is never buried.
 */
export function filterServices(services: readonly ServiceInfo[], text: string, filter: ServiceFilter): ServiceInfo[] {
  const needle = text.trim().toLowerCase();
  return services
    .filter((s) => {
      if (filter === "active" && s.active !== "active") return false;
      if (filter === "failed" && s.active !== "failed") return false;
      if (needle === "") return true;
      return s.unit.toLowerCase().includes(needle) || s.description.toLowerCase().includes(needle);
    })
    .sort((a, b) => {
      const af = a.active === "failed" ? 0 : 1;
      const bf = b.active === "failed" ? 0 : 1;
      if (af !== bf) return af - bf;
      return a.unit.localeCompare(b.unit);
    });
}
