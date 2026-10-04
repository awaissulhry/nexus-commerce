/**
 * Selling status — what the product sheet's **Status** column draws (sheet publish parity, build shape v2, Owner
 * 2026-10-04). Pure — no React — so the cell, the catalog, the editor and the tests share one rule.
 *
 * The column shows the LIVE selling state Nexus holds for one listing (`sellingStateOf`, @nexus/shared/listing-actions)
 * and, when someone changed it, the TARGET that waits for Publish:
 *  - Live: a Pill with a dot — Active = success; Inactive and Mixed = warning; Ended, Not listed and Unknown = neutral.
 *    One set of words (Owner 2026-10-04): Active · Inactive · Not listed · Ended (eBay, Shopify), Mixed when the
 *    variations differ; a draft (never sent) reads Not listed.
 *  - Waiting: the target as a toned Pill with a CLOCK glyph (Active = info, Inactive = warning, Ended = danger: it cannot
 *    be undone the same way), the live state beside it in small text ("now Active"). Who and when go in the tooltip and
 *    in the screen-reader sentence: "Status: Active. Inactive is waiting for Publish, set by Awais today 10:42."
 *  - Read-only: a draft or Not listed row the caller gives no `create` (a main product on the channel whose variations
 *    are not), or a cell the caller locks with a reason. A lock glyph; the reason in the tooltip and the sentence.
 *  - A waiting target the listing already reached says "No longer applies" (safety rule 5 of the combined plan).
 *  - New listings (Owner 2026-10-04): a row NOT on the channel (never sent, no listing here, or deleted by Nexus) carries
 *    `create` — what Publish creates it as (Active, Inactive) or that it leaves it out (Not listed). Never locked: the
 *    pill is the effective choice (Active = info, Inactive = warning, Not listed = neutral) with a small "new" mark beside
 *    it; a choice made on this row waits with a CLOCK glyph (who and when in the tooltip); a choice the row takes from its
 *    main product or the default has no glyph ("new · as main"). Its editor offers Active · Inactive · Not listed, each
 *    with what Publish does (`newListingEditorOptions`). A row Nexus deleted is one too (simplify): Not listed by default
 *    with "deleted 4 Oct" beside it; Active or Inactive lists it again ("lists again").
 *
 * The words are spelled here, not imported: this design system is also compiled in apps/factory, which has no runtime
 * dependency on @nexus/shared (the same reason as `metafieldDisplay.ts` and `channelAxes.ts`). Only TYPES come from
 * @nexus/shared; `sellingStatus.shared.vitest.test.ts` (web only) holds every word equal to `SELLING_STATE_LABEL` and
 * `STATUS_TARGET_LABEL`.
 *
 * Inactive rows also carry a ROW-START MARK — a slim warning bar at the row's start edge, never a whole-row tint (Owner's
 * decision): `rowCarriesInactiveMark` says when, `SELLING_ROW_MARK_CLASS` is the class (`grid.css`).
 */
import type { NewListingSource, NewListingTarget, SellingState, StatusTarget } from '@nexus/shared/listing-actions'
import type { ListboxPanelOption } from '../../components/ListboxPanel'
import type { Tone } from '../../primitives/tone'
import { publishFullTime, publishShortTime } from './publishStatus'

export type { NewListingSource, NewListingTarget, SellingState, StatusTarget }

/** The state words — equal to `SELLING_STATE_LABEL` (@nexus/shared/listing-actions). The key `paused` reads "Inactive". */
export const SELLING_STATE_WORD: Readonly<Record<SellingState, string>> = {
  active: 'Active', paused: 'Inactive', ended: 'Ended', draft: 'Not listed', not_listed: 'Not listed', mixed: 'Mixed', unknown: 'Unknown',
}

/** The target words — equal to `STATUS_TARGET_LABEL` (@nexus/shared/listing-actions). */
export const STATUS_TARGET_WORD: Readonly<Record<StatusTarget, string>> = { active: 'Active', inactive: 'Inactive', ended: 'Ended', not_listed: 'Not listed' }

/** The state a target stands for — equal to `STATUS_TARGET_STATE` (@nexus/shared/listing-actions). */
export const STATUS_TARGET_SELLING_STATE: Readonly<Record<StatusTarget, SellingState>> = { active: 'active', inactive: 'paused', ended: 'ended', not_listed: 'not_listed' }

/** Live state tones. The word carries the meaning; the tone repeats it. */
export const SELLING_STATE_TONE: Readonly<Record<SellingState, Tone>> = {
  active: 'success', paused: 'warning', mixed: 'warning', ended: 'neutral', draft: 'neutral', not_listed: 'neutral', unknown: 'neutral',
}

/** Waiting target tones: Active (resume, relist) = info, Inactive = warning, Ended = danger, Not listed = neutral (nothing is sent). */
export const STATUS_TARGET_TONE: Readonly<Record<StatusTarget, Tone>> = { active: 'info', inactive: 'warning', ended: 'danger', not_listed: 'neutral' }

// ── New listings (Owner 2026-10-04) ─────────────────────────────────────────────────────────────────────────────────

/** The small mark beside a new row's choice. */
export const NEW_LISTING_MARK = 'new'
/** The mark when the row takes its choice from its family's main product. */
export const NEW_LISTING_MARK_MAIN = 'new · as main'
/** Beside a Not listed choice taken from the main product (no "new": nothing is created). */
export const NEW_LISTING_AS_MAIN = 'as main'
/** The editor's line under the choice a row holds now. */
export const NEW_CHOICE_MAIN = 'Now: it follows the main product\'s choice.'
export const NEW_CHOICE_DEFAULT = 'Now: the default for a new listing here.'
/** The same on a row Nexus deleted (its default is Not listed). */
export const NEW_CHOICE_DELETED = 'Now: a deleted listing stays off until you choose Active or Inactive.'
/** The small mark beside a deleted row's Active or Inactive: Publish lists it again. */
export const RELIST_MARK = 'lists again'
/** Why a new row's choice is what it is, in the tooltip and the sentence. */
export const NEW_SOURCE_SENTENCE: Readonly<Record<NewListingSource, string>> = {
  own: 'Chosen on this row.',
  main: 'It follows the main product\'s choice.',
  default: 'The default for a new listing here.',
}

/** What a state means, for the tooltip when the listing gives no reason of its own. */
export const SELLING_STATE_HINT: Readonly<Record<SellingState, string>> = {
  active: 'Buyers can buy it here.',
  paused: 'Buyers cannot buy it here. The listing, its number and its content stay.',
  mixed: 'Its variations are in different states.',
  ended: 'Ended on the channel. Set Active to relist it.',
  draft: 'In Nexus only. Publish creates it on the channel.',
  not_listed: 'Not on the channel yet. Publish creates it.',
  unknown: 'Nexus has no confirmed state for this listing. Check it on the channel.',
}

/**
 * States the Status cannot change when the caller gives no `create` (a main product on the channel whose variations are
 * not, or an older caller). A new row (`create`) chooses what Publish creates instead.
 */
export const SELLING_READ_ONLY_STATES: readonly SellingState[] = ['draft', 'not_listed']

/** The row class for an inactive listing row: a slim warning bar at the row's start edge (`grid.css`). */
export const SELLING_ROW_MARK_CLASS = 'nds-row-inactive'

/** Inactive or Mixed: the states that carry the warning tone and the row-start mark. */
export function isInactiveSellingState(state: SellingState | null | undefined): boolean {
  return state === 'paused' || state === 'mixed'
}

/**
 * Should this row carry the row-start mark? Yes when ANY of its markets is live Inactive or Mixed. Read from
 * the LIVE state only: a waiting Inactive is not inactive yet (the toolbar's waiting mark counts those), and a waiting
 * Active on an inactive row is still inactive until Publish. For `rowClassRules: { [SELLING_ROW_MARK_CLASS]: … }`.
 */
export function rowCarriesInactiveMark(states: Iterable<SellingState | SellingStatusValue | null | undefined>): boolean {
  for (const entry of states) {
    const state = typeof entry === 'string' ? entry : entry?.state
    if (isInactiveSellingState(state)) return true
  }
  return false
}

/** Who set a waiting value, and when (ISO). Both may be unknown. */
export interface WaitingBy {
  setAt: string | null
  setByName: string | null
}

/** One Status cell's facts. */
export interface SellingStatusValue {
  /** The live selling state Nexus holds (no channel call). */
  state: SellingState
  /** Why the listing is in this state (plain English, e.g. Amazon's own reason), or null. */
  reason?: string | null
  /** A change that waits for Publish. */
  waiting?: ({ target: StatusTarget } & WaitingBy) | null
  /** The caller locks this cell (plain English: why). A draft and Not listed are read-only without `create`. */
  lockedReason?: string | null
  /**
   * New listings: the row is not on the channel yet — what Publish creates it as, or that it leaves it out. `waiting`
   * then carries who chose it and when (source `own`). Null on every other row.
   */
  create?: NewListingCellFacts | null
}

/** A new row's Status facts (`PublishActionCell.create`, @nexus/shared/publish-actions). */
export interface NewListingCellFacts {
  target: NewListingTarget
  source: NewListingSource
  /** What Publish does, and where the choice comes from ("Publish creates it and it sells."). */
  sentence: string
  /** One more line for the tooltip (the eBay out-of-stock check), or null. */
  note?: string | null
  /** Nexus deleted this row from the channel: when ("4 Oct", the caller's words), for the "deleted 4 Oct" mark. */
  deleted?: { on: string } | null
}

export type SellingCellKind = 'loading' | 'live' | 'waiting' | 'outgrown' | 'locked' | 'new'

export interface SellingPillMeta {
  label: string
  tone: Tone
  /** `dot` for a live state, `clock` for a value waiting for Publish, `none` for a new row's choice nobody set on it. */
  glyph: 'dot' | 'clock' | 'none'
}

export interface SellingStatusModel {
  kind: SellingCellKind
  /** The cell's pill: the waiting target when one waits, else the live state. */
  pill: SellingPillMeta
  /** Small text beside the pill ("now Active", "No longer applies", "Publish creates it", "new"), or null. */
  aside: string | null
  /** The cell's tooltip line. The COLUMN composes it (`composeCellTooltip`); a renderer never claims `title`. */
  tooltip: string
  /** The whole screen-reader sentence. */
  ariaLabel: string
  /** May the Status editor open here? */
  editable: boolean
  /** Draw the lock glyph. */
  locked: boolean
  /** The row carries the inactive row-start mark (from this cell alone). */
  rowMark: boolean
}

/**
 * When a waiting value was set: "today 10:42" on the viewer's day, otherwise "on 3 Oct, 10:42" ("on 3 Oct 2025, 10:42"
 * in another year) — the shapes the "Last publish" cell uses. Empty for a missing or unreadable time.
 */
export function waitingWhen(setAt: string | null | undefined, now: number = Date.now()): string {
  if (!setAt || Number.isNaN(Date.parse(setAt))) return ''
  const short = publishShortTime(setAt, now)
  return short.includes(':') ? `today ${short}` : `on ${publishFullTime(setAt, now)}`
}

/** "set by Awais today 10:42" · "set by Awais" · "set today 10:42" · "" — who and when, as far as they are known. */
export function waitingSetPhrase(by: Partial<WaitingBy> | null | undefined, now: number = Date.now()): string {
  const who = by?.setByName?.trim()
  const when = waitingWhen(by?.setAt, now)
  if (!who && !when) return ''
  return ['set', who ? `by ${who}` : '', when].filter(Boolean).join(' ')
}

const sentence = (text: string) => { const t = text.trim(); return !t ? '' : /[.!?]\)?$/.test(t) ? t : `${t}.` }
const join = (...parts: Array<string | null | undefined>) => parts.map(p => sentence(p ?? '')).filter(Boolean).join(' ')

const livePill = (state: SellingState): SellingPillMeta => ({ label: SELLING_STATE_WORD[state], tone: SELLING_STATE_TONE[state], glyph: 'dot' })

/** A new row's pill: its choice, a clock when chosen on this row (it waits for Publish), no glyph otherwise. */
export function newListingPill(create: Pick<NewListingCellFacts, 'target' | 'source'>): SellingPillMeta {
  return { label: STATUS_TARGET_WORD[create.target], tone: STATUS_TARGET_TONE[create.target], glyph: create.source === 'own' ? 'clock' : 'none' }
}

/**
 * The small mark beside a new row's pill: "new", "new · as main"; a Not listed choice is no new listing. A row Nexus
 * deleted: "deleted 4 Oct" while it stays off, "lists again" once Active or Inactive.
 */
export function newListingAside(create: Pick<NewListingCellFacts, 'target' | 'source' | 'deleted'>): string | null {
  if (create.deleted) {
    if (create.target === 'not_listed') return create.source === 'main' ? NEW_LISTING_AS_MAIN : `deleted ${create.deleted.on}`
    return create.source === 'main' ? `${RELIST_MARK} · as main` : RELIST_MARK
  }
  if (create.target === 'not_listed') return create.source === 'main' ? NEW_LISTING_AS_MAIN : null
  return create.source === 'main' ? NEW_LISTING_MARK_MAIN : NEW_LISTING_MARK
}

/**
 * What one Status cell draws. `value === undefined` = the read has not answered yet (a skeleton, never a guessed state).
 */
export function sellingStatusModel(value: SellingStatusValue | undefined, now: number = Date.now()): SellingStatusModel {
  if (value === undefined) {
    return {
      kind: 'loading', pill: livePill('unknown'), aside: null, tooltip: 'Loading the selling state.', ariaLabel: 'Status: loading.',
      editable: false, locked: false, rowMark: false,
    }
  }
  const state = value.state
  const live = SELLING_STATE_WORD[state]
  const reason = value.reason?.trim() || null
  const rowMark = isInactiveSellingState(state)
  const readOnly = SELLING_READ_ONLY_STATES.includes(state)
  const lockedReason = value.lockedReason?.trim() || null

  const create = value.create ?? null
  if (create) {
    // A new row: never read-only by its state — the person chooses what Publish creates.
    const word = STATUS_TARGET_WORD[create.target]
    const by = create.source === 'own' && value.waiting ? waitingSetPhrase(value.waiting, now) : ''
    // A deleted row left off: the caller's sentence is the delete's own words (no "default for a new listing").
    const source = create.source === 'own' ? (by ? `${by[0].toUpperCase()}${by.slice(1)}` : NEW_SOURCE_SENTENCE.own)
      : create.source === 'default' && !create.deleted ? NEW_SOURCE_SENTENCE.default : null // the caller's sentence names the main product
    const what = join(create.sentence, create.note, source)
    const head = create.target === 'not_listed' ? `${word}` : create.deleted ? `Lists again: ${word}` : `New listing: ${word}`
    return {
      kind: lockedReason ? 'locked' : 'new', pill: newListingPill(create), aside: newListingAside(create),
      tooltip: join(lockedReason, what), ariaLabel: `Status: ${join(head, lockedReason, what)}`,
      editable: !lockedReason, locked: !!lockedReason, rowMark: false,
    }
  }

  if (readOnly || lockedReason) {
    const why = lockedReason ?? reason ?? SELLING_STATE_HINT[state]
    return {
      kind: 'locked', pill: livePill(state), aside: state === 'draft' && !lockedReason ? 'Publish creates it' : null,
      tooltip: join(why), ariaLabel: `Status: ${join(live, why)}`, editable: false, locked: true, rowMark,
    }
  }

  const waiting = value.waiting ?? null
  if (waiting) {
    const target = STATUS_TARGET_WORD[waiting.target]
    const by = waitingSetPhrase(waiting, now)
    if (STATUS_TARGET_SELLING_STATE[waiting.target] === state) {
      // The listing already reached the target (a channel change, another publish): nothing would be sent.
      const outgrown = `The waiting change to ${target} no longer applies: the listing is already ${live}`
      return {
        kind: 'outgrown', pill: livePill(state), aside: 'No longer applies',
        tooltip: join(outgrown, by ? `It was ${by}` : null), ariaLabel: `Status: ${join(live, outgrown)}`,
        editable: true, locked: false, rowMark,
      }
    }
    const waits = `${target} is waiting for Publish${by ? `, ${by}` : ''}`
    return {
      kind: 'waiting',
      pill: { label: target, tone: STATUS_TARGET_TONE[waiting.target], glyph: 'clock' },
      aside: `now ${live}`,
      tooltip: join(`${target} is waiting for Publish`, `Now ${live} on the channel`, reason, by ? `${by[0].toUpperCase()}${by.slice(1)}` : null),
      ariaLabel: `Status: ${join(live, reason, waits)}`,
      editable: true, locked: false, rowMark,
    }
  }

  return {
    kind: 'live', pill: livePill(state), aside: null,
    tooltip: join(reason ?? SELLING_STATE_HINT[state]), ariaLabel: `Status: ${join(live, reason)}`,
    editable: true, locked: false, rowMark,
  }
}

// ── The Status editor's options (DS SelectPanelEditor) ─────────────────────────────────────────────────────────────

/** One Status choice as `statusOptionsFor` (@nexus/shared/listing-actions) returns it. */
export interface StatusChoiceLike {
  target: StatusTarget
  offered: boolean
  reason: string | null
  warning?: string | null
  /** New listings: what this choice makes Publish do. */
  sentence?: string | null
  /** A check Nexus makes again when Publish sends (eBay's out-of-stock option). */
  checkedAtSend?: string | null
}

export const STATUS_NOW_NOTE = 'Now on the channel. Choosing it clears a waiting change.'
export const STATUS_REFUSED_FALLBACK = 'Not possible for this listing.'

/**
 * The options the Status editor shows: every target, the refused ones HELD (reachable, announced, never committed) with
 * their reason, and one line under each that needs it — the waiting value's "set by … today 10:42", the reason a target
 * is refused, a warning (FBA pause), or "now on the channel" for the current state.
 */
export function statusEditorOptions(
  choices: readonly StatusChoiceLike[],
  live: SellingState,
  waiting?: ({ target: StatusTarget } & Partial<WaitingBy>) | null,
  now: number = Date.now(),
): ListboxPanelOption[] {
  return choices.map(choice => {
    const label = STATUS_TARGET_WORD[choice.target]
    const isWaiting = waiting?.target === choice.target && STATUS_TARGET_SELLING_STATE[choice.target] !== live
    const by = isWaiting ? waitingSetPhrase(waiting, now) : ''
    if (!choice.offered) {
      const why = choice.reason?.trim() || STATUS_REFUSED_FALLBACK
      return { value: choice.target, label, heldReason: why, note: why }
    }
    const note = isWaiting ? sentence(`Waiting for Publish${by ? `, ${by}` : ''}`)
      : choice.warning?.trim() ? choice.warning.trim()
        : STATUS_TARGET_SELLING_STATE[choice.target] === live ? STATUS_NOW_NOTE
          : undefined
    return note ? { value: choice.target, label, note } : { value: choice.target, label }
  })
}

/**
 * The options a NEW row's Status editor shows (New listings, Owner 2026-10-04): Active · Inactive · Not listed, each with
 * what Publish does, its warning (a main row's Not listed leaves the whole family out) and the check made again when
 * Publish sends (eBay); a refused choice is HELD with its reason. The choice the row holds now says where it comes from:
 * "Waiting for Publish, set by Awais today 10:42." (chosen here), "Now: it follows the main product's choice.", "Now: the
 * default for a new listing here."
 */
export function newListingEditorOptions(
  choices: readonly StatusChoiceLike[],
  current: Pick<NewListingCellFacts, 'target' | 'source' | 'deleted'>,
  waiting?: Partial<WaitingBy> | null,
  now: number = Date.now(),
): ListboxPanelOption[] {
  return choices.map(choice => {
    const label = STATUS_TARGET_WORD[choice.target]
    if (!choice.offered) {
      const why = choice.reason?.trim() || STATUS_REFUSED_FALLBACK
      return { value: choice.target, label, heldReason: why, note: why }
    }
    const holds = current.target === choice.target
    const by = holds && current.source === 'own' ? waitingSetPhrase(waiting, now) : ''
    const marker = !holds ? null
      : current.source === 'own' ? `Waiting for Publish${by ? `, ${by}` : ''}`
        : current.source === 'main' ? NEW_CHOICE_MAIN : current.deleted ? NEW_CHOICE_DELETED : NEW_CHOICE_DEFAULT
    const note = join(choice.sentence, choice.warning, choice.checkedAtSend, marker)
    return note ? { value: choice.target, label, note } : { value: choice.target, label }
  })
}
