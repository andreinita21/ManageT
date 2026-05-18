import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ssh2", "better-sqlite3"],
  allowedDevOrigins: ["managet.andreinita.com", "192.168.100.82", "192.168.100.95"],
};

export default nextConfig;
