'use client'

import { useLiveBus } from '../../../shell/live/use-live'
import type { LiveChange } from '../../../record-panels/model'
import type { LiveState } from './model'

// B-TH-260: the record's tab is `partyTabOf` (model.ts: every old `?tab=` mapped); its thread docks in the shared RecordFrame (the dock
// hook copy went).

/**
 * The live stream (`GET /live` through this app's `/api`, the parties' events: party.created, party.updated,
 * party.status_changed, party.addresses_changed, party.contacts_changed, party.tax_identity_changed, party.vies_checked)
 * with its state in words: connecting, live, offline (the browser's EventSource reconnects by itself; after a break the
 * screen reads everything again). A message is a hint: the screen reads the part again.
 */
export function useLive(onChange: (change: LiveChange) => void, onReconnect: () => void): LiveState {
  // B-W2b-05: the tab's ONE live connection (shell/live/bus.ts), shared with the bell and every other screen.
  return useLiveBus({ onChange, onReconnect })
}

/** A parties' event (`party.*`), and the party it is about. */
export function partyEvent(change: LiveChange): { partyId: string | null } | null {
  if (!change.type.startsWith('party.')) return null
  const id = change.fields.partyId
  return { partyId: typeof id === 'string' ? id : null }
}

/** The byte-order mark spreadsheet programs need to read a UTF-8 CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff)

/** Downloads text as a file (Export ▾ "This view (CSV)"): a Blob link, clicked once. */
export function downloadText(name: string, text: string, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([`${BOM}${text}`], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
