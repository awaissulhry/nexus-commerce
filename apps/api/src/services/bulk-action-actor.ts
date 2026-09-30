/**
 * Who a bulk job acts for — its `createdBy`, and so the actor on every audit row, timeline row and queue row the job
 * writes (a bulk price override records it as `lastOverrideBy`, `ChannelListingOverride.changedBy`,
 * `PriceChangeEvent.actor` and the PRICE_UPDATE row's `actor`).
 *
 * 🔴 Never a caller-supplied string. `POST /api/bulk-operations` took `createdBy` from the request body, so a price
 * change could be recorded under any name the caller typed — and the web sent none, so it read "bulk-action". Now:
 *   - a request acts for the signed-in person: their user id (the name is shown where the app shows who ran a job);
 *   - a request with an API key and no session acts for `api-key:<key id>`;
 *   - a schedule acts for the person who scheduled it (checked to be a real person), else `schedule:<schedule id>`;
 *   - an automation rule acts as `automation:<rule id>` (set in `automation/bulk-ops-actions.ts`);
 *   - a rollback acts for the person who asked for it, else `bulk-action-rollback`.
 */
import type { PrismaClient } from '@prisma/client'

/** What the session hooks put on a request (`lib/auth/guards.ts` → `authUser`, `lib/api-key-hook.ts` → `apiKey`). */
type ActorRequest = { authUser?: { id?: string | null } | null; apiKey?: { id?: string | null } | null }

/** The signed-in person's id, or the API key's; `null` when the request carries neither. Never the body. */
export function bulkActorOf(request: ActorRequest): string | null {
  if (request.authUser?.id) return request.authUser.id
  if (request.apiKey?.id) return `api-key:${request.apiKey.id}`
  return null
}

/**
 * A scheduled run acts for the person who scheduled it. A schedule saved before its creator came from the session
 * holds whatever the caller typed, so the stored value counts only when it names a real person; otherwise the run
 * names its schedule.
 */
export async function scheduledRunActor(
  db: Pick<PrismaClient, 'userProfile'>,
  schedule: { id: string; createdBy: string | null },
): Promise<string> {
  if (schedule.createdBy) {
    const person = await db.userProfile.findUnique({ where: { id: schedule.createdBy }, select: { id: true } })
    if (person) return person.id
  }
  return `schedule:${schedule.id}`
}

const SYSTEM_LABELS: Array<[prefix: string, label: string]> = [
  ['automation:', 'Automation rule'],
  ['schedule:', 'Schedule'],
  ['api-key:', 'API key'],
  ['bulk-action-rollback', 'Rollback'],
]

/**
 * The name to show for each job actor: a person's display name, a plain label for a system actor. Anything else — a
 * string a caller supplied before this change — gets no name: it is not shown as if it were someone.
 */
export async function bulkActorNames(
  db: Pick<PrismaClient, 'userProfile'>,
  actors: ReadonlyArray<string | null | undefined>,
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const people: string[] = []
  for (const actor of new Set(actors)) {
    if (!actor) continue
    const system = SYSTEM_LABELS.find(([prefix]) => actor.startsWith(prefix))
    if (system) names.set(actor, system[1])
    else people.push(actor)
  }
  if (people.length) {
    const rows = await db.userProfile.findMany({ where: { id: { in: people } }, select: { id: true, displayName: true, email: true } })
    for (const row of rows) names.set(row.id, row.displayName || row.email)
  }
  return names
}
