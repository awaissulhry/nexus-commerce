import type { PreferencesAggFunc } from './PreferencesModal'

/**
 * The words of `PreferencesModal` and its panes (`usePreferencesPanes`), B-W2b-04. English by default; the props
 * `title`, `listLabel`, `listHint` and `confirmLabel` still win where they apply. A column, group or option name is the
 * host's already: these words put it in a sentence ("Remove Status from the view").
 */
export interface PreferencesModalLabels {
  // ── The dialog ──
  title: string
  /** The list's name (when no `listLabel` is passed); also the heading of columns with no group. */
  columns: string
  reset: string
  saveAsView: string
  /** Update the active saved view: "Update “Mine”". */
  update: (view: string) => string
  /** The save-as-view group's name. */
  saveAsViewGroup: string
  viewName: string
  saveView: string
  cancel: string
  reloadSaved: string
  saving: string
  /** The primary button (when no `confirmLabel` is passed). */
  save: string
  /** The tab row's name, and its tabs (a grid that offers grouping). */
  sections: string
  tabColumns: string
  tabGrouping: string
  tabDisplay: string
  /** The dialog's close button. */
  close: string
  // ── Display ──
  rowsPerPage: string
  sticky: string
  stickyHelp: string
  pinFirst: string
  pinLast: string
  sortOrder: string
  descending: string
  ascending: string
  // ── Choosing columns ──
  /** The hint under the list's legend (when no `listHint` is passed). */
  tickHint: string
  quickPicks: string
  all: string
  everyColumn: string
  none: string
  onlyLocked: string
  filterPlaceholder: string
  /** The filter's name: "Filter columns". */
  filter: (list: string) => string
  /** The filter's count: "3 of 98" while filtering, "98 columns" otherwise. */
  matchCount: (matches: number, total: number) => string
  columnCount: (total: number) => string
  expandAll: string
  collapseAll: string
  selectEveryGroup: string
  selectMatchingGroup: string
  selectAll: string
  clearAll: string
  /** "Select the match" / "Select all 4 matches". */
  selectMatches: (count: number) => string
  /** "Clear the match" / "Clear 4 matches". */
  clearMatches: (count: number) => string
  /** No column matches the filter: "No column matches “size”.". */
  noMatch: (query: string) => string
  /** A group heading's count (attribute groups): "3/7 shown", and "2 match" while filtering. */
  groupShown: (shown: number, total: number) => string
  groupMatches: (count: number) => string
  /** A group's All / Clear: its name ("Add every Identity column", "Remove matching Identity column"). */
  groupToggle: (add: boolean, matching: boolean, group: string) => string
  clear: string
  locked: string
  fixed: string
  fixedColumns: string
  lockedByGrid: string
  /** "Locked — frozen at the left while you scroll". */
  lockedAt: (side: 'left' | 'right') => string
  alwaysShown: string
  alwaysShownHint: string
  // ── In view ──
  inView: string
  /** Beside "In view": "7 of 18". */
  inViewCount: (shown: number, total: number) => string
  viewHelp: string
  viewHelpGroups: string
  dragColumn: (column: string) => string
  dragGroup: (group: string) => string
  selectForBulk: (column: string) => string
  moveUp: (column: string) => string
  moveDown: (column: string) => string
  moveGroupUp: (group: string) => string
  moveGroupDown: (group: string) => string
  lockColumn: (column: string) => string
  unlockColumn: (column: string) => string
  lockHint: string
  unlockHint: string
  removeColumn: (column: string) => string
  pinned: string
  pinnedRight: string
  pinnedColumns: string
  pinnedRightColumns: string
  selectAllInView: string
  selectMatchingInView: string
  selectBulk: string
  selectBulkMatching: string
  selectedActions: string
  /** "3 selected", and " · 1 hidden from this list". */
  selected: (count: number) => string
  hiddenFromList: (count: number) => string
  clearSelection: string
  moveToGroupLabel: string
  moveToGroup: string
  show: string
  hide: string
  pin: string
  unpin: string
  resetGroup: string
  /** A group's name in view: "Identity in view". */
  groupInView: (group: string) => string
  /** "Select matching Identity columns in view". */
  selectGroupInView: (group: string, matching: boolean) => string
  /** A group's count: "3/7 · 1 pinned", titled "3 shown of 7 columns, including 1 pinned". */
  groupCount: (shown: number, total: number, pinned: number) => string
  groupCountTitle: (shown: number, total: number, pinned: number) => string
  groupEmpty: string
  pinnedAbove: (count: number) => string
  noScrolling: string
  showMatches: string
  showGroup: string
  noViewMatch: (query: string) => string
  // ── Dragging, for a screen reader ──
  dragInstructions: string
  dragPicked: (item: string) => string
  dragOver: (item: string, over: string) => string
  dragNowhere: (item: string) => string
  dragDropped: (item: string, over: string) => string
  dragPutBack: (item: string) => string
  dragCancelled: (item: string) => string
  // ── Grouping ──
  rowGroups: string
  rowGroupsHelp: string
  noGrouping: string
  stopGrouping: (column: string) => string
  groupable: string
  allGroupableUsed: string
  groupBy: (column: string) => string
  totals: string
  totalsHelp: string
  noTotals: string
  totalFor: (column: string) => string
  removeTotal: (column: string) => string
  totalable: string
  allTotalsUsed: string
  addTotal: (column: string) => string
  /** A total's name: Sum, Average, Minimum, Maximum, Count. */
  aggregates: Readonly<Record<PreferencesAggFunc, string>>
}

export const PREFERENCES_MODAL_LABELS: PreferencesModalLabels = {
  title: 'Customise',
  columns: 'Columns',
  reset: 'Reset to default',
  saveAsView: 'Save as view…',
  update: (view) => `Update “${view}”`,
  saveAsViewGroup: 'Save as view',
  viewName: 'View name',
  saveView: 'Save view',
  cancel: 'Cancel',
  reloadSaved: 'Reload saved layout',
  saving: 'Saving…',
  save: 'Save',
  sections: 'Customise sections',
  tabColumns: 'Columns',
  tabGrouping: 'Grouping',
  tabDisplay: 'Display',
  close: 'Close',
  rowsPerPage: 'Rows per page',
  sticky: 'Sticky columns',
  stickyHelp: 'Keep the first / last column pinned while scrolling sideways.',
  pinFirst: 'Pin first column',
  pinLast: 'Pin last column',
  sortOrder: 'Sort order',
  descending: 'Descending',
  ascending: 'Ascending',
  tickHint: 'Tick a column to add it to the view.',
  quickPicks: 'Quick picks',
  all: 'All',
  everyColumn: 'Every column',
  none: 'None',
  onlyLocked: 'Only the locked columns',
  filterPlaceholder: 'Filter columns…',
  filter: (list) => `Filter ${list.toLowerCase()}`,
  matchCount: (matches, total) => `${matches} of ${total}`,
  columnCount: (total) => `${total} columns`,
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  selectEveryGroup: 'Select every column',
  selectMatchingGroup: 'Select the matching columns',
  selectAll: 'Select all',
  clearAll: 'Clear all',
  selectMatches: (count) => `Select ${count === 1 ? 'the match' : `all ${count} matches`}`,
  clearMatches: (count) => `Clear ${count === 1 ? 'the match' : `${count} matches`}`,
  noMatch: (query) => `No column matches “${query}”.`,
  groupShown: (shown, total) => `${shown}/${total} shown`,
  groupMatches: (count) => `${count} match`,
  groupToggle: (add, matching, group) => `${add ? 'Add' : 'Remove'} ${matching ? 'matching' : 'every'} ${group} column`,
  clear: 'Clear',
  locked: 'Locked',
  fixed: 'Fixed',
  fixedColumns: 'Fixed columns',
  lockedByGrid: 'Locked by the grid',
  lockedAt: (side) => `Locked — frozen at the ${side} while you scroll`,
  alwaysShown: 'Always shown',
  alwaysShownHint: 'Always on screen — move or pin it in In view',
  inView: 'In view',
  inViewCount: (shown, total) => `${shown} of ${total}`,
  viewHelp: 'Drag to reorder · ✕ removes a column from the view.',
  viewHelpGroups: 'Select columns to move or edit together. Drag groups or columns to reorder.',
  dragColumn: (column) => `Drag ${column} — Space to lift, arrow keys to move, Space to drop`,
  dragGroup: (group) => `Drag the ${group} group — Space to lift, arrow keys to move, Space to drop`,
  selectForBulk: (column) => `Select ${column} for bulk actions`,
  moveUp: (column) => `Move ${column} up`,
  moveDown: (column) => `Move ${column} down`,
  moveGroupUp: (group) => `Move ${group} group up`,
  moveGroupDown: (group) => `Move ${group} group down`,
  lockColumn: (column) => `Lock ${column} — frozen while you scroll`,
  unlockColumn: (column) => `Unlock ${column} — back into the scrolling columns`,
  lockHint: 'Lock — frozen while you scroll',
  unlockHint: 'Unlock — back into the scrolling columns',
  removeColumn: (column) => `Remove ${column} from the view`,
  pinned: 'Pinned',
  pinnedRight: 'Pinned right',
  pinnedColumns: 'Pinned columns',
  pinnedRightColumns: 'Pinned right columns',
  selectAllInView: 'Select all columns in view',
  selectMatchingInView: 'Select matching columns in view',
  selectBulk: 'Select columns for bulk actions',
  selectBulkMatching: 'Select matching columns for bulk actions',
  selectedActions: 'Selected column actions',
  selected: (count) => `${count} selected`,
  hiddenFromList: (count) => `${count} hidden from this list`,
  clearSelection: 'Clear selection',
  moveToGroupLabel: 'Move selected columns to group',
  moveToGroup: 'Move to group…',
  show: 'Show',
  hide: 'Hide',
  pin: 'Pin',
  unpin: 'Unpin',
  resetGroup: 'Reset group',
  groupInView: (group) => `${group} in view`,
  selectGroupInView: (group, matching) => `Select ${matching ? 'matching ' : ''}${group} columns in view`,
  groupCount: (shown, total, pinned) => `${shown}/${total}${pinned > 0 ? ` · ${pinned} pinned` : ''}`,
  groupCountTitle: (shown, total, pinned) => `${shown} shown of ${total} columns${pinned ? `, including ${pinned} pinned` : ''}`,
  groupEmpty: 'Empty · drag a column here to put it back',
  pinnedAbove: (count) => `${count} pinned above`,
  noScrolling: 'No scrolling columns in view',
  showMatches: 'Show matches',
  showGroup: 'Show group',
  noViewMatch: (query) => `No columns in view match “${query}”.`,
  dragInstructions: 'To move a column or a group, focus its grip and press Space. Arrow keys move it, Space drops it, Escape cancels.',
  dragPicked: (item) => `Picked up ${item}. Arrow keys move it, Space drops it, Escape cancels.`,
  dragOver: (item, over) => `${item} is over ${over}.`,
  dragNowhere: (item) => `${item} is not over a place it can go.`,
  dragDropped: (item, over) => `${item} dropped at ${over}.`,
  dragPutBack: (item) => `${item} put back.`,
  dragCancelled: (item) => `Moving ${item} cancelled. It is back where it was.`,
  rowGroups: 'Row groups',
  rowGroupsHelp: 'Drag a column here to fold the rows into groups — outermost first. While grouped, families do not expand.',
  noGrouping: 'No grouping · drop a column here',
  stopGrouping: (column) => `Stop grouping by ${column}`,
  groupable: 'Columns you can group by',
  allGroupableUsed: 'Every groupable column is in use.',
  groupBy: (column) => `Group by ${column}`,
  totals: 'Totals',
  totalsHelp: 'What a group row shows for a column. Drag a column here and pick its total.',
  noTotals: 'No totals · drop a column here',
  totalFor: (column) => `Total for ${column}`,
  removeTotal: (column) => `Remove the total for ${column}`,
  totalable: 'Columns you can total',
  allTotalsUsed: 'Every column with a total is in use.',
  addTotal: (column) => `Add a total for ${column}`,
  aggregates: { sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', count: 'Count' },
}
