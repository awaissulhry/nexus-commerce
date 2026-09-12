import type { SaveReporter } from './types'
import { emptyLedger, ledgerCleared, ledgerPending, ledgerResolved, ledgerState, type SaveLedger } from './saveState'

/** Each reporter closes over its destination, including after its tab has unmounted. */
export function createWorkspaceSaveStore(changed: () => void) {
  const entries = new Map<string, { ledger: SaveLedger; message?: string; reporter: SaveReporter }>()
  return {
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
