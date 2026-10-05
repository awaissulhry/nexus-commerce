/**
 * Publish action — what the product sheet's **Action** column draws (sheet publish parity, build shape v2, Owner
 * 2026-10-04). Pure — no React — so the cell, the catalog, the editor and the tests share one rule.
 *
 * The Action says how Publish sends a row's content:
 *  - **Partial update** — the default, never stored: today's Publish, only the changed fields. QUIET: muted text
 *    (`--nds-grid-muted-fg`, 7:1 in both themes), no pill. A column of defaults must not read as a column of alerts.
 *  - **Full update** — waiting: an info Pill with a clock glyph. Every field Nexus manages is sent again.
 *  - **Delete** — waiting: a danger Pill with a clock glyph. Publish removes the listing from the channel.
 * Who and when go in the tooltip and the screen-reader sentence ("Action: Delete is waiting for Publish, set by Awais
 * today 10:42. …").
 *
 * Where Partial update sends no field (a product already on Shopify, Etsy — 2026-10-05), the caller passes
 * `partialNote`: the tooltip and the screen-reader sentence say that instead of "Publish sends only the fields you
 * changed.", and the editor's Partial update note says it too (the option's `warning`).
 *
 * A row NOT on the channel (Owner 2026-10-04, simplify: never sent, no listing here, or deleted by Nexus) reads **Full
 * update** — a create always sends the whole listing — as an info Pill without a glyph (what Publish does, not a value
 * someone set); when its Status is Not listed, Publish leaves it out and the word is drawn quiet. Its editor lists Full
 * update (the value) and Partial update, Delete HELD with the server's reasons. There are no other Action words: no
 * "Create", no "Deleted", no "Keep deleted" — the Status column says whether a row is on the channel.
 *
 * The words are spelled here, equal to `SEND_MODE_LABEL` (@nexus/shared/publish-actions; held equal by
 * `sellingStatus.shared.vitest.test.ts`, web only): this design system is also compiled in apps/factory, which has no
 * runtime dependency on @nexus/shared. Only types come from it.
 */
import type { SendMode, SendModeOption } from '@nexus/shared/publish-actions'
import type { ListboxPanelOption } from '../../components/ListboxPanel'
import type { Tone } from '../../primitives/tone'
import { waitingSetPhrase, type WaitingBy } from './sellingStatus'

export type { SendMode }

/** Equal to `SEND_MODE_LABEL` (@nexus/shared/publish-actions). */
export const SEND_MODE_WORD: Readonly<Record<SendMode, string>> = { partial: 'Partial update', full: 'Full update', delete: 'Delete' }

/** A waiting value's tone (and a new row's Full update). Partial update is the default and has none: it is drawn quiet. */
export const SEND_MODE_TONE: Readonly<Record<Exclude<SendMode, 'partial'>, Tone>> = { full: 'info', delete: 'danger' }

/** What each value makes Publish do (the tooltip's second sentence). */
export const SEND_MODE_HINT: Readonly<Record<SendMode, string>> = {
  partial: 'Publish sends only the fields you changed.',
  full: 'Publish sends every field Nexus manages again; the review lists what the channel holds that Nexus does not, and those values are removed.',
  delete: 'Publish removes this listing from the channel and Nexus forgets its channel number. It cannot be undone.',
}

/** A row not on the channel: why it reads Full update — equal to `NEW_LISTING_SENT_WHOLE` (@nexus/shared/publish-actions). */
export const NEW_ROW_SENT_WHOLE = 'A new listing is always sent whole.'
/** A row not on the channel whose Status is Not listed: the Full update cell's tooltip. */
export const NEW_ROW_LEFT_OUT_HINT = 'Its Status is Not listed, so Publish leaves it out. Choose Active or Inactive in the Status column to create it.'
/** The same on a row Nexus deleted. */
export const DELETED_ROW_LEFT_OUT_HINT = 'Its Status is Not listed, so Publish leaves it out: it stays deleted. Set Status to Active to list it again.'
/** The note under a new row's Full update in the editor. */
export const NEW_ROW_FULL_NOTE = 'Now. A new listing is always sent whole: its Status says whether Publish creates it.'

/** The editor's groups (the combined plan: Send · Remove). */
export const SEND_MODE_GROUP: Readonly<Record<SendMode, string>> = { partial: 'Send', full: 'Send', delete: 'Remove' }

/** One Action cell's facts. */
export interface PublishActionValue extends Partial<WaitingBy> {
  mode: SendMode
  /** The caller locks this cell (plain English: why), e.g. a channel the sheet cannot publish to yet. */
  lockedReason?: string | null
  /** The row is not on the channel (never sent, no listing here, or deleted by Nexus): it reads Full update, sent whole. */
  newRow?: boolean
  /** A row not on the channel whose Status is Not listed: Publish leaves it out (Full update is drawn quiet). */
  leftOut?: boolean
  /** A row not on the channel because Nexus deleted it (its tooltip says it stays deleted while it is left out). */
  deleted?: boolean
  /**
   * What Partial update does on this row when Publish sends none of its fields (plain English, e.g. a product already on
   * Shopify): replaces `SEND_MODE_HINT.partial` in the tooltip and the screen-reader sentence. Absent = the usual hint.
   */
  partialNote?: string | null
}

export type PublishActionKind = 'loading' | 'default' | 'waiting' | 'locked' | 'new'

export interface PublishActionModel {
  kind: PublishActionKind
  /** The value's word ("Partial update", "Full update", "Delete"). */
  label: string
  /** The waiting pill (a clock), a new row's Full update (no glyph), or null for the quiet default (and while loading). */
  pill: { label: string; tone: Tone; glyph: 'clock' | 'none' } | null
  /** Small text beside the pill, or null. */
  aside: string | null
  /** The cell's tooltip line. The COLUMN composes it (`composeCellTooltip`); a renderer never claims `title`. */
  tooltip: string
  /** The whole screen-reader sentence. */
  ariaLabel: string
  editable: boolean
  locked: boolean
}

const capital = (text: string) => (text ? `${text[0].toUpperCase()}${text.slice(1)}` : text)

/** What one Action cell draws. `value === undefined` = the read has not answered yet (a skeleton). */
export function publishActionModel(value: PublishActionValue | undefined, now: number = Date.now()): PublishActionModel {
  if (value === undefined) {
    return { kind: 'loading', label: '', pill: null, aside: null, tooltip: 'Loading the publish action.', ariaLabel: 'Action: loading.', editable: false, locked: false }
  }
  const newRow = !!value.newRow
  const mode: SendMode = newRow && value.mode !== 'delete' ? 'full' : value.mode in SEND_MODE_WORD ? value.mode : 'partial'
  const label = SEND_MODE_WORD[mode]
  const lockedReason = value.lockedReason?.trim() || null
  if (lockedReason) {
    // A locked cell never shows a waiting pill: nothing it says could be sent from here.
    const why = /[.!?]$/.test(lockedReason) ? lockedReason : `${lockedReason}.`
    const word = newRow ? SEND_MODE_WORD.full : SEND_MODE_WORD.partial
    return { kind: 'locked', label: word, pill: null, aside: null, tooltip: why, ariaLabel: `Action: ${word}. ${why}`, editable: false, locked: true }
  }
  if (newRow && mode === 'full') {
    // A row not on the channel: what Publish does (not a value someone set), so no glyph; quiet when its Status leaves it out.
    const hint = value.leftOut ? `${NEW_ROW_SENT_WHOLE} ${value.deleted ? DELETED_ROW_LEFT_OUT_HINT : NEW_ROW_LEFT_OUT_HINT}` : NEW_ROW_SENT_WHOLE
    return {
      kind: 'new', label, pill: value.leftOut ? null : { label, tone: SEND_MODE_TONE.full, glyph: 'none' }, aside: null,
      tooltip: `${label}: ${hint}`, ariaLabel: `Action: ${label}. ${hint}`, editable: true, locked: false,
    }
  }
  if (mode === 'partial') {
    const hint = value.partialNote?.trim() || SEND_MODE_HINT.partial
    return { kind: 'default', label, pill: null, aside: null, tooltip: `${label}: ${hint}`, ariaLabel: `Action: ${label}. ${hint}`, editable: true, locked: false }
  }
  const by = waitingSetPhrase(value, now)
  const waits = `${label} is waiting for Publish`
  return {
    kind: 'waiting', label,
    pill: { label, tone: SEND_MODE_TONE[mode], glyph: 'clock' }, aside: null,
    tooltip: [`${waits}.`, SEND_MODE_HINT[mode], by ? `${capital(by)}.` : ''].filter(Boolean).join(' '),
    ariaLabel: `Action: ${waits}${by ? `, ${by}` : ''}. ${SEND_MODE_HINT[mode]}`,
    editable: true, locked: false,
  }
}

// ── The Action editor's options (DS SelectPanelEditor) ─────────────────────────────────────────────────────────────

/** One Action choice as `sendModeOptions` (@nexus/shared/publish-actions) returns it. */
export type SendModeChoiceLike = Pick<SendModeOption, 'mode' | 'offered' | 'reason'> & { warning?: string | null }

export const SEND_MODE_DEFAULT_NOTE = 'The default. Only the fields you changed.'
/** Partial update's note where it carries a warning (Publish sends none of the row's fields): "The default. <warning>". */
export const sendModeDefaultNote = (warning?: string | null) => warning?.trim() ? `The default. ${warning.trim()}` : SEND_MODE_DEFAULT_NOTE
export const SEND_MODE_REFUSED_FALLBACK = 'Not possible for this listing.'

/**
 * The options the Action editor shows, grouped Send (Partial update, Full update) · Remove (Delete). A refused value
 * stays in the list HELD with its reason; the waiting value says who set it and when; Full update carries its warning,
 * and so does Partial update where it sends no field ("The default. Publish does not send Etsy listing fields yet. …").
 *
 * On a row not on the channel (`newRow`: never sent, no listing here, or deleted by Nexus): Full update is the value it
 * holds (its note: a new listing is always sent whole), Partial update and Delete are HELD with the caller's reasons.
 */
export function sendModeEditorOptions(
  choices: readonly SendModeChoiceLike[],
  waiting?: ({ mode: SendMode } & Partial<WaitingBy>) | null,
  now: number = Date.now(),
  newRow = false,
): ListboxPanelOption[] {
  return choices.map(choice => {
    const base = { value: choice.mode, label: SEND_MODE_WORD[choice.mode], group: SEND_MODE_GROUP[choice.mode] }
    if (!choice.offered) {
      const why = choice.reason?.trim() || SEND_MODE_REFUSED_FALLBACK
      return { ...base, heldReason: why, note: why }
    }
    if (newRow && choice.mode === 'full') return { ...base, note: NEW_ROW_FULL_NOTE }
    // Partial update is the default: never a value someone set.
    const isWaiting = !newRow && waiting != null && waiting.mode === choice.mode && choice.mode !== 'partial'
    const by = isWaiting ? waitingSetPhrase(waiting, now) : ''
    const note = isWaiting ? `Waiting for Publish${by ? `, ${by}` : ''}.`
      : choice.mode === 'partial' ? sendModeDefaultNote(choice.warning)
        : choice.warning?.trim() || undefined
    return note ? { ...base, note } : base
  })
}
