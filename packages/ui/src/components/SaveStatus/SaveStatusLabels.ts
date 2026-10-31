/**
 * `SaveStatus`'s words (B-W2b-09, D6). English by default; a host passes the words it translates. A word with a number
 * in it is a function: the host writes its own plural forms.
 */
export interface SaveStatusLabels {
  /** Saved, no time known. */
  saved: string
  /** Saved at a time: "All changes saved · 10:42". */
  savedAt: (time: string) => string
  /** A save is under way. */
  saving: string
  /** Saves that failed: "1 change not saved". */
  failed: (count: number) => string
  /** The failed state's button. */
  retry: string
  /** A form with changes not saved yet, count unknown. */
  unsaved: string
  /** A form with this many changes not saved yet: "3 unsaved changes". */
  unsavedCount: (count: number) => string
  /** No connection, nothing waiting. */
  offline: string
  /** No connection, changes waiting to be sent: "Offline — 2 changes wait to be sent". */
  offlineCount: (count: number) => string
  /** The group's name for a screen reader. */
  region: string
}

export const SAVE_STATUS_LABELS: SaveStatusLabels = {
  saved: 'All changes saved',
  savedAt: (time) => `All changes saved · ${time}`,
  saving: 'Saving…',
  failed: (count) => (count === 1 ? '1 change not saved' : `${count} changes not saved`),
  retry: 'Retry',
  unsaved: 'Unsaved changes',
  unsavedCount: (count) => (count === 1 ? '1 unsaved change' : `${count} unsaved changes`),
  offline: 'Offline',
  offlineCount: (count) => (count === 1 ? 'Offline — 1 change waits to be sent' : `Offline — ${count} changes wait to be sent`),
  region: 'Save status',
}
