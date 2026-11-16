import { defineDesignScreen } from '../../design/design-screen'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import type { ComposerContext } from '../composer/model'
import { OFFICE_PEOPLE } from '../demo-data'
import type { Contact, Recipient, SendCheck } from './model'
import { SendCase, type SendCaseModel } from './view/SendCase'

/**
 * SCR-006-send — know who gets it before it goes (B-TH-207, T7; picture 5, approved 2026-11-17). Made-up data: the brand-wall
 * helpers' Brand Alpha (the record's customer) and Brand Beta (another customer). Each case is a state of the picture: a reply
 * ready (To filled from the record's contact, Subject folded), every warning with another customer's address refused until
 * "Send outside this customer" is ticked, the tick given, nothing to check, checking, the check could not run (Send still
 * possible), the check refused, and Brand Beta's copy (To suggests only Brand Beta's contacts). Undo send waits for B-TH-048.
 */

const ORDER: ComposerContext = { recordType: 'SalesOrder', recordLabel: BRAND_ALPHA.numbers.order, party: { name: BRAND_ALPHA.tradeName }, can: { post: true, email: true, manage: false }, people: OFFICE_PEOPLE }
const ALPHA = { id: 'a1a1a1a1-0000-4000-8000-0000000000aa', name: BRAND_ALPHA.tradeName }
const BETA = { id: 'b2b2b2b2-0000-4000-8000-0000000000bb', name: BRAND_BETA.tradeName }

const CONTACTS = (brand = BRAND_ALPHA): Contact[] => [brand.contact, brand.portalPerson].map((person) => ({ name: person.name, email: person.email }))
const alma: Recipient = { address: BRAND_ALPHA.contact.email, name: BRAND_ALPHA.contact.name, kind: 'PARTY', organisation: BRAND_ALPHA.tradeName }
const bruno: Recipient = { address: BRAND_BETA.contact.email, name: BRAND_BETA.contact.name, kind: 'OTHER_PARTY', organisation: BRAND_BETA.tradeName }
const stranger: Recipient = { address: 'someone@post.example.com', name: null, kind: 'UNKNOWN', organisation: null }

const EVERYTHING: SendCheck = {
  party: ALPHA,
  recipients: [
    { address: alma.address, kind: 'PARTY', source: 'CONTACT', organisation: ALPHA, personName: alma.name },
    { address: bruno.address, kind: 'OTHER_PARTY', source: 'CONTACT', organisation: BETA, personName: bruno.name },
    { address: stranger.address, kind: 'UNKNOWN', source: null, organisation: null, personName: null },
  ],
  warnings: [
    { code: 'OTHER_ORGANISATION', items: [BETA.name] },
    { code: 'UNKNOWN_RECIPIENT', items: [stranger.address] },
    { code: 'MENTIONS_COST', items: ['price'] },
    { code: 'NAMES_OTHER_CUSTOMER', items: [BETA.name] },
    { code: 'INTERNAL_MENTION', items: ['Bea Esempio'] },
    { code: 'OFFICE_FILE', items: ['cost-sheet-v3.xlsx'] },
  ],
  attachments: [{ id: 'f1', name: 'cost-sheet-v3.xlsx', sizeBytes: 96_000, audience: 'OFFICE' }],
  outsideCustomer: [bruno.address],
}
const WITHOUT_OFFICE_FILE: SendCheck = { ...EVERYTHING, warnings: EVERYTHING.warnings.filter((warning) => warning.code !== 'OFFICE_FILE'), attachments: [] }
const CLEAN: SendCheck = { party: ALPHA, recipients: [EVERYTHING.recipients[0]], warnings: [], attachments: [], outsideCustomer: [] }

const REPLY = { mode: 'reply' as const, body: 'Hello Alma,\nthe photos of the first pieces are attached. Cutting starts on Thursday.\nAlex', forFloor: false }
const base: SendCaseModel = { context: ORDER, draft: REPLY, to: [alma], cc: [], subject: `Re: ${BRAND_ALPHA.numbers.order} · pre-production sample`, contacts: CONTACTS(), files: 1 }
const warned: SendCaseModel = { ...base, cc: [bruno, stranger], draft: { ...REPLY, body: 'Hello Alma,\nthe price for the second run stays as Brand Beta got it. @Bea Esempio please check.\nAlex' } }

export const designScreen = defineDesignScreen<SendCaseModel>({
  screen: 'SCR-006-send',
  title: 'Record thread · To, Cc and the send check (T7)',
  view: SendCase,
  cases: [
    { id: 'reply', label: 'Reply ready', model: base, note: 'To is filled from the record’s contact, with the organisation; Cc behind its button; Subject folded (click to change it). Type in To: only Brand Alpha’s contacts are suggested.' },
    { id: 'warnings', label: 'Every warning', model: { ...warned, check: { status: 'ready', check: EVERYTHING } }, note: 'Another customer’s address refused until “Send outside this customer” is ticked (recorded), an unknown address, money words, another customer named, a colleague’s @mention, an office file (back to the text).' },
    { id: 'ticked', label: 'Send outside this customer, ticked', model: { ...warned, check: { status: 'ready', check: WITHOUT_OFFICE_FILE }, outside: true }, note: 'The tick is on and no office file: “Send to Brand Alpha” may go (Enter). The API records the tick with the send.' },
    { id: 'clean', label: 'Nothing to check', model: { ...base, check: { status: 'ready', check: CLEAN } } },
    { id: 'checking', label: 'Checking', model: { ...base, check: { status: 'checking' } } },
    { id: 'failed', label: 'Could not check', model: { ...base, check: { status: 'error', problem: 'problem.unavailable', retry: true } }, note: 'Send is still possible: the factory refuses another customer’s address on its own.' },
    { id: 'refused', label: 'No right to send', model: { ...base, check: { status: 'error', problem: 'problem.forbidden', retry: false } } },
    { id: 'no-recipient', label: 'No recipient', model: { ...base, to: [] }, note: 'Send waits: “Add a recipient”.' },
    {
      id: 'brand-beta',
      label: 'Brand Beta’s copy (brand wall)',
      model: { ...base, context: { ...ORDER, recordLabel: BRAND_BETA.numbers.order, party: { name: BRAND_BETA.tradeName } }, to: [{ ...bruno, kind: 'PARTY' }], contacts: CONTACTS(BRAND_BETA), subject: `Re: ${BRAND_BETA.numbers.order}`, draft: { ...REPLY, body: 'Hello Bruno,\nthe photos follow.\nAlex' } },
      note: 'On Brand Beta’s order To suggests only Brand Beta’s contacts: nothing of Brand Alpha.',
    },
  ],
})
