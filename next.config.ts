import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  allowedDevOrigins:
    process.env.CUPBOARD_DEV_ORIGINS?.split(",").filter(Boolean),
};

export default nextConfig;
