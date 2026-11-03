import type { Issue } from '../../core/errors'
import { businessDayStart, type BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'

/**
 * Corrective actions, CAPA and 8D (B-W2b-108; QHS-087 escalate to CAPA, QHS-093 the CAPA record, QHS-094 the 8D report,
 * QHS-096 actions with reminders and escalation; design quality.capa SCR-146, its popups capa-new and capa-action, and
 * ncr-capa on the NCR page), pure: the stages of each type, what a close needs, the shape of what a CAPA and an action
 * say, when an action is reminded and when it escalates, why a record is worth escalating, and the words of the reminder
 * and escalation tasks. apps/factory-api's modules/quality/capa writes them; the …_quality_problems_w2b_guards triggers
 * hold the same rules for every login (capa.prisma). Root cause, effectiveness and staged approval are W3: nothing here.
 *
 * Stages: a CAPA goes PLAN → ACT → CHECK, an 8D D1 … D8; inside its own stages a record moves either way (a team goes back
 * from D5 to D4) and may skip; it closes only from its last stage, once at least one action is done and none is open; it
 * is cancelled from any stage (raised by mistake). CLOSED and CANCELLED never change.
 *
 * Reminders (through tasks, COL-037): an open action is reminded REMINDER_DAYS_BEFORE its due day (3 days before, and on
 * the day), from REMINDER_HOUR o'clock in Rome; each moment once (a reminder sent after a moment covers it: an action made
 * two days before its due day gets one reminder, not two). Moving the due day later brings the moments of the new day.
 * Escalation: once, when the action is overdue (the day after its due day began) plus the waiting time of the company's
 * CAPA_ACTION_OVERDUE rule (QualityAlertRule.withinMinutes; 0 at once), to the action's escalation path, else the rule's
 * audience (the API reads both).
 */

export const CAPA_RECORD = 'Capa'
export const ACTION_RECORD = 'CapaAction'

export const CAPA_TYPES = ['CAPA', 'EIGHT_D'] as const
export type CapaType = (typeof CAPA_TYPES)[number]

export const CAPA_PRIORITIES = ['LOW', 'NORMAL', 'HIGH'] as const
export type CapaPriority = (typeof CAPA_PRIORITIES)[number]

export const CAPA_STATUSES = ['PLAN', 'ACT', 'CHECK', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'CLOSED', 'CANCELLED'] as const
export type CapaStatus = (typeof CAPA_STATUSES)[number]

export const ACTION_KINDS = ['CORRECTIVE', 'PREVENTIVE'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]

export const ACTION_STATUSES = ['OPEN', 'DONE', 'CANCELLED'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

/** What a CAPA comes from. The table also takes an Audit, which has no table yet: the API offers none. */
export const SOURCE_TYPES = ['Nonconformance', 'Complaint'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/** The list's saved rows (design capa-metrics and capa-grid): open (default), mine, overdue (an action overdue), closed, cancelled, all. */
export const CAPA_VIEWS = ['open', 'mine', 'overdue', 'closed', 'cancelled', 'all'] as const
export type CapaView = (typeof CAPA_VIEWS)[number]

/** The stages of each type, in order. */
export const STAGES: Readonly<Record<CapaType, readonly CapaStatus[]>> = Object.freeze({
  CAPA: Object.freeze(['PLAN', 'ACT', 'CHECK'] as const),
  EIGHT_D: Object.freeze(['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'] as const),
})

export const firstStage = (type: CapaType): CapaStatus => STAGES[type][0]!
export const lastStage = (type: CapaType): CapaStatus => STAGES[type][STAGES[type].length - 1]!
export const isFinal = (status: CapaStatus): boolean => status === 'CLOSED' || status === 'CANCELLED'
export const isStageOf = (type: CapaType, status: string): status is CapaStatus => (STAGES[type] as readonly string[]).includes(status)

/** The stage after this one inside its type (null: the last stage, or an ended record). */
export function nextStage(type: CapaType, status: CapaStatus): CapaStatus | null {
  const stages = STAGES[type]
  const at = stages.indexOf(status)
  return at < 0 || at === stages.length - 1 ? null : stages[at + 1]!
}

/** The API's own words for a status (the screens say them in their language). */
export const STATUS_WORDS: Readonly<Record<CapaStatus, string>> = Object.freeze({
  PLAN: 'Plan',
  ACT: 'Act',
  CHECK: 'Check',
  D1: 'D1 team',
  D2: 'D2 problem',
  D3: 'D3 containment',
  D4: 'D4 root cause',
  D5: 'D5 corrective actions',
  D6: 'D6 actions in place',
  D7: 'D7 prevention',
  D8: 'D8 closure',
  CLOSED: 'closed',
  CANCELLED: 'cancelled',
})

export const typeWords = (type: CapaType): string => (type === 'EIGHT_D' ? '8D' : 'CAPA')

export const CAPA_LIMITS = Object.freeze({
  title: 200,
  problem: 2000,
  teamRole: 60,
  team: 20,
  description: 2000,
  note: 500,
  evidence: 4000,
  reason: 1000,
  closeNote: 4000,
  /** Sources named in one request, actions per CAPA. */
  sources: 50,
  actions: 100,
  listDefault: 50,
  list: 200,
  /** The escalation preview's records. */
  preview: 50,
})

/** The changed fields capa.changed names. */
export const CAPA_CHANGED_FIELDS = ['title', 'ownerId', 'team', 'dueOn', 'priority', 'customerId', 'problemWhat', 'problemWhere', 'problemWhen', 'problemHowMany'] as const
export type CapaChangedField = (typeof CAPA_CHANGED_FIELDS)[number]

export const ACTION_CHANGES = ['ADDED', 'CHANGED', 'DONE', 'CANCELLED'] as const
export type ActionChange = (typeof ACTION_CHANGES)[number]

export const SOURCE_CHANGES = ['ADDED', 'REMOVED'] as const
export type SourceChange = (typeof SOURCE_CHANGES)[number]

/** The day N days after (before, when negative) a business date. */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  const at = new Date(`${date}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

// ---- the record's shape -----------------------------------------------------------------------------------------------

export interface TeamMember {
  readonly userId: string
  readonly role: string
}

const blank = (value: string | null | undefined): boolean => value !== null && value !== undefined && value.trim() === ''
const tooLong = (value: string | null | undefined, max: number): boolean => value !== null && value !== undefined && value.trim().length > max

/** D1, the team: each person once, a role in words each, at most CAPA_LIMITS.team. */
export function teamProblems(team: readonly TeamMember[], path = 'team'): Issue[] {
  const problems: Issue[] = []
  if (team.length > CAPA_LIMITS.team) problems.push({ path, message: `At most ${CAPA_LIMITS.team} people in the team.` })
  const seen = new Set<string>()
  for (const [index, member] of team.entries()) {
    if (seen.has(member.userId)) problems.push({ path: `${path}/${index}/userId`, message: 'Each person once in the team.' })
    seen.add(member.userId)
    if (member.role.trim() === '') problems.push({ path: `${path}/${index}/role`, message: "Say the person's role in the team (lead, quality, production …)." })
    else if (member.role.trim().length > CAPA_LIMITS.teamRole) problems.push({ path: `${path}/${index}/role`, message: `A role in at most ${CAPA_LIMITS.teamRole} characters.` })
  }
  return problems
}

export interface CapaDraft {
  readonly title?: string | undefined
  readonly dueOn?: BusinessDate | undefined
  readonly problemWhat?: string | null | undefined
  readonly problemWhere?: string | null | undefined
  readonly problemWhen?: string | null | undefined
  readonly problemHowMany?: string | null | undefined
}

/** What a CAPA says, checked: a title, a due day (not before today when it is opened), the problem's words not blank when given. */
export function capaDraftProblems(draft: CapaDraft, opening: boolean, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  if (opening ? !draft.title?.trim() : draft.title !== undefined && draft.title.trim() === '') problems.push({ path: 'title', message: 'Say in a few words what the CAPA is about.' })
  else if (tooLong(draft.title, CAPA_LIMITS.title)) problems.push({ path: 'title', message: `A title in at most ${CAPA_LIMITS.title} characters.` })
  if (opening && !draft.dueOn) problems.push({ path: 'dueOn', message: 'When it is due.' })
  else if (opening && draft.dueOn && draft.dueOn < today) problems.push({ path: 'dueOn', message: 'A new CAPA is due today or later.' })
  for (const field of ['problemWhat', 'problemWhere', 'problemWhen', 'problemHowMany'] as const) {
    if (blank(draft[field])) problems.push({ path: field, message: 'Leave it empty, or say it in words.' })
    else if (tooLong(draft[field], CAPA_LIMITS.problem)) problems.push({ path: field, message: `At most ${CAPA_LIMITS.problem} characters.` })
  }
  return problems
}

export interface ActionDraft {
  readonly description?: string | undefined
  readonly dueOn?: BusinessDate | undefined
}

/** What an action says, checked: what to do, by when (today or later when it is added). */
export function actionDraftProblems(draft: ActionDraft, adding: boolean, today: BusinessDate): Issue[] {
  const problems: Issue[] = []
  if (adding ? !draft.description?.trim() : draft.description !== undefined && draft.description.trim() === '') problems.push({ path: 'description', message: 'Say what to do.' })
  else if (tooLong(draft.description, CAPA_LIMITS.description)) problems.push({ path: 'description', message: `At most ${CAPA_LIMITS.description} characters.` })
  if (adding && !draft.dueOn) problems.push({ path: 'dueOn', message: 'By when it is due.' })
  else if (adding && draft.dueOn && draft.dueOn < today) problems.push({ path: 'dueOn', message: 'A new action is due today or later.' })
  return problems
}

// ---- stages and the close -----------------------------------------------------------------------------------------------

export type CloseCheckKey = 'LAST_STAGE' | 'ACTION_DONE' | 'NO_OPEN_ACTION'

export interface CloseCheck {
  readonly key: CloseCheckKey
  readonly ok: boolean
  /** Our words when it is not met (the screens say them in their language by the key). */
  readonly words: string
}

export interface CloseFacts {
  readonly type: CapaType
  readonly status: CapaStatus
  readonly actions: readonly { readonly status: ActionStatus }[]
}

/** What a close needs (the guard reads the same at the UPDATE): the last stage, at least one action done, none open. */
export function closeChecks(facts: CloseFacts): CloseCheck[] {
  const last = lastStage(facts.type)
  const open = facts.actions.filter((action) => action.status === 'OPEN').length
  return [
    { key: 'LAST_STAGE', ok: facts.status === last, words: `${facts.type === 'EIGHT_D' ? 'An 8D' : 'A CAPA'} closes from ${STATUS_WORDS[last]}: move it there first.` },
    { key: 'ACTION_DONE', ok: facts.actions.some((action) => action.status === 'DONE'), words: 'No action is done yet: it closes with at least one action done.' },
    { key: 'NO_OPEN_ACTION', ok: open === 0, words: `${open === 1 ? 'One action is' : `${open} actions are`} still open: finish or cancel ${open === 1 ? 'it' : 'them'} first.` },
  ]
}

export const allMet = (checks: readonly { readonly ok: boolean }[]): boolean => checks.every((check) => check.ok)

/** A move inside its own stages, in words when it is refused (null: allowed). */
export function moveProblem(type: CapaType, from: CapaStatus, to: string): string | null {
  if (isFinal(from)) return `The ${typeWords(type)} is ${STATUS_WORDS[from]}: it never changes.`
  if (to === 'CLOSED' || to === 'CANCELLED') return 'Close or cancel it with its own step (a closing note, or the reason).'
  if (!isStageOf(type, to)) return `${type === 'EIGHT_D' ? 'An 8D' : 'A CAPA'} moves through ${STAGES[type].join(', ')} only.`
  if (to === from) return `It is at ${STATUS_WORDS[from]} already.`
  return null
}

// ---- reminders and escalation (QHS-096) ---------------------------------------------------------------------------------

/** Days before the due day an open action is reminded: 3 days before, and on the day. */
export const REMINDER_DAYS_BEFORE = Object.freeze([3, 0] as const)
/** From this hour (Rome) on its day a reminder goes out. */
export const REMINDER_HOUR = 7
/** No action is reminded more often than this (a due day moved again and again). */
export const MAX_REMINDERS = 20
/** How far ahead the reminders' cron looks for due days. */
export const REMIND_LOOK_AHEAD_DAYS = Math.max(...REMINDER_DAYS_BEFORE)

export interface RemindedAction {
  readonly status: ActionStatus
  readonly dueOn: BusinessDate
  readonly remindersSent: number
  readonly lastRemindedAt: Date | null
}

/** The moments an action is reminded, earliest first. */
export function reminderMoments(dueOn: BusinessDate): Date[] {
  return [...REMINDER_DAYS_BEFORE].sort((a, b) => b - a).map((days) => new Date(businessDayStart(addDays(dueOn, -days)).getTime() + REMINDER_HOUR * 3_600_000))
}

/** The reminder moment due now (the latest one not yet covered by a reminder), or null. */
export function reminderDue(action: RemindedAction, now: Date): Date | null {
  if (action.status !== 'OPEN' || action.remindersSent >= MAX_REMINDERS) return null
  const due = reminderMoments(action.dueOn).filter((moment) => moment.getTime() <= now.getTime() && (action.lastRemindedAt === null || action.lastRemindedAt.getTime() < moment.getTime()))
  return due.length === 0 ? null : due[due.length - 1]!
}

/** When an action becomes overdue: the start (Rome) of the day after its due day. */
export const overdueFrom = (dueOn: BusinessDate): Date => businessDayStart(addDays(dueOn, 1))

/** Open and its due day is behind us. */
export const isOverdue = (action: { readonly status: ActionStatus; readonly dueOn: BusinessDate }, today: BusinessDate): boolean => action.status === 'OPEN' && action.dueOn < today

/** When an open, overdue action escalates (once): overdue plus the rule's waiting time; null: not (yet). */
export function escalationDue(action: { readonly status: ActionStatus; readonly dueOn: BusinessDate; readonly escalatedAt: Date | null }, withinMinutes: number, now: Date): Date | null {
  if (action.status !== 'OPEN' || action.escalatedAt !== null) return null
  const at = new Date(overdueFrom(action.dueOn).getTime() + Math.max(0, withinMinutes) * 60_000)
  return now.getTime() >= at.getTime() ? at : null
}

// ---- why escalate (ncr-capa: "the rule that suggested it") --------------------------------------------------------------

export const ESCALATION_REASONS = ['CRITICAL', 'REPEAT_DEFECT', 'CUSTOMER', 'SAFETY'] as const
export type EscalationReason = (typeof ESCALATION_REASONS)[number]

/** A repeat: the same library defect (on the same style, when the NCR names one) in another NCR within these days. */
export const REPEAT_DAYS = 180

export const REASON_WORDS: Readonly<Record<DocumentLanguage, Readonly<Record<EscalationReason, string>>>> = Object.freeze({
  it: { CRITICAL: 'Critica', REPEAT_DEFECT: 'Difetto ripetuto', CUSTOMER: 'Reclamo del cliente', SAFETY: 'Sicurezza' },
  en: { CRITICAL: 'Critical', REPEAT_DEFECT: 'Repeat defect', CUSTOMER: 'Customer complaint', SAFETY: 'Safety' },
})

/** Why an NCR is worth a CAPA: critical, a repeat of its defect, found by or about a customer. */
export function ncrReasons(facts: { readonly severity: string; readonly source: string; readonly repeats: number }): EscalationReason[] {
  const reasons: EscalationReason[] = []
  if (facts.severity === 'CRITICAL') reasons.push('CRITICAL')
  if (facts.repeats > 0) reasons.push('REPEAT_DEFECT')
  if (facts.source === 'COMPLAINT' || facts.source === 'RETURN') reasons.push('CUSTOMER')
  return reasons
}

/** Why a complaint is worth a CAPA: it is a customer's; a safety one above all. */
export function complaintReasons(facts: { readonly category: string | null }): EscalationReason[] {
  return facts.category === 'SAFETY' ? ['CUSTOMER', 'SAFETY'] : ['CUSTOMER']
}

// ---- the reminder and escalation tasks (COL-037) ------------------------------------------------------------------------

export interface TaskFacts {
  readonly number: string
  readonly seq: number
  readonly description: string
  readonly dueOn: BusinessDate
  /** The action's owner, by name (an office person, inside the CAPA). */
  readonly ownerName: string | null
}

const TASK_WORDS = {
  it: {
    reminder: (facts: TaskFacts) => `Promemoria: azione ${facts.seq} di ${facts.number} entro il ${formatDate(facts.dueOn, 'it')}`,
    escalation: (facts: TaskFacts) => `In ritardo: azione ${facts.seq} di ${facts.number} (scaduta il ${formatDate(facts.dueOn, 'it')})`,
    owner: 'Responsabile',
    body: 'Da fare',
    evidence: "Registra l'azione come fatta nella CAPA, con la prova (una nota o un file).",
    escalated: "L'azione è scaduta e non è stata registrata come fatta: segui con il responsabile.",
  },
  en: {
    reminder: (facts: TaskFacts) => `Reminder: action ${facts.seq} of ${facts.number} due ${formatDate(facts.dueOn, 'en')}`,
    escalation: (facts: TaskFacts) => `Overdue: action ${facts.seq} of ${facts.number} (due ${formatDate(facts.dueOn, 'en')})`,
    owner: 'Owner',
    body: 'To do',
    evidence: 'Record the action done in the CAPA, with its evidence (a note or a file).',
    escalated: 'The action is overdue and not recorded done: follow it up with its owner.',
  },
} as const

const TITLE_MAX = 200
const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
export const taskLanguageOf = (locale: string | null | undefined): DocumentLanguage => (locale === 'en' ? 'en' : 'it')

/** The reminder task of an action, in its owner's language. */
export function reminderTask(language: DocumentLanguage, facts: TaskFacts): { title: string; description: string } {
  const words = TASK_WORDS[language]
  return { title: clip(words.reminder(facts), TITLE_MAX), description: clip(`${words.body}: ${facts.description.trim()}\n\n${words.evidence}`, 4000) }
}

/** The escalation task of an overdue action, in its reader's language. */
export function escalationTask(language: DocumentLanguage, facts: TaskFacts): { title: string; description: string } {
  const words = TASK_WORDS[language]
  const owner = facts.ownerName ? `\n${words.owner}: ${facts.ownerName}` : ''
  return { title: clip(words.escalation(facts), TITLE_MAX), description: clip(`${words.body}: ${facts.description.trim()}${owner}\n\n${words.escalated}`, 4000) }
}
