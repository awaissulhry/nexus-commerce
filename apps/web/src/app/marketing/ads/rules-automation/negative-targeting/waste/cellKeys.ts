/**
 * Negative Targeting page — the keys of the cells that hold controls (their `suppressKeyboardEvent`). Pure, tested in
 * Node (audit S4: the verb and the owner chip could not be reached by keyboard).
 *
 *   Where   Enter → the campaign · ⇧ Enter → the ad group (one link per line)
 *   Who     Enter → the owner's chip when it opens something (a rule)
 *   Verb    Enter or Space → the row's verb (a held verb says why on focus and does nothing)
 * Focus ON a link or a button keeps the control's own keys. Every other key stays the grid's; a cell with no control
 * lets Enter through (the view opens the record).
 */

interface Clickable { click(): void; focus?(): void; getAttribute?(name: string): string | null }
interface KeyTarget {
  closest?: (selector: string) => unknown
  querySelectorAll?: (selector: string) => ArrayLike<Clickable>
  querySelector?: (selector: string) => Clickable | null
}
export interface CellKeyParams {
  event: { key: string; shiftKey?: boolean; type?: string; target: unknown; preventDefault?: () => void }
  editing: boolean
}

const LINK = 'a[href]'
const CONTROL = 'a[href], button'

/** The control already has the focus: its own keys. */
const onControl = (t: KeyTarget) => typeof t.closest === 'function' && !!t.closest(CONTROL)

function press(event: CellKeyParams['event'], pick: Clickable | null | undefined): boolean {
  if (!pick) return false
  if (event.type && event.type !== 'keydown') return true
  event.preventDefault?.()
  if (pick.getAttribute?.('aria-disabled') === 'true') pick.focus?.()
  else pick.click()
  return true
}

/** Where: Enter follows the campaign (line 1), ⇧ Enter the ad group (line 2). */
export function placeKeys({ event, editing }: CellKeyParams): boolean {
  const t = event.target as KeyTarget | null
  if (!t || typeof t.closest !== 'function') return false
  if (t.closest(LINK)) return true
  if (editing || event.key !== 'Enter' || typeof t.querySelectorAll !== 'function') return false
  const links = t.querySelectorAll(LINK)
  return press(event, event.shiftKey ? links[1] : links[0])
}

/** Who: Enter opens the owner's chip when it is a link or a button. */
export function ownerKeys({ event, editing }: CellKeyParams): boolean {
  const t = event.target as KeyTarget | null
  if (!t || typeof t.closest !== 'function') return false
  if (onControl(t)) return true
  if (editing || event.key !== 'Enter' || typeof t.querySelector !== 'function') return false
  return press(event, t.querySelector(CONTROL))
}

/** The verb: Enter or Space presses it (a held one takes the focus, so its reason shows). */
export function verbKeys({ event, editing }: CellKeyParams): boolean {
  const t = event.target as KeyTarget | null
  if (!t || typeof t.closest !== 'function') return false
  if (onControl(t)) return true
  if (editing || (event.key !== 'Enter' && event.key !== ' ') || typeof t.querySelector !== 'function') return false
  return press(event, t.querySelector('button'))
}
