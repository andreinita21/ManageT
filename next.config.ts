import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ssh2", "better-sqlite3"],
};

export default nextConfig;
