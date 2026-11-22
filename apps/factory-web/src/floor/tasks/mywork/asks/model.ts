/**
 * F-OF-204 (order FILES tab W2; 10-design §8 "Floor") — "Files asked" on My work, without a screen: one card per ask a team, a floor role
 * or a step of this tablet holds — what · the step · the work order · the customer's floor code (never its name) · due and "2 days late"
 * (L6: a team's card names nobody) · "The office asks: …" · "Asked again: …" · "The office asked for an update, …"; no worker's name, no
 * "seen", no count per person. A photo needs the network (L8: the camera waits while offline). Pure.
 */

export interface FloorAsk {
  readonly askId: string
  /** The office's words (a floor ask is never priced, never body data: the words always come). */
  readonly words: string | null
  readonly dueOn: string
  readonly lateDays: number
  readonly workOrder: { readonly id: string; readonly number: string }
  readonly step: { readonly id: string; readonly seq: number; readonly name: string } | null
  /** The floor's customer code (never its name). */
  readonly customer: string | null
  readonly askedAgain: string | null
  readonly chasedAt: string | null
}

/** The cards in the order a floor reads them: the most late first, then the nearest due day. */
export const floorAskCards = (asks: readonly FloorAsk[]): FloorAsk[] => [...asks].sort((a, b) => b.lateDays - a.lateDays || (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0))

/** Why the photo is held (a key of `floor-mywork`), or null: offline the camera waits (L8); one send at a time. */
export const askPhotoHeld = (input: { readonly online: boolean; readonly busy: boolean }): string | null => (!input.online ? 'asked.offline' : input.busy ? 'asked.sending' : null)

/** After a send: sent (the ask arrived at the office), closed meanwhile (the photo went on the work order as a note), or failed (try again). */
export type AskPhotoOutcome = 'sent' | 'closed' | 'failed'

/** What came of a send (S2 #1881): the note posted and answered the ask; posted but the ask was closed meanwhile (`answered` false); failed. */
export const outcomeOf = (result: { readonly ok: true; readonly answered: boolean } | { readonly ok: false }): AskPhotoOutcome => (result.ok ? (result.answered ? 'sent' : 'closed') : 'failed')
