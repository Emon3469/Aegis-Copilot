import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image needs the standalone server bundle; Vercel builds its own output.
  output: process.env.VERCEL ? undefined : "standalone",
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
