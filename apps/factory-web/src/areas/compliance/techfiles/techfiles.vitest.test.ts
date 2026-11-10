import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ASSESSMENT_STATUSES,
  BATCH_STATES,
  EVIDENCE_FILE_RECORD_TYPES,
  FREQUENCIES,
  HAZARDS,
  ITEM_STATES,
  MISSING_CODES,
  PACK_CONTENTS,
  PACK_PURPOSES,
  PACK_SCOPES,
  PACK_STATUSES,
  PLAN_STATES,
  POINT_STATES,
  RESIDUAL_RISKS,
  RETENTION_STATES,
  TECHNICAL_FILE_STATUSES,
  TEST_KINDS,
  TEST_RESULTS,
} from '@nexus/factory-domain/compliance/techfiles/rules'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { RECORD_PAGES, recordAddress as recordPage } from '../../../lib/records/record-links'
import { permissionCheck } from '../../../lib/session/session'
import { isWindowPage, OFFICE_PAGES, officeNavFor } from '../../../shell/nav/office-nav'
import { EVIDENCE_STATES, LIST_TILES, REPORT_SOURCES } from './api'
import { BUILT_PACK, FAILED_PACK, FILES, LIST, OPEN_RECORD, RISK, TODAY } from './_demo/fixtures'
import { designScreen as listScreen } from './fixtures'
import { designScreen as authorityScreen } from './link/fixtures'
import {
  addDays,
  annexBar,
  archiveHeld,
  batchList,
  completeHeld,
  completeHeldWords,
  csvRows,
  daysUntil,
  emptyPack,
  emptyRecord,
  emptySchedule,
  emptyShare,
  fileWriteHeld,
  itemActionHeld,
  linkLive,
  listAddressOf,
  listSearch,
  newRevisionHeld,
  newRiskRow,
  openPointLetters,
  packBody,
  packProblems,
  packsInOrder,
  problemOf,
  productionTone,
  recordProblems,
  recordTypeKey,
  refusalDetail,
  removePackHeld,
  reopenHeld,
  reportKind,
  riskCellProblem,
  riskWriteHeld,
  scheduleProblems,
  shareHeld,
  shareProblems,
  shortHash,
  shownAssessment,
  signHeld,
  signProblems,
  techfilesCan,
  tileOfAddress,
  tilesOf,
  unreviewState,
  zoneCodeOf,
  zoneIdOf,
  zoneMarks,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { designScreen as windowScreen } from './window/fixtures'

const MANAGER = techfilesCan(['compliance.certificates.view', 'compliance.techfiles.manage', 'compliance.techfiles.sign', 'compliance.techfiles.share', 'files.read'])
const READER = techfilesCan(['compliance.certificates.view'])

describe('technical files: the list (SCR-120)', () => {
  it('reads and writes its address; a tile is a saved filter of the API', () => {
    const params = new URLSearchParams('status=OPEN&q=JKT&tile=ITEMS_MISSING&new=1&pack=abc')
    const address = listAddressOf(params)
    expect(address).toEqual({ status: 'OPEN', q: 'JKT', tile: 'ITEMS_MISSING', add: true, pack: 'abc' })
    expect(listSearch(address)).toBe('?status=OPEN&q=JKT&tile=ITEMS_MISSING&new=1&pack=abc')
    expect(listAddressOf(new URLSearchParams('status=LOST&tile=NOPE'))).toMatchObject({ status: null, tile: null, add: false })
    expect(tileOfAddress(address)).toBe('itemsMissing')
    expect(LIST_TILES).toEqual(['COMPLETE', 'ITEMS_MISSING', 'BATCHES_WITHOUT_EVIDENCE', 'RETENTION_ENDING', 'AUTHORITY_PACKS'])
  })

  it('five tiles; unknown while reading (never 0); the alarm only when something is missing', () => {
    expect(tilesOf(null).map((tile) => tile.value)).toEqual([null, null, null, null, null])
    const tiles = tilesOf(LIST.tiles)
    expect(tiles.map((tile) => [tile.id, tile.value, tile.second, tile.alarm])).toEqual([
      ['complete', 1, null, false],
      ['itemsMissing', 3, 9, true],
      ['batches', 2, null, true],
      ['retention', 1, 0, false],
      ['authority', 1, null, false],
    ])
  })

  it('the Annex III bar and the production-control cell say their tone from what is missing', () => {
    expect(annexBar({ done: 9, outOf: 13, open: null, missingItems: 2 })).toEqual({ percent: 69, tone: 'missing' })
    expect(annexBar({ done: 13, outOf: 13, open: null, missingItems: 0 }).tone).toBe('complete')
    expect(productionTone({ made: 4, withEvidence: 2, missing: 1, failed: 1, inProgress: 0 })).toBe('danger')
    expect(productionTone({ made: 4, withEvidence: 3, missing: 1, failed: 0, inProgress: 0 })).toBe('warning')
    expect(productionTone({ made: 0, withEvidence: 0, missing: 0, failed: 0, inProgress: 0 })).toBe('neutral')
  })

  it('the CSV says the rows in the page words, one line per file, no money', () => {
    const rows = csvRows(FILES.slice(0, 1), (key, params) => `${key}${params ? JSON.stringify(params) : ''}`, (day) => day ?? '')
    expect(rows[0]).toEqual(expect.arrayContaining(['TF-DEMO-0001', 'DEMO-JKT-01 Giacca Demo Touring', 'status.OPEN', 'cell.annex{"done":9,"outOf":13}']))
    expect(rows[0]!.join(' ')).not.toMatch(/price|cost|wage|€/i)
  })
})

describe('technical files: the record', () => {
  it('a file changes only while OPEN, by a person who manages, online', () => {
    expect(fileWriteHeld('OPEN', MANAGER, true)).toBeNull()
    expect(fileWriteHeld('OPEN', READER, true)).toBe('held.manage')
    expect(fileWriteHeld('OPEN', MANAGER, false)).toBe('held.offline')
    expect(fileWriteHeld('COMPLETE', MANAGER, true)).toBe('held.complete')
    expect(fileWriteHeld('ARCHIVED', MANAGER, true)).toBe('held.archived')
    expect(reopenHeld('OPEN', MANAGER, true)).toBe('held.notComplete')
    expect(reopenHeld('COMPLETE', MANAGER, true)).toBeNull()
    expect(archiveHeld('ARCHIVED', MANAGER, true)).toBe('held.archived')
    expect(archiveHeld('COMPLETE', MANAGER, true)).toBeNull()
  })

  it('Complete is held with the open points by their letters, else the certificate the category needs', () => {
    expect(openPointLetters(OPEN_RECORD.points)).toEqual(['(b)', '(d)', '(e)', '(j)'])
    expect(completeHeld(OPEN_RECORD, MANAGER, true)).toBe('held.openPoints')
    expect(completeHeldWords(OPEN_RECORD, MANAGER, true)).toEqual({ key: 'held.openPointsList', params: { count: 4, points: '(b), (d), (e), (j)' } })
    const done = { ...OPEN_RECORD, points: OPEN_RECORD.points.map((point) => ({ ...point, state: 'REVIEWED' as const })), file: { ...OPEN_RECORD.file, certificate: null } }
    expect(completeHeldWords({ ...done, completeProblems: [{ path: 'certificateId', message: 'x' }] }, MANAGER, true)).toEqual({ key: 'held.certificateNeeded' })
    expect(completeHeldWords({ ...done, completeProblems: [] }, MANAGER, true)).toBeNull()
    expect(completeHeldWords(OPEN_RECORD, READER, true)).toEqual({ key: 'held.manage' })
  })

  it('each Annex III row action says why it is held; the system never reviews', () => {
    const missing = { state: 'MISSING' as const, evidence: null }
    const linked = { state: 'LINKED' as const, evidence: OPEN_RECORD.points[1]!.items[0]!.evidence }
    expect(itemActionHeld('review', missing, null, 1)).toBe('held.noEvidence')
    expect(itemActionHeld('review', linked, null, 1)).toBeNull()
    expect(itemActionHeld('review', { state: 'REVIEWED', evidence: linked.evidence }, null, 1)).toBe('held.reviewed')
    expect(itemActionHeld('review', { state: 'NOT_APPLICABLE', evidence: null }, null, 1)).toBe('held.isNa')
    expect(itemActionHeld('unreview', linked, null, 1)).toBe('held.notReviewed')
    expect(itemActionHeld('clear', missing, null, 1)).toBe('held.nothingToClear')
    expect(itemActionHeld('remove', linked, null, 1)).toBe('held.lastRow')
    expect(itemActionHeld('remove', linked, null, 2)).toBeNull()
    expect(itemActionHeld('link', missing, 'held.complete', 1)).toBe('held.complete')
    expect(unreviewState({ evidence: linked.evidence })).toBe('LINKED')
    expect(unreviewState({ evidence: null })).toBe('MISSING')
    expect(recordTypeKey('Certificate')).toBe('recordType.Certificate')
    expect(recordTypeKey('Invoice')).toBe('recordType.other')
  })

  it('the garment zones: the map ids to the rows codes and back, marks per zone', () => {
    expect(zoneCodeOf('ELBOW_L')).toBe('elbow_l')
    expect(zoneIdOf('elbow_l')).toBe('ELBOW_L')
    expect(zoneIdOf('knee-left')).toBeNull()
    expect(zoneIdOf(null)).toBeNull()
    expect(GARMENT_ZONES.every((zone) => /^[a-z][a-z0-9_-]{0,39}$/.test(zoneCodeOf(zone.id)!))).toBe(true)
    expect(zoneMarks(RISK.assessments[1]!.rows)).toEqual(expect.arrayContaining([{ zone: 'SHOULDER', value: 1 }, { zone: 'ELBOW_L', value: 1 }, { zone: 'BACK', value: 1 }]))
  })

  it('the risk assessment: the revision shown, who may write, start and sign', () => {
    expect(shownAssessment(RISK.assessments, null)!.status).toBe('DRAFT')
    expect(shownAssessment(RISK.assessments, RISK.assessments[0]!.id)!.revision).toBe(1)
    const draft = RISK.assessments[1]!
    const signed = RISK.assessments[0]!
    expect(riskWriteHeld(draft, 'OPEN', MANAGER, true)).toBeNull()
    expect(riskWriteHeld(signed, 'OPEN', MANAGER, true)).toBe('held.signed')
    expect(riskWriteHeld(draft, 'COMPLETE', MANAGER, true)).toBeNull()
    expect(riskWriteHeld(draft, 'ARCHIVED', MANAGER, true)).toBe('held.archived')
    expect(newRevisionHeld(RISK.assessments, 'OPEN', MANAGER, true)).toBe('held.draftExists')
    expect(newRevisionHeld([signed], 'OPEN', MANAGER, true)).toBeNull()
    expect(signHeld(draft, 'OPEN', MANAGER, true)).toBeNull()
    expect(signHeld({ ...draft, rows: [] }, 'OPEN', MANAGER, true)).toBe('held.noHazards')
    expect(signHeld(draft, 'OPEN', READER, true)).toBe('held.sign')
    expect(signHeld(signed, 'OPEN', MANAGER, true)).toBe('held.noDraft')
    expect(signProblems({ name: ' ', fn: 'QA' })).toEqual(['problem.signName'])
  })

  it('a cell is checked before it is sent; a new hazard takes the first one not listed and the zone picked', () => {
    expect(riskCellProblem('hazard', 'FIRE')).toBe('problem.hazard')
    expect(riskCellProblem('residualRisk', 'LOW')).toBeNull()
    expect(riskCellProblem('garmentZone', 'Left Shoulder')).toBe('problem.zone')
    expect(riskCellProblem('garmentZone', '')).toBeNull()
    expect(riskCellProblem('control', '  ')).toBe('problem.required')
    expect(riskCellProblem('foreseeableMisuse', '')).toBeNull()
    expect(riskCellProblem('standardClause', 'x'.repeat(101))).toBe('problem.tooLong')
    expect(newRiskRow([{ hazard: 'ABRASION' }], 'KNEE_L', { intendedUse: 'u', control: 'c' })).toEqual({ hazard: 'IMPACT', garmentZone: 'knee_l', intendedUse: 'u', control: 'c', residualRisk: 'LOW' })
  })

  it('production control: the drafts of Schedule and Record test, and the days', () => {
    expect(scheduleProblems(emptySchedule(TODAY))).toEqual([])
    expect(scheduleProblems({ ...emptySchedule(TODAY), test: 'OTHER' })).toEqual(['problem.testName'])
    expect(emptySchedule(TODAY, 'SEAM_STRENGTH', 'wo').frequency).toBe('EVERY_BATCH')
    expect(recordProblems(emptyRecord(TODAY), TODAY)).toEqual(['problem.result', 'problem.testedBy'])
    expect(recordProblems({ ...emptyRecord(TODAY), result: 'PASS', testedBy: 'Lab', testedOn: '2026-12-01' }, TODAY)).toEqual(['problem.testedFuture'])
    expect(recordProblems({ ...emptyRecord(TODAY), result: 'PASS', testedBy: 'Lab', file: { name: 'r.docx', size: 1, type: 'application/msword' } }, TODAY)).toEqual(['problem.labReportType'])
    expect(daysUntil('2026-11-18', TODAY)).toBe(8)
    expect(daysUntil('2026-10-28', TODAY)).toBe(-13)
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('test reports: a control test says its kind in our words', () => {
    expect(reportKind({ source: 'CONTROL_TEST', title: 'pocket retention (armour pocket, elbow)' })).toEqual({ test: 'POCKET_RETENTION', name: 'armour pocket, elbow' })
    expect(reportKind({ source: 'CONTROL_TEST', title: 'seam strength' })).toEqual({ test: 'SEAM_STRENGTH', name: null })
    expect(reportKind({ source: 'CERTIFICATE_FILE', title: 'Certificate X' })).toBeNull()
  })
})

describe('technical files: evidence packs', () => {
  it('the pop-up starts with every kind on, the newest batch as scope; its problems in our words', () => {
    const draft = emptyPack('de', 'LOT-1')
    expect(draft.include).toEqual([...PACK_CONTENTS])
    expect(draft.scope).toBe('BATCHES')
    expect(emptyPack('it').scope).toBe('STYLE')
    expect(packProblems(draft)).toEqual(['problem.recipient'])
    expect(packProblems({ ...draft, recipient: 'A', include: [], language: 'German' })).toEqual(['problem.language', 'problem.include'])
    expect(packProblems({ ...draft, recipient: 'A', scope: 'SERIALS', serialFrom: 'B', serialTo: 'A' })).toEqual(['problem.serialOrder'])
    expect(packProblems({ ...draft, recipient: 'A', scope: 'SHIPMENT' })).toEqual(['problem.shipment'])
    expect(batchList('LOT-1, LOT-2\nLOT-1;;')).toEqual(['LOT-1', 'LOT-2'])
    expect(packBody({ ...draft, recipient: ' Authority ', batchNumbers: 'B1\nB2', include: ['CR6', 'DOC'] })).toEqual({ purpose: 'AUTHORITY', language: 'de', recipient: 'Authority', recipientPartyId: null, scope: { kind: 'BATCHES', batchNumbers: ['B1', 'B2'] }, include: ['DOC', 'CR6'], note: null })
  })

  it('sending by link: a party, a password of 8, an end within 365 days, an e-mail when mailed; who may', () => {
    const draft = emptyShare(TODAY, 'it', 'party')
    expect(draft.expiresOn).toBe('2026-12-10')
    expect(shareProblems(draft, TODAY)).toEqual(['problem.password', 'problem.email'])
    expect(shareProblems({ ...draft, partyId: null, password: '12345678', send: false }, TODAY)).toEqual(['problem.noParty'])
    expect(shareProblems({ ...draft, password: '12345678', send: false, expiresOn: '2027-11-11' }, TODAY)).toEqual(['problem.expiresOn'])
    expect(shareHeld(BUILT_PACK, MANAGER, true)).toBeNull()
    expect(shareHeld(BUILT_PACK, READER, true)).toBe('held.share')
    expect(shareHeld(FAILED_PACK, MANAGER, true)).toBe('held.share')
    expect(removePackHeld(FAILED_PACK, true)).toBeNull()
    expect(removePackHeld(BUILT_PACK, true)).toBe('held.packKept')
    const now = new Date('2026-11-10T10:00:00Z')
    expect(BUILT_PACK.links.map((link) => linkLive(link, now))).toEqual([true, false])
    expect(shortHash('0123456789abcdef')).toBe('012345…cdef')
    expect(packsInOrder([BUILT_PACK, { ...FAILED_PACK, status: 'BUILDING' }])[0]!.status).toBe('BUILDING')
  })

  it('a refusal is said in our words with the API sentences as data under it', () => {
    const error = new ApiError('conflict', 409, 'conflict', 'Refused.', null, [{ path: 'points/B', message: 'Point (b) is not reviewed.' }])
    expect(problemOf(error)).toBe('problem.conflict')
    expect(refusalDetail(error)).toEqual(['Point (b) is not reviewed.'])
    expect(problemOf(new Error('x'))).toBe('problem.unavailable')
  })
})

describe('technical files: navigation', () => {
  it('the list, the record and the two windows are built; a technical file and a pack open their pages', () => {
    for (const page of ['/compliance/techfiles', '/compliance/techfiles/[id]', '/compliance/techfiles/pack', '/compliance/techfiles/pack/link']) expect(OFFICE_PAGES.has(page), page).toBe(true)
    expect(isWindowPage('/compliance/techfiles/pack?pack=x')).toBe(true)
    expect(isWindowPage('/compliance/techfiles/pack/link')).toBe(true)
    expect(isWindowPage('/compliance/techfiles')).toBe(false)
    expect(RECORD_PAGES.TechnicalFile).toBe('/compliance/techfiles/[id]')
    expect(recordPage({ type: 'TechnicalFile', id: 'f1' }, OFFICE_PAGES)).toBe('/compliance/techfiles/f1')
    expect(recordPage({ type: 'EvidencePack', id: 'p1' }, OFFICE_PAGES)).toBe('/compliance/techfiles/pack?pack=p1')
  })

  it('Compliance › Main lists Technical files after Certificates for a reader of certificates', () => {
    const nav = officeNavFor(permissionCheck(['home.view', 'compliance.certificates.view']))
    const area = nav.areas.find((entry) => entry.id === 'compliance')!
    const ids = (area.sections ?? []).flatMap((section) => section.items.map((entry) => entry.id))
    expect(ids.indexOf('compliance-techfiles')).toBe(ids.indexOf('compliance-certificates') + 1)
    const none = officeNavFor(permissionCheck(['home.view', 'sales.quotes.view']))
    expect((none.areas.find((entry) => entry.id === 'compliance')?.sections ?? []).flatMap((section) => section.items.map((entry) => entry.id))).not.toContain('compliance-techfiles')
  })
})

// ---- the words and every design case ---------------------------------------------------------------------------------------

const NAMESPACE = 'compliance-techfiles'
const TOP = [...new Set(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).map((key) => key.split('.')[0]!.replace(/_(one|other)$/, '')))]
const LEFT_KEY = new RegExp(`\\b(?:${TOP.join('|')})\\.[a-zA-Z_-]+(?:\\.[a-zA-Z_-]+)*\\b`)
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Said on purpose: permission names, e-mail addresses, made-up links and file names. */
const SAID = /\b(?:compliance\.[a-zA-Z.]+|files\.[a-z]+|[a-z.-]+@[a-z.-]+\.example|https:\/\/[^\s"<]+|[A-Za-z0-9 _-]+\.(?:pdf|zip))/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'quality']) }, createElement(View, { model })))
}

describe('technical files: the words', () => {
  it('every key in it and en; every word the screens name exists; every code has its words', () => {
    expect(Object.keys(CATALOGUE.it[NAMESPACE] ?? {}).sort()).toEqual(Object.keys(CATALOGUE.en[NAMESPACE] ?? {}).sort())
    const folder = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(folder, { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.') && !file.includes('fixtures')).map((file) => readFileSync(join(folder, file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...[...source.matchAll(/'((?:held|problem|refused|done|stepUp\.sentence)\.[a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!), 'stepUp.cancelled', 'stepUp.confirm']
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale][NAMESPACE] ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      expect([...new Set([...literal, ...named])].filter((key) => !has(key)), locale).toEqual([])
      const codes: [string, readonly string[]][] = [
        ['status', TECHNICAL_FILE_STATUSES],
        ['ppe', ['NOT_PPE', 'CATEGORY_I', 'CATEGORY_II', 'CATEGORY_III']],
        ['assessment', ASSESSMENT_STATUSES],
        ['retention', RETENTION_STATES],
        ['pointState', POINT_STATES],
        ['itemState', ITEM_STATES],
        ['evidence.stale', EVIDENCE_STATES],
        ['recordType', [...EVIDENCE_FILE_RECORD_TYPES, 'other']],
        ['hazard', HAZARDS],
        ['residual', RESIDUAL_RISKS],
        ['testKind', TEST_KINDS],
        ['result', TEST_RESULTS],
        ['reportSource', REPORT_SOURCES],
        ['inspectionStatus', ['OPEN', 'PASSED', 'FAILED', 'CANCELLED']],
        ['batchState', BATCH_STATES],
        ['missing', MISSING_CODES],
        ['frequency', FREQUENCIES],
        ['planState', PLAN_STATES],
        ['purpose', PACK_PURPOSES],
        ['packStatus', PACK_STATUSES],
        ['scope', PACK_SCOPES],
        ['packScope', PACK_SCOPES],
        ['content', PACK_CONTENTS],
        ['linkState', ['LIVE', 'ENDED', 'REVOKED']],
        ['share.delivery', ['SENT', 'FAILED', 'QUEUED']],
        ['tab', ['annex', 'risk', 'tests', 'production', 'pack', 'activity']],
        ['live', ['connecting', 'live', 'offline']],
        ['done.item', ['review', 'unreview', 'clear', 'remove', 'na', 'linked']],
        ['refused.test', ['schedule', 'record']],
      ]
      for (const [prefix, list] of codes) for (const code of list) expect(has(`${prefix}.${code}`), `${locale} ${prefix}.${code}`).toBe(true)
      for (const tile of ['complete', 'itemsMissing', 'batches', 'retention', 'authority']) expect(has(`tile.${tile}.label`) && has(`tile.${tile}.hint`), `${locale} tile.${tile}`).toBe(true)
    }
  })

  for (const screen of [listScreen, recordScreen, windowScreen, authorityScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en with no key or placeholder left`, () => {
      for (const entry of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, entry.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${entry.id}`).toBeGreaterThan(150)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${entry.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('the design cases name every state and role the design asks for', () => {
    expect(listScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['normal', 'loading', 'error', 'empty', 'filtered-none', 'offline', 'sales', 'read-only', 'pack', 'pack-building', 'pack-built', 'new']))
    expect(recordScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['annex', 'risk', 'tests', 'production', 'packs', 'sign-code', 'share-code', 'offline', 'read-only', 'loading', 'error', 'forbidden']))
    expect(windowScreen.screen).toBe('SCR-326')
    expect(authorityScreen.screen).toBe('SCR-327')
  })
})
