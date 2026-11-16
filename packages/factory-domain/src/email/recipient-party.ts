/**
 * B-TH-004 (threads plan TH-0, WALL-G03/G04/G05; the brand wall, Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand. But we, as the production unit, should be able to see it all."): ONE recipient rule for
 * every mail that goes out on a record of a party (a customer, a supplier, a subcontractor) — a thread mail, a module's send
 * (order confirmation, quote, statement, complaint answer …: all of them go through email-out's sendEmail), and the address a
 * one-off link is made for:
 *
 *   - an address that is a contact or a portal person of the record's OWN party passes — also when another party knows it
 *     too (a contact of both, an agent who works for several);
 *   - an address that is NOT the record's party's and IS a contact or a portal person of ANOTHER party is refused, unless the
 *     person ticks "Send outside this customer" (the tick is recorded in the send's audit row with what it let through);
 *   - an address nobody knows passes (the mis-send check warns "unknown recipient"; the person decides);
 *   - a blind copy (Bcc) of a party's mail goes only to our own people (a colleague, an address at a domain we send from or
 *     receive replies at) or to the party's own: never to anybody else, tick or not — a hidden recipient the customer never
 *     sees is exactly what the wall forbids.
 *
 * A record without a party (a company's, a person's) has no outside to protect: nothing here applies. Pure: the API reads the
 * facts (whose each address is) and asks.
 */

/** What we know of one address, as email-out's mis-send check reads it. */
export interface AddressOwnership {
  readonly address: string
  /** The parties the address is a contact or a portal person of. */
  readonly parties: readonly string[]
  /** An office person of ours has it, or it is at a domain we send from or receive replies at. */
  readonly ours: boolean
}

/** One address the rule holds back, and the other parties it belongs to. */
export interface OutsideAddress {
  readonly address: string
  readonly field: 'to' | 'cc' | 'bcc'
  readonly index: number
  readonly parties: readonly string[]
}

export interface RecipientRuleInput {
  /** The record's party; null: the rule does not apply. */
  readonly recordParty: string | null
  readonly to: readonly string[]
  readonly cc?: readonly string[] | undefined
  readonly bcc?: readonly string[] | undefined
  /** Whose each address is (an address missing here is nobody's we know). */
  readonly ownership: ReadonlyMap<string, AddressOwnership>
}

export interface RecipientRuleResult {
  /** To and Cc addresses of another party (held back unless the person ticks "Send outside this customer"). */
  readonly outside: readonly OutsideAddress[]
  /** Bcc addresses that are neither ours nor the party's (refused, tick or not). */
  readonly hiddenOutside: readonly OutsideAddress[]
}

const key = (address: string): string => address.trim().toLowerCase()

/** Whether an address is the record's party's own (a contact or portal person of it), whatever else it is. */
export function isOwnAddress(recordParty: string, ownership: AddressOwnership | undefined): boolean {
  return ownership !== undefined && ownership.parties.includes(recordParty)
}

/** The rule (see above): the To/Cc addresses of another party, and the Bcc addresses that are not ours nor the party's. */
export function recipientRule(input: RecipientRuleInput): RecipientRuleResult {
  if (input.recordParty === null) return { outside: [], hiddenOutside: [] }
  const party = input.recordParty
  const ownershipOf = (address: string) => input.ownership.get(key(address))
  const outside: OutsideAddress[] = []
  for (const field of ['to', 'cc'] as const) {
    ;(input[field] ?? []).forEach((address, index) => {
      const known = ownershipOf(address)
      if (!known || isOwnAddress(party, known)) return
      const others = known.parties.filter((other) => other !== party)
      if (others.length > 0) outside.push({ address: key(address), field, index, parties: others })
    })
  }
  const hiddenOutside: OutsideAddress[] = []
  ;(input.bcc ?? []).forEach((address, index) => {
    const known = ownershipOf(address)
    if (known && (known.ours || isOwnAddress(party, known))) return
    hiddenOutside.push({ address: key(address), field: 'bcc', index, parties: known?.parties.filter((other) => other !== party) ?? [] })
  })
  return { outside, hiddenOutside }
}

/** The refusal's codes (409 `refusal/<CODE>`), and the words in Italian and English. The office reads the real reason. */
export const RECIPIENT_REFUSALS = Object.freeze({
  /** To or Cc holds an address of another customer, supplier or subcontractor: tick "Send outside this customer" to send. */
  OTHER_PARTY: Object.freeze({
    it: 'Uno o più indirizzi appartengono a un altro cliente o fornitore. Spunta «Invia fuori da questo cliente» per inviare comunque.',
    en: 'One or more addresses belong to another customer or supplier. Tick “Send outside this customer” to send anyway.',
  }),
  /** A Bcc that is neither ours nor the party's own: refused, tick or not. */
  HIDDEN_OUTSIDE: Object.freeze({
    it: 'Una copia nascosta (Ccn) della posta di un cliente va solo ai nostri colleghi o ai contatti del cliente stesso.',
    en: 'A blind copy (Bcc) of a customer’s mail goes only to our own colleagues or to the customer’s own contacts.',
  }),
})
export type RecipientRefusal = keyof typeof RECIPIENT_REFUSALS

/** The words of one address held back, for the office (which may name the other party: the office sees every customer). */
export function outsideAddressWords(address: OutsideAddress, nameOf: (partyId: string) => string): string {
  const names = address.parties.map(nameOf).filter((name) => name.trim() !== '')
  return names.length > 0 ? `${address.address} belongs to ${names.join(', ')}.` : `${address.address} is not one of ours nor of this customer.`
}
