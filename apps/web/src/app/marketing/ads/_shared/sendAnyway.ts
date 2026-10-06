/**
 * 3A (Owner decided 2026-10-06) — HIS limits warn, they never block his own edits.
 *
 * When a person's write goes past one of his own limits (a campaign's bid or budget limit, a bid policy, a spend
 * ceiling, the daily budget-move limit, the per-change value cap, his CPC ceiling) the API answers 409 with
 * `needsConfirmation: { limits }` and writes nothing. The screen shows the warning with "Send anyway"; sending the same
 * body again with `confirmOwnLimits: true` goes through, and the action log records "sent past <limit> by <person>".
 * Amazon's own limits are never in this list: those stay refusals.
 *
 * One dialog for every screen: `SendAnywayHost` (mounted once in the ads layout) answers `askSendAnyway`. Asks that
 * arrive together (a modal adding ten keywords, a bulk edit) are shown as ONE dialog and get one answer. With no host
 * mounted the answer is "no", so nothing is ever sent past a limit without the person seeing it.
 */

export interface OwnLimitLine { limit: string; reason: string }

/** The limits a write waits on, from its answer; null when it does not wait on any. Pure. */
export function readNeedsConfirmation(status: number, body: unknown): OwnLimitLine[] | null {
  if (status !== 409) return null
  const nc = (body as { needsConfirmation?: { limits?: unknown } } | null)?.needsConfirmation
  if (!nc || !Array.isArray(nc.limits)) return null
  return nc.limits
    .filter((l): l is OwnLimitLine => !!l && typeof (l as OwnLimitLine).reason === 'string')
    .map((l) => ({ limit: String(l.limit ?? ''), reason: l.reason }))
}

/** What the dialog shows: every limit, once, and how many changes wait. */
export interface SendAnywayAsk { changes: number; limits: OwnLimitLine[] }
export type SendAnywayAsker = (ask: SendAnywayAsk) => Promise<boolean>

let asker: SendAnywayAsker | null = null
/** The host registers itself (and null when it unmounts). */
export function setSendAnywayAsker(next: SendAnywayAsker | null): void {
  asker = next
}

let batch: { changes: number; limits: OwnLimitLine[]; waiters: Array<(yes: boolean) => void> } | null = null

/** Ask once for every write that waits at the same moment. Resolves false without a host. */
export function askSendAnyway(limits: OwnLimitLine[], changes = 1): Promise<boolean> {
  if (!asker) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    if (!batch) {
      batch = { changes: 0, limits: [], waiters: [] }
      const open = batch
      // Writes started together answer within a few milliseconds of each other: one dialog for all of them.
      setTimeout(() => {
        batch = null
        const seen = new Set<string>()
        const unique = open.limits.filter((l) => (seen.has(l.reason) ? false : (seen.add(l.reason), true)))
        const ask = asker
        void (ask ? ask({ changes: open.changes, limits: unique }) : Promise.resolve(false))
          .catch(() => false)
          .then((yes) => { for (const w of open.waiters) w(yes) })
      }, 40)
    }
    batch.changes += changes
    batch.limits.push(...limits)
    batch.waiters.push(resolve)
  })
}

/** The body sent again after "Send anyway". Pure. */
export const confirmed = <B extends Record<string, unknown>>(body: B): B & { confirmOwnLimits: true } => ({ ...body, confirmOwnLimits: true })

/** What a write that waited and was not sent says. Pure. */
export function notSentPastLimits(limits: OwnLimitLine[]): string {
  return `Not sent — it goes past your own limits: ${limits.map((l) => l.reason).join('; ')}. Choose "Send anyway" to send it.`
}
