import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // @wom/db is TypeScript source inside the workspace
  transpilePackages: ["@wom/db", "@wom/scenario", "@wom/runtime"],
  serverExternalPackages: ["@prisma/client", "bcryptjs"],
  // dev server only: hosts allowed to load /_next dev resources (LAN demo + e2e via 127.0.0.1)
  allowedDevOrigins: ["127.0.0.1", ...(process.env.ALLOWED_DEV_ORIGINS?.split(",") ?? [])],
  turbopack: {
    // npm workspaces: `next` lives in the repository root node_modules
    root: path.resolve(process.cwd(), "../.."),
  },
};

export default nextConfig;
