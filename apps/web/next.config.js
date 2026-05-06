/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This prevents Turbopack from breaking the Prisma connection
  serverExternalPackages: ["@prisma/client", "pg", "@nexus/database"],
  async redirects() {
    return [
      // Phase 4 (2026-05-06): /pim/review → /catalog/organize.
      // Page does catalog organization, not a review queue; renamed
      // so the URL matches the behaviour. Permanent because the new
      // path is the canonical one going forward.
      { source: '/pim/review', destination: '/catalog/organize', permanent: true },
      { source: '/pim/review/:path*', destination: '/catalog/organize/:path*', permanent: true },
      { source: '/pim', destination: '/catalog/organize', permanent: true },
    ];
  },
};

module.exports = nextConfig;
