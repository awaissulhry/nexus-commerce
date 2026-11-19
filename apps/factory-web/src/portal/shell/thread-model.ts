/**
 * The record conversation's rules the frame says in its own words (B-W2b-168's composer reasons; pure, held by
 * model.vitest.test.ts against factory-domain's constants: the domain's thread rules reach `node:crypto`, so a browser module
 * never imports them).
 */

/** The longest message (factory-domain threads/rules MAX_BODY_LENGTH): the Textarea counts toward it, never blocks. */
export const THREAD_BODY_LIMIT = 20_000

/** Why the person may not write here, as the words' key (factory-domain threads/partner COMPOSER_REASONS). */
export function threadHeldKey(reason: string | null): string {
  if (reason === 'PREVIEW' || reason === 'NO_COMMENT' || reason === 'CLOSED') return `thread.held.${reason}`
  return 'thread.held.other'
}

/** The record types a portal person can open (factory-domain search/partner views, THREAD_RECORDS), by their words' key. */
// B-W2b-197: a customer's return and complaint (their own partner views: Messages, search).
export const RECORD_TYPE_WORDS: readonly string[] = [
  'SalesOrder',
  'Quote',
  'Shipment',
  'Invoice',
  'Ddt',
  'PurchaseOrder',
  'SubcontractOrder',
  'ShipNotice',
  'Party',
  'ReturnAuthorisation',
  'Complaint',
  // ---- B-TH-253 (threads plan TH-5): a project the person was added to; B-TH-073: the brand's own style and sample round, each
  // discussed on its own page (their partner views, search group `samples`).
  'Project',
  'Style',
  'SampleRound',
  // ---- end B-TH-253
]

/** The words' key of a record type ("Order", "Purchase order"); an unknown type is "Record". */
export const recordTypeKey = (type: string): string => (RECORD_TYPE_WORDS.includes(type) ? `record.type.${type}` : 'record.type.other')

// ---- F-CP-156 (customer page plan C7, D12; 12 §5; B-CP-079): "Ask <name>, factory designer" under the portal thread ----------------
// The DS PartnerThread stays as it is: under it, a DS Checkbox "Ask Giulia Verdi, factory designer" with its hint. Typing "@" in the box
// shows ONE chip "Giulia Verdi · factory designer" — never another name, never a list of our people; pressing it puts "@Giulia Verdi "
// in the text and ticks the box. No name (none named for the customer) or a record the customer cannot ask on: no box. After Send:
// "We asked Giulia Verdi." — never whether she read it (no "seen by", Statuto art. 4). A 409 keeps the text, with its words.

/** The records whose thread may ask the factory designer (factory-domain threads/designer DESIGNER_ASK_RECORD_TYPES; a draft order too). */
export const DESIGNER_ASK_RECORDS: readonly string[] = Object.freeze(['PortalOrderRequest', 'SalesOrder', 'Inquiry', 'SampleRound', 'Project', 'Party', 'ReturnAuthorisation', 'Complaint'])

/** The box shows: a name to ask, a record the customer may ask on, and a box to write in (a held composer has no ask). */
export const designerBoxShows = (input: { readonly name: string | null; readonly type: string; readonly canPost: boolean }): boolean =>
  input.name !== null && input.name.trim() !== '' && input.canPost && DESIGNER_ASK_RECORDS.includes(input.type)

/** The "@" being typed at the end of the text ("…can the stripes @Gi"), or null: the chip shows while one is typed. */
const TRAILING_AT = /(^|\s)@([^\s@]*)$/

/**
 * Whether the ONE chip shows: an "@" is being typed at the end of the text and what follows it still matches the name (case and accents
 * aside); never once the name is in the text already.
 */
export function designerChipShows(text: string, name: string | null): boolean {
  if (!name) return false
  if (text.includes(`@${name}`)) return false
  const typed = TRAILING_AT.exec(text)
  if (!typed) return false
  const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  return fold(name).startsWith(fold(typed[2] ?? ''))
}

/** Pressing the chip: the "@…" being typed becomes "@<name> " (the text before it stays as it is). */
export function withDesignerMention(text: string, name: string): string {
  const typed = TRAILING_AT.exec(text)
  if (!typed) return `${text}${text === '' || /\s$/.test(text) ? '' : ' '}@${name} `
  return `${text.slice(0, typed.index + typed[1]!.length)}@${name} `
}

/** The API's refusal of an ask (409, nothing posted: the text stays) by its issues' paths, as the words' key; null: not one of these. */
export function designerRefusalKey(issuePaths: readonly string[]): string | null {
  const paths = issuePaths.map((path) => path.replace(/\./g, '/'))
  if (paths.includes('refusal/DESIGNER_NO_DESIGNER')) return 'thread.designer.noDesigner'
  if (paths.includes('refusal/DESIGNER_NOT_HERE')) return 'thread.designer.notHere'
  return null
}

/** What the page says after a post that asked: "We asked <name>.", or — the day's asks used up — that the message reached the team. */
export function designerAskedOf(answer: { readonly asked: boolean; readonly name: string | null } | null | undefined): { key: string; name?: string } | null {
  if (!answer) return null
  return answer.asked && answer.name ? { key: 'thread.designer.asked', name: answer.name } : { key: 'thread.designer.capped' }
}
// ---- end F-CP-156
