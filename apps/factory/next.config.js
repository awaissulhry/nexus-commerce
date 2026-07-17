/**
 * F1 — Nexus Factory OS Next.js config. One app serves UI + API route handlers
 * on port 3100 (see docs/factory/F0-ARCHITECTURE.md). better-sqlite3 is a
 * native addon and the generated Prisma client rides on it — both must stay
 * external to the bundler.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Dev runs in .next-dev so a concurrent `next build` (verification, CI,
  // another session) can never clobber the live dev server's assets — the
  // multi-session lesson apps/web learned with NEXT_DEV_ISOLATED (gate
  // incident 2026-07-05: a parallel build blanked the Owner's running app).
  distDir: process.env.FACTORY_BUILD_DIR || ".next",
  // EPQ.3 — pin the workspace root to THIS checkout's monorepo root. Without
  // it, a build inside a git worktree (.claude/worktrees/…) sees two lockfiles
  // (worktree + outer repo), infers the OUTER repo as root, and resolves the
  // commerce tree's Next runtime alongside the factory's pinned one — the
  // export phase then dies with "Expected workStore to be initialized".
  // On the main checkout this resolves to /…/nexus-commerce, unchanged.
  turbopack: {
    root: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  },
  serverExternalPackages: [
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "better-sqlite3",
    // pdfkit reads its .afm font-metric files from node_modules at runtime;
    // bundling it breaks that path (FP3 quote PDF). Keep it external.
    "pdfkit",
  ],
};

export default nextConfig;
