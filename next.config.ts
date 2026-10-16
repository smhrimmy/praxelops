import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ssh2", "ws"],
};

export default nextConfig;
