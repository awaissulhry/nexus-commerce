/**
 * CR (Control Room review) — "Changes to the controls": who moved a control of the ads automation, when, from what to
 * what. The Control Room's History shows it beside "What automation did".
 *
 * Read-only. The rows already exist in two logs, and this is the one place that reads both:
 *   - the ads action log rows marked `evidence.metric = 'operator_autonomy'`: the account level (dial), Stop now / Start
 *     again, the breaker limits, a rule's level, an automation's level (ads-automation-state.service.ts,
 *     automation-stop.service.ts, ads-rule-crud.service.ts, ads-automation-adapters.ts);
 *   - the audit log rows of an engine's level for this business (`set_engine_switch`, engine-switch.service.ts) and of
 *     "Automation may change it" on a campaign (`set_live_writes`, campaign-settings.service.ts).
 * Both logs are scoped to the business by row-level security, like every read here.
 */
import prisma from '../../db.js'

export type ControlKind = 'account-level' | 'stop' | 'start' | 'brakes' | 'rule-level' | 'automation-level' | 'engine-level' | 'campaign-allowed' | 'other'

export interface ControlChange {
  id: string
  at: string
  /** The person's id when a person made it (an approved Claude change runs as the person who approved it). */
  userId: string | null
  /** Their name in this business, or a plain word when no person is known. */
  by: string
  kind: ControlKind
  /** What was changed, in plain words: "Account level", "Engine: auto-bid", "Campaign: DE_Auto_Close". */
  what: string
  from: string | null
  to: string | null
}

const LEVEL_WORD: Record<string, string> = {
  OFF: 'Off', OBSERVE: 'Watch', SUGGEST: 'Ask me', PROPOSE: 'Ask me', AUTO: 'Auto',
}
const levelWord = (v: unknown): string | null => (typeof v === 'string' ? LEVEL_WORD[v.toUpperCase()] ?? v : null)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** One ads action log row (operator_autonomy) in plain words. Pure. */
export function actionLogChange(row: {
  id: string; createdAt: Date; userId: string | null; actionType: string; entityType: string | null; entityId: string | null
  payloadBefore: unknown; payloadAfter: unknown; evidence: unknown
}): Omit<ControlChange, 'by'> {
  const before = obj(row.payloadBefore)
  const after = obj(row.payloadAfter)
  const note = typeof obj(row.evidence).note === 'string' ? (obj(row.evidence).note as string) : null
  const base = { id: `a:${row.id}`, at: row.createdAt.toISOString(), userId: personOf(row.userId) }
  if (row.actionType === 'halt_automation') return { ...base, kind: 'stop', what: 'Stop now', from: 'Running', to: 'Stopped' }
  if (row.actionType === 'resume_automation') return { ...base, kind: 'start', what: 'Start again', from: 'Stopped', to: 'Running' }
  if (row.entityType === 'ADS_DIAL') {
    return { ...base, kind: 'account-level', what: 'Account level', from: levelWord(before.autonomy ?? before.level), to: levelWord(after.autonomy ?? after.level) }
  }
  if (row.actionType === 'tune_engine_setting' && row.entityId === 'breaker') {
    return { ...base, kind: 'brakes', what: 'Account brakes', from: brakesWords(before), to: brakesWords(after) }
  }
  if (row.actionType === 'set_rule_autonomy') {
    // The note is "<rule name> → <LEVEL>"; the level before is not stored on these rows.
    const name = note?.split(' → ')[0] ?? row.entityId ?? 'a rule'
    return { ...base, kind: 'rule-level', what: `Rule: ${name}`, from: null, to: levelWord(after.level) }
  }
  if (row.actionType === 'set_automation_level') {
    const name = note?.split(' → ')[0] ?? row.entityId ?? 'an automation'
    return { ...base, kind: 'automation-level', what: `Automation: ${name}`, from: levelWord(before.level), to: levelWord(after.level) }
  }
  return { ...base, kind: 'other', what: note ?? row.actionType, from: null, to: null }
}

/** One audit log row (an engine's level, a campaign's "Automation may change it") in plain words. Pure. */
export function auditLogChange(row: {
  id: string; createdAt: Date; userId: string | null; action: string; entityId: string; before: unknown; after: unknown; metadata: unknown
}, engineName: (key: string) => string): Omit<ControlChange, 'by'> {
  const before = obj(row.before)
  const after = obj(row.after)
  const base = { id: `l:${row.id}`, at: row.createdAt.toISOString(), userId: row.userId }
  if (row.action === 'set_live_writes') {
    const name = typeof obj(row.metadata).campaignName === 'string' ? (obj(row.metadata).campaignName as string) : row.entityId
    const yes = (v: unknown) => (v === true ? 'Yes' : v === false ? 'No' : null)
    return { ...base, kind: 'campaign-allowed', what: `Automation may change it: ${name}`, from: yes(before.liveBidWritesEnabled), to: yes(after.liveBidWritesEnabled) }
  }
  return { ...base, kind: 'engine-level', what: `Engine: ${engineName(row.entityId)}`, from: levelWord(before.mode), to: levelWord(after.mode) }
}

/** "250 actions/h · €500/h" — the breaker limits a row holds; null when it holds none. */
function brakesWords(v: Record<string, unknown>): string | null {
  // A null limit is the default (250 actions, €500 an hour).
  const actions = typeof v.maxActionsPerHour === 'number' ? `${v.maxActionsPerHour} actions/h` : 'maxActionsPerHour' in v ? 'actions: default' : null
  const spend = typeof v.maxHourlySpendCentsEur === 'number' ? `€${(v.maxHourlySpendCentsEur / 100).toLocaleString('en-GB')}/h` : 'maxHourlySpendCentsEur' in v ? 'spend: default' : null
  const parts = [actions, spend].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

/** The person's id from a `user:<id>` actor; none for anonymous, Claude by rule, a job or a cron. */
export function personOf(actor: string | null): string | null {
  if (!actor?.startsWith('user:')) return null
  const id = actor.slice(5)
  return id && id !== 'anonymous' && !id.startsWith('cron') ? id : null
}

/** Newest first, the last `days` days (7 unless named), at most `limit` rows (60 unless named, 200 at most). */
export async function listControlChanges(opts: { days?: number; limit?: number } = {}): Promise<{ rows: ControlChange[]; from: string }> {
  const days = Math.min(Math.max(Math.trunc(opts.days ?? 7), 1), 90)
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 60), 1), 200)
  const since = new Date(Date.now() - days * 86_400_000)
  const [actions, audits] = await Promise.all([
    prisma.advertisingActionLog.findMany({
      where: { createdAt: { gte: since }, evidence: { path: ['metric'], equals: 'operator_autonomy' } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, createdAt: true, userId: true, actionType: true, entityType: true, entityId: true, payloadBefore: true, payloadAfter: true, evidence: true },
    }),
    prisma.auditLog.findMany({
      where: { createdAt: { gte: since }, action: { in: ['set_engine_switch', 'set_live_writes'] } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, createdAt: true, userId: true, action: true, entityId: true, before: true, after: true, metadata: true },
    }),
  ])
  const { ENGINES } = await import('../automation/engine-switch.service.js')
  const engineName = (key: string) => (ENGINES as Record<string, { name?: string }>)[key]?.name ?? key
  const merged = [
    ...actions.map(actionLogChange),
    ...audits.map((a) => auditLogChange(a, engineName)),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit)

  const ids = [...new Set(merged.map((r) => r.userId).filter((v): v is string => !!v))]
  const people = ids.length
    ? await prisma.userProfile.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, displayName: true } }).catch(() => [])
    : []
  const nameOf = new Map(people.map((p) => [p.id, p.displayName?.trim() || p.email || p.id]))
  return {
    from: since.toISOString(),
    rows: merged.map((r) => ({ ...r, by: r.userId ? nameOf.get(r.userId) ?? 'A person' : 'Nexus (no person recorded)' })),
  }
}
