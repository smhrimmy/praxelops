import { describe, it, expect } from "vitest";
import type { ServiceInfo } from "@/lib/metrics/types";
import { filterServices, serviceCounts } from "./services";

const svc = (unit: string, active: string, description = ""): ServiceInfo => ({ unit, load: "loaded", active, sub: active === "active" ? "running" : "dead", description });

const SERVICES = [
  svc("sshd.service", "active", "OpenBSD Secure Shell server"),
  svc("nginx.service", "failed", "A high performance web server"),
  svc("cron.service", "active", "Regular background program processing daemon"),
  svc("apt-daily.service", "inactive", "Daily apt download activities"),
  svc("docker.service", "failed", "Docker Application Container Engine"),
];

describe("serviceCounts", () => {
  it("counts active and failed units", () => {
    expect(serviceCounts(SERVICES)).toEqual({ all: 5, active: 2, failed: 2 });
    expect(serviceCounts([])).toEqual({ all: 0, active: 0, failed: 0 });
  });
});

describe("filterServices", () => {
  it("lists failed units first, then alphabetically", () => {
    expect(filterServices(SERVICES, "", "all").map((s) => s.unit)).toEqual([
      "docker.service",
      "nginx.service",
      "apt-daily.service",
      "cron.service",
      "sshd.service",
    ]);
  });

  it("filters by state", () => {
    expect(filterServices(SERVICES, "", "failed").map((s) => s.unit)).toEqual(["docker.service", "nginx.service"]);
    expect(filterServices(SERVICES, "", "active").map((s) => s.unit)).toEqual(["cron.service", "sshd.service"]);
  });

  it("matches the text against unit and description, case-insensitively", () => {
    expect(filterServices(SERVICES, "SSH", "all").map((s) => s.unit)).toEqual(["sshd.service"]);
    expect(filterServices(SERVICES, "web server", "all").map((s) => s.unit)).toEqual(["nginx.service"]);
  });

  it("combines text and state filters", () => {
    expect(filterServices(SERVICES, "service", "failed")).toHaveLength(2);
    expect(filterServices(SERVICES, "cron", "failed")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const copy = [...SERVICES];
    filterServices(SERVICES, "", "all");
    expect(SERVICES).toEqual(copy);
  });
});
