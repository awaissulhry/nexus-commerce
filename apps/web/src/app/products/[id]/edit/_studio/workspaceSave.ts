import type { SaveReporter, StudioSaveState } from './types'
import { emptyLedger, ledgerCleared, ledgerPending, ledgerResolved, ledgerState, type SaveLedger } from './saveState'

/** Each reporter closes over its destination, including after its tab has unmounted. */
export interface PublicationSaveBarrier {
  flush(): Promise<void>
  blocker(): string | null
}

export function createWorkspaceSaveStore(changed: () => void) {
  const entries = new Map<string, { ledger: SaveLedger; message?: string; reporter: SaveReporter }>()
  const barriers = new Set<PublicationSaveBarrier>()
  const publicationState = (): StudioSaveState => {
    const states = [...entries.values()].map(entry => ledgerState(entry.ledger, entry.message))
    const error = states.find(state => state.kind === 'error')
    if (error) return error
    const pending = states.reduce((count, state) => count + (state.kind === 'saving' ? state.pending : 0), 0)
    if (pending) return { kind: 'saving', pending }
    return states.filter(state => state.kind === 'saved').sort((a, b) => b.at - a.at)[0] ?? { kind: 'idle' }
  }
  const publicationBlocker = (canChangeEditor?: () => boolean) => {
    if (canChangeEditor?.() === false) return 'Save or discard changes in the open editor before publishing.'
    for (const barrier of barriers) {
      const message = barrier.blocker()
      if (message) return message
    }
    const state = publicationState()
    return state.kind === 'error' ? `Resolve unsaved changes before publishing: ${state.message}`
      : state.kind === 'saving' ? 'Changes are still saving. Wait for confirmation before publishing.' : null
  }
  return {
    publicationState,
    publicationBlocker,
    registerPublicationBarrier(barrier: PublicationSaveBarrier) {
      barriers.add(barrier)
      return () => { barriers.delete(barrier) }
    },
    async preparePublication(canChangeEditor?: () => boolean) {
      await Promise.all([...barriers].map(barrier => barrier.flush()))
      return publicationBlocker(canChangeEditor)
    },
    forScope(key: string) {
      let entry = entries.get(key)
      if (!entry) {
        const next = { ledger: emptyLedger, message: undefined as string | undefined, reporter: {} as SaveReporter }
        next.reporter = {
          pending(id, subject) { next.ledger = ledgerPending(next.ledger, id, subject); changed() },
          resolved(id, ok, message, subject) { next.ledger = ledgerResolved(next.ledger, id, ok, Date.now(), subject); next.message = message; changed() },
          cleared(subjects) { next.ledger = ledgerCleared(next.ledger, subjects); changed() },
        }
        entry = next
        entries.set(key, entry)
      }
      return { state: ledgerState(entry.ledger, entry.message), reporter: entry.reporter }
    },
  }
}
