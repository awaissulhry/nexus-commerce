import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FINDINGS, permissionsOf, ROWS, SUMMARY, TILES } from './fixtures'
import { RECORD } from './record/fixtures'
import { ticketLabel } from '@nexus/factory-domain/production/bundles/ticket'
import { addressOf, addressText, askOf, BUNDLE_TILES, BUNDLE_VIEWS, bundlesCanOf, bundleTabOf, csvCell, findingSelectable, isBundleChange, nextWords, oneHit, patternsState, placeWords, reasonOk, reprintHeld, reviewHeld, reviewManyHeld, rowsOfView, seenWords, stuckTile, stuckWords, ticketLayout, ticketOf, viewOfAddress, viewQuery, voidHeld, whoHeld, whoProblem, whoShowHeld } from './model'
import { ApiError } from '../../../lib/api/errors'

const params = (query: string) => new URLSearchParams(query)
const manager = bundlesCanOf(permissionsOf('manager'))
const owner = bundlesCanOf(permissionsOf('owner'))
const reader = bundlesCanOf(permissionsOf('reader'))

describe('the address: the API\'s own filters', () => {
  it('reads the two addresses Floor now links to (B-W2b-66), by those names', () => {
    expect(viewOfAddress(params('stuck=true'))).toBe('stuck')
    expect(viewOfAddress(params('place=LINE'))).toBe('line')
    expect(viewQuery('stuck', '', null)).toMatchObject({ status: 'ACTIVE', stuck: true })
    expect(viewQuery('line', '', 'site-1')).toMatchObject({ status: 'ACTIVE', place: ['LINE'], siteId: 'site-1' })
  })

  it('writes every view back as the same address, and reads it again', () => {
    for (const view of BUNDLE_VIEWS) expect(viewOfAddress(params(addressText({ view, q: '', ask: null }).slice(1)))).toBe(view)
    expect(addressText({ view: 'stuck', q: '', ask: null })).toBe('?stuck=true')
    expect(addressText({ view: 'line', q: '', ask: null })).toBe('?place=LINE')
    expect(addressText({ view: 'active', q: '', ask: null })).toBe('')
  })

  it('keeps the search and the count pressed, and ignores a kind it does not know', () => {
    const ask = { kind: 'GAP_BELOW_STANDARD', lineId: 'l1', operationCode: 'SCHIENA' } as const
    const address = addressOf(params(addressText({ view: 'line', q: ' BN-1 ', ask }).slice(1)))
    expect(address).toEqual({ view: 'line', q: 'BN-1', ask })
    expect(addressOf(params('check=WHO_IS_SLOW')).ask).toBeNull()
  })

  it('a place in lower case or a list reads its first known place; nothing known is the default', () => {
    expect(viewOfAddress(params('place=line'))).toBe('line')
    expect(viewOfAddress(params('place=NOPE,CUTTING'))).toBe('cutting')
    expect(viewOfAddress(params('place=NOPE'))).toBe('active')
    expect(viewOfAddress(null)).toBe('active')
  })

  it('the default leaves finished bundles out; void and all ask no place', () => {
    expect(viewQuery('active', '', null).place).toEqual(['CUTTING', 'LINE', 'QUALITY', 'SUBCONTRACTOR'])
    expect(viewQuery('void', '', null)).toMatchObject({ status: 'VOID' })
    expect(viewQuery('void', '', null).place).toBeUndefined()
    expect(viewQuery('all', 'x', null)).toMatchObject({ q: 'x' })
    expect(viewQuery('all', '', null).status).toBeUndefined()
  })
})

describe('the tiles and the views', () => {
  it('each tile but one is a view; Tickets replaced today only counts (the API has no filter for it)', () => {
    expect(BUNDLE_TILES.map((tile) => tile.view)).toEqual(['active', 'stuck', null, 'onHold', 'subcontractor'])
    expect(BUNDLE_TILES.map((tile) => tile.count(TILES))).toEqual([42, 3, 2, 1, 6])
  })

  it('the stuck tile names the limit of one site, else the limit in general', () => {
    expect(stuckTile(TILES)).toEqual({ key: 'tile.stuck', params: { hours: 4 } })
    expect(stuckTile({ ...TILES, stuckLimitHours: null })).toEqual({ key: 'tile.stuckAny' })
    expect(stuckTile(null)).toEqual({ key: 'tile.stuckAny' })
  })

  it('On hold keeps the holds: the API has one place for holds and rework', () => {
    expect(rowsOfView('onHold', ROWS.slice(3, 5)).map((row) => row.qualityReason)).toEqual(['HOLD'])
    expect(rowsOfView('quality', ROWS.slice(3, 5))).toHaveLength(2)
  })
})

describe('where a bundle is', () => {
  it('says each place in words, with the next operation', () => {
    expect(placeWords(ROWS[0]!)).toEqual({ key: 'place.line', params: { seq: 20, code: 'SCHIENA' } })
    expect(nextWords(ROWS[0]!)).toEqual({ key: 'place.next', params: { seq: 30, code: 'MANICHE' } })
    expect(placeWords(ROWS[2]!).key).toBe('place.cutting')
    expect(placeWords(ROWS[3]!).key).toBe('place.hold')
    expect(placeWords(ROWS[4]!).key).toBe('place.rework')
    expect(placeWords(ROWS[5]!)).toEqual({ key: 'place.subcontractor', params: { number: 'SC-00007' } })
    expect(placeWords(ROWS[6]!).key).toBe('place.finished')
    expect(placeWords(ROWS[7]!).key).toBe('place.void')
    expect(nextWords(ROWS[7]!)).toBeNull()
  })

  it('says a stuck wait in whole hours of the site calendar', () => {
    expect(stuckWords(ROWS[1]!)).toEqual({ key: 'stuck.for', params: { hours: 6, limit: 4 } })
    expect(stuckWords(ROWS[0]!)).toBeNull()
  })
})

describe('held acts say why', () => {
  it('Reprint N: the rights, then a selection every bundle of which may be reprinted', () => {
    const open = ROWS.slice(0, 2)
    expect(reprintHeld(open, manager)).toBeNull()
    expect(reprintHeld(open, reader)?.key).toBe('held.noAct')
    expect(reprintHeld(open, { ...manager, printLabels: false })?.key).toBe('held.noPrint')
    expect(reprintHeld([], manager)?.key).toBe('held.pickFirst')
    expect(reprintHeld([ROWS[0]!, ROWS[7]!], manager)).toEqual({ key: 'held.reprintVoid', params: { count: 1 } })
    expect(reprintHeld([ROWS[0]!, { ...ROWS[1]!, workOrder: { ...ROWS[1]!.workOrder, status: 'ON_HOLD' } }], manager)).toEqual({ key: 'held.reprintNotOpen', params: { count: 1 } })
    expect(reprintHeld([ROWS[0]!, { ...ROWS[1]!, siteId: 'another' }], manager)?.key).toBe('held.oneSite')
  })

  it('Void: the API\'s own rule, in order', () => {
    const none = { ...RECORD, bundle: { ...RECORD.bundle, scans: 0 } }
    expect(voidHeld(none, manager)).toBeNull()
    expect(voidHeld(RECORD, manager)).toEqual({ key: 'held.voidScanned', params: { count: 3 } })
    expect(voidHeld(none, reader)?.key).toBe('held.noAct')
    expect(voidHeld({ ...none, bundle: { ...none.bundle, status: 'VOID' } }, manager)?.key).toBe('held.voidAlready')
    expect(voidHeld({ ...none, workOrder: { ...none.workOrder, status: 'COMPLETED' } }, manager)?.key).toBe('held.voidNotOpen')
  })

  it('a reason is 3 to 200 characters', () => {
    expect(reasonOk(' ab ')).toBe(false)
    expect(reasonOk('abc')).toBe(true)
    expect(reasonOk('x'.repeat(201))).toBe(false)
  })
})

describe('scan-pattern checks: about bundles, never a person', () => {
  it('says per site why the checks do not run; the counts stay for sites that run', () => {
    expect(patternsState(SUMMARY)).toEqual({ counts: true, off: [] })
    const station = { ...SUMMARY, rows: [], sites: [{ ...SUMMARY.sites[0]!, checks: 'STATION_SITE' as const }] }
    expect(patternsState(station).counts).toBe(false)
    expect(patternsState(station).off[0]!.words).toEqual({ key: 'checks.STATION_SITE' })
    // Past findings stay readable after the purpose is switched off.
    expect(patternsState({ ...SUMMARY, sites: [{ ...SUMMARY.sites[0]!, checks: 'GATE_CLOSED' }] }).counts).toBe(true)
  })

  it('a count asks its kind, line and operation; a row without them asks none', () => {
    expect(askOf(SUMMARY.rows[0]!)).toMatchObject({ kind: 'BUNCHED_AT_SHIFT_END', operationCode: 'SCHIENA' })
    expect(askOf(SUMMARY.rows[2]!)).toEqual({ kind: 'MOVED_NOT_SCANNED', lineId: null, operationCode: null })
  })

  it('what was seen is counts and times', () => {
    expect(seenWords(FINDINGS[0]!)).toEqual({ key: 'seen.BUNCHED_AT_SHIFT_END', params: { scans: 7, minutes: 30 } })
    expect(seenWords({ kind: 'MOVED_NOT_SCANNED', seen: { missingSeq: 20, reachedSeq: 30 } }).params).toEqual({ missing: 20, reached: 30 })
    expect(seenWords({ kind: 'GAP_BELOW_STANDARD', seen: { gapMinutes: 4, standardMinutes: 9, pieces: 10 } }).params).toEqual({ gap: 4, standard: 9, pieces: 10 })
  })

  it('a finding is reviewed once, by who may', () => {
    expect(reviewHeld(FINDINGS[0]!, manager)).toBeNull()
    expect(reviewHeld(FINDINGS[0]!, reader)?.key).toBe('held.noFindings')
    expect(reviewHeld(FINDINGS[2]!, manager)?.key).toBe('held.findingFinal')
    expect(reviewHeld(FINDINGS[0]!, manager, true)?.key).toBe('held.busy')
    expect(reviewManyHeld([FINDINGS[0]!, FINDINGS[2]!], manager)?.key).toBe('held.findingFinal')
    expect(findingSelectable(FINDINGS[0]!)).toBeNull()
    expect(findingSelectable(FINDINGS[3]!)?.key).toBe('held.findingFinal')
  })

  it('Show who: the owner\'s permission first, then the site\'s checks', () => {
    expect(whoHeld(FINDINGS[0]!, SUMMARY, owner)).toBeNull()
    expect(whoHeld(FINDINGS[0]!, SUMMARY, manager)).toEqual({ key: 'held.noWho', params: { permission: 'production.bundles.who' } })
    expect(manager.who).toBe(false)
    const off = (checks: 'STATION_SITE' | 'NO_BASIS' | 'GATE_CLOSED') => whoHeld(FINDINGS[0]!, { ...SUMMARY, sites: [{ ...SUMMARY.sites[0]!, checks }] }, owner)?.key
    expect([off('STATION_SITE'), off('NO_BASIS'), off('GATE_CLOSED')]).toEqual(['checks.STATION_SITE', 'checks.NO_BASIS', 'checks.GATE_CLOSED'])
    expect(whoHeld(FINDINGS[0]!, null, owner)?.key).toBe('checks.UNKNOWN')
    expect(whoShowHeld(null, false)?.key).toBe('who.heldPurpose')
    expect(whoShowHeld('PAY_QUERY', false)).toBeNull()
  })

  it('a refused Show who is said in this page\'s words', () => {
    const refused = (kind: ApiError['kind'], path: string) => new ApiError(kind, 409, 'invalid_state', 'English', null, [{ path, message: 'English' }])
    expect(whoProblem(refused('conflict', 'gate/PERFORMANCE')).key).toBe('checks.GATE_CLOSED')
    expect(whoProblem(refused('conflict', 'who/STATION_SITE')).key).toBe('checks.STATION_SITE')
    expect(whoProblem(refused('conflict', 'who/NO_BASIS')).key).toBe('checks.NO_BASIS')
    expect(whoProblem(new Error('no')).key).toBe('who.failed')
  })

  it('no list or summary row of the page carries a person', () => {
    const keys = JSON.stringify([ROWS, SUMMARY, FINDINGS])
    expect(keys).not.toMatch(/worker|employee|operator/i)
  })

  it('names are read in one view file only, and the page keeps them only in the dialog\'s state', () => {
    const list = readFileSync(new URL('./view/BundlesView.tsx', import.meta.url), 'utf8')
    expect(list).not.toMatch(/worker/i)
    const page = readFileSync(new URL('./BundlesPage.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/Closing the dialog drops the names/)
    expect(page.match(/localStorage|sessionStorage/)).toBeNull()
  })
})

describe('search or scan', () => {
  it('one hit of what was scanned opens it; typing alone never does', () => {
    expect(oneHit('BN-1', 'BN-1', ROWS.slice(0, 1))).toBe(true)
    expect(oneHit(null, 'BN-1', ROWS.slice(0, 1))).toBe(false)
    expect(oneHit('BN-1', 'BN-1', ROWS.slice(0, 2))).toBe(false)
    expect(oneHit('BN-2', 'BN-1', ROWS.slice(0, 1))).toBe(false)
    expect(oneHit(' ', ' ', ROWS.slice(0, 1))).toBe(false)
  })
})

describe('the ticket', () => {
  const words = { name: (code: string) => `Ticket ${code}`, workOrder: 'WO', style: 'Style', colour: 'Colour', size: 'Size', pieces: 'Pieces', operations: 'Ops' }

  it('as LabelPreview data: 100 × 50 mm, the code as QR and barcode, the operations by number', () => {
    const layout = ticketLayout(RECORD, words)
    expect([layout.widthMm, layout.heightMm]).toEqual([100, 50])
    expect(JSON.stringify(layout.blocks)).toContain('"kind":"barcode","value":"BN-000001"')
    expect(JSON.stringify(layout.blocks)).toContain('"kind":"qr","value":"BN-000001"')
    expect(JSON.stringify(layout.blocks)).toContain('Ops: 10 · 20 · 30 · 40')
  })

  it('as the same BUNDLE label the printer prints, with no money and no person', () => {
    const label = ticketLabel(ticketOf(RECORD, 'it', 'Officina Demo'))
    expect(label.kind).toBe('BUNDLE')
    expect(label.scanId).toBe('BN-000001')
    expect(JSON.stringify(label)).not.toMatch(/price|cost|worker/i)
  })
})

describe('small rules', () => {
  it('the tabs default to Progress', () => {
    expect(bundleTabOf('ticket')).toBe('ticket')
    expect(bundleTabOf('who')).toBe('progress')
  })

  it('reads again on a scan, a bundle change or a finding, not on any production event', () => {
    for (const type of ['production.scan_recorded', 'production.bundle_created', 'production.bundle_stuck', 'production.scan_findings_found', 'production.scan_finding_reviewed']) expect(isBundleChange(type)).toBe(true)
    expect(isBundleChange('production.floor_rules_changed')).toBe(false)
    expect(isBundleChange('workorder.changed')).toBe(false)
  })

  it('a CSV cell is quoted when it must be', () => {
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell('say "x"')).toBe('"say ""x"""')
    expect(csvCell(null)).toBe('')
    expect(csvCell(3)).toBe('3')
  })
})
