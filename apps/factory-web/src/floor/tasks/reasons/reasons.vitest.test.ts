import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { FLOOR_NAMESPACES } from '../routes'
import { ReasonPickerBody, type ReasonPickerModel } from './view/ReasonPicker'
import { REASON_COLOURS, REASON_ICONS } from '@nexus/factory-domain/reasons/rules'
import { W1_SCAN_REASONS } from '@nexus/factory-domain/production/scans/reasons'
import { SPLIT_REASONS } from '@nexus/factory-domain/production/bundles/split'
import { tagIconSpec } from '@nexus/ui/primitives'
import { countedOf, doneHeld, fromDefect, fromFixedReason, fromListReason, fromScanReason, inTileOrder, LIST_OF, listOffers, lookOf, MODE_OF, NOTE_IN_OFFICE, pickedOf, PICKER_PURPOSES, tilesOf, wordOf, type PickerReason } from './model'

/**
 * SCR-091 the reason picker (B-W2a-74): one shape for every source, the tiles in the office's order and in the worker's
 * language, the look (the office's icon, the standard look of a scan code, tones only), and when Done waits.
 */

const listReason = (code: string, sortOrder: number, extra: Partial<PickerReason> = {}): PickerReason => ({
  ...fromListReason({ id: `r-${code}`, list: 'PAUSE', code, labelIt: `${code} it`, labelEn: `${code} en`, labelI18n: { ro: `${code} ro` }, icon: null, colour: null, needsDetail: false, sortOrder }),
  ...extra,
})

describe('the reasons of every source in one shape', () => {
  it('a list reason, a scan reason and a defect keep their words, look, photo and "asks for more"', () => {
    const pause = fromListReason({ id: 'x', list: 'PAUSE', code: 'OTHER', labelIt: 'Altro', labelEn: 'Other', labelI18n: {}, icon: 'camera', colour: '#5B6573', needsDetail: true, sortOrder: 90 })
    expect(pause).toMatchObject({ id: 'OTHER', list: 'PAUSE', icon: 'camera', needsDetail: true, photo: null })
    const scrap = fromScanReason({ kind: 'SCRAP', code: 'STAIN', label: { it: 'Macchia', en: 'Stain' }, sortOrder: 40 })
    expect(scrap).toMatchObject({ id: 'STAIN', list: 'SCRAP', labelIt: 'Macchia', labelEn: 'Stain', icon: null, colour: null, needsDetail: false })
    const defect = fromDefect({ id: 'd1', code: 'HOLE', labelIt: 'Foro', labelEn: 'Hole', labelI18n: {}, icon: null, colour: '#e5484d', pictureFileId: 'f1', needsDetail: false, sortOrder: 10 }, (id) => `/api/files/${id}/download`)
    expect(defect).toMatchObject({ list: 'DEFECT', photo: '/api/files/f1/download' })
    expect(fromDefect({ ...defect, id: 'd2', pictureFileId: null }).photo).toBeNull()
  })

  it('a reason the screen fixes (B-W2a-F6: a split\'s rework / recut / hold) keeps the API\'s code and the screen\'s word and hint', () => {
    const recut = fromFixedReason({ list: 'SPLIT', code: 'RECUT', label: 'Ritaglio', hint: 'Pezzi da tagliare di nuovo', sortOrder: 20 })
    expect(recut).toMatchObject({ id: 'RECUT', list: 'SPLIT', code: 'RECUT', icon: null, colour: null, needsDetail: false, hint: 'Pezzi da tagliare di nuovo' })
    expect(wordOf(recut, 'en')).toBe('Ritaglio')
    expect(wordOf(recut, 'de')).toBe('Ritaglio')
    expect(tilesOf([recut], 'it')[0]).toMatchObject({ label: 'Ritaglio', hint: 'Pezzi da tagliare di nuovo', heldReason: null })
    expect(tilesOf([listReason('BREAK', 10)], 'it')[0]!.hint).toBeNull()
  })

  it('the tiles follow the office\'s order (code breaks a tie), never a per-person learning', () => {
    const reasons = [listReason('B', 20), listReason('A', 20), listReason('C', 10)]
    expect(inTileOrder(reasons).map((reason) => reason.code)).toEqual(['C', 'A', 'B'])
    expect(tilesOf(reasons, 'en').map((tile) => tile.id)).toEqual(['C', 'A', 'B'])
  })

  it('says each reason in the worker\'s language; another floor language falls back to English when it has none', () => {
    const reason = listReason('MACHINE', 10)
    expect(wordOf(reason, 'it')).toBe('MACHINE it')
    expect(wordOf(reason, 'en')).toBe('MACHINE en')
    expect(wordOf(reason, 'ro')).toBe('MACHINE ro')
    expect(wordOf(reason, 'de')).toBe('MACHINE en')
  })
})

describe('the look of a tile', () => {
  it('every icon the office may pick is a DS tag icon, every colour a tone (a tenant hex is never painted)', () => {
    for (const icon of REASON_ICONS) {
      expect(tagIconSpec(icon), icon).toBeTruthy()
      expect(lookOf(listReason('X', 1, { icon })).icon).toBe(`tag:${icon}`)
    }
    for (const colour of REASON_COLOURS) expect(['primary', 'success', 'warning', 'danger', 'info', 'neutral']).toContain(lookOf(listReason('X', 1, { icon: 'star', colour })).tone)
    expect(lookOf(listReason('X', 1, { icon: 'star', colour: '#E5484D' })).tone).toBe('danger')
    expect(lookOf(listReason('X', 1, { icon: 'star', colour: '#123456' })).tone).toBe('neutral')
  })

  it('W2b (MES-125): a scan reason with the office\'s icon, colour and words draws them; its other language is the worker\'s word', () => {
    const stain = fromScanReason({ kind: 'SCRAP', code: 'STAIN', label: { it: 'Macchia', en: 'Stain' }, sortOrder: 40, icon: 'alert', colour: '#e5484d', labelI18n: { ro: 'Pată' }, needsDetail: false })
    expect(lookOf(stain)).toEqual({ icon: 'tag:alert', tone: 'danger' })
    expect(tilesOf([stain], 'ro')[0]).toMatchObject({ label: 'Pată', icon: 'tag:alert', tone: 'danger' })
    const other = fromScanReason({ kind: 'SCRAP', code: 'OTHER', label: { it: 'Altro', en: 'Other' }, sortOrder: 90, icon: null, colour: null, labelI18n: {}, needsDetail: true })
    expect(tilesOf([other], 'en', { withPhotos: true })[0]).toMatchObject({ icon: 'std:help', photoNeeded: true, heldReason: null })
    expect(tilesOf([other], 'en')[0]).toMatchObject({ photoNeeded: false, heldReason: null })
  })

  it('a scan reason without the office\'s icon: every standard scrap and rework code has a look of its own, an added code its kind\'s', () => {
    for (const reason of W1_SCAN_REASONS) {
      const look = lookOf(fromScanReason({ kind: reason.kind, code: reason.code, label: reason.label, sortOrder: reason.sortOrder }))
      expect(look.icon.startsWith('std:'), reason.code).toBe(true)
    }
    expect(lookOf(fromScanReason({ kind: 'SCRAP', code: 'STAIN', label: { it: '', en: '' }, sortOrder: 1 }))).toEqual({ icon: 'std:stain', tone: 'warning' })
    expect(lookOf(fromScanReason({ kind: 'SCRAP', code: 'NEW_ONE', label: { it: '', en: '' }, sortOrder: 1 }))).toEqual({ icon: 'std:scrap', tone: 'danger' })
    expect(lookOf(fromScanReason({ kind: 'REWORK', code: 'NEW_ONE', label: { it: '', en: '' }, sortOrder: 1 }))).toEqual({ icon: 'std:rework', tone: 'warning' })
    expect(lookOf(listReason('OTHER', 1)).icon).toBe('std:help')
  })

  it('a split\'s three codes have a look of their own (rework, recut, hold), as the bundle card drew them', () => {
    const looks = SPLIT_REASONS.map((code, index) => lookOf(fromFixedReason({ list: 'SPLIT', code, label: code, sortOrder: index })))
    expect(looks).toEqual([
      { icon: 'std:rework', tone: 'warning' },
      { icon: 'std:scissors', tone: 'info' },
      { icon: 'std:hand', tone: 'danger' },
    ])
  })

  it('"Other" asks for a photo only where the host keeps one (no typing on the floor)', () => {
    const other = listReason('OTHER', 90, { needsDetail: true })
    expect(tilesOf([other], 'en')[0]!.photoNeeded).toBe(false)
    expect(tilesOf([other], 'en', { withPhotos: true })[0]!.photoNeeded).toBe(true)
  })

  it('a held tile stays in view: no network for the host\'s call, or "Other" where the call needs a written note (Hold lot)', () => {
    const other = listReason('OTHER', 90, { needsDetail: true })
    const check = listReason('QUALITY_CHECK', 10)
    expect(tilesOf([check, other], 'en').map((tile) => tile.heldReason)).toEqual([null, null])
    expect(tilesOf([check, other], 'en', { noteHeld: 'Quality places this hold' }).map((tile) => tile.heldReason)).toEqual([null, 'Quality places this hold'])
    expect(tilesOf([other], 'en', { withPhotos: true, noteHeld: 'never' })[0]!.heldReason).toBeNull()
    expect(tilesOf([check, other], 'en', { held: 'No network', noteHeld: 'Quality places this hold' }).map((tile) => tile.heldReason)).toEqual(['No network', 'No network'])
    expect([...NOTE_IN_OFFICE]).toEqual(['hold'])
  })
})

describe('picking and counting', () => {
  it('pick mode waits for a pick; count mode never waits', () => {
    expect(PICKER_PURPOSES.map((purpose) => MODE_OF[purpose])).toEqual(['count', 'count', 'pick', 'pick', 'count', 'pick', 'pick', 'pick'])
    expect(PICKER_PURPOSES.map((purpose) => LIST_OF[purpose])).toEqual(['SCRAP', 'REWORK', 'PAUSE', 'PAUSE', null, null, 'HOLD', 'REWORK'])
    expect(doneHeld('pick', null)).toBe('choose')
    expect(doneHeld('pick', 'BREAK')).toBeNull()
    expect(doneHeld('count', null)).toBeNull()
  })

  it('counts the pieces in all and finds the picked reason only while it is still offered', () => {
    expect(countedOf({ A: 2, B: 1, C: 0 })).toBe(3)
    const reasons = [listReason('BREAK', 10)]
    expect(pickedOf(reasons, 'BREAK')?.code).toBe('BREAK')
    expect(pickedOf(reasons, 'GONE')).toBeNull()
    expect(pickedOf(reasons, null)).toBeNull()
  })

  it('a host asks a reason only while its list is on screen and not empty (Receive back goes without one otherwise)', () => {
    const reasons = [listReason('RESTITCH', 10)]
    expect(listOffers({ state: 'ready', reasons, asOf: null })).toBe(true)
    expect(listOffers({ state: 'ready', reasons, asOf: '2026-10-31T08:00:00.000Z' })).toBe(true)
    expect(listOffers({ state: 'ready', reasons: [], asOf: null })).toBe(false)
    expect(listOffers({ state: 'loading', reasons, asOf: null })).toBe(false)
    expect(listOffers({ state: 'error', reasons: [], asOf: null })).toBe(false)
    expect(listOffers(null)).toBe(false)
  })
})

describe('the picker for every floor "why" (B-W2a-F6: split, Hold lot, Receive back)', () => {
  const body = (model: ReasonPickerModel, locale: 'it' | 'en' = 'en') =>
    renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(ReasonPickerBody, { model })))
  const hold = [
    listReason('QUALITY_CHECK', 10, { list: 'HOLD', labelEn: 'Quality check', labelIt: 'Verifica qualità', icon: 'shield', colour: '#8b5cf6' }),
    listReason('OTHER', 90, { list: 'HOLD', labelEn: 'Other', labelIt: 'Altro', needsDetail: true }),
  ]

  it('Hold lot: what it is about, the HOLD tiles, "Other" in view but held (quality places that hold)', () => {
    const html = body({ purpose: 'hold', subject: 'WO-DEMO-0042', reasons: hold, value: 'QUALITY_CHECK' })
    for (const word of ['Hold lot', 'WO-DEMO-0042', 'Why hold it?', 'Chosen: Quality check', 'Other', 'This reason needs a written note: quality places this hold in the office.']) expect(html).toContain(word)
    expect(body({ purpose: 'hold', subject: 'WO-DEMO-0042', reasons: hold, value: null }, 'it')).toContain('Questo motivo chiede una nota scritta')
    expect(body({ purpose: 'putLast', subject: 'WO-DEMO-0042', reasons: hold.map((reason) => ({ ...reason, list: 'PAUSE' })), value: null })).not.toContain('written note')
  })

  it('every state in words: loading, failed with Try again, offline, nothing set, kept on this tablet', () => {
    expect(body({ purpose: 'reject', subject: 'BN-1', reasons: [], state: 'loading' })).toContain('Loading the reasons')
    const failed = body({ purpose: 'hold', subject: 'WO-1', reasons: [], state: 'error' })
    expect(failed).toContain('Could not load the reasons')
    expect(failed).toContain('Try again')
    expect(body({ purpose: 'reject', subject: 'BN-1', reasons: [], state: 'offline' })).toContain('Not on this tablet')
    expect(body({ purpose: 'reject', subject: 'BN-1', reasons: [] })).toContain('Ask the office')
    expect(body({ purpose: 'reject', subject: 'BN-1 · Rejected', reasons: [listReason('RESTITCH', 10, { list: 'REWORK' })], asOf: '2026-10-31T08:00:00.000Z' })).toContain('From this tablet, as of')
  })

  it('a split offline: the three tiles stay in view, each held with the host\'s words', () => {
    const reasons = SPLIT_REASONS.map((code, index) => fromFixedReason({ list: 'SPLIT', code, label: code, sortOrder: index }))
    const html = body({ purpose: 'split', subject: 'BN-1', reasons, value: null, heldReason: 'A split needs the network' })
    expect(html.match(/A split needs the network/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})
