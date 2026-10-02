/**
 * RV.4.2 — the review request mailer's pause switch (`ReviewMailerState`), one row per business.
 *
 * Moved here unchanged from `routes/reviews.routes.ts` and `jobs/review-request-mailer.job.ts` (R1, MCP full control
 * part 06), so the mailer tick, the reviews page and Claude's `stop-automation` (R12) read and write the switch the
 * same way.
 *
 * PER BUSINESS. The row's id is the fixed `default`, but the workspace client (`packages/database/workspace-client.ts`,
 * `singleton()`) stores and reads it as `<workspaceId>:default` for every business except the legacy one, which keeps
 * `default`. A pause in one business therefore never skips another business's tick
 * (`automation-state-two-business-postgres.vitest.test.ts`).
 */
import prisma from '../../db.js'

const ROW_ID = 'default'

/** The business's switch; created (not paused) on first read. What the mailer tick and the reviews summary read. */
export async function readReviewMailerState() {
  return prisma.reviewMailerState.upsert({
    where: { id: ROW_ID },
    update: {},
    create: { id: ROW_ID },
  })
}

/** The business's switch without creating it; null when nobody has read or set it yet. */
export async function findReviewMailerState() {
  return prisma.reviewMailerState.findUnique({ where: { id: ROW_ID } })
}

export async function pauseReviewMailer(args: { reason?: string | null; pausedBy?: string | null }) {
  const paused = {
    isPaused: true,
    pausedReason: args.reason ?? null,
    pausedAt: new Date(),
    pausedBy: args.pausedBy ?? 'default-user',
  }
  return prisma.reviewMailerState.upsert({
    where: { id: ROW_ID },
    update: paused,
    create: { id: ROW_ID, ...paused },
  })
}

export async function resumeReviewMailer() {
  return prisma.reviewMailerState.upsert({
    where: { id: ROW_ID },
    update: {
      isPaused: false,
      pausedReason: null,
      pausedAt: null,
      pausedBy: null,
    },
    create: { id: ROW_ID, isPaused: false },
  })
}
