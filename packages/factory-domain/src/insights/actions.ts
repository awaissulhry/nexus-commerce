import type { Issue } from '../core/errors'
import type { Actor, Permission } from '../core/permissions'
import { ATTENTION_KINDS, type AttentionItem, type AttentionKind, type AttentionScope } from './attention'
import { FLOW_LENSES, type FlowLens } from './flow'

/**
 * Acting on Today's alerts (B-W1-52 actions; ANA-037; design home.today needs-me: "alert → Acknowledge · Assign ·
 * Resolve", "Handled today", popups assign, resolve-note and arrange; build HANDOFF "Later schema list › Home attention
 * actions"). Today's rows are computed from the records (insights/attention); what people do about one is stored per
 * row key (factory-db insights.prisma AttentionAction) with the row's CONDITION (attention conditionOf):
 *
 *   ASSIGN       to a person who may act on the row (the same rule as the list: actingPermission, for them), or back to
 *                nobody. It holds until the row is resolved or assigned again; the row stays on everyone's Today, marked
 *                "Assigned to <name>".
 *   RESOLVE      with a note saying what was done: the row leaves Today for everyone until its condition changes (and
 *                comes back then, unassigned). The design: "the alert closes for everyone it went to".
 *   ACKNOWLEDGE  "I have seen it": the row stays, marked, while its condition holds.
 *
 *   SNOOZE       (W2a, B-W2a-20; design home.today popup snooze "Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick a
 *                date · Until something changes on the record"): the row leaves Today for everyone until that time, or
 *                (no time) until its condition changes; like an acknowledgement it is the row's, not one person's. It is
 *                not a decision: "Handled today" does not count it.
 *
 * Only alerts take these verbs: an approval or a mail is decided in its own review (Approve · Reject, Sort), never closed
 * from Today. Who may act is never stored: the API asks actingPermission at every action, for the person
 * acting and for the assignee, and a person never acts on a row they could not see (it is not on their Today: 404).
 */

export const ACTION_VERBS = ['ASSIGN', 'RESOLVE', 'ACKNOWLEDGE'] as const
export type ActionVerb = (typeof ACTION_VERBS)[number]

/** The history's verbs (factory-db AttentionVerb). */
export const LOG_VERBS = ['ASSIGNED', 'UNASSIGNED', 'RESOLVED', 'ACKNOWLEDGED', 'SNOOZED'] as const
export type LogVerb = (typeof LOG_VERBS)[number]

/** A resolve note: what was done, in words (the same bounds as a rejection's reason). */
export const NOTE_MIN = 3
export const NOTE_MAX = 1000

/** A row key: `<kind>:<record id>[:<sub key>]` (attention rowKeyOf). */
const ROW_KEY = /^([A-Z][A-Z_]*):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([A-Za-z0-9._:-]{1,120}))?$/
/** A condition: 32 hex characters (attention conditionOf). */
export const CONDITION = /^[0-9a-f]{32}$/

/** The kind, record id and sub key of a row key, or null for a key that is not one. */
export function parseRowKey(key: string): { readonly kind: AttentionKind; readonly recordId: string; readonly subKey: string | null } | null {
  const match = key.length <= 200 ? ROW_KEY.exec(key) : null
  if (!match || !(ATTENTION_KINDS as readonly string[]).includes(match[1]!)) return null
  return { kind: match[1] as AttentionKind, recordId: match[2]!, subKey: match[3] ?? null }
}

/** What is stored about a row (factory-db AttentionAction), as the rules read it. */
export interface StoredAction {
  readonly id: string
  readonly rowKey: string
  readonly version: number
  readonly assignedToId: string | null
  readonly assignedById: string | null
  readonly assignedAt: Date | null
  readonly resolvedCondition: string | null
  readonly resolvedById: string | null
  readonly resolvedAt: Date | null
  readonly acknowledgedCondition: string | null
  readonly acknowledgedById: string | null
  readonly acknowledgedAt: Date | null
  /** W2a: the condition it was snoozed in, by whom, when, and until when (null: until the condition changes). */
  readonly snoozedCondition?: string | null
  readonly snoozedById?: string | null
  readonly snoozedAt?: Date | null
  readonly snoozedUntil?: Date | null
}

/** A row's actions as the reader gets them. */
export interface RowActions {
  /** The row's condition (send it back with an action: a row that changed meanwhile is refused). */
  readonly condition: string
  /** The stored version (0: nothing stored yet; send it back with an action). */
  readonly version: number
  /** What the reader may do to it now. */
  readonly verbs: readonly ActionVerb[]
  readonly assigned: { readonly toId: string; readonly byId: string; readonly at: Date } | null
  /** Acknowledged in this condition. */
  readonly acknowledged: { readonly byId: string; readonly at: Date } | null
  /** W2a: whether the reader may snooze it (an alert); snoozed rows are not on Today. */
  readonly snoozable: boolean
}

/** Whether a row takes the alert verbs (an approval or a mail is decided in its own review). */
export const takesActions = (item: Pick<AttentionItem, 'category'>): boolean => item.category === 'ALERT'

/** Resolved in the row's present condition: it is not on Today. */
export const isResolved = (item: Pick<AttentionItem, 'condition'>, stored: StoredAction | undefined): boolean => stored?.resolvedCondition === item.condition

/**
 * Snoozed now: snoozed in the row's present condition, until a time not yet come or until the condition changes (no
 * time). A row whose condition moved comes back at once.
 */
export const isSnoozed = (item: Pick<AttentionItem, 'condition'>, stored: StoredAction | undefined, now: Date): boolean =>
  !!stored?.snoozedAt && stored.snoozedCondition === item.condition && (stored.snoozedUntil == null || stored.snoozedUntil.getTime() > now.getTime())

/** The row's actions for its reader (every row on Today is one its reader may act on). */
export function rowActionsOf(item: Pick<AttentionItem, 'condition' | 'category'>, stored: StoredAction | undefined): RowActions {
  const acknowledged = stored && stored.acknowledgedCondition === item.condition && stored.acknowledgedById && stored.acknowledgedAt ? { byId: stored.acknowledgedById, at: stored.acknowledgedAt } : null
  const assigned = stored && stored.assignedToId && stored.assignedById && stored.assignedAt ? { toId: stored.assignedToId, byId: stored.assignedById, at: stored.assignedAt } : null
  const verbs: ActionVerb[] = takesActions(item) ? ['ASSIGN', 'RESOLVE', ...(acknowledged ? [] : (['ACKNOWLEDGE'] as const))] : []
  return { condition: item.condition, version: stored?.version ?? 0, verbs, assigned, acknowledged, snoozable: takesActions(item) }
}

/**
 * The rows still on Today (a row resolved in its present condition is not; nor one snoozed now, W2a), each with its
 * actions. Without `now` no snooze is applied (a caller that knows none).
 */
export function withActions<Item extends AttentionItem>(items: readonly Item[], stored: ReadonlyMap<string, StoredAction>, now?: Date): { readonly items: (Item & { readonly actions: RowActions })[]; readonly resolved: number; readonly snoozed: number } {
  const open: (Item & { readonly actions: RowActions })[] = []
  let resolved = 0
  let snoozed = 0
  for (const item of items) {
    const action = stored.get(item.key)
    if (isResolved(item, action)) {
      resolved += 1
      continue
    }
    if (now !== undefined && isSnoozed(item, action, now)) {
      snoozed += 1
      continue
    }
    open.push({ ...item, actions: rowActionsOf(item, action) })
  }
  return { items: open, resolved, snoozed }
}

// ---- Snooze (W2a; design home.today popup snooze) ----------------------------------------------------------------------

/** A snooze reaches at most this far ahead. */
export const SNOOZE_MAX_DAYS = 90

/** Why the row cannot be snoozed as it is now (null: it can); the time is checked apart (snoozeTimeProblem). */
export function snoozeRefusal(item: Pick<AttentionItem, 'condition' | 'category'>, stored: StoredAction | undefined, sent: { readonly condition: string }): ActionRefusal | null {
  if (!takesActions(item)) return 'NOT_AN_ALERT'
  if (sent.condition !== item.condition) return 'CHANGED'
  if (isResolved(item, stored)) return 'ALREADY_RESOLVED'
  return null
}

/** What is wrong with a snooze until this time (null: nothing; a null time is "until something changes on the record"). */
export function snoozeTimeProblem(until: Date | null, now: Date): string | null {
  if (until === null) return null
  if (until.getTime() <= now.getTime()) return 'Snooze until a later time.'
  if (until.getTime() - now.getTime() > SNOOZE_MAX_DAYS * 86_400_000) return `Snooze for at most ${SNOOZE_MAX_DAYS} days.`
  return null
}

/** The refusal codes of an action, in words for the person (the API answers 409 with them). */
export const ACTION_REFUSALS = {
  NOT_AN_ALERT: 'This row is an approval or a mail: decide it in its review, not here.',
  ALREADY_RESOLVED: 'Someone resolved this row meanwhile: it is off Today until its condition changes.',
  CHANGED: 'This row changed since you read it. Read Today again and decide on what it says now.',
  ALREADY_ACKNOWLEDGED: 'This row is acknowledged already.',
  ALREADY_ASSIGNED: 'This row is assigned to this person already.',
  NOT_ASSIGNED: 'This row is not assigned to anyone.',
} as const
export type ActionRefusal = keyof typeof ACTION_REFUSALS

/** Why this action cannot be done to the row as it is now (null: it can). The note and the assignee are checked apart. */
export function actionRefusal(
  verb: ActionVerb,
  item: Pick<AttentionItem, 'condition' | 'category'>,
  stored: StoredAction | undefined,
  sent: { readonly condition: string; readonly assigneeId?: string | null },
): ActionRefusal | null {
  if (!takesActions(item)) return 'NOT_AN_ALERT'
  if (sent.condition !== item.condition) return 'CHANGED'
  if (isResolved(item, stored)) return 'ALREADY_RESOLVED'
  if (verb === 'ACKNOWLEDGE' && stored?.acknowledgedCondition === item.condition) return 'ALREADY_ACKNOWLEDGED'
  if (verb === 'ASSIGN') {
    const current = stored?.assignedToId ?? null
    if (sent.assigneeId === null && current === null) return 'NOT_ASSIGNED'
    if (sent.assigneeId !== null && sent.assigneeId === current) return 'ALREADY_ASSIGNED'
  }
  return null
}

/** What is wrong with a resolve note (null: nothing). */
export function resolveNoteProblem(note: string): string | null {
  const text = note.trim()
  if (text.length < NOTE_MIN) return `Say what was done, in at least ${NOTE_MIN} characters.`
  if (text.length > NOTE_MAX) return `Keep the note to ${NOTE_MAX} characters.`
  return null
}

/**
 * The person a row may be assigned to was "responsible" for it when one of their grants that acts on it names the row's
 * site, or its company without being over every company (the design: "who is responsible for this site or line
 * suggested first").
 */
export function responsibleFor(person: Actor, act: Permission, scope: AttentionScope): boolean {
  return person.grants.some((grant) => {
    if (!grant.permissions.includes(act)) return false
    if (scope.siteId !== null && Array.isArray(grant.sites)) return (grant.sites as readonly string[]).includes(scope.siteId)
    if (scope.companyId !== null && Array.isArray(grant.companies)) return (grant.companies as readonly string[]).includes(scope.companyId)
    return false
  })
}

// ---- "Arrange Today" (popup arrange: PreferencesModal + SectionLayout, saved on the server per person) -------------------

/** The page's sections that a person orders and hides (W1). "Needs me now" is never hidden. */
export const TODAY_SECTIONS = ['focus-strip', 'needs-me', 'flow', 'role-panels'] as const
export type TodaySection = (typeof TODAY_SECTIONS)[number]
export const FIXED_SECTIONS: readonly TodaySection[] = Object.freeze(['needs-me'])

/** A "My lists" panel's width: half, two thirds or the whole row. */
export const PANEL_WIDTHS = ['HALF', 'TWO_THIRDS', 'FULL'] as const
export type PanelWidth = (typeof PANEL_WIDTHS)[number]

/** A panel's id: the web names its panels (`lateOrders`, `quotesToApprove` …). */
export const PANEL_ID = /^[a-z][A-Za-z0-9-]{0,63}$/
export const MAX_PANELS = 60

export interface TodayLayout {
  readonly sections: readonly { readonly id: TodaySection; readonly hidden: boolean }[]
  readonly panels: readonly { readonly id: string; readonly hidden: boolean; readonly width: PanelWidth }[]
  /** The lens the flow strip opens on ("My main role"); null: the first the person has. */
  readonly mainLens: FlowLens | null
}

/** Before a person arranges it: every section shown in the design's order, the web's own panel order, no main lens. */
export const DEFAULT_LAYOUT: TodayLayout = Object.freeze({
  sections: Object.freeze(TODAY_SECTIONS.map((id) => Object.freeze({ id, hidden: false }))),
  panels: Object.freeze([]),
  mainLens: null,
})

/** What is wrong with a layout as sent (empty: nothing). */
export function layoutProblems(layout: { readonly sections: readonly { readonly id: string; readonly hidden: boolean }[]; readonly panels: readonly { readonly id: string; readonly hidden: boolean; readonly width: string }[]; readonly mainLens: string | null }): Issue[] {
  const problems: Issue[] = []
  const seen = new Set<string>()
  layout.sections.forEach((section, index) => {
    const path = `body/sections/${index}`
    if (!(TODAY_SECTIONS as readonly string[]).includes(section.id)) problems.push({ path: `${path}/id`, message: `Not a section of Today (${TODAY_SECTIONS.join(', ')}).` })
    else if (seen.has(section.id)) problems.push({ path: `${path}/id`, message: 'This section is listed twice.' })
    else if (section.hidden && (FIXED_SECTIONS as readonly string[]).includes(section.id)) problems.push({ path: `${path}/hidden`, message: '"Needs me now" is always shown.' })
    seen.add(section.id)
  })
  if (layout.panels.length > MAX_PANELS) problems.push({ path: 'body/panels', message: `At most ${MAX_PANELS} panels.` })
  const panels = new Set<string>()
  layout.panels.forEach((panel, index) => {
    const path = `body/panels/${index}`
    if (!PANEL_ID.test(panel.id)) problems.push({ path: `${path}/id`, message: 'Not a panel id.' })
    else if (panels.has(panel.id)) problems.push({ path: `${path}/id`, message: 'This panel is listed twice.' })
    if (!(PANEL_WIDTHS as readonly string[]).includes(panel.width)) problems.push({ path: `${path}/width`, message: `A width is ${PANEL_WIDTHS.join(', ')}.` })
    panels.add(panel.id)
  })
  if (layout.mainLens !== null && !(FLOW_LENSES as readonly string[]).includes(layout.mainLens)) problems.push({ path: 'body/mainLens', message: `Not a lens (${FLOW_LENSES.join(', ')}).` })
  return problems
}

/**
 * A layout as stored, read leniently (it may come from an older page): unknown sections and malformed panels are left
 * out, the sections it does not list follow in the design's order, "Needs me now" is shown.
 */
export function layoutOf(stored: { readonly sections: unknown; readonly panels: unknown; readonly mainLens: string | null } | null): TodayLayout {
  if (stored === null) return DEFAULT_LAYOUT
  const sections: { id: TodaySection; hidden: boolean }[] = []
  for (const entry of Array.isArray(stored.sections) ? (stored.sections as unknown[]) : []) {
    const value = entry as { id?: unknown; hidden?: unknown } | null
    if (!value || !(TODAY_SECTIONS as readonly unknown[]).includes(value.id) || sections.some((section) => section.id === value.id)) continue
    const id = value.id as TodaySection
    sections.push({ id, hidden: value.hidden === true && !FIXED_SECTIONS.includes(id) })
  }
  for (const id of TODAY_SECTIONS) if (!sections.some((section) => section.id === id)) sections.push({ id, hidden: false })
  const panels: { id: string; hidden: boolean; width: PanelWidth }[] = []
  for (const entry of Array.isArray(stored.panels) ? (stored.panels as unknown[]) : []) {
    const value = entry as { id?: unknown; hidden?: unknown; width?: unknown } | null
    if (!value || typeof value.id !== 'string' || !PANEL_ID.test(value.id) || panels.some((panel) => panel.id === value.id) || panels.length >= MAX_PANELS) continue
    panels.push({ id: value.id, hidden: value.hidden === true, width: (PANEL_WIDTHS as readonly unknown[]).includes(value.width) ? (value.width as PanelWidth) : 'HALF' })
  }
  const mainLens = stored.mainLens !== null && (FLOW_LENSES as readonly string[]).includes(stored.mainLens) ? (stored.mainLens as FlowLens) : null
  return { sections, panels, mainLens }
}

/** A layout as sent, in the stored shape: every section once (the unlisted ones after, in the design's order). */
export function layoutToStore(layout: { readonly sections: readonly { readonly id: string; readonly hidden: boolean }[]; readonly panels: readonly { readonly id: string; readonly hidden: boolean; readonly width: string }[]; readonly mainLens: string | null }): TodayLayout {
  return layoutOf({ sections: layout.sections, panels: layout.panels, mainLens: layout.mainLens })
}
