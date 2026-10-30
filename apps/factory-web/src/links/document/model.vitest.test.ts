import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api/errors'
import { linkDocumentsSchema, type LinkDocument } from './api'
import { designScreen } from './fixtures'
import {
  dayInstant,
  documentRows,
  fileNameOf,
  isExpired,
  languageName,
  languageVersions,
  MAX_TIMER_MS,
  msUntilExpiry,
  opensLeftTone,
  rowOf,
  shownDocument,
  sortedDocuments,
  stateOfDocuments,
  stateOfReadError,
} from './model'

/** SCR-101's rules: the list's order, the document shown, its languages, the link's expiry and the dead states. */

const doc = (n: number, over: Partial<LinkDocument>): LinkDocument => ({
  fileId: `f${n}`,
  kind: 'OTHER',
  title: 't',
  style: null,
  language: null,
  number: null,
  date: null,
  originalName: `file-${n}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 1,
  sha256: String(n),
  availableAt: '2026-11-12T15:00:00.000Z',
  ...over,
})

const STYLE = { code: 'DEMO-JKT-01', name: 'Giacca Demo', revision: 3 }
const DDT = doc(1, { kind: 'DDT', number: '2026/0153' })
const DOC_IT = doc(2, { kind: 'DECLARATION_OF_CONFORMITY', style: STYLE, language: 'it' })
const DOC_EN = doc(3, { kind: 'DECLARATION_OF_CONFORMITY', style: STYLE, language: 'en' })
const INFO_EN = doc(4, { kind: 'USER_INFORMATION', style: STYLE, language: 'en' })
const OLD_DOC = doc(5, { kind: 'DECLARATION_OF_CONFORMITY', style: { ...STYLE, revision: 2 }, language: 'it' })
const OTHER = doc(6, { originalName: 'Note.pdf' })
const ALL = [OTHER, INFO_EN, DOC_EN, OLD_DOC, DOC_IT, DDT]

describe('the documents of the link (SCR-101)', () => {
  it('lists the DDT first, then the declarations (newest revision first) and the user information, then any other file', () => {
    expect(sortedDocuments(ALL).map((entry) => entry.fileId)).toEqual(['f1', 'f3', 'f2', 'f5', 'f4', 'f6'])
  })

  it('shows the chosen document while the link still shows it, else the first of the list; none when there is none', () => {
    expect(shownDocument(ALL, 'f4')?.fileId).toBe('f4')
    expect(shownDocument(ALL, 'gone')?.fileId).toBe('f1')
    expect(shownDocument(ALL, null)?.fileId).toBe('f1')
    expect(shownDocument([], null)).toBeNull()
  })

  it('finds the same document in other languages: same kind, style and revision; never for a DDT or another file', () => {
    expect(languageVersions(ALL, DOC_IT).map((entry) => entry.language)).toEqual(['en', 'it'])
    expect(languageVersions(ALL, OLD_DOC).map((entry) => entry.fileId)).toEqual(['f5'])
    expect(languageVersions(ALL, INFO_EN).map((entry) => entry.fileId)).toEqual(['f4'])
    expect(languageVersions(ALL, DDT)).toEqual([DDT])
    expect(languageVersions(ALL, OTHER)).toEqual([OTHER])
  })

  it('folds the languages of one document into one row, opening the version in the page language when there is one', () => {
    const rows = documentRows(ALL, 'it')
    expect(rows.map((row) => row.document.fileId)).toEqual(['f1', 'f2', 'f5', 'f4', 'f6'])
    expect(rows[1]?.versions.map((version) => version.fileId)).toEqual(['f3', 'f2'])
    expect(documentRows(ALL, 'en')[1]?.document.fileId).toBe('f3')
    expect(rowOf(rows, 'f3')?.document.fileId).toBe('f2')
    expect(rowOf(rows, 'nope')).toBeNull()
  })
})

describe('the link while the page is open', () => {
  const now = new Date('2026-11-30T16:00:00.000Z')

  it('expires when its expiry passes by the device clock, and says how long is left (never below 0, capped for a timer)', () => {
    expect(isExpired({ expiresAt: '2026-11-30T17:00:00.000Z' }, now)).toBe(false)
    expect(isExpired({ expiresAt: '2026-11-30T16:00:00.000Z' }, now)).toBe(true)
    expect(msUntilExpiry({ expiresAt: '2026-11-30T17:00:00.000Z' }, now)).toBe(3_600_000)
    expect(msUntilExpiry({ expiresAt: '2026-11-30T15:00:00.000Z' }, now)).toBe(0)
    expect(msUntilExpiry({ expiresAt: '2027-11-30T17:00:00.000Z' }, now)).toBe(MAX_TIMER_MS)
    expect(stateOfDocuments({ shipment: { number: 'S', status: 'SHIPPED', shippedAt: null, deliveredAt: null }, link: { expiresAt: '2026-11-30T15:00:00.000Z', usesLeft: 3 }, documents: [] }, now)).toBe('expired')
  })

  it('reads the one 404 of a dead link as "no longer opens", anything else as an error', () => {
    expect(stateOfReadError(new ApiError('not_found', 404, 'LINK_UNAVAILABLE', 'x'))).toBe('unavailable')
    expect(stateOfReadError(new ApiError('unavailable', 503, 'x', 'x'))).toBe('error')
    expect(stateOfReadError(new TypeError('network'))).toBe('error')
  })

  it('warns on the last few opens', () => {
    expect(opensLeftTone(1)).toBe('warning')
    expect(opensLeftTone(3)).toBe('warning')
    expect(opensLeftTone(18)).toBe('neutral')
  })
})

describe('words and files', () => {
  it('names a language in the page language, else its code', () => {
    expect(languageName('en', 'it')).toBe('Inglese')
    expect(languageName('it', 'en')).toBe('Italian')
    expect(languageName('zz', 'en')).toMatch(/^ZZ$|^Zz$/i)
  })

  it('reads a document date given as a day or as an instant (the DoC and the leaflet send their issue instant)', () => {
    expect(dayInstant('2026-11-12')).toBe('2026-11-12T12:00:00Z')
    expect(dayInstant('2026-10-30T03:05:00.000Z')).toBe('2026-10-30T03:05:00.000Z')
    for (const value of ['2026-11-12', '2026-10-30T03:05:00.000Z']) expect(Number.isNaN(new Date(dayInstant(value)).getTime())).toBe(false)
  })

  it('gives the download a .pdf name for a PDF', () => {
    expect(fileNameOf({ originalName: 'DDT 2026-0153', contentType: 'application/pdf' })).toBe('DDT 2026-0153.pdf')
    expect(fileNameOf({ originalName: 'DDT.pdf', contentType: 'application/pdf' })).toBe('DDT.pdf')
    expect(fileNameOf({ originalName: 'note.txt', contentType: 'text/plain' })).toBe('note.txt')
  })

  it('reads an unknown document kind as OTHER (a new API kind never breaks the page)', () => {
    const parsed = linkDocumentsSchema.parse({ shipment: { number: 'S', status: 'SHIPPED', shippedAt: null, deliveredAt: null }, link: { expiresAt: '2026-11-30T17:00:00.000Z', usesLeft: 3 }, documents: [{ ...DDT, kind: 'SOMETHING_NEW' }] })
    expect(parsed.documents[0]?.kind).toBe('OTHER')
  })

  it('has a design case for every state the page draws', () => {
    const states = new Set(designScreen.cases.map((entry) => entry.model.link))
    expect([...states].sort()).toEqual(['error', 'expired', 'loading', 'unavailable', 'valid'])
    expect(designScreen.cases.some((entry) => entry.model.ask === 'done')).toBe(true)
    expect(designScreen.cases.some((entry) => entry.model.pdf?.state === 'failed')).toBe(true)
  })
})
