import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../i18n/locales'
import { createTranslator, messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import type { ThreadFile } from '../files/model'
import { designScreen } from './fixtures'
import { bulkReach, filesGroups, keepLines, rangeOf, START_AUDIENCE } from './model'

/**
 * B-TH-299 — the Files view (T9): groups (by kind until the origin is known, then by origin), versions as one document, the
 * bulk bar's reach (Share only with THIS record's party, W13/W25; a legal hold refuses Delete), only this record's files —
 * tabs with their own file API stay out (R-1 to R-4, W26) —, the keep lines, the upload starting on Office, every case in
 * it and en.
 */

const KEY_ON_SCREEN = /\b(title|subtitle|missing|refused|forbidden|problem|empty|upload|select|bulk|group|version|keep|design)\.[a-zA-Z]/
const RECORD = { type: 'SalesOrder', id: 'so-beta' }
const PARTY = { id: 'party-beta', role: 'customer' as const }
const ALL = { upload: true, share: true, delete: true }

const file = (over: Partial<ThreadFile>): ThreadFile => ({
  id: 'f',
  recordType: RECORD.type,
  recordId: RECORD.id,
  name: 'x.pdf',
  contentType: 'application/pdf',
  kind: 'DOCUMENT',
  sizeBytes: 1,
  status: 'AVAILABLE',
  quarantineReason: null,
  visibility: ['OFFICE'],
  partyId: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  previewUrl: null,
  ...over,
})

describe('groups and versions', () => {
  it('groups by the system’s kind until every file says where it came from, then by origin; empty groups hidden', () => {
    const files = [file({ id: 'p', name: 'p.jpg', kind: 'PHOTO', contentType: 'image/jpeg' }), file({ id: 'd', name: 'd.pdf' }), file({ id: 'c', name: 'c.pdf', kind: 'CERTIFICATE' })]
    expect(filesGroups(files, RECORD).map((group) => group.key)).toEqual(['kind:PHOTO', 'kind:DOCUMENT', 'kind:CERTIFICATE'])
    const known = [file({ id: 'a', name: 'a.pdf', origin: 'party' }), file({ id: 'b', name: 'b.pdf', origin: 'made' })]
    expect(filesGroups(known, RECORD).map((group) => group.key)).toEqual(['origin:party', 'origin:made'])
    // One file without an origin: no half-true origin groups.
    expect(filesGroups([...known, file({ id: 'n', name: 'n.pdf' })], RECORD).every((group) => group.group.by === 'kind')).toBe(true)
  })

  it('shows a document once, its version in force on top and the earlier ones under it', () => {
    const groups = filesGroups([file({ id: 'v1', versionNo: 1 }), file({ id: 'v2', versionNo: 2, seriesId: 'v1', createdAt: '2026-11-12T09:00:00.000Z' })], RECORD)
    expect(groups[0]!.series).toHaveLength(1)
    expect(groups[0]!.series[0]!.latest.id).toBe('v2')
    expect(groups[0]!.series[0]!.earlier.map((one) => one.id)).toEqual(['v1'])
  })

  it('never lists another record’s file: tabs with their own file API keep theirs (R-1 to R-4, W26)', () => {
    const groups = filesGroups([file({ id: 'own', name: BRAND_BETA.fileName }), file({ id: 'wo', name: 'wo.pdf', recordType: 'WorkOrder', recordId: 'wo-1' }), file({ id: 'alpha', recordId: 'so-alpha', name: BRAND_ALPHA.fileName })], RECORD)
    const ids = groups.flatMap((group) => group.series.map((one) => one.latest.id))
    expect(ids).toEqual(['own'])
    expect(scanText(JSON.stringify(groups), BRAND_ALPHA)).toEqual([])
  })
})

describe('the bulk bar', () => {
  const shared = file({ id: 's', name: 's.pdf', visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id })
  const office = file({ id: 'o', name: 'o.pdf' })
  const held = file({ id: 'h', name: 'h.pdf', legalHold: true, visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id })
  const quarantined = file({ id: 'q', name: 'q.pdf', status: 'QUARANTINED', quarantineReason: 'scan_pending' })

  it('counts only what each action is allowed for', () => {
    const reach = bulkReach([shared, office, held, quarantined], PARTY, ALL)
    expect(reach.download).toEqual(['s', 'o', 'h'])
    expect(reach.share).toEqual(['o'])
    expect(reach.officeOnly).toEqual(['s', 'h'])
    expect(reach.remove).toEqual(['s', 'o', 'q'])
    expect(reach.onHold).toBe(1)
  })

  it('shares only with THIS record’s party: none without a party or without the right (W13, W25)', () => {
    // A file shared with another party counts as not shared with this one: Share puts it on this party, never the other.
    const elsewhere = file({ id: 'e', visibility: ['OFFICE', 'PARTNER'], partyId: 'party-alpha' })
    expect(bulkReach([elsewhere], PARTY, ALL).share).toEqual(['e'])
    expect(bulkReach([office], null, ALL).share).toEqual([])
    expect(bulkReach([office], PARTY, { ...ALL, share: false }).share).toEqual([])
    expect(bulkReach([office], PARTY, { ...ALL, delete: false })).toMatchObject({ remove: [], onHold: 0 })
  })

  it('shift-click chooses the range in the window’s order', () => {
    expect(rangeOf(['a', 'b', 'c', 'd'], 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeOf(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['a', 'b', 'c', 'd'])
    expect(rangeOf(['a', 'b'], null, 'b')).toEqual(['b'])
  })
})

describe('the keep lines and the upload', () => {
  const now = Date.UTC(2026, 10, 17)
  it('says held, legal hold and retention read-only', () => {
    expect(keepLines(file({ status: 'QUARANTINED', quarantineReason: 'scan_pending' }), now)[0]).toMatchObject({ key: 'keep.scanPending', tone: 'warning' })
    expect(keepLines(file({ status: 'QUARANTINED', quarantineReason: 'virus_found' }), now)[0]).toMatchObject({ key: 'keep.infected', tone: 'danger' })
    expect(keepLines(file({ legalHold: true }), now).map((line) => line.key)).toEqual(['keep.legalHold'])
    expect(keepLines(file({ retainUntil: '2036-12-31T23:00:00.000Z' }), now)[0]).toMatchObject({ key: 'keep.until' })
    expect(keepLines(file({ retainUntil: '2026-11-01T00:00:00.000Z' }), now)[0]).toMatchObject({ key: 'keep.due' })
  })

  it('starts an upload on Office', () => {
    expect(START_AUDIENCE).toBe('OFFICE')
  })
})

describe('the words', () => {
  it('has the words of every group, audience and plural, in it and en', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view'] ?? {})
      for (const key of ['PHOTO', 'DOCUMENT', 'CERTIFICATE', 'ATTACHMENT', 'AUDIO', 'FISCAL_ARCHIVE'].map((kind) => `group.kind.${kind}`).concat(['group.origin.ours', 'group.origin.made', 'group.origin.floor', 'group.origin.party.customer', 'group.origin.party.supplier'], ['OFFICE', 'FLOOR', 'PARTNER', 'LINK'].flatMap((audience) => [`upload.audience.${audience}`, `upload.audience.${audience}Body`]))) {
        expect(t(key), `${locale} ${key}`).not.toBe(key)
      }
      expect(t('subtitle', { count: 1 })).not.toBe(t('subtitle', { count: 2 }))
    }
  })

  it('draws every case of SCR-006-filesview with no key on screen', () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
        expect(html, `${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
      }
    }
  })
})
