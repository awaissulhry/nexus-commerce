/**
 * Keyboard shortcuts registry for the flat-file editors.
 *
 * Same registry used by both AmazonFlatFileClient and FlatFileGrid
 * (which the eBay editor consumes). The shortcuts themselves are
 * implemented in each consumer's keyboard handler; this file is just
 * the documentation surfaced through the KeyboardShortcutsModal.
 *
 * Matches the bindings in:
 *   - apps/web/src/app/products/amazon-flat-file/AmazonFlatFileClient.tsx (~line 1158)
 *   - apps/web/src/components/flat-file/FlatFileGrid.tsx
 */

import type { ShortcutGroup } from '../../_shared/grid-lens/KeyboardShortcutsModal'

export const FLAT_FILE_SHORTCUTS: ShortcutGroup[] = [
  {
    title: 'Navigation',
    rows: [
      { keys: ['↑', '↓', '←', '→'], label: 'Move active cell' },
      { keys: ['⌘', '↑'], label: 'Jump to top of column' },
      { keys: ['⌘', '↓'], label: 'Jump to bottom of column' },
      { keys: ['⌘', '←'], label: 'Jump to first column' },
      { keys: ['⌘', '→'], label: 'Jump to last column' },
      { keys: ['⌘', 'Home'], label: 'Jump to top-left cell' },
      { keys: ['⌘', 'End'], label: 'Jump to bottom-right cell' },
      { keys: ['Tab'], label: 'Move right one cell' },
      { keys: ['⇧', 'Tab'], label: 'Move left one cell' },
    ],
  },
  {
    title: 'Editing',
    rows: [
      { keys: ['F2'], label: 'Edit the active cell' },
      { keys: ['Enter'], label: 'Edit, then move down on commit' },
      { keys: ['Delete'], label: 'Clear selected cells' },
      { keys: ['⌘', 'D'], label: 'Fill down from top of selection' },
      { keys: ['⌘', 'C'], label: 'Copy selection' },
      { keys: ['⌘', 'X'], label: 'Cut selection' },
      { keys: ['⌘', 'V'], label: 'Paste into selection' },
      { keys: ['Esc'], label: 'Cancel edit / clear selection' },
    ],
  },
  {
    title: 'Selection',
    rows: [
      { keys: ['⌘', 'A'], label: 'Select all rows' },
      { keys: ['⇧', '↑↓←→'], label: 'Extend selection one cell' },
      { keys: ['⌘', '⇧', '↑↓←→'], label: 'Extend to row/column edge' },
      { keys: ['Click row #'], label: 'Select row' },
      { keys: ['⇧', 'Click row #'], label: 'Extend row selection to here' },
    ],
  },
  {
    title: 'Toolbar',
    rows: [
      { keys: ['⌘', 'Z'], label: 'Undo' },
      { keys: ['⌘', '⇧', 'Z'], label: 'Redo' },
      { keys: ['⌘', 'F'], label: 'Find & Replace' },
      { keys: ['?'], label: 'Show this shortcuts modal' },
    ],
  },
]
