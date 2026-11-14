import { describe, expect, it } from 'vitest'
import {
  bounceKindOf,
  bounceTaskWords,
  captureAddressOf,
  captureTokensOf,
  deliveryStateOf,
  forwardedOf,
  forwardedTextOf,
  guardRefusalWords,
  inboxNameProblem,
  inquiryAddressIn,
  inquiryAddressProblems,
  localPartProblem,
  plainSubject,
  recordNumbersIn,
  secretEndOf,
  teamInboxOf,
  untilProblem,
  webhookSecretProblem,
  workRefusal,
  workStateOf,
} from './rules'

// Made-up addresses only (example.invalid style).
const DOMAIN = 'reply.company-a.example.invalid'
const TOKEN = 'abcdefghijklmnopqrstuvwxyz'

describe('the capture address', () => {
  it('is c-<token>@<reply domain>, and only a 26-character base32 token at a reply domain of the tenant names one', () => {
    expect(captureAddressOf(TOKEN, 'Reply.Company-A.example.invalid')).toBe(`c-${TOKEN}@${DOMAIN}`)
    expect(captureTokensOf([`C-${TOKEN.toUpperCase()}@${DOMAIN}`, `c-${TOKEN}@${DOMAIN}`, `c-${TOKEN}@elsewhere.example.invalid`, `r-${TOKEN}@${DOMAIN}`, `c-short@${DOMAIN}`], [DOMAIN])).toEqual([TOKEN])
    expect(captureTokensOf(['not an address'], [DOMAIN])).toEqual([])
  })

  it('finds the forwarded mail: its marker, its sender, and the part the partner wrote', () => {
    const text = 'Puoi guardare?\n\n---------- Forwarded message ---------\nFrom: Anna Rossi <Anna@Pista.example.invalid>\nDate: Mon, 9 Nov 2026\nSubject: taglie\n\nCiao, ci servono le taglie.'
    const found = forwardedOf(text)
    expect(found).toMatchObject({ address: 'anna@pista.example.invalid', name: 'Anna Rossi' })
    expect(forwardedTextOf(text, found!.start)).toMatch(/^---------- Forwarded message/)
    expect(forwardedTextOf(text, found!.start)).not.toContain('Puoi guardare')
    // Italian clients, Outlook's line, a bare address.
    expect(forwardedOf('---------- Messaggio inoltrato ---------\nDa: ufficio@brand.example.invalid\nData: oggi')).toMatchObject({ address: 'ufficio@brand.example.invalid', name: null })
    expect(forwardedOf('Vedi sotto\n________________________________\nFrom: Buyer <buyer@brand.example.invalid>\nSent: Monday')).toMatchObject({ address: 'buyer@brand.example.invalid' })
    expect(forwardedOf('Just a note, nothing forwarded.')).toBeNull()
    expect(forwardedOf('---------- Forwarded message ---------\nFrom: nobody')).toBeNull()
    expect(forwardedOf(null)).toBeNull()
  })

  it('reads subjects: without their forward and reply prefixes, and the record numbers they name', () => {
    expect(plainSubject('Fwd: Re: R: ordine 42')).toBe('ordine 42')
    expect(recordNumbersIn('Fwd: Re: SO-2026-00042 sizes, and QT-2026-00007.')).toEqual(['SO-2026-00042', 'QT-2026-00007'])
    expect(recordNumbersIn('ordine 42 del 2026')).toEqual([])
    expect(recordNumbersIn(null)).toEqual([])
  })
})

describe('team inboxes', () => {
  const inboxes = [
    { id: 'orders', localPart: 'orders', active: true },
    { id: 'old', localPart: 'samples', active: false },
  ]

  it('takes a mail by the local part of a recipient at a reply domain of its company, switched on only', () => {
    expect(teamInboxOf([`Orders@${DOMAIN}`], [DOMAIN], inboxes)).toBe('orders')
    expect(teamInboxOf([`samples@${DOMAIN}`], [DOMAIN], inboxes)).toBeNull()
    expect(teamInboxOf(['orders@elsewhere.example.invalid'], [DOMAIN], inboxes)).toBeNull()
  })

  it('checks the address before the @ and the name', () => {
    expect(localPartProblem('orders')).toBeNull()
    expect(localPartProblem('ordini.italia+1')).toBeNull()
    expect(localPartProblem('Orders')).not.toBeNull()
    expect(localPartProblem('r-orders')).toMatch(/reply and capture/)
    expect(localPartProblem('c-orders')).toMatch(/reply and capture/)
    expect(inboxNameProblem('Orders')).toBeNull()
    expect(inboxNameProblem('  ')).not.toBeNull()
    expect(inboxNameProblem('two\nlines')).not.toBeNull()
  })

  it('says where a mail is: closed wins, a snooze in the future hides it, a passed one is over', () => {
    const now = new Date('2026-11-14T10:00:00Z')
    expect(workStateOf({ closedAt: now, snoozedUntil: null, followUpUntil: null }, now)).toBe('CLOSED')
    expect(workStateOf({ closedAt: null, snoozedUntil: new Date('2026-11-14T12:00:00Z'), followUpUntil: null }, now)).toBe('SNOOZED')
    expect(workStateOf({ closedAt: null, snoozedUntil: new Date('2026-11-14T09:00:00Z'), followUpUntil: null }, now)).toBe('OPEN')
  })

  it('keeps snoozes and follow-ups between 5 minutes and 90 days ahead; a REJECTED mail or one in no inbox is refused', () => {
    const now = new Date('2026-11-14T10:00:00Z')
    expect(untilProblem(new Date('2026-11-14T10:10:00Z'), now)).toBeNull()
    expect(untilProblem(new Date('2026-11-14T10:01:00Z'), now)).toMatch(/5 minutes/)
    expect(untilProblem(new Date('2027-03-01T10:00:00Z'), now)).toMatch(/90 days/)
    expect(workRefusal({ status: 'REJECTED', teamInboxId: 'x' })).toMatch(/thrown away/)
    expect(workRefusal({ status: 'TRIAGE', teamInboxId: null })).toMatch(/no team inbox/)
    expect(workRefusal({ status: 'MATCHED', teamInboxId: 'x' })).toBeNull()
  })
})

describe('delivery status', () => {
  it('maps SES bounce types and the outbound status to what the thread shows', () => {
    expect(bounceKindOf('Permanent')).toBe('PERMANENT')
    expect(bounceKindOf('Transient')).toBe('TRANSIENT')
    expect(bounceKindOf('Undetermined')).toBe('UNDETERMINED')
    expect(bounceKindOf('Something new')).toBe('UNDETERMINED')
    expect(deliveryStateOf('QUEUED', null)).toBe('WAITING')
    expect(deliveryStateOf('SENDING', null)).toBe('WAITING')
    expect(deliveryStateOf('SENT', null)).toBe('SENT')
    expect(deliveryStateOf('SENT', 'TRANSIENT')).toBe('SOFT_BOUNCE')
    expect(deliveryStateOf('DELIVERED', null)).toBe('DELIVERED')
    expect(deliveryStateOf('BOUNCED', 'PERMANENT')).toBe('BOUNCED')
    expect(deliveryStateOf('FAILED', null)).toBe('FAILED')
  })

  it('words the bounce task in the sender’s language', () => {
    expect(bounceTaskWords('en', { kind: 'PERMANENT', subject: 'Sizes', record: 'SO-2026-00001' }).title).toBe('Mail bounced: Sizes (SO-2026-00001)')
    expect(bounceTaskWords('it', { kind: 'TRANSIENT', subject: 'Taglie', record: null }).title).toBe('Mail non consegnata: Taglie')
    expect(bounceTaskWords(null, { kind: 'PERMANENT', subject: 'x'.repeat(300), record: null }).title.length).toBeLessThanOrEqual(200)
  })
})

describe('inquiry addresses, the webhook secret and the guards’ words', () => {
  it('checks a list: addresses, each once, at most 20', () => {
    expect(inquiryAddressProblems(['sales@reply.company-a.example.invalid'])).toEqual([])
    expect(inquiryAddressProblems(['sales@x.example.invalid', 'SALES@x.example.invalid']).map((issue) => issue.path)).toEqual(['body/addresses/1'])
    expect(inquiryAddressProblems(['not-an-address'])).toHaveLength(1)
    expect(inquiryAddressProblems(Array.from({ length: 21 }, (_, index) => `s${index}@x.example.invalid`))[0]!.path).toBe('body/addresses')
    expect(inquiryAddressIn(['other@x.example.invalid', 'SALES@x.example.invalid'], ['sales@x.example.invalid'])).toBe('sales@x.example.invalid')
    expect(inquiryAddressIn(['other@x.example.invalid'], ['sales@x.example.invalid'])).toBeNull()
  })

  it('takes a secret of 32 to 256 printable characters and shows only its last four', () => {
    expect(webhookSecretProblem('whsec_made_up_for_tests_000000000001')).toBeNull()
    expect(webhookSecretProblem('short')).not.toBeNull()
    expect(webhookSecretProblem('with a space in it, long enough to pass the length')).not.toBeNull()
    expect(secretEndOf('whsec_made_up_4F2A')).toBe('4F2A')
  })

  it('turns the guards’ refusals into sentences, and leaves others alone', () => {
    expect(guardRefusalWords('email-in: mail 1 is REJECTED; it changes no more')).toBe('Mail 1 is REJECTED; it changes no more.')
    expect(guardRefusalWords('sales: an inquiry address is listed twice.')).toBe('An inquiry address is listed twice.')
    expect(guardRefusalWords('threads: something')).toBeNull()
  })
})
