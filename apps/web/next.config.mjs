/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output → a small runtime image (server.js + minimal node_modules).
  output: "standalone",
  reactStrictMode: true,
};

export default nextConfig;
