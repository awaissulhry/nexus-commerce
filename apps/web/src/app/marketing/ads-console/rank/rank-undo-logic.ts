/**
 * RC4.6/4.10 — pure undo logic, dependency-free so it's unit-testable (no React,
 * no '@/' aliases). The hook (useRankUndo) wires these to fetches + state.
 */

export interface HistEntry {
  id: string; at: string; actor: 'you' | 'automation'; entityType: string; entityId: string
  field: string; oldValue: string | null; newValue: string | null; reason: string | null
  isUndo: boolean; undoable: boolean
}

export const fmtEur = (c: number) => `€${(c / 100).toFixed(2)}`

/**
 * The change that undo() targets: the most-recent REAL undoable entry — skipping
 * undo()'s own reverse entries (isUndo) and anything already consumed this
 * session, so repeated Cmd+Z walks back through distinct changes.
 */
export function pickUndoTarget(entries: HistEntry[], consumed: Set<string>): HistEntry | null {
  return entries.find(e => e.undoable && !e.isUndo && !consumed.has(e.id)) ?? null
}
