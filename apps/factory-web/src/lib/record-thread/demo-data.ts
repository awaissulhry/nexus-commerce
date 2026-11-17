import { BRAND_ALPHA, type BrandFixture } from '../testing/two-brands'
import type { CardMessage } from './card/model'

/**
 * Made-up data for the record thread's design cases and tests (PLAN §3.1): the two brands of the brand-wall helpers (B-TH-203,
 * lib/testing/two-brands) and the design kit's fake office people (Alex Demo, Bea Esempio, Carlo Prova). A thread is drawn for
 * ONE brand: `demoThread(BRAND_BETA)` is Brand Beta's copy, which a brand-wall test scans for Brand Alpha (nothing may show).
 * Nothing here is real; addresses are `example` domains.
 */

export const OFFICE_PEOPLE = Object.freeze([
  { id: '0190f0e2-4370-7000-8000-00000000a001', name: 'Alex Demo' },
  { id: '0190f0e2-4370-7000-8000-00000000a002', name: 'Bea Esempio' },
  { id: '0190f0e2-4370-7000-8000-00000000a003', name: 'Carlo Prova' },
])

/** A fixed "now" for the cases: Tuesday 17 Nov 2026, 11:00 in Rome. */
export const DEMO_NOW = '2026-11-17T10:00:00.000Z'

const at = (day: number, hhmm: string) => {
  const [hours, minutes] = hhmm.split(':').map(Number)
  // Rome is UTC+1 in November.
  return new Date(Date.UTC(2026, 10, day, hours - 1, minutes)).toISOString()
}

let seq = 0
const id = (brand: BrandFixture, n: number) => `${brand.key === 'alpha' ? 'a1a1a1a1' : 'b2b2b2b2'}-0000-4000-8000-${String(900000 + n).padStart(12, '0')}`

/** The brand's thread on its sales order: older mail, a note, our mail with files, the customer's portal answers. */
export function demoThread(brand: BrandFixture = BRAND_ALPHA): CardMessage[] {
  seq = 0
  const next = () => id(brand, ++seq)
  const contact = brand.contact.name
  const order = brand.numbers.order
  const older: CardMessage[] = Array.from({ length: 12 }, (_, index) => ({
    id: next(),
    kind: index % 3 === 1 ? 'note' : index % 3 === 0 ? 'theirs' : 'ours',
    channel: index % 3 === 1 ? 'APP' : 'EMAIL',
    author: index % 3 === 0 ? contact : index % 3 === 1 ? 'Bea Esempio' : 'Alex Demo',
    authorKind: index % 3 === 0 ? 'PARTY' : 'USER',
    at: at(2 + Math.floor(index * 0.7), `${String(9 + (index % 7)).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}`),
    body: index % 3 === 0 ? `About ${order}: the second size run, point ${index + 1}.` : index % 3 === 1 ? `Checked with cutting, point ${index + 1}.` : `Thank you, point ${index + 1} is noted.`,
    mentions: [],
    files: [],
    email: index % 3 === 2 ? { to: [brand.contact.email], subject: `Re: ${order}`, status: 'DELIVERED' } : null,
  }))
  return [
    ...older,
    {
      id: next(),
      kind: 'theirs',
      channel: 'EMAIL',
      author: contact,
      authorKind: 'PARTY',
      at: at(11, '09:20'),
      body: `Hello Alex,\nlabel artwork: our designer sends it from her own address today. Please wait for it before cutting.\n${contact.split(' ')[0]}`,
      mentions: [],
      files: [],
    },
    {
      id: next(),
      kind: 'theirs',
      channel: 'EMAIL',
      author: contact,
      authorKind: 'PARTY',
      at: at(13, '16:05'),
      body: `Hello Alex,\nbefore you cut, could you send photos of the pre-production sample? We moved the size label to the left side seam, 3 cm from the hem.\nThanks, ${contact.split(' ')[0]}\n\nOn 12 Nov, Alex Demo wrote:\n> Thanks, we wait for the artwork before cutting.\n--\n${contact} · Buyer · ${brand.tradeName}`,
      mentions: [],
      files: [
        { id: next(), name: 'label-sketch.jpg', sizeBytes: 820_000, contentType: 'image/jpeg', status: 'AVAILABLE' },
        { id: next(), name: brand.fileName, sizeBytes: 240_000, contentType: 'application/pdf', status: 'AVAILABLE' },
      ],
    },
    {
      id: next(),
      kind: 'note',
      channel: 'APP',
      author: 'Bea Esempio',
      authorKind: 'USER',
      at: at(13, '17:30'),
      body: 'Checked with cutting: the label move costs nothing and does not change the date. @Alex Demo please send the sample photos on Monday morning.',
      mentions: ['Alex Demo'],
      files: [],
    },
    {
      id: next(),
      kind: 'ours',
      channel: 'EMAIL',
      author: 'Alex Demo',
      authorKind: 'USER',
      at: at(17, '09:12'),
      body: `Good morning ${contact.split(' ')[0]},\nhere are the photos of the pre-production sample and the label placement for your OK. Cutting starts on Wednesday 18 Nov.\nAlex`,
      mentions: [],
      files: [
        { id: next(), name: 'sample-front.jpg', sizeBytes: 2_400_000, contentType: 'image/jpeg', status: 'AVAILABLE' },
        { id: next(), name: 'label-detail.jpg', sizeBytes: 1_900_000, contentType: 'image/jpeg', status: 'AVAILABLE' },
        { id: next(), name: 'Label placement v2.pdf', sizeBytes: 412_000, contentType: 'application/pdf', status: 'AVAILABLE' },
      ],
      email: { to: [brand.contact.email], subject: `Re: ${order} label position`, status: 'DELIVERED' },
    },
    {
      id: next(),
      kind: 'theirs',
      channel: 'PORTAL',
      author: brand.portalPerson.name,
      authorKind: 'PARTY',
      at: at(17, '10:41'),
      body: 'Photos look good. On the PDF: is the label 3 cm from the hem on both sizes, 54 and 56?',
      mentions: [],
      files: [],
    },
    {
      id: next(),
      kind: 'theirs',
      channel: 'PORTAL',
      author: brand.portalPerson.name,
      authorKind: 'PARTY',
      at: at(17, '10:44'),
      body: 'And please keep the old care label text.',
      mentions: [],
      files: [],
    },
  ]
}

/** The few messages of picture 2: the customer's mail with files, a note, a bounce, our delivered mail, a ticked floor note. */
export function demoCards(brand: BrandFixture = BRAND_ALPHA): CardMessage[] {
  const thread = demoThread(brand)
  const mail = thread[thread.length - 5]
  const note = thread[thread.length - 4]
  const ours = thread[thread.length - 3]
  return [
    mail,
    note,
    {
      id: id(brand, 801),
      kind: 'ours',
      channel: 'EMAIL',
      author: 'Alex Demo',
      authorKind: 'USER',
      at: at(17, '08:40'),
      body: 'Good morning, the photos follow in a minute.',
      mentions: [],
      files: [],
      email: { to: [`ugo@${brand.contact.email.split('@')[1]}`], subject: `Re: ${brand.numbers.order}`, status: 'BOUNCED' },
      bounceTask: { href: '/w/demo/home/tasks?open=task-1' },
    },
    ours,
    {
      id: id(brand, 802),
      kind: 'note',
      channel: 'APP',
      author: 'Carlo Prova',
      authorKind: 'USER',
      at: at(17, '09:30'),
      body: 'Use the grey mesh for the collar lining, as on the sample.',
      forFloor: true,
      mentions: [],
      files: [],
    },
    {
      id: id(brand, 803),
      kind: 'floor',
      channel: 'APP',
      author: null,
      authorKind: 'WORKER',
      authorHidden: true,
      at: at(17, '09:45'),
      body: 'Collar lining cut in grey mesh.',
      forFloor: true,
      mentions: [],
      files: [],
    },
  ]
}
