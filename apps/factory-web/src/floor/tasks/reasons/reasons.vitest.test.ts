import { describe, expect, it } from 'vitest'
import { REASON_COLOURS, REASON_ICONS } from '@nexus/factory-domain/reasons/rules'
import { W1_SCAN_REASONS } from '@nexus/factory-domain/production/scans/reasons'
import { tagIconSpec } from '@nexus/ui/primitives'
import { countedOf, doneHeld, fromDefect, fromListReason, fromScanReason, inTileOrder, lookOf, MODE_OF, pickedOf, PICKER_PURPOSES, tilesOf, wordOf, type PickerReason } from './model'

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

  it('the scan lists keep no icon yet: every standard scrap and rework code has a look of its own, an added code its kind\'s', () => {
    for (const reason of W1_SCAN_REASONS) {
      const look = lookOf(fromScanReason({ kind: reason.kind, code: reason.code, label: reason.label, sortOrder: reason.sortOrder }))
      expect(look.icon.startsWith('std:'), reason.code).toBe(true)
    }
    expect(lookOf(fromScanReason({ kind: 'SCRAP', code: 'STAIN', label: { it: '', en: '' }, sortOrder: 1 }))).toEqual({ icon: 'std:stain', tone: 'warning' })
    expect(lookOf(fromScanReason({ kind: 'SCRAP', code: 'NEW_ONE', label: { it: '', en: '' }, sortOrder: 1 }))).toEqual({ icon: 'std:scrap', tone: 'danger' })
    expect(lookOf(fromScanReason({ kind: 'REWORK', code: 'NEW_ONE', label: { it: '', en: '' }, sortOrder: 1 }))).toEqual({ icon: 'std:rework', tone: 'warning' })
    expect(lookOf(listReason('OTHER', 1)).icon).toBe('std:help')
  })

  it('"Other" asks for a photo only where the host keeps one (no typing on the floor)', () => {
    const other = listReason('OTHER', 90, { needsDetail: true })
    expect(tilesOf([other], 'en')[0]!.photoNeeded).toBe(false)
    expect(tilesOf([other], 'en', { withPhotos: true })[0]!.photoNeeded).toBe(true)
  })
})

describe('picking and counting', () => {
  it('pick mode waits for a pick; count mode never waits', () => {
    expect(PICKER_PURPOSES.map((purpose) => MODE_OF[purpose])).toEqual(['count', 'count', 'pick', 'pick', 'count'])
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
})
