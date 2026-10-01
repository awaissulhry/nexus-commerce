export interface SheetSaveCounts {
  pending: number
  refused: number
  warned: number
  retryable: number
  refusedRowIds: ReadonlySet<string>
  offline: boolean
  saving: boolean
}

export interface SheetSaveStatus extends SheetSaveCounts {
  lastSavedAt: string | null
}

function sameRows(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  return a.size === b.size && [...a].every(id => b.has(id))
}

/** The same counts and the same refused rows. */
export function sameStatus(a: SheetSaveCounts, b: SheetSaveCounts): boolean {
  return a.pending === b.pending && a.refused === b.refused && a.warned === b.warned && a.retryable === b.retryable &&
    a.offline === b.offline && a.saving === b.saving && sameRows(a.refusedRowIds, b.refusedRowIds)
}

/** Save progress belongs to the status strip. Only refusals change the sheet's row filter. */
export function createSheetSaveStatusStore(readCounts: () => SheetSaveCounts) {
  let snapshot: SheetSaveStatus = { ...readCounts(), lastSavedAt: null }
  let refused = { refused: snapshot.refused, refusedRowIds: snapshot.refusedRowIds }
  const noteOf = ({ offline, refused, retryable, lastSavedAt }: SheetSaveStatus) => ({ offline, refused, retryable, lastSavedAt })
  let note = noteOf(snapshot)
  const listeners = new Set<() => void>()
  const emit = () => {
    if (note.offline !== snapshot.offline || note.refused !== snapshot.refused || note.retryable !== snapshot.retryable || note.lastSavedAt !== snapshot.lastSavedAt) note = noteOf(snapshot)
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => snapshot,
    getRefusedSnapshot: () => refused,
    getNoteSnapshot: () => note,
    getPendingWrite: () => snapshot.pending > 0 || snapshot.saving,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refreshCounts: () => {
      const next = readCounts()
      if (sameStatus(snapshot, next)) return
      const sameRefusedRows = sameRows(refused.refusedRowIds, next.refusedRowIds)
      if (refused.refused !== next.refused || !sameRefusedRows) {
        refused = { refused: next.refused, refusedRowIds: sameRefusedRows ? refused.refusedRowIds : next.refusedRowIds }
      }
      snapshot = { ...next, refusedRowIds: refused.refusedRowIds, lastSavedAt: snapshot.lastSavedAt }
      emit()
    },
    saved: (lastSavedAt: string) => {
      if (snapshot.lastSavedAt === lastSavedAt) return
      snapshot = { ...snapshot, lastSavedAt }
      emit()
    },
  }
}

export type SheetSaveStatusStore = ReturnType<typeof createSheetSaveStatusStore>
