/**
 * AGW — the edit-mode draft store.
 *
 * In the hand-rolled grid a keystroke in an edit-mode input set React state on the grid and
 * re-rendered every cell on the page; it was fine for a `<table>`. Inside AG Grid a cell is a React
 * component AG mounts and refreshes on its own schedule, and re-rendering the whole grid for one
 * keystroke would mean `refreshCells({force:true})` on thousands of cells per key. So the drafts
 * live here — a tiny external store — and each editable cell subscribes to ITS OWN key through
 * `useSyncExternalStore`: a keystroke re-renders one input. The toolbar subscribes to the version,
 * so "Apply Changes" enables the instant a field becomes dirty, exactly as before.
 *
 * The shape is the one `collectEdits` (the shared diff) reads: `{ [rowId]: { [fieldKey]: value } }`.
 */
import type { EditDrafts } from '@/design-system/patterns/workspace-grid/editDrafts'

type Listener = () => void

export interface DraftStore {
  /** The current drafts — the SAME object identity until something changes (useSyncExternalStore needs that). */
  snapshot: () => EditDrafts
  get: (id: string, key: string) => string | undefined
  set: (id: string, key: string, value: string) => void
  reset: () => void
  /** Subscribe to one cell; the callback fires only when THAT cell's draft changes. */
  subscribeCell: (id: string, key: string, cb: Listener) => () => void
  /** Subscribe to every change (the toolbar's dirty count). */
  subscribeAll: (cb: Listener) => () => void
}

const cellKey = (id: string, key: string) => `${id}\u0000${key}`

export function createDraftStore(): DraftStore {
  let drafts: EditDrafts = {}
  const cellListeners = new Map<string, Set<Listener>>()
  const allListeners = new Set<Listener>()

  const notifyCell = (id: string, key: string) => {
    cellListeners.get(cellKey(id, key))?.forEach((cb) => cb())
    allListeners.forEach((cb) => cb())
  }

  return {
    snapshot: () => drafts,
    get: (id, key) => drafts[id]?.[key],
    set: (id, key, value) => {
      if (drafts[id]?.[key] === value) return
      // A new object at every level that changed: `collectEdits` and the version subscribers
      // compare identities, never contents.
      drafts = { ...drafts, [id]: { ...drafts[id], [key]: value } }
      notifyCell(id, key)
    },
    reset: () => {
      if (Object.keys(drafts).length === 0) return
      const old = drafts
      drafts = {}
      for (const id of Object.keys(old)) for (const key of Object.keys(old[id])) cellListeners.get(cellKey(id, key))?.forEach((cb) => cb())
      allListeners.forEach((cb) => cb())
    },
    subscribeCell: (id, key, cb) => {
      const k = cellKey(id, key)
      let set = cellListeners.get(k)
      if (!set) { set = new Set(); cellListeners.set(k, set) }
      set.add(cb)
      return () => {
        set!.delete(cb)
        if (set!.size === 0) cellListeners.delete(k)
      }
    },
    subscribeAll: (cb) => {
      allListeners.add(cb)
      return () => { allListeners.delete(cb) }
    },
  }
}
