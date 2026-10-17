import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required by the production Docker image (standalone server bundle).
  output: "standalone",
  agentRules: false,
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
