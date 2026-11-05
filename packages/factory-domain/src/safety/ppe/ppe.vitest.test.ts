import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { ROLE_TEMPLATES } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { SAFETY_PPE_ISSUE, SAFETY_PPE_MANAGE } from './permissions'
import { ppeReceipt, receiptFingerprintText, type ReceiptInput } from './receipt'
import {
  cleanSizes,
  COMMON_PPE,
  gapLines,
  itemProblems,
  lineEventId,
  lineProblems,
  normalPpeCode,
  paperDateRefusal,
  PPE_CODE,
  receiptKeyOf,
  receiptState,
  receiptsOf,
  sha256Hex,
  signedLanguageOf,
  signedReceiptText,
  standingIssues,
  statementLanguageOf,
  unitsDue,
  type CatalogueItem,
  type HeldRow,
  type SignedReceipt,
} from './rules'

/** PPE for workers (B-W2b-134; QHS-259, QHS-260, QHS-261): the catalogue's checks, issue lines, receipts, gaps. Made-up ids. */

const today = '2026-11-04'
const at = (iso: string) => new Date(iso)
const items = new Map<string, CatalogueItem>([
  ['i-gloves', { id: 'i-gloves', companyId: 'co-a', status: 'ACTIVE', sizes: ['7', '8', '9'] }],
  ['i-ears', { id: 'i-ears', companyId: 'co-a', status: 'ACTIVE', sizes: [] }],
  ['i-old', { id: 'i-old', companyId: 'co-a', status: 'ARCHIVED', sizes: [] }],
  ['i-other', { id: 'i-other', companyId: 'co-b', status: 'ACTIVE', sizes: [] }],
])

describe('the catalogue', () => {
  it('a code in capitals without spaces, sizes each once, 1 to 120 months, a cost from 0', () => {
    expect(normalPpeCode(' gloves-cut ')).toBe('GLOVES-CUT')
    expect(PPE_CODE.test('GLOVES CUT')).toBe(false)
    expect(itemProblems({ code: 'gloves cut', name: '', sizes: ['M', 'm', ''], lifeMonths: 0, unitCost: -1 }).map((issue) => issue.path)).toEqual([
      'code',
      'name',
      'sizes/2',
      'sizes',
      'lifeMonths',
      'unitCost',
    ])
    expect(itemProblems({ code: 'EAR-DEF', name: 'Ear defenders', sizes: [], lifeMonths: 24, unitCost: 1990, standard: 'EN 352-1:2020' })).toEqual([])
    expect(cleanSizes([' 7', '8', '7 ', ''])).toEqual(['7', '8'])
  })

  it('the common items are complete PPE items (the floor tiles: gloves, shoes, glasses, hearing, apron, mask)', () => {
    expect(COMMON_PPE.map((item) => item.code)).toEqual(['GLOVES-CUT', 'SHOES-S3', 'GLASSES', 'EAR-DEF', 'APRON', 'MASK-FFP2'])
    for (const item of COMMON_PPE) expect(itemProblems({ ...item, sizes: [...item.sizes] })).toEqual([])
  })
})

describe('issue lines', () => {
  it('items of the person’s company, ACTIVE, in one of their sizes (none for one size), 1 to 99, one line per item and size', () => {
    expect(lineProblems([{ ppeItemId: 'i-gloves', size: '8', quantity: 2, reason: 'NEW' }, { ppeItemId: 'i-ears', quantity: 1, reason: 'NEW' }], items, 'co-a')).toEqual([])
    const paths = lineProblems(
      [
        { ppeItemId: 'i-gloves', size: '12', quantity: 1, reason: 'NEW' },
        { ppeItemId: 'i-ears', size: 'M', quantity: 0, reason: 'NEW' },
        { ppeItemId: 'i-old', quantity: 1, reason: 'NEW' },
        { ppeItemId: 'i-other', quantity: 1, reason: 'NEW' },
        { ppeItemId: 'i-gloves', size: null, quantity: 1, reason: 'LOST' },
      ],
      items,
      'co-a',
    ).map((issue) => issue.path)
    expect(paths).toEqual(['lines/0/size', 'lines/1/size', 'lines/1/quantity', 'lines/2/ppeItemId', 'lines/3/ppeItemId', 'lines/4/size'])
    expect(lineProblems([{ ppeItemId: 'i-ears', quantity: 1, reason: 'NEW' }, { ppeItemId: 'i-ears', quantity: 2, reason: 'NEW' }], items, 'co-a').map((issue) => issue.path)).toEqual(['lines/1'])
    expect(lineProblems([], items, 'co-a').map((issue) => issue.path)).toEqual(['lines'])
  })

  it('a paper receipt is dated now or up to a year ago, never in the future', () => {
    const now = at('2026-11-04T10:00:00Z')
    expect(paperDateRefusal(at('2026-11-04T09:00:00Z'), now)).toBeNull()
    expect(paperDateRefusal(at('2026-11-05T10:00:00Z'), now)).toBe('IN_FUTURE')
    expect(paperDateRefusal(at('2025-10-01T10:00:00Z'), now)).toBe('TOO_LATE')
  })
})

describe('receipts', () => {
  const row = (id: string, issuedAt: string, extra: Partial<{ siteId: string; employeeId: string; method: string }> = {}) => ({ id, siteId: 's-a1', employeeId: 'p-anna', issuedAt: at(issuedAt), method: 'PAPER', ...extra })

  it('lines handed over together are one receipt named by its smallest id, newest first', () => {
    const rows = [row('b', '2026-11-04T10:00:00Z'), row('a', '2026-11-04T10:00:00Z'), row('c', '2026-11-03T10:00:00Z'), row('d', '2026-11-04T10:00:00Z', { method: 'FLOOR_PIN' }), row('e', '2026-11-04T10:00:00Z', { employeeId: 'p-bruno' })]
    const receipts = receiptsOf(rows)
    expect(receipts.map((receipt) => [receipt.receiptId, receipt.rows.map((entry) => entry.id)])).toEqual([
      ['a', ['a', 'b']],
      ['d', ['d']],
      ['e', ['e']],
      ['c', ['c']],
    ])
    expect(receiptKeyOf(rows[0]!)).toBe(receiptKeyOf(rows[1]!))
  })

  it('signed with the PIN, on paper with or without its scan, every line voided', () => {
    expect(receiptState('FLOOR_PIN', 0, 2, false)).toBe('SIGNED_PIN')
    expect(receiptState('PAPER', 0, 2, true)).toBe('SIGNED_PAPER')
    expect(receiptState('PAPER', 1, 2, false)).toBe('NOT_SIGNED')
    expect(receiptState('PAPER', 2, 2, false)).toBe('VOIDED')
  })

  it('the SHA-256 binds the statement in the person’s language and exactly the lines (never an item’s name)', () => {
    const signed: SignedReceipt = {
      language: 'it',
      companyId: 'co-a',
      siteId: 's-a1',
      employeeId: 'p-anna',
      workerId: 'w-anna',
      deviceId: 'd-1',
      issuedAt: '2026-11-04T10:00:00.000Z',
      lines: [{ ppeItemId: 'i-gloves', code: 'GLOVES-CUT', size: '8', quantity: 2, reason: 'NEW' }],
    }
    const sha = sha256Hex(signedReceiptText(signed))
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
    const { language: _language, ...facts } = signed
    expect(signedLanguageOf(facts, sha)).toBe('it')
    expect(signedLanguageOf(facts, sha256Hex(signedReceiptText({ ...signed, language: 'en' })))).toBe('en')
    expect(signedLanguageOf({ ...facts, lines: [{ ...facts.lines[0]!, quantity: 3 }] }, sha)).toBeNull()
    expect(statementLanguageOf('it-IT')).toBe('it')
    expect(statementLanguageOf('pa')).toBe('en')
    expect(lineEventId('key-1', 0)).toBe('key-1.1')
  })

  it('the PDF names each line with its void mark and says how it was signed; its fingerprint ignores the day it is made', () => {
    const input: ReceiptInput = {
      language: 'en',
      createdAt: '2026-11-04T10:00:00.000Z',
      company: { name: 'Made-up Leather Srl', lines: ['Via Finta 1'], legal: 'Made-up' },
      site: { code: 'A1', name: 'Plant A1' },
      person: { name: 'Made-up Anna', employeeCode: 'E1' },
      issuedAt: '2026-11-04T09:00:00.000Z',
      handedOverBy: null,
      method: 'FLOOR_PIN',
      state: 'SIGNED_PIN',
      signature: { worker: 'Anna', device: 'Tablet A1', sha256: 'a'.repeat(64), statement: 'I received these items and their instructions.' },
      scan: null,
      lines: [
        { code: 'GLOVES-CUT', name: 'Gloves', size: '8', quantity: 2, reason: 'NEW', voided: null },
        { code: 'EAR-DEF', name: 'Ear defenders', size: null, quantity: 1, reason: 'NEW', voided: { at: '2026-11-04T09:30:00.000Z', reason: 'Wrong item' } },
      ],
      sample: true,
    }
    const report = ppeReceipt(input)
    expect(report.title).toBe('PPE receipt')
    expect(report.sample).toBe('PREVIEW - not kept')
    expect(report.rows.map((entry) => entry.kind)).toEqual(['8', 'one size'])
    expect(report.rows[1]!.note).toContain('VOID on')
    expect(report.facts.some((fact) => fact.value === 'a'.repeat(64))).toBe(true)
    const { createdAt: _c, sample: _s, ...contents } = input
    expect(receiptFingerprintText(contents)).toBe(receiptFingerprintText({ ...contents }))
    expect(ppeReceipt({ ...input, state: 'VOIDED', sample: false }).sample).toContain('VOID')
  })
})

describe('gaps', () => {
  const issue = (id: string, ppeItemId: string, quantity: number, issuedAt: string, extra: Partial<HeldRow> = {}): HeldRow => ({ id, kind: 'ISSUE', ppeItemId, quantity, issuedAt: at(issuedAt), voidsId: null, ...extra })

  it('a VOID takes its issue out of what is held', () => {
    const rows = [issue('1', 'i-gloves', 2, '2026-10-01T08:00:00Z'), issue('2', 'i-gloves', 1, '2026-10-02T08:00:00Z'), issue('3', 'i-gloves', 1, '2026-10-02T09:00:00Z', { kind: 'VOID', voidsId: '2' })]
    expect(standingIssues(rows).map((row) => row.id)).toEqual(['1'])
  })

  it('units due: the newest units up to the kit are in use, due when their life is over; a replacement makes them new', () => {
    const old = [issue('1', 'i-gloves', 2, '2026-03-01T08:00:00Z')]
    expect(unitsDue(old, 2, 6, today)).toBe(2)
    expect(unitsDue(old, 2, 12, today)).toBe(0)
    expect(unitsDue(old, 2, null, today)).toBe(0)
    const replaced = [...old, issue('2', 'i-gloves', 2, '2026-11-01T08:00:00Z')]
    expect(unitsDue(replaced, 2, 6, today)).toBe(0)
    expect(unitsDue([...old, issue('2', 'i-gloves', 1, '2026-11-01T08:00:00Z')], 2, 6, today)).toBe(1)
  })

  it('a person against their kit: units held, missing, due for replacement', () => {
    const standing = [issue('1', 'i-gloves', 1, '2026-03-01T08:00:00Z')]
    const lines = gapLines(
      [
        { ppeItemId: 'i-gloves', quantity: 2, whenToWear: 'At the cutting table' },
        { ppeItemId: 'i-ears', quantity: 1, whenToWear: 'At the press' },
      ],
      (itemId) => (itemId === 'i-gloves' ? 1 : 0),
      standing,
      (itemId) => (itemId === 'i-gloves' ? 6 : null),
      today,
    )
    expect(lines.map((line) => [line.ppeItemId, line.held, line.missing, line.replace])).toEqual([
      ['i-gloves', 1, 1, 1],
      ['i-ears', 0, 1, 0],
    ])
  })
})

describe('permissions, templates, events', () => {
  it('declared; the safety officer keeps the catalogue; it, HR and the floor supervisor record paper receipts; events of their own module', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(SAFETY_PPE_MANAGE)).toBe(true)
    expect(FACTORY_PERMISSIONS.isDeclared(SAFETY_PPE_ISSUE)).toBe(true)
    expect(ROLE_TEMPLATES.filter((template) => template.permissions.includes(SAFETY_PPE_MANAGE)).map((template) => template.key).sort()).toEqual(['owner', 'safety_officer'])
    expect(ROLE_TEMPLATES.filter((template) => template.permissions.includes(SAFETY_PPE_ISSUE)).map((template) => template.key).sort()).toEqual(['floor_supervisor', 'hr', 'owner', 'safety_officer'])
    expect(EVENT_DEFINITIONS.filter((event) => event.context === 'safety-ppe').map((event) => event.type)).toEqual(['ppe_item.changed', 'ppe.issued', 'ppe_issue.voided'])
  })
})
