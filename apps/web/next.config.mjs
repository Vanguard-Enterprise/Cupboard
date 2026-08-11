/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output → a small runtime image (server.js + minimal node_modules).
  output: "standalone",
  reactStrictMode: true,
  // The dashboard image is built with /app while the storefront image remains at /.
  // Keeping this build-time lets the two independently deployed variants share code.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
  // Next 16 protects development assets from unlisted network origins. Keep this
  // environment-driven so local/NetBird addresses never leak into production config.
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      try {
        return new URL(origin).hostname;
      } catch {
        return origin.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").split("/")[0].split(":")[0];
      }
    })
    .filter(Boolean),
};

export default nextConfig;
