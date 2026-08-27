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
  // ── Turbopack dev cache — bounded by construction (2026-08-27) ────────────────────────────
  //
  // Same reason as apps/web/next.config.js, where the full incident is written up: Next 16
  // defaults `turbopackFileSystemCacheForDev` to TRUE and nothing prunes it. apps/web's copy
  // reached 15.8 GB and kernel-panicked this machine twice in 95 minutes; this app's own
  // `.next-dev` had been sitting at 2.0 GB since 07-05 on the same unbounded default.
  // Off here too, so the failure cannot simply move apps.
  experimental: {
    turbopackFileSystemCacheForDev: false,
    // A "target" limit in bytes, not a hard cap — but the only lever that reaches Turbopack's
    // native Rust allocation. DEV ONLY: Next threads the same value into the production build,
    // and this is guarding a long-lived dev server, not a one-shot build. See apps/web's copy.
    ...(process.env.NODE_ENV === "development"
      ? { turbopackMemoryLimit: 4 * 1024 * 1024 * 1024 }
      : {}),
  },
};

export default nextConfig;
