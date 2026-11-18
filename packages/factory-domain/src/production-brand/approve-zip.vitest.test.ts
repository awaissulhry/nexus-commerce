import { describe, expect, it } from 'vitest'
import { GUEST_ZIP } from '../accounting/guest/files'
import { APPROVAL_KINDS, KIND_RULES } from '../approvals-out/kinds'
import { groupOf, kindOfFile, maySee, type DocumentAccess } from '../sales/portal-documents/library'
import {
  approveManyProblems,
  approveRowCodeOf,
  APPROVED_WORDS,
  approvesInBulk,
  BULK_APPROVE_KINDS,
  BULK_APPROVE_MAX,
  BULK_FILES_MAX,
  NO_UNDO_WORDS,
  NONE_APPROVED_WORDS,
  OWN_ANSWER_WORDS,
  PRODUCTION_ZIP,
  PRODUCTION_ZIP_REFUSALS,
  PRODUCTION_ZIP_WORDS,
  productionZipFolders, // fix-pr-5
  productionZipName,
  productionZipPaths,
  productionZipProblem,
  wordsOfRefusal,
} from './approve-zip'
import { BULK_ASK_MAX } from './bulk'

/**
 * B-PR-46b — Approve N and Download files of N, the pure part (production plan §1 "Bulk", §3 "Bulk 'Approve' cannot be undone";
 * L26; R-52; PW-12): the kinds Approve N answers (a revised order, a concession, a signature: "Open it to answer"), the body's own
 * problems, the row codes, the zip's limits, paths and name, the order confirmation as a priced document, and the customer's words
 * in "voi" (fix-portal-1).
 */

const ONE = '01900000-0000-7000-8000-000000000001'
const TWO = '01900000-0000-7000-8000-000000000002'

describe('B-PR-46b Approve N: kinds, limits, problems, codes', () => {
  it('answers a yes to a sample, a swatch, an artwork, a proof, a new date or our counter-offer; a revised order, a concession and a signature need their own page', () => {
    expect(BULK_APPROVE_MAX).toBe(50)
    expect(BULK_FILES_MAX).toBe(BULK_ASK_MAX)
    for (const kind of BULK_APPROVE_KINDS) expect(APPROVAL_KINDS as readonly string[]).toContain(kind)
    expect(APPROVAL_KINDS.filter((kind) => !approvesInBulk(kind))).toEqual(['CONCESSION', 'REVISED_ORDER', 'SIGNATURE'])
    // The revised order is the one kind that shows prices on its page: never answered from a list.
    expect(APPROVAL_KINDS.filter((kind) => KIND_RULES[kind].price).every((kind) => !approvesInBulk(kind))).toBe(true)
    expect(approvesInBulk('NOT_A_KIND')).toBe(false)
  })

  it('checks the typed name and each request once before any answer (400)', () => {
    expect(approveManyProblems({ typedName: 'Bea Buyer', items: [{ requestId: ONE }, { requestId: TWO }] })).toEqual([])
    expect(approveManyProblems({ typedName: ' B ', items: [{ requestId: ONE }] })).toEqual([{ path: 'body/typedName', message: 'Type your full name to sign the approvals.' }])
    expect(approveManyProblems({ typedName: 'x'.repeat(201), items: [{ requestId: ONE }] })).toEqual([{ path: 'body/typedName', message: 'At most 200 characters.' }])
    expect(approveManyProblems({ typedName: 'Bea Buyer', items: [{ requestId: ONE }, { requestId: ONE }] })).toEqual([{ path: 'body/items/1/requestId', message: 'This request is named twice.' }])
  })

  it("names a row's refusal by the answer path's error: someone else answers it, it takes no answer now, it changed since", () => {
    expect(approveRowCodeOf('forbidden')).toBe('NOT_YOURS')
    expect(approveRowCodeOf('invalid_state')).toBe('HELD')
    expect(approveRowCodeOf('conflict')).toBe('CHANGED')
    expect(approveRowCodeOf('validation_failed')).toBe('NOT_DONE')
  })

  it('speaks to the customer with "voi", says before Send that it cannot be undone, and keeps a refusal\'s own words', () => {
    expect(APPROVED_WORDS).toEqual({ it: 'Approvato.', en: 'Approved.' })
    expect(OWN_ANSWER_WORDS.en).toMatch(/^Open it to answer/)
    expect(OWN_ANSWER_WORDS.it).toMatch(/^Apritela per rispondere/)
    expect(NO_UNDO_WORDS.it).toContain('scriveteci')
    expect(NONE_APPROVED_WORDS.it).toContain('vedete')
    for (const words of [APPROVED_WORDS, OWN_ANSWER_WORDS, NO_UNDO_WORDS, NONE_APPROVED_WORDS, ...Object.values(PRODUCTION_ZIP_WORDS)]) {
      expect(words.it).not.toMatch(/\b(tu|ti|tuo|tua|tuoi|tue)\b/i)
      expect(words.it.trim()).not.toBe('')
      expect(words.en.trim()).not.toBe('')
    }
    expect(wordsOfRefusal(' This request is answered already. ')).toEqual({ it: 'This request is answered already.', en: 'This request is answered already.' })
    expect(wordsOfRefusal('')).toEqual({ it: 'Non è stato possibile approvarla.', en: 'This could not be approved.' })
  })
})

describe('B-PR-46b Download files of N: the zip', () => {
  it("holds what the accountant's zip holds at most, and says why not in words", () => {
    expect(PRODUCTION_ZIP).toEqual(GUEST_ZIP)
    expect(productionZipProblem([])).toBe('NOTHING_TO_ZIP')
    expect(productionZipProblem([{ sizeBytes: 10 }])).toBeNull()
    expect(productionZipProblem(Array.from({ length: GUEST_ZIP.maxFiles + 1 }, () => ({ sizeBytes: 1 })))).toBe('TOO_MANY_FILES')
    expect(productionZipProblem([{ sizeBytes: GUEST_ZIP.fileBytes + 1 }])).toBe('TOO_LARGE')
    expect(productionZipProblem(Array.from({ length: 5 }, () => ({ sizeBytes: GUEST_ZIP.fileBytes })))).toBe('TOO_LARGE')
    for (const code of PRODUCTION_ZIP_REFUSALS) expect(PRODUCTION_ZIP_WORDS[code]).toBeDefined()
    expect(PRODUCTION_ZIP_WORDS.TOO_MANY_FILES.en).toBe('A zip holds at most 400 files: pick fewer orders.')
  })

  it('puts each file in its order\'s folder, numbers a repeated name, and names the zip by its order or its count', () => {
    expect(productionZipPaths([
      { folder: 'BETA-PO-0142', name: 'order sheet.pdf' },
      { folder: 'BETA-PO-0142', name: 'Order Sheet.pdf' },
      { folder: 'Your order 13', name: 'order sheet.pdf' },
      { folder: 'BETA/0144', name: '../artwork.pdf' },
    ])).toEqual(['BETA-PO-0142/order sheet.pdf', 'BETA-PO-0142/Order Sheet (2).pdf', 'Your order 13/order sheet.pdf', 'BETA_0144/__artwork.pdf'])
    expect(productionZipName(['BETA-PO-0142'], '2026-11-18')).toBe('BETA-PO-0142_files.zip')
    expect(productionZipName(['BETA-PO-0142', 'Your order 13'], '2026-11-18')).toBe('files_2_orders_2026-11-18.zip')
  })

  // fix-pr-5 (lead decision): the portal never shows the office's order series; the zip names each order as the customer knows it.
  it('names each order by its own PO, else "Your order N" (its own number), else its place; a PO picked twice adds the number', () => {
    expect(productionZipFolders([{ customerRef: 'BETA-PO-0142', customerSeq: 12 }, { customerRef: null, customerSeq: 13 }, { customerRef: '  ', customerSeq: null }], 'en')).toEqual(['BETA-PO-0142', 'Your order 13', 'Order 3'])
    expect(productionZipFolders([{ customerRef: null, customerSeq: 13 }, { customerRef: null, customerSeq: null }], 'it')).toEqual(['Il vostro ordine 13', 'Ordine 2'])
    expect(productionZipFolders([{ customerRef: 'PO 7', customerSeq: 4 }, { customerRef: 'po 7', customerSeq: 5 }, { customerRef: 'PO 7', customerSeq: null }], 'en')).toEqual(['PO 7 (Your order 4)', 'po 7 (Your order 5)', 'PO 7 (Order 3)'])
    expect(productionZipFolders([{ customerRef: 'PO/8', customerSeq: 1 }], 'en')).toEqual(['PO_8'])
  })

  it('reads the order confirmation the sales order keeps as an ORDER_CONFIRMATION: only a role that sees prices gets it (R-52)', () => {
    const shared = { recordType: 'SalesOrder', fileKind: 'DOCUMENT', category: null, created: null, source: null, generatedKind: 'ORDER_CONFIRMATION', quoteAccepted: null }
    expect(kindOfFile(shared)).toBe('ORDER_CONFIRMATION')
    expect(groupOf('ORDER_CONFIRMATION')).toBe('ORDERS')
    const production: DocumentAccess = { view: true, conformity: false, finance: false, price: false }
    const buyer: DocumentAccess = { view: true, conformity: true, finance: false, price: true }
    expect(maySee(production, groupOf('ORDER_CONFIRMATION'))).toBe(false)
    expect(maySee(buyer, groupOf('ORDER_CONFIRMATION'))).toBe(true)
    // A plain file shared on the order stays a document every role with the documents right reads.
    expect(kindOfFile({ ...shared, generatedKind: null })).toBe('OTHER')
    expect(maySee(production, groupOf('OTHER'))).toBe(true)
  })
})
