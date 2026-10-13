// Autosave ordering shared by the two PO editors: the draft editor
// (EditableSummaryPane) and the revision editor (RevisionEditor in
// [id]/PurchaseOrderDetailClient.tsx). No React in here, so the rules are
// tested on their own (po-autosave.vitest.test.ts).
//
// The rules:
//   - The draft is read when a save is SENT, not when its timer started. The
//     editors keep the draft in a ref and the save callback reads it, so the
//     last keystroke goes out.
//   - One save at a time. An edit during a save waits behind it; a newer edit
//     replaces the waiting one (one waiting slot, which reads the draft when
//     it is sent).
//   - flush() sends now and resolves once nothing waits or runs — "Apply"
//     waits on it.
//   - A server copy replaces the draft only when it is newer than the version
//     this editor knows and nothing is unsaved (mayReseed). The echo of our
//     own save carries the version that save returned, so it is never newer.
//   - A read ticket drops a response when a newer read has started, so an
//     older answer never overwrites a newer one.

export interface SaveQueue {
  /** An edit happened: (re)start the quiet timer. The save runs when it ends. */
  schedule(): void
  /** Send now. Resolves once nothing waits or runs: true when the last save went through. */
  flush(): Promise<boolean>
  /** Drop the timer and a waiting save (the draft is being replaced by the server's copy). */
  cancel(): void
  /** True while a save waits on the timer, waits behind another save, or runs. */
  busy(): boolean
}

export interface SaveQueueOptions {
  /** Sends the draft as it is NOW. True when it saved (or there was nothing to save), false when it failed. */
  save: () => Promise<boolean>
  /** Quiet time after the last edit before the save runs. */
  delayMs: number
  /** Called when a save run ends and no other save waits. */
  onIdle?: () => void
}

export function createSaveQueue({ save, delayMs, onIdle }: SaveQueueOptions): SaveQueue {
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<boolean> | null = null
  let waiting = false

  const stopTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const drain = async (): Promise<boolean> => {
    let ok = true
    do {
      waiting = false
      try {
        ok = await save()
      } catch {
        ok = false
      }
    } while (waiting)
    running = null
    if (timer === null) onIdle?.()
    return ok
  }

  const flush = (): Promise<boolean> => {
    stopTimer()
    if (running) {
      waiting = true
      return running
    }
    // Started on the next microtask so `running` is set before the first save begins.
    running = Promise.resolve().then(drain)
    return running
  }

  return {
    schedule() {
      stopTimer()
      timer = setTimeout(() => {
        timer = null
        void flush()
      }, delayMs)
    },
    flush,
    cancel() {
      stopTimer()
      waiting = false
    },
    busy: () => timer !== null || running !== null,
  }
}

/**
 * Whether a server copy may replace the editor's draft.
 *   serverVersion   — the version on the copy that just arrived.
 *   knownVersion    — the newest version this editor knows: the one it was seeded with, or the one its own
 *                     last save returned.
 *   unsaved         — an edit waits, a save runs, or the draft differs from what the server last accepted.
 *   conflictVersion — after a conflict (409): the server version the editor must take, unsaved edits or not.
 */
export function mayReseed({
  serverVersion,
  knownVersion,
  unsaved,
  conflictVersion = null,
}: {
  serverVersion: number
  knownVersion: number
  unsaved: boolean
  conflictVersion?: number | null
}): boolean {
  if (conflictVersion !== null) return serverVersion >= conflictVersion
  return !unsaved && serverVersion > knownVersion
}

export interface ReadTicket {
  /** Call when a read starts; keep the number. */
  take(): number
  /** True when no read started after this one. */
  isLatest(ticket: number): boolean
}

export function createReadTicket(): ReadTicket {
  let latest = 0
  return {
    take: () => ++latest,
    isLatest: (ticket) => ticket === latest,
  }
}
