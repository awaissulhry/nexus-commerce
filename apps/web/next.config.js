/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This prevents Turbopack from breaking the Prisma connection
  serverExternalPackages: ["@prisma/client", "pg", "@nexus/database"],
};

module.exports = nextConfig;