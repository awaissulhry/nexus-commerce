/**
 * F1 — Nexus Factory OS Next.js config. One app serves UI + API route handlers
 * on port 3100 (see docs/factory/F0-ARCHITECTURE.md). better-sqlite3 is a
 * native addon and the generated Prisma client rides on it — both must stay
 * external to the bundler.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Dev runs in .next-dev so a concurrent `next build` (verification, CI,
  // another session) can never clobber the live dev server's assets — the
  // multi-session lesson apps/web learned with NEXT_DEV_ISOLATED (gate
  // incident 2026-07-05: a parallel build blanked the Owner's running app).
  distDir: process.env.FACTORY_BUILD_DIR || ".next",
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "better-sqlite3",
  ],
};

export default nextConfig;
