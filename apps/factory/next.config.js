/**
 * F1 — Nexus Factory OS Next.js config. One app serves UI + API route handlers
 * on port 3100 (see docs/factory/F0-ARCHITECTURE.md). better-sqlite3 is a
 * native addon and the generated Prisma client rides on it — both must stay
 * external to the bundler.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "better-sqlite3",
  ],
};

export default nextConfig;
