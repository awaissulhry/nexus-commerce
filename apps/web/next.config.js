/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // This prevents Turbopack from breaking the Prisma connection
  serverExternalPackages: ["@prisma/client", "pg", "@nexus/database"],
  // PERF — client-side Router Cache. Next 15 defaults staleTimes.dynamic to 0,
  // so dynamic (force-dynamic) pages are NEVER kept client-side → every Back
  // navigation re-fetches + re-renders from scratch (skeleton flash + reload).
  // Keeping visited dynamic segments for 3 min makes Back instant (restores the
  // cached page + scroll, no server round trip). Live views still refresh via
  // their own SSE/effect subscriptions.
  experimental: {
    staleTimes: {
      dynamic: 180,
      static: 300,
    },
  },
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
