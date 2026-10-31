/**
 * The rules of `RecordNav` (B-W2b-09, D13) — the `DetailModal` `nav` rule for record PAGES, pure and tested in Node.
 *
 * The page knows the list it was opened from (the ids in the order the list showed them, filtered and sorted — the app
 * keeps them, e.g. in the session, when the row is opened). Previous / Next walk those ids; at either end the control is
 * held and says why, never wraps; a record no longer in the list holds both. A paged list passes `offset` and `total` so
 * the counter counts the whole list ("53 of 56"). The keys are the modal's: K previous, J next — never with a modifier,
 * never while typing, in a grid or in a list (`detailNavKey`), and never while a dialog is open over the page.
 */
import {
  DETAIL_NAV_KEYS, KEY_TARGET_SELECTORS, detailNavHeld, detailNavKey, detailNavLabel, detailPosition,
  type DetailDirection, type DetailPlace, type DetailPosition, type KeyTargetKind, type NavKeyEvent,
} from '../detailModalModel'
import { RECORD_NAV_LABELS, type RecordNavLabels } from './RecordNavLabels'

export type RecordNavDirection = DetailDirection
export { DETAIL_NAV_KEYS as RECORD_NAV_KEYS, KEY_TARGET_SELECTORS as RECORD_NAV_KEY_TARGETS }

export interface RecordNavStep {
  dir: RecordNavDirection
  /** The record this control opens; null when held. */
  id: string | null
  /** The control's name: "Previous work order". */
  label: string
  /** Why it is held; null when it can go. */
  held: string | null
  /** The key that moves this way ("K" / "J"). */
  key: string
}

export interface RecordNavView {
  position: DetailPosition
  /** "53 of 56"; null when the record is not in the list. */
  counter: string | null
  /** The group's name: "Move between work orders". */
  groupLabel: string
  prev: RecordNavStep
  next: RecordNavStep
}

/** Where the record is in the list and what each control does. */
export function recordNavView(
  ids: readonly string[],
  current: string | null | undefined,
  options: { noun?: string; place?: DetailPlace; words?: RecordNavLabels } = {},
): RecordNavView {
  const words = options.words ?? RECORD_NAV_LABELS
  const noun = options.noun ?? words.noun
  const position = detailPosition(ids, current, options.place, words)
  const held = detailNavHeld(position, noun, options.place, words)
  const step = (dir: RecordNavDirection): RecordNavStep => ({
    dir,
    id: held[dir] ? null : dir === 'prev' ? position.prevId : position.nextId,
    label: detailNavLabel(dir, noun, words),
    held: held[dir],
    key: DETAIL_NAV_KEYS[dir],
  })
  return { position, counter: position.words, groupLabel: words.moveBetween(noun), prev: step('prev'), next: step('next') }
}

/**
 * Which way a key moves on the page, or null. On top of the modal's rule (`detailNavKey`): never while a dialog is open
 * (its own keys win), never when the event was already handled.
 */
export function recordNavKey(event: NavKeyEvent & { defaultPrevented?: boolean }, target: KeyTargetKind, dialogOpen: boolean): RecordNavDirection | null {
  if (event.defaultPrevented || dialogOpen) return null
  return detailNavKey(event, target)
}
