import { describe, expect, it } from 'vitest'
import { mapHeaders } from '../../imports/headers'
import { parseRow } from '../../imports/plan'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { partnerTemplateOf } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { ATTENTION_KINDS, KIND_RULES } from '../../insights/attention'
import { decisionProblem, draftReadiness, refuseReasonProblem, withdrawProblem, type DraftFacts } from './office'
import { PORTAL_ADDRESSES_MANAGE, PORTAL_ADDRESSES_VIEW, PORTAL_CATALOGUE_VIEW, PORTAL_ORDER_DRAFTS_EDIT, PORTAL_ORDER_REQUESTS_MANAGE, PORTAL_ORDERING_PERMISSIONS } from './permissions'
import { reorderPlan, type ReorderFacts } from './reorder'
import { PPE_CATEGORIES } from '../../product/styles/rules'
import { PPE_WORDS } from './rules'
import { draftTotals, headerProblems, heldWords, lineProblems, lineShapeProblems, lowestPrice, mayOffer, offeredSizes, rangeLabel, type LineFacts } from './rules'
import { linesOfReady, portalOrderLinesImporter, refusedRowsCsv, uploadVerdicts, type CatalogueEntry } from './upload'
import { DRAFT_FILE_CATEGORY, DRAFT_FILES_MAX, draftFilePartOf, draftFilesByPart, draftFileWords } from './draft-files' // B-CP-072
// B-CP-075: every kind of draft line, the people on it, problems per part, the 409 that names the colleague.
import { MEASURE_BY, MEASURE_BY_WORDS, PEOPLE_IN_SHEET, personRow, personShapeProblems } from './people'
import { customLineProblems, customLineShapeProblems, draftStaleWords, lineHasPieces, linePieces, MTM_CLOSED_WORDS, PROBLEM_CODES, type CustomLineFacts } from './rules'
import { problemPartOf, problemsByPartOf } from './office'
import { ACCEPT_MAP_LIMITS, ACCEPT_WORDS, acceptPlanOf, lineMapOf, mappedLineNote, type AcceptLineFacts } from './office' // B-CP-077
import { brandPricesOfAccept, draftValueOf } from './office' // B-CP-076

const P1 = '00000000-0000-4000-8000-000000000001'
const P2 = '00000000-0000-4000-8000-000000000002'
const A = '00000000-0000-4000-8000-0000000000aa'
const facts = (more: Partial<LineFacts> = {}): LineFacts => ({ styleCode: 'JKT-100', sold: true, colourwayName: 'Black', colourwayActive: true, offered: ['48', '50', '52'], priceNow: '410.00', ...more })

describe('permissions and templates (B-W2b-190)', () => {
  it('declares five partner permissions, never office ones', () => {
    expect(PORTAL_ORDERING_PERMISSIONS).toHaveLength(5)
    for (const name of PORTAL_ORDERING_PERMISSIONS) expect(FACTORY_PERMISSIONS.get(name)?.partner, name).toBe(true)
    expect(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name)).not.toContain(PORTAL_CATALOGUE_VIEW)
    expect(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name)).not.toContain(PORTAL_ORDER_DRAFTS_EDIT)
  })

  // B-CP-070 (customer page plan D11): the brand's Designer starts and fills a draft, never sends it, never sees a price.
  it('gives the drafts to the Buyer and the Designer (the Admin follows); sending stays the Buyer\'s and the Admin\'s', () => {
    for (const key of ['customer-buyer', 'customer-designer', 'customer-admin']) expect(partnerTemplateOf(key)?.permissions, key).toContain(PORTAL_ORDER_DRAFTS_EDIT)
    for (const key of ['customer-finance', 'customer-quality', 'customer-production', 'customer-viewer', 'supplier-orders', 'supplier-admin', 'subcontractor-jobs', 'guest-accountant']) {
      expect(partnerTemplateOf(key)?.permissions, key).not.toContain(PORTAL_ORDER_DRAFTS_EDIT)
    }
    const designer = partnerTemplateOf('customer-designer')!
    expect(designer.permissions).not.toContain(PORTAL_ORDER_REQUESTS_MANAGE)
    expect(designer.grains).toEqual([])
    expect(partnerTemplateOf('customer-buyer')?.permissions).toContain(PORTAL_ORDER_REQUESTS_MANAGE)
    expect(partnerTemplateOf('customer-admin')?.permissions).toContain(PORTAL_ORDER_REQUESTS_MANAGE)
    expect(FACTORY_PERMISSIONS.get(PORTAL_ORDER_DRAFTS_EDIT)?.risk).toBe('write')
  })

  it('gives the catalogue and addresses to every customer role, requests to the Buyer, address changes to the Admin only', () => {
    for (const key of ['customer-buyer', 'customer-finance', 'customer-quality', 'customer-designer', 'customer-viewer', 'customer-admin']) {
      expect(partnerTemplateOf(key)?.permissions, key).toEqual(expect.arrayContaining([PORTAL_CATALOGUE_VIEW, PORTAL_ADDRESSES_VIEW]))
    }
    expect(partnerTemplateOf('customer-buyer')?.permissions).toContain(PORTAL_ORDER_REQUESTS_MANAGE)
    expect(partnerTemplateOf('customer-admin')?.permissions).toEqual(expect.arrayContaining([PORTAL_ORDER_REQUESTS_MANAGE, PORTAL_ADDRESSES_MANAGE]))
    for (const key of ['customer-finance', 'customer-viewer', 'customer-designer', 'customer-quality']) expect(partnerTemplateOf(key)?.permissions, key).not.toContain(PORTAL_ORDER_REQUESTS_MANAGE)
    for (const key of ['customer-buyer', 'customer-finance', 'customer-viewer']) expect(partnerTemplateOf(key)?.permissions, key).not.toContain(PORTAL_ADDRESSES_MANAGE)
    for (const key of ['supplier-orders', 'supplier-admin', 'subcontractor-jobs', 'guest-accountant']) expect(partnerTemplateOf(key)?.permissions, key).not.toContain(PORTAL_CATALOGUE_VIEW)
  })

  it('declares the request events and the Approvals kind', () => {
    const types = EVENT_DEFINITIONS.map((definition) => definition.type as string)
    for (const type of ['portal_order_request.sent', 'portal_order_request.accepted', 'portal_order_request.refused', 'portal_order_request.withdrawn', /* B-CP-071 */ 'portal_order_request.draft_changed']) expect(types).toContain(type)
    // B-CP-071 (review C2): a draft's change reaches screens by its id only; its party routes the message, never a field.
    expect(EVENT_DEFINITIONS.find((definition) => definition.type === 'portal_order_request.draft_changed')?.live).toEqual({ permission: 'orders.view', floor: null, fields: ['requestId'] })
    expect(ATTENTION_KINDS).toContain('PORTAL_ORDER_REQUEST')
    expect(KIND_RULES.PORTAL_ORDER_REQUEST).toMatchObject({ category: 'APPROVAL', view: 'orders.view', act: ['orders.manage'], decide: 'OPEN' })
  })
})

describe('the catalogue (SAL-071)', () => {
  it('offers the open range and the customer own label, never another customer label, a draft or an archived style', () => {
    expect(mayOffer({ status: 'ACTIVE', companyId: null, brandPartyId: null }, P1, A)).toBe(true)
    expect(mayOffer({ status: 'ACTIVE', companyId: A, brandPartyId: P1 }, P1, A)).toBe(true)
    expect(mayOffer({ status: 'ACTIVE', companyId: A, brandPartyId: P2 }, P1, A)).toBe(false)
    expect(mayOffer({ status: 'DRAFT', companyId: A, brandPartyId: null }, P1, A)).toBe(false)
    expect(mayOffer({ status: 'ARCHIVED', companyId: A, brandPartyId: null }, P1, A)).toBe(false)
    expect(mayOffer({ status: 'ACTIVE', companyId: P2, brandPartyId: null }, P1, A)).toBe(false)
  })

  it('keeps the range order, says the range and the lowest price', () => {
    expect(offeredSizes(['48', '50', '52', '54'], ['54', '50'])).toEqual(['50', '54'])
    expect(rangeLabel(['48', '50', '52'])).toBe('48–52')
    expect(rangeLabel(['52'])).toBe('52')
    expect(lowestPrice(['410.000000', null, '395.5'])).toBe('395.50')
    expect(lowestPrice([null])).toBeNull()
  })
})

describe('a draft and its problems (SAL-074)', () => {
  it('refuses a line shape without sizes, with a size twice or a quantity out of range', () => {
    expect(lineShapeProblems({ styleId: 's', colourwayId: 'c', sizes: [] })).toEqual(['A line asks at least one size.'])
    expect(lineShapeProblems({ styleId: 's', colourwayId: 'c', sizes: [{ size: '50', quantity: 1 }, { size: '50', quantity: 2 }] })).toEqual(['Size 50 is asked twice on the line.'])
    expect(lineShapeProblems({ styleId: 's', colourwayId: 'c', sizes: [{ size: '50', quantity: 0 }] })).toEqual(['Size 50: 1 to 99999 pieces.'])
  })

  it('names a style no longer sold, a discontinued colour, a size not offered and a changed price', () => {
    const line = { id: 'l1', sizes: [{ size: '50', quantity: 2 }, { size: '62', quantity: 1 }], unitPriceShown: '400.000000' }
    expect(lineProblems(line, null, true).map((entry) => entry.code)).toEqual(['STYLE_NOT_SOLD'])
    expect(lineProblems(line, facts({ sold: false }), true).map((entry) => entry.code)).toEqual(['STYLE_NOT_SOLD'])
    const problems = lineProblems(line, facts(), true)
    expect(problems.map((entry) => [entry.code, entry.size])).toEqual([
      ['SIZE_NOT_OFFERED', '62'],
      ['PRICE_CHANGED', null],
    ])
    expect(problems[1]!.words.en).toBe('Price now 410.00 (was 400.00).')
    expect(lineProblems(line, facts({ colourwayActive: false }), true).map((entry) => entry.code)).toEqual(['COLOUR_DISCONTINUED', 'PRICE_CHANGED'])
    // A person without prices never meets a price problem.
    expect(lineProblems({ ...line, unitPriceShown: null }, facts({ offered: ['50', '62'] }), false)).toEqual([])
    expect(lineProblems({ ...line, unitPriceShown: '410' }, facts({ offered: ['50', '62'] }), true)).toEqual([])
  })

  it('holds the send without lines, with a past date or an archived address', () => {
    expect(headerProblems({ requestedDate: '2026-11-01', shipToActive: false, lineCount: 0 }, '2026-11-07').map((entry) => entry.code)).toEqual(['NO_LINES', 'DATE_PAST', 'SHIP_TO_ARCHIVED'])
    expect(headerProblems({ requestedDate: '2026-11-07', shipToActive: true, lineCount: 1 }, '2026-11-07')).toEqual([])
    expect(heldWords(2)?.en).toBe('2 problems to fix')
    expect(heldWords(0)).toBeNull()
  })

  it('adds up lines, pieces and the net of the prices shown (none without prices)', () => {
    const lines = [
      { sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }], unitPriceShown: '410.000000' },
      { sizes: [{ size: '52', quantity: 4 }], unitPriceShown: '395.000000' },
    ]
    expect(draftTotals(lines, true)).toEqual({ lines: 2, pieces: 9, net: '3630.00' })
    expect(draftTotals(lines, false)).toEqual({ lines: 2, pieces: 9, net: null })
    expect(draftTotals([{ sizes: [{ size: '50', quantity: 1 }], unitPriceShown: null }], true).net).toBeNull()
  })
})

describe('the office decision', () => {
  it('decides a SENT request only, and the customer withdraws only a SENT one', () => {
    expect(decisionProblem('SENT')).toBeNull()
    expect(decisionProblem('DRAFT')).toBe("This is still the customer's draft: it is decided once they send it.") // B-CP-071
    expect(decisionProblem('ACCEPTED')).toMatch(/already accepted/)
    expect(withdrawProblem('SENT')).toBeNull()
    expect(withdrawProblem('REFUSED')).toMatch(/already decided/)
    expect(refuseReasonProblem('  ')).toMatch(/Say why/)
    expect(refuseReasonProblem('Out of season')).toBeNull()
  })
})

// ---- B-CP-071 (customer page plan D10, review B4): the draft's checklist as the office and the portal read it.
describe('a draft\'s checklist (B-CP-071)', () => {
  const facts = (more: Partial<DraftFacts> = {}): DraftFacts => ({ lines: 0, linesWithoutPieces: 0, logos: 0, references: 0, requestedDate: false, headerProblems: 0, note: false, later: [], pricedLines: null, problems: 1, ...more })

  it('starts with what is needed missing and the rest optional; six parts for a reader without the price grain', () => {
    const empty = draftReadiness(facts())
    expect(empty.parts).toEqual([
      { part: 'NEED', state: 'MISSING' },
      { part: 'LOGOS', state: 'OPTIONAL' },
      { part: 'REFERENCES', state: 'OPTIONAL' },
      { part: 'PEOPLE', state: 'MISSING' },
      { part: 'DATE', state: 'OPTIONAL' },
      { part: 'NOTES', state: 'OPTIONAL' },
    ])
    expect(empty).toMatchObject({ done: 0, of: 6, problems: 1 })
  })

  it('counts part 6 "Your price" for a price holder only, ready once every line carries the customer\'s price', () => {
    expect(draftReadiness(facts({ lines: 2, pricedLines: 1 })).of).toBe(7)
    expect(draftReadiness(facts({ lines: 2, pricedLines: 1 })).parts.find((entry) => entry.part === 'PRICE')?.state).toBe('OPTIONAL')
    expect(draftReadiness(facts({ lines: 2, pricedLines: 2 })).parts.find((entry) => entry.part === 'PRICE')?.state).toBe('READY')
    expect(draftReadiness(facts({ lines: 2 })).parts.map((entry) => entry.part)).not.toContain('PRICE')
  })

  it('reads lines, files, people, the date and the note; "sending later" for logos, references and people; a past date is missing', () => {
    const full = draftReadiness(facts({ lines: 2, logos: 1, references: 3, requestedDate: true, note: true, problems: 0 }))
    expect(full).toMatchObject({ done: 6, of: 6, problems: 0 })
    const later = draftReadiness(facts({ lines: 1, linesWithoutPieces: 1, later: ['LOGOS', 'PEOPLE'] }))
    expect(later.parts.filter((entry) => entry.state === 'LATER').map((entry) => entry.part)).toEqual(['LOGOS', 'PEOPLE'])
    expect(draftReadiness(facts({ lines: 1, requestedDate: true, headerProblems: 1 })).parts.find((entry) => entry.part === 'DATE')?.state).toBe('MISSING')
  })
})
// ---- end B-CP-071

// ---- B-CP-072 (customer page plan C5): a draft's files by part.
describe('a draft\'s files (B-CP-072)', () => {
  it('files a logo as ARTWORK, a sheet as MEASUREMENTS, a reference with no category, and reads them back the same way', () => {
    expect(DRAFT_FILE_CATEGORY).toEqual({ LOGO: 'ARTWORK', REFERENCE: null, SHEET: 'MEASUREMENTS' })
    for (const [part, category] of Object.entries(DRAFT_FILE_CATEGORY)) expect(draftFilePartOf(category)).toBe(part)
    expect(draftFilePartOf('PROOF')).toBe('REFERENCE')
  })

  it('groups the draft\'s own files and its lines\' by part, leaving out another record\'s', () => {
    const R = '00000000-0000-4000-8000-0000000000r1'
    const grouped = draftFilesByPart(
      [
        { id: 'f1', recordType: 'PortalOrderRequest', recordId: R, category: 'ARTWORK' },
        { id: 'f2', recordType: 'PortalOrderRequestLine', recordId: 'line-1', category: 'MEASUREMENTS' },
        { id: 'f3', recordType: 'PortalOrderRequest', recordId: R, category: null },
        { id: 'f4', recordType: 'PortalOrderRequest', recordId: 'another-request', category: 'ARTWORK' },
        { id: 'f5', recordType: 'SalesOrder', recordId: R, category: 'ARTWORK' },
      ],
      R,
    )
    expect(grouped.logos.map((file) => [file.id, file.lineId])).toEqual([['f1', null]])
    expect(grouped.sheets.map((file) => [file.id, file.lineId])).toEqual([['f2', 'line-1']])
    expect(grouped.references.map((file) => file.id)).toEqual(['f3'])
  })

  it('refuses the file after DRAFT_FILES_MAX in the person\'s words, never naming anyone', () => {
    expect(DRAFT_FILES_MAX).toBe(50)
    expect(draftFileWords('TOO_MANY_FILES', 'en')).toBe('This draft already holds 50 files: remove one, or write to us in the messages for the rest.')
    expect(draftFileWords('TOO_MANY_FILES', 'it')).toContain('50 file')
  })
})
// ---- end B-CP-072

// ---- B-CP-075 (customer page plan C5; 12 §2 parts 1 and 4; review A5, F1, F2) ---------------------------------------------------
describe('B-CP-075: described and made-to-measure lines, and the people on them', () => {
  const custom = (more: Partial<CustomLineFacts> = {}): CustomLineFacts => ({ id: 'l2', kind: 'DESCRIBED', quantity: 40, sizes: [], byPerson: false, people: [], sheetOnLine: false, style: null, colourway: null, mtmOpen: true, garmentType: null, ...more })
  const codes = (facts: CustomLineFacts) => customLineProblems(facts).map((entry) => entry.code)

  it('holds each kind to its shape before it is written: words for a described line, a garment type and people for made to measure', () => {
    expect(customLineShapeProblems({ kind: 'DESCRIBED', description: 'Team jackets, our logo on the back', quantity: 40 })).toEqual([])
    expect(customLineShapeProblems({ kind: 'DESCRIBED', description: '  ' })).toEqual(['Say in your words what you need (1 to 2000 characters).'])
    expect(customLineShapeProblems({ kind: 'DESCRIBED', description: 'x'.repeat(2001) })).toContain('A description is at most 2000 characters.')
    expect(customLineShapeProblems({ kind: 'DESCRIBED', description: 'Made-up', quantity: 0 })).toContain('A total is 1 to 100000 pieces.')
    expect(customLineShapeProblems({ kind: 'DESCRIBED', description: 'Made-up', colourwayId: 'c1' })).toContain('A colour of ours goes with its style.')
    expect(customLineShapeProblems({ kind: 'DESCRIBED', description: 'Made-up', byPerson: true, quantity: 12 })).toContain('A line by person takes its pieces from its people: no total and no sizes.')
    expect(customLineShapeProblems({ kind: 'DESCRIBED', description: 'Made-up', quantity: 4, sizes: [{ size: '50', quantity: 2 }, { size: '50', quantity: 2 }] })).toContain('Size 50 is asked twice on the line.')
    expect(customLineShapeProblems({ kind: 'MADE_TO_MEASURE', garmentType: 'JACKET' })).toEqual([])
    expect(customLineShapeProblems({ kind: 'MADE_TO_MEASURE', garmentType: '' })).toEqual(['Choose the garment type to make to measure.'])
    expect(customLineShapeProblems({ kind: 'MADE_TO_MEASURE', garmentType: 'JACKET', byPerson: false, quantity: 3 })).toEqual(expect.arrayContaining(['A made-to-measure line is always by person.', 'A made-to-measure line counts its people, not a total.']))
  })

  it('counts a line by its kind; Send takes a described total, people, or a measurement sheet that stands for them (review A5)', () => {
    expect(linePieces({ kind: 'DESCRIBED', quantity: 40, sizes: [{ size: '50', quantity: 3 }], byPerson: false, people: 0 })).toBe(40)
    expect(linePieces({ kind: 'MADE_TO_MEASURE', quantity: null, sizes: [], byPerson: true, people: 12 })).toBe(12)
    expect(linePieces({ kind: 'CATALOGUE', quantity: null, sizes: [{ size: '50', quantity: 3 }, { size: '52', quantity: 2 }], byPerson: false, people: 0 })).toBe(5)
    const mtm = { kind: 'MADE_TO_MEASURE' as const, quantity: null, sizes: [], byPerson: true, people: 0 }
    expect(lineHasPieces({ ...mtm, sheetOnLine: false })).toBe(false)
    expect(lineHasPieces({ ...mtm, sheetOnLine: true })).toBe(true)
    expect(lineHasPieces({ kind: 'DESCRIBED', quantity: 40, sizes: [], byPerson: false, people: 0, sheetOnLine: false })).toBe(true)
    expect(lineHasPieces({ kind: 'DESCRIBED', quantity: null, sizes: [], byPerson: false, people: 0, sheetOnLine: false })).toBe(false)
  })

  it('names what holds the send of a custom line: no total, sizes that miss the total, no one named, made to measure off, a garment type gone', () => {
    expect(codes(custom())).toEqual([])
    expect(codes(custom({ quantity: null }))).toEqual(['NO_TOTAL'])
    expect(codes(custom({ quantity: 40, sizes: [{ size: '50', quantity: 30 }] }))).toEqual(['SIZES_NOT_TOTAL'])
    expect(customLineProblems(custom({ quantity: 40, sizes: [{ size: '50', quantity: 30 }] }))[0]!.words.en).toBe('The sizes add up to 30 pieces, the total says 40.')
    const byPerson = custom({ kind: 'MADE_TO_MEASURE', quantity: null, byPerson: true, garmentType: { code: 'JACKET', active: true } })
    expect(codes(byPerson)).toEqual(['NO_PEOPLE'])
    // "People: in the attached sheet": a sheet on the line stands for its roster.
    expect(codes({ ...byPerson, sheetOnLine: true })).toEqual([])
    expect(PEOPLE_IN_SHEET.en).toBe('People: in the attached sheet')
    // A customer the office switched off (mtmDraftsOn false): held in the portal's words, never a garment type to fix first.
    expect(customLineProblems({ ...byPerson, sheetOnLine: true, mtmOpen: false }).map((entry) => [entry.code, entry.words])).toEqual([['MTM_CLOSED', MTM_CLOSED_WORDS]])
    expect(codes({ ...byPerson, sheetOnLine: true, garmentType: { code: 'JACKET', active: false } })).toEqual(['GARMENT_TYPE_GONE'])
  })

  it('checks the customer’s own style and a person’s size against the range; a person’s problem is the People part', () => {
    const own = { code: 'SEED-JKT-02', sold: true, range: ['48', '50', '52'] }
    expect(codes(custom({ style: { ...own, sold: false } }))).toEqual(['STYLE_NOT_SOLD'])
    expect(codes(custom({ quantity: 2, sizes: [{ size: '58', quantity: 2 }], style: own }))).toEqual(['SIZE_NOT_OFFERED'])
    const roster = customLineProblems(custom({ byPerson: true, quantity: null, style: own, people: [{ id: 'p1', size: '50' }, { id: 'p2', size: '58' }, { id: 'p3', size: null }] }))
    expect(roster.map((entry) => [entry.code, entry.size, entry.personId])).toEqual([['SIZE_NOT_OFFERED', '58', 'p2']])
    expect(problemPartOf(roster[0]!)).toBe('PEOPLE')
    expect(problemPartOf({ code: 'NO_PEOPLE', personId: null })).toBe('PEOPLE')
    expect(problemPartOf({ code: 'DATE_PAST', personId: null })).toBe('DATE')
    expect(problemPartOf({ code: 'NO_TOTAL', personId: null })).toBe('NEED')
    expect(problemsByPartOf([...roster, { code: 'NO_TOTAL', personId: null }, { code: 'NO_TOTAL', personId: null }])).toEqual({ PEOPLE: 1, NEED: 2 })
  })

  it('a part with a problem is not ready; the people part says "sending later" when marked so', () => {
    const base: DraftFacts = { lines: 2, linesWithoutPieces: 0, logos: 0, references: 0, requestedDate: false, headerProblems: 0, note: false, later: [], pricedLines: null, problems: 1 }
    const state = (facts: DraftFacts, part: string) => draftReadiness(facts).parts.find((entry) => entry.part === part)!.state
    expect(state(base, 'NEED')).toBe('READY')
    expect(state({ ...base, problemsByPart: { NEED: 1 } }, 'NEED')).toBe('MISSING')
    expect(state({ ...base, problemsByPart: { PEOPLE: 1 } }, 'PEOPLE')).toBe('MISSING')
    expect(state({ ...base, linesWithoutPieces: 1, later: ['PEOPLE'] }, 'PEOPLE')).toBe('LATER')
    // Absent (an older reader): as before.
    expect(state({ ...base, problems: 3 }, 'NEED')).toBe('READY')
  })

  it('holds a person to one way of being measured — a size, a sheet of the draft, or later — and writes it trimmed', () => {
    expect(MEASURE_BY).toEqual(['SIZE', 'SHEET', 'LATER'])
    expect((MEASURE_BY as readonly string[]).includes('PROFILE')).toBe(false) // review F2: "Saved measurements" comes later
    expect(MEASURE_BY_WORDS.SHEET).toEqual({ it: 'Scheda misure', en: 'Measurement sheet' })
    expect(personShapeProblems({ name: 'Mario Rossi', number: '46', measureBy: 'SIZE', size: '52' })).toEqual([])
    expect(personShapeProblems({ name: ' ', measureBy: 'LATER' })).toEqual(['A name is 1 to 120 characters.'])
    expect(personShapeProblems({ name: 'Made-up Rider', number: '12345678901', measureBy: 'LATER' })).toEqual(['A number is at most 10 characters.'])
    expect(personShapeProblems({ name: 'Made-up Rider', measureBy: 'SIZE' })).toEqual(['Give the size (1 to 40 characters).'])
    expect(personShapeProblems({ name: 'Made-up Rider', measureBy: 'SHEET', size: '52' })).toEqual(['Choose the measurement sheet of this draft that holds the measures.', 'A person measured by a sheet names no size.'])
    expect(personShapeProblems({ name: 'Made-up Rider', measureBy: 'LATER', size: '52' })).toEqual(['A person whose measures come later names no size and no sheet.'])
    expect(personRow({ name: '  Giulia Verdi ', number: ' ', measureBy: 'SIZE', size: ' 50 ', note: '' })).toEqual({ name: 'Giulia Verdi', number: null, measureBy: 'SIZE', size: '50', measurementFileId: null, note: null })
  })

  it('the 409 of a draft a colleague changed names them (or the person’s other window), never anyone else', () => {
    expect(draftStaleWords({ name: 'Marta Bianchi', self: false, version: 15 }).en).toBe('Marta Bianchi changed this draft since you read it (now version 15): read it again.')
    expect(draftStaleWords({ name: 'Marta Bianchi', self: false, version: 15 }).it).toContain('Marta Bianchi ha modificato questa bozza')
    expect(draftStaleWords({ name: null, self: true, version: 3 }).en).toBe('You changed this draft in another window (now version 3): read it again.')
    expect(draftStaleWords({ name: null, self: false, version: 3 }).en).toBe('This draft changed since you read it (now version 3): read it again.')
    for (const code of ['NO_TOTAL', 'SIZES_NOT_TOTAL', 'NO_PEOPLE', 'MTM_CLOSED', 'GARMENT_TYPE_GONE']) expect(PROBLEM_CODES as readonly string[]).toContain(code)
  })
})
// ---- end B-CP-075

describe('reorder (SAL-072)', () => {
  const past = { kind: 'SIZE_GRID' as const, unitPrice: '389.000000', revision: 1, sizes: [{ size: '50', quantity: 2 }, { size: '56', quantity: 1 }] }
  const now = (more: Partial<ReorderFacts> = {}): ReorderFacts => ({ ...facts(), revisionNow: 2, ...more })

  it('copies at today\'s price, naming the price, the revision and the sizes left out', () => {
    const plan = reorderPlan(past, now(), true)
    expect(plan.addable).toBe(true)
    expect(plan.sizes).toEqual([{ size: '50', quantity: 2 }])
    expect(plan.notices.map((entry) => entry.code)).toEqual(['PRICE_CHANGED', 'REVISION_CHANGED', 'SIZES_DROPPED'])
    expect(plan.notices[0]!.words.en).toBe('Price now 410.00 (was 389.00)')
    expect(plan.notices[2]!.words.en).toBe('Sizes no longer offered, left out: 56')
    expect(reorderPlan(past, now(), false).notices.map((entry) => entry.code)).toEqual(['REVISION_CHANGED', 'SIZES_DROPPED'])
  })

  it('asks for another colour, refuses a style no longer sold, made to measure, or no size left', () => {
    expect(reorderPlan(past, now({ colourwayActive: false, colourwayName: 'Brown' }), true)).toMatchObject({ addable: false, needsColour: true })
    expect(reorderPlan(past, now({ sold: false }), true).notices.map((entry) => entry.code)).toEqual(['STYLE_NOT_SOLD'])
    expect(reorderPlan(past, null, true).addable).toBe(false)
    expect(reorderPlan({ ...past, kind: 'MADE_TO_MEASURE' }, now(), true).notices.map((entry) => entry.code)).toEqual(['MADE_TO_MEASURE'])
    expect(reorderPlan(past, now({ offered: ['48'] }), true)).toMatchObject({ addable: false, sizes: [] })
  })
})

describe('order upload (SAL-073)', () => {
  const catalogue = new Map<string, CatalogueEntry>([['JKT-100', { styleId: 's1', styleCode: 'JKT-100', colourways: [{ id: 'c1', code: 'BLK', name: 'Black', offered: ['50', '52'] }] }]])
  const read = (headers: string[], rows: (string | number)[][]) => {
    const mapping = mapHeaders(portalOrderLinesImporter.columns, headers, {})
    return rows.map((cells, index) => parseRow(portalOrderLinesImporter, mapping.columns, { rowNumber: index + 2, cells }, { numberFormat: 'it' }))
  }

  it('maps the Italian headers and gives every row a verdict before anything lands', () => {
    const parsed = read(['Codice', 'Colore', 'Taglia', 'Quantità', 'Vostro codice'], [
      ['jkt-100', 'BLK', '50', 4, 'R-1'],
      ['JKT-100', 'black', 52, 6, 'R-1'],
      ['JKT-100', 'BLK', '62', 1, ''],
      ['JKT-999', 'BLK', '50', 1, ''],
      ['JKT-100', 'RED', '50', 1, ''],
      ['JKT-100', 'BLK', '50', 2, ''],
      ['JKT-100', 'BLK', '52', 'tre', ''],
    ])
    const verdicts = uploadVerdicts(parsed, catalogue)
    expect(verdicts.map((verdict) => verdict.status)).toEqual(['READY', 'READY', 'REFUSED', 'REFUSED', 'REFUSED', 'REFUSED', 'REFUSED'])
    expect(verdicts[2]!.reasons[0]!.en).toBe('Size 62 not offered for JKT-100 BLK.')
    expect(verdicts[3]!.reasons[0]!.en).toBe('JKT-999 is not in your catalogue.')
    expect(verdicts[4]!.reasons[0]!.en).toBe('JKT-100 has no colour RED.')
    expect(verdicts[5]!.reasons[0]!.en).toBe('Repeats row 2 (same style, colour and size).')
    expect(verdicts[6]!.reasons[0]!.en).toMatch(/^quantity: /)
    expect(linesOfReady(verdicts)).toEqual([{ styleId: 's1', colourwayId: 'c1', sizes: [{ size: '50', quantity: 4 }, { size: '52', quantity: 6 }], note: 'R-1' }])
    const csv = refusedRowsCsv(verdicts, 'en')
    expect(csv.split('\r\n')[0]).toBe('Row;Style;Colour;Size;Quantity;Your code;Reason')
    expect(csv.split('\r\n').filter((line) => line !== '')).toHaveLength(6)
  })
})

describe('B-W2b-F17: the PPE category in words', () => {
  it('has words in both languages for every stored code (Style.ppeCategory), never the code itself', () => {
    expect(Object.keys(PPE_WORDS).sort()).toEqual([...PPE_CATEGORIES].sort())
    for (const code of PPE_CATEGORIES) {
      for (const locale of ['it', 'en'] as const) {
        expect(PPE_WORDS[code][locale], `${code} ${locale}`).toBeTruthy()
        expect(PPE_WORDS[code][locale], `${code} ${locale}`).not.toBe(code)
      }
    }
    expect(PPE_WORDS.CATEGORY_II).toEqual({ it: 'DPI categoria II', en: 'PPE category II' })
  })
})

// ---- B-CP-077: the accept's ONE line map (pure) -------------------------------------------------------------------------------
describe('B-CP-077: accept a described or made-to-measure request by its line map', () => {
  const line = (over: Partial<AcceptLineFacts> & Pick<AcceptLineFacts, 'id' | 'seq' | 'kind'>): AcceptLineFacts => ({ styleId: null, colourwayId: null, sizes: [], quantity: null, byPerson: false, peopleSizes: [], note: null, ownWords: null, colourText: null, ...over })
  const catalogue = line({ id: 'c1', seq: 1, kind: 'CATALOGUE', styleId: 's1', colourwayId: 'k1', sizes: [{ size: '50', quantity: 2 }] })
  const described = line({ id: 'd2', seq: 2, kind: 'DESCRIBED', quantity: 6, ownWords: 'Made-up team jackets', colourText: 'Black and red' })
  const tailored = line({ id: 'm3', seq: 3, kind: 'MADE_TO_MEASURE', byPerson: true, peopleSizes: ['50', '52', '52'], ownWords: 'JACKET' })
  const plan = (as: 'ORDER' | 'QUOTE', map: Parameters<typeof acceptPlanOf>[0]['map'], lines = [catalogue, described, tailored], prices: { lineId: string; unitPrice?: string }[] = []) => acceptPlanOf({ number: 'RQ-0001', as, lines, map, prices })

  it('holds an unmapped line (as a quote) and a made-to-measure line (as an order), in words naming their places', () => {
    expect(plan('QUOTE', [])).toEqual({ kind: 'HELD', words: ACCEPT_WORDS.unmapped([2, 3]), issues: [{ path: 'request/lines/2', message: ACCEPT_WORDS.unmapped([2, 3]) }, { path: 'request/lines/3', message: ACCEPT_WORDS.unmapped([2, 3]) }] })
    expect(ACCEPT_WORDS.unmapped([2])).toMatch(/described or made to measure/)
    expect(plan('ORDER', [{ lineId: 'm3', into: [{ styleId: 's1', colourwayId: 'k1' }] }]).kind).toBe('HELD')
    expect(plan('ORDER', [], [catalogue, tailored])).toMatchObject({ kind: 'HELD', words: ACCEPT_WORDS.madeToMeasureOrder([3]) })
    // A catalogue-only request needs no map.
    expect(plan('ORDER', [], [catalogue])).toMatchObject({ kind: 'PLAN', lines: [{ requestLineId: 'c1', styleId: 's1', sizes: [{ size: '50', quantity: 2 }], at: 'request/lines/1' }] })
  })

  it('refuses by place what the office sent: a catalogue line, an unknown line, twice, no sizes, a price on a described line', () => {
    const mtm = { lineId: 'm3', into: [{ styleId: 's1', colourwayId: 'k1' }] }
    expect(plan('QUOTE', [{ lineId: 'c1', into: [{ styleId: 's1', colourwayId: 'k1' }] }, mtm])).toMatchObject({ kind: 'INVALID', issues: [{ path: 'body/map/0/lineId', message: ACCEPT_WORDS.fromCatalogue(1) }] })
    expect(plan('QUOTE', [{ lineId: 'x9', into: [{ styleId: 's1', colourwayId: 'k1' }] }, mtm])).toMatchObject({ kind: 'INVALID', issues: [{ path: 'body/map/0/lineId', message: ACCEPT_WORDS.notALine }] })
    expect(plan('QUOTE', [mtm, mtm])).toMatchObject({ kind: 'INVALID', issues: [{ path: 'body/map/1/lineId', message: ACCEPT_WORDS.mappedTwice(3) }] })
    expect(plan('QUOTE', [{ lineId: 'd2', into: [{ styleId: 's1', colourwayId: 'k1' }] }, mtm])).toMatchObject({ kind: 'INVALID', issues: [{ path: 'body/map/0/into/0/sizes', message: ACCEPT_WORDS.sizesOfTotal(2, 6) }] })
    expect(plan('QUOTE', [{ lineId: 'd2', into: [{ styleId: 's1', colourwayId: 'k1', sizes: [{ size: '50', quantity: 3 }] }, { styleId: 's1', colourwayId: 'k2' }] }, mtm])).toMatchObject({ kind: 'INVALID', issues: [{ path: 'body/map/0/into/1/sizes', message: ACCEPT_WORDS.sizesOfEach(2) }] })
    expect(plan('QUOTE', [{ lineId: 'd2', into: [{ styleId: 's1', colourwayId: 'k1', sizes: [{ size: '50', quantity: 6 }] }] }, mtm], undefined, [{ lineId: 'd2', unitPrice: '10' }])).toMatchObject({ kind: 'INVALID', issues: [{ path: 'body/lines/0/lineId', message: ACCEPT_WORDS.priceOnMap(2) }] })
    // People measured by a sheet or "sending later" give no size: the office names them.
    const later = line({ id: 'm4', seq: 4, kind: 'MADE_TO_MEASURE', byPerson: true, peopleSizes: ['50', null] })
    expect(plan('QUOTE', [{ lineId: 'm4', into: [{ styleId: 's1', colourwayId: 'k1' }] }], [later])).toMatchObject({ kind: 'INVALID', issues: [{ message: ACCEPT_WORDS.sizesOfPeople(4, 1, 2) }] })
    const sheet = line({ id: 'm5', seq: 5, kind: 'MADE_TO_MEASURE', byPerson: true })
    expect(plan('QUOTE', [{ lineId: 'm5', into: [{ styleId: 's1', colourwayId: 'k1' }] }], [sheet])).toMatchObject({ kind: 'INVALID', issues: [{ message: ACCEPT_WORDS.sizesInSheet(5) }] })
  })

  it('plans every line in the request’s order, a mapped line into its style lines; its people’s sizes; the note names no person; pieces said', () => {
    const planned = plan('QUOTE', [
      { lineId: 'm3', into: [{ styleId: 's1', colourwayId: 'k1' }] },
      { lineId: 'd2', into: [{ styleId: 's1', colourwayId: 'k1', sizes: [{ size: '50', quantity: 2 }] }, { styleId: 's1', colourwayId: 'k2', sizes: [{ size: ' 52 ', quantity: 3 }], note: 'Made-up red half' }] },
    ])
    if (planned.kind !== 'PLAN') throw new Error(planned.words)
    expect(planned.lines.map((entry) => [entry.requestLineId, entry.colourwayId, entry.sizes, entry.at])).toEqual([
      ['c1', 'k1', [{ size: '50', quantity: 2 }], 'request/lines/1'],
      ['d2', 'k1', [{ size: '50', quantity: 2 }], 'body/map/1/into/0'],
      ['d2', 'k2', [{ size: '52', quantity: 3 }], 'body/map/1/into/1'],
      ['m3', 'k1', [{ size: '50', quantity: 1 }, { size: '52', quantity: 2 }], 'body/map/0/into/0'],
    ])
    expect(planned.lines[1]!.note).toBe('Request RQ-0001, line 2 (described): Made-up team jackets · Colours: Black and red')
    expect(planned.lines[2]!.note).toBe('Made-up red half')
    expect(planned.lines[3]!.note).toBe('Request RQ-0001, line 3 (made to measure): JACKET · People: 3 on the request (their names stay there)')
    expect(planned.warnings).toEqual([ACCEPT_WORDS.pieces(2, 6, 5, 'QUOTE')])
    expect(mappedLineNote(null, line({ id: 'z', seq: 9, kind: 'DESCRIBED', ownWords: 'x'.repeat(2000) })).length).toBe(ACCEPT_MAP_LIMITS.note)
  })

  it('the map pairs the lines made with the plan, by id; a place a copy left out has none', () => {
    const planned = [
      { requestLineId: 'c1', requestSeq: 1 },
      { requestLineId: 'd2', requestSeq: 2 },
      { requestLineId: 'd2', requestSeq: 2 },
      { requestLineId: 'm3', requestSeq: 3 },
    ]
    const made = [{ id: 'o10', seq: 10 }, { id: 'o20', seq: 20 }, { id: 'o30', seq: 30 }, { id: 'o40', seq: 40 }]
    expect(lineMapOf(planned, made)).toEqual([
      { requestLineId: 'c1', requestSeq: 1, into: [{ lineId: 'o10', seq: 10 }] },
      { requestLineId: 'd2', requestSeq: 2, into: [{ lineId: 'o20', seq: 20 }, { lineId: 'o30', seq: 30 }] },
      { requestLineId: 'm3', requestSeq: 3, into: [{ lineId: 'o40', seq: 40 }] },
    ])
    expect(lineMapOf(planned, made.slice(0, 3), new Set([0]))).toEqual([
      { requestLineId: 'c1', requestSeq: 1, into: [] },
      { requestLineId: 'd2', requestSeq: 2, into: [{ lineId: 'o10', seq: 10 }, { lineId: 'o20', seq: 20 }] },
      { requestLineId: 'm3', requestSeq: 3, into: [{ lineId: 'o30', seq: 30 }] },
    ])
  })
})
// ---- end B-CP-077

// ---- B-CP-076: "Your price" — the draft's value and the carry on accept (pure) -----------------------------------------------
describe('B-CP-076: the customer’s own price — the draft’s value and its carry onto the order by the line map', () => {
  it('values a draft at the price shown, else the customer’s own, in minor units; null when a line has neither, or no line', () => {
    expect(draftValueOf([{ priceShown: '410', brandUnitPrice: '400', pieces: 2 }, { priceShown: null, brandUnitPrice: '390', pieces: 2 }], 'EUR')).toBe(160_000)
    expect(draftValueOf([{ priceShown: '410', brandUnitPrice: null, pieces: 1 }, { priceShown: null, brandUnitPrice: null, pieces: 1 }], 'EUR')).toBeNull()
    expect(draftValueOf([], 'EUR')).toBeNull()
    // The price check's own rounding: half up to the minor unit (1.005 → 1.01).
    expect(draftValueOf([{ priceShown: '0.335', brandUnitPrice: null, pieces: 3 }], 'EUR')).toBe(101)
  })

  it('carries by the map, never by place: 1 → 1 a unit row; 1 → n a line total on the first; every line priced → one order total', () => {
    const map = [
      { requestLineId: 'c1', into: [{ lineId: 'o10', pieces: 3 }] },
      { requestLineId: 'r2', into: [{ lineId: 'o20', pieces: 1 }] },
      { requestLineId: 'd3', into: [{ lineId: 'o30', pieces: 2 }, { lineId: 'o40', pieces: 2 }] },
    ]
    const priced = (red: string | null) => [{ requestLineId: 'c1', brandUnitPrice: '401' }, { requestLineId: 'r2', brandUnitPrice: red }, { requestLineId: 'd3', brandUnitPrice: '395.5' }]
    expect(brandPricesOfAccept({ currency: 'EUR', prices: priced(null), map })).toEqual([
      { orderLineId: 'o10', unitPrice: '401', netAmount: null, requestLineIds: ['c1'] },
      { orderLineId: 'o30', unitPrice: null, netAmount: 158_200, requestLineIds: ['d3'] },
    ])
    expect(brandPricesOfAccept({ currency: 'EUR', prices: priced('402'), map })).toEqual([
      { orderLineId: 'o10', unitPrice: '401', netAmount: null, requestLineIds: ['c1'] },
      { orderLineId: 'o20', unitPrice: '402', netAmount: null, requestLineIds: ['r2'] },
      { orderLineId: null, unitPrice: null, netAmount: 120_300 + 40_200 + 158_200, requestLineIds: ['c1', 'r2', 'd3'] },
    ])
    // No line made into several: unit rows only; no price: nothing; a line a copy made nothing from: nothing.
    expect(brandPricesOfAccept({ currency: 'EUR', prices: priced('402'), map: map.slice(0, 2) })).toHaveLength(2)
    expect(brandPricesOfAccept({ currency: 'EUR', prices: [{ requestLineId: 'c1', brandUnitPrice: null }], map })).toEqual([])
    expect(brandPricesOfAccept({ currency: 'EUR', prices: priced(null), map: [{ requestLineId: 'c1', into: [] }] })).toEqual([])
  })
})
// ---- end B-CP-076
