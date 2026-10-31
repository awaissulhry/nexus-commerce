/**
 * Kit staging (B-W2b-15; SCM-213; design warehouse.picking pk-grid "kit location", pop:pk-list "Kit complete check" and
 * "Mark kit complete (held while lines are short)"), pure. A work order's kit is the material picked for it, waiting at
 * one place of its site until the cutters take it: ONE kit record per work order (factory-db WorkOrderKit, its id the work
 * order's): where it is staged, and whether a person checked it complete. What was picked is the ledger's (the ISSUE moves
 * the floor's scans and the office post: OPEN, PARTLY, COMPLETE from the picks); the check is a person's word on top of it.
 *
 *   stage     put the kit at a place of the site (any location in use but a workshop's), or take it off (no place);
 *   complete  the kit is checked complete: held while a line is still short (or the work order plans no material);
 *   reopen    a kit checked complete is open again (something went missing, a line was given back).
 *
 * Only while the work order is picked for (RELEASED, IN_PROGRESS, ON_HOLD: a held work order keeps its kit). Never a
 * person's name in a list: the check keeps who and when (the record's), the screens say only when.
 */

export const KIT_ACTIONS = ['stage', 'complete', 'reopen'] as const
export type KitAction = (typeof KIT_ACTIONS)[number]

/** Why a kit action is held: the work order is not picked for, a line is short, nothing is planned, already (not) checked. */
export const KIT_HELD = ['WORK_ORDER_NOT_OPEN', 'LINES_SHORT', 'NOTHING_PLANNED', 'ALREADY_CHECKED', 'NOT_CHECKED'] as const
export type KitHeld = (typeof KIT_HELD)[number]

/** The work orders whose kit is staged and checked: the ones the floor picks for. */
export const KIT_WORK_ORDER_STATUSES = ['RELEASED', 'IN_PROGRESS', 'ON_HOLD'] as const
export const isKitWorkOrder = (status: string): boolean => (KIT_WORK_ORDER_STATUSES as readonly string[]).includes(status)

/** What a kit change was (the event's `change`). */
export const KIT_CHANGES = ['STAGED', 'UNSTAGED', 'COMPLETED', 'REOPENED'] as const
export type KitChange = (typeof KIT_CHANGES)[number]

/** The facts the actions read: the work order's state, its lines (planned materials) and the short ones, the check. */
export interface KitFacts {
  readonly workOrderStatus: string
  /** Planned materials of the work order (one per item and colour). */
  readonly lines: number
  /** Lines still short (issued below planned). */
  readonly short: number
  /** The kit was checked complete (and not opened again since). */
  readonly checked: boolean
}

export interface KitActionState {
  readonly allowed: boolean
  readonly held: KitHeld | null
  /** For LINES_SHORT: how many lines. */
  readonly count?: number
}

const allowed: KitActionState = { allowed: true, held: null }
const held = (code: KitHeld, count?: number): KitActionState => ({ allowed: false, held: code, ...(count === undefined ? {} : { count }) })

/** What a person may do with the kit now, each action allowed or held with why (the Owner's rule: held buttons say why). */
export function kitActions(facts: KitFacts): Readonly<Record<KitAction, KitActionState>> {
  if (!isKitWorkOrder(facts.workOrderStatus)) {
    const closed = held('WORK_ORDER_NOT_OPEN')
    return { stage: closed, complete: closed, reopen: closed }
  }
  const complete = facts.checked ? held('ALREADY_CHECKED') : facts.lines === 0 ? held('NOTHING_PLANNED') : facts.short > 0 ? held('LINES_SHORT', facts.short) : allowed
  return { stage: allowed, complete, reopen: facts.checked ? allowed : held('NOT_CHECKED') }
}

/** The refusal of a kit action in words (the API's 409 message; the screens say their own words from the code). */
export function kitHeldWords(code: KitHeld, facts: { readonly number: string; readonly status: string; readonly count?: number }): string {
  switch (code) {
    case 'WORK_ORDER_NOT_OPEN':
      return `Work order ${facts.number} is ${facts.status.toLowerCase().replace(/_/g, ' ')}: a kit is staged and checked while the work order is picked for (released, in progress or on hold).`
    case 'LINES_SHORT':
      return `${facts.count ?? 0} line(s) of work order ${facts.number} are still short: the kit is checked complete once every line is picked in full.`
    case 'NOTHING_PLANNED':
      return `Work order ${facts.number} plans no material: there is no kit to check.`
    case 'ALREADY_CHECKED':
      return `The kit of work order ${facts.number} is checked complete already.`
    case 'NOT_CHECKED':
      return `The kit of work order ${facts.number} is not checked complete: there is nothing to open again.`
  }
}

/** A place a kit may wait at: a location of the work order's site in use, not a workshop's (the WorkOrderKit trigger's rule). */
export function stagingProblem(location: { readonly siteId: string; readonly status: string; readonly kind: string } | null, siteId: string): string | null {
  if (!location || location.siteId !== siteId) return 'Not a location of the work order\'s site.'
  if (location.status === 'ARCHIVED') return 'That location is archived: a kit waits at a place in use.'
  if (location.kind === 'SUBCONTRACTOR') return 'That is a workshop\'s location: a kit waits at a place of the site.'
  return null
}
