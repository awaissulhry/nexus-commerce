/**
 * The ads grid's row keys (`keyboardNav`) — which keydown moves the keyboard row, opens it, or hands a letter to the
 * page's row verbs (`onRowKey`: A apply, P mute, R restore …). Pure, so every refusal is a test.
 *
 * The keys listen on the whole page, so a person can press J on landing without clicking into the grid first. That
 * reach is why they must refuse everything that is not meant for them (grid audit F1, 2026-10-12: ⌘R on a Dismissed
 * tab restored the focused suggestion on the server, ⌘A / ⌘P staged verbs, Enter on any button opened the row, and the
 * arrows stopped scrolling the page). The refusals are the DS grid shortcut filter's (`gridShortcuts.ts`): Ctrl / ⌘ /
 * Alt, an IME, a key already handled, typing, a cell editor, a menu or dialog, a modal the grid is not in, and Enter /
 * Space on a button or a link. On top of those:
 *
 *  - the keys belong to this grid only while focus is inside the grid or on something that HOLDS it — the page itself
 *    when nothing is focused, or the shell's `<main tabIndex={-1}>` a click lands on — never on another control;
 *  - ArrowUp / ArrowDown move rows only while focus is inside the grid — on the page they scroll it;
 *  - J / K and the arrows repeat while held; a verb never does (holding A must not apply row after row).
 */
import { matchGridShortcut, shortcutKey, type MatchOptions, type ShortcutContainer, type ShortcutKeyEvent } from '../hooks/gridShortcuts'

export type RowNavAction = { kind: 'move'; step: 1 | -1 } | { kind: 'open' } | { kind: 'verb'; key: string }

/**
 * `grid.contains(node)`: focus is inside the grid. `holdsGrid(node)`: the focused element holds the grid — `<body>`
 * when nothing is focused, `<html>`, the shell's `<main>` a click on a plain cell lands on.
 */
export function rowNavAction(
  event: ShortcutKeyEvent,
  grid: ShortcutContainer,
  holdsGrid: (node: unknown) => boolean,
  options: MatchOptions = {},
): RowNavAction | null {
  const key = shortcutKey(event.key)
  const arrow = key === 'ArrowDown' || key === 'ArrowUp'
  const move = arrow || key === 'j' || key === 'k'
  const scope: ShortcutContainer = {
    contains: (node) => grid.contains(node) || (!arrow && holdsGrid(node)),
  }
  if (!matchGridShortcut(event, scope, [{ key: event.key, repeat: move }], options)) return null
  if (key === 'j' || key === 'ArrowDown') return { kind: 'move', step: 1 }
  if (key === 'k' || key === 'ArrowUp') return { kind: 'move', step: -1 }
  if (key === 'o' || key === 'Enter') return { kind: 'open' }
  return { kind: 'verb', key: event.key.toLowerCase() }
}
