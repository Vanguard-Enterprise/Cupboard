/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output → a small runtime image (server.js + minimal node_modules).
  output: "standalone",
  reactStrictMode: true,
  // The dashboard image is built with /app while the storefront image remains at /.
  // Keeping this build-time lets the two independently deployed variants share code.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
};

export default nextConfig;
