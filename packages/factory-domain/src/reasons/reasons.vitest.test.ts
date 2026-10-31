import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { fieldsOf, isReasonList, REASON_CODE_LISTS, REASON_LIST_GROUPS, REASON_LISTS, sourceOf } from './lists'
import { mergedWords, movedOrder, nextSortOrder, orderProblems, REASON_CODE, REASON_COLOURS, REASON_ICONS, reasonDraftProblems, reasonLabel, sortOrdersOf } from './rules'
import { BASE_REASONS, missingStandardReasons, standardReasonsOf } from './standard'

describe('reason lists (B-W2a-18; PLT-116)', () => {
  it('keeps eleven ReasonCode lists and the two scan lists, each with its source and what it keeps', () => {
    expect(REASON_LISTS).toHaveLength(13)
    expect(sourceOf('WRITE_OFF')).toBe('REASON_CODE')
    expect(sourceOf('SCRAP')).toBe('SCRAP_REASON')
    expect(fieldsOf('RETURN')).toEqual({ icon: true, colour: true, languages: true, needsDetail: true })
    // W2b (B-W2b-10; MES-125): the scan lists keep every field too (ScrapReason's icon, colour, labelI18n, needsDetail).
    expect(fieldsOf('REWORK')).toEqual({ icon: true, colour: true, languages: true, needsDetail: true })
    expect(isReasonList('HOLD')).toBe(true)
    expect(isReasonList('DEFECT')).toBe(false)
    for (const group of Object.values(REASON_LIST_GROUPS)) for (const list of group) expect(isReasonList(list)).toBe(true)
  })

  it('gives every ReasonCode list a standard list whose codes, icons and colours its own rules accept', () => {
    for (const list of REASON_CODE_LISTS) {
      const reasons = BASE_REASONS[list]
      expect(reasons.length).toBeGreaterThan(2)
      expect(new Set(reasons.map((reason) => reason.code)).size).toBe(reasons.length)
      for (const reason of reasons) expect(reasonDraftProblems(list, reason), `${list} ${reason.code}`).toEqual([])
    }
    // "Other" asks for a note; the scan lists are W1's: no icon (the floor's standard look per code), OTHER needs detail (W2b).
    expect(BASE_REASONS.RETURN.find((reason) => reason.code === 'OTHER')).toMatchObject({ needsDetail: true, icon: 'camera' })
    expect(standardReasonsOf('SCRAP').map((reason) => reason.code)).toEqual(['LEATHER_FLAW', 'CUT_WRONG', 'STITCHING', 'STAIN', 'TEAR', 'MACHINE', 'OTHER'])
    expect(standardReasonsOf('REWORK').every((reason) => reason.icon === null && reason.needsDetail === (reason.code === 'OTHER'))).toBe(true)
    for (const list of ['SCRAP', 'REWORK'] as const) for (const reason of standardReasonsOf(list)) expect(reasonDraftProblems(list, reason), `${list} ${reason.code}`).toEqual([])
  })

  it('adds only the standard codes a list does not have, active or not', () => {
    expect(missingStandardReasons('WRITE_OFF', ['DAMAGED', 'LOST', 'MY_OWN']).map((reason) => reason.code)).toEqual(['EXPIRED', 'OBSOLETE', 'OTHER'])
    expect(missingStandardReasons('WRITE_OFF', BASE_REASONS.WRITE_OFF.map((reason) => reason.code))).toEqual([])
    expect(missingStandardReasons('PAUSE', [])).toHaveLength(BASE_REASONS.PAUSE.length)
  })

  it('checks a draft field by field, in words, by what the list keeps', () => {
    expect(REASON_CODE.test('WRONG_SIZE')).toBe(true)
    expect(reasonDraftProblems('RETURN', { code: 'wrong size', labelIt: ' ', labelEn: 'x'.repeat(81) }).map((issue) => issue.path)).toEqual(['code', 'labelIt', 'labelEn'])
    expect(reasonDraftProblems('RETURN', { icon: 'rocket', colour: '#123456' }).map((issue) => issue.path)).toEqual(['icon', 'colour'])
    expect(reasonDraftProblems('RETURN', { icon: 'truck', colour: '#1F6FDE', labelI18n: { ro: 'Mărime greșită', ur: null } })).toEqual([])
    expect(reasonDraftProblems('RETURN', { labelI18n: { it: 'x', RO: 'y', de: ' ' } }).map((issue) => issue.path)).toEqual(['labelI18n/it', 'labelI18n/RO', 'labelI18n/de'])
    // W2b (MES-125): a scan list keeps an icon, a colour, other languages and the note like any list, by the same rules.
    expect(reasonDraftProblems('SCRAP', { icon: 'alert', colour: '#e5484d', labelI18n: { ro: 'Pată' }, needsDetail: true })).toEqual([])
    expect(reasonDraftProblems('SCRAP', { icon: 'rocket', colour: '#123456' }).map((issue) => issue.path)).toEqual(['icon', 'colour'])
    expect(reasonDraftProblems('SCRAP', { icon: null, colour: null, needsDetail: false })).toEqual([])
  })

  it('merges the other languages: null takes one out, words replace, sorted by language', () => {
    expect(mergedWords({ ro: 'a', ur: 'b' }, { ur: null, de: ' c ', ro: 'd' })).toEqual({ de: 'c', ro: 'd' })
    expect(Object.keys(mergedWords({ zh: 'x' }, { ar: 'y' }))).toEqual(['ar', 'zh'])
    expect(reasonLabel({ labelIt: 'Taglia', labelEn: 'Size', labelI18n: { ro: 'Mărime' } }, 'ro')).toBe('Mărime')
    expect(reasonLabel({ labelIt: 'Taglia', labelEn: 'Size', labelI18n: {} }, 'ur')).toBe('Size')
    expect(reasonLabel({ labelIt: 'Taglia', labelEn: 'Size' }, 'it')).toBe('Taglia')
  })

  it('orders a list in tens, adds at its end, and moves chosen reasons one place, a block at the edge staying', () => {
    expect([...sortOrdersOf(['a', 'b', 'c']).values()]).toEqual([10, 20, 30])
    expect(nextSortOrder([10, 20, 35])).toBe(40)
    expect(nextSortOrder([])).toBe(10)
    expect(movedOrder(['a', 'b', 'c', 'd'], ['c'], -1)).toEqual(['a', 'c', 'b', 'd'])
    expect(movedOrder(['a', 'b', 'c', 'd'], ['b', 'd'], -1)).toEqual(['b', 'a', 'd', 'c'])
    expect(movedOrder(['a', 'b', 'c', 'd'], ['a', 'b'], -1)).toEqual(['a', 'b', 'c', 'd'])
    expect(movedOrder(['a', 'b', 'c', 'd'], ['b', 'c'], 1)).toEqual(['a', 'd', 'b', 'c'])
    expect(movedOrder(['a', 'b', 'c', 'd'], ['c', 'd'], 1)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('takes a reorder only when it names every reason of the list once', () => {
    expect(orderProblems(['a', 'b'], ['b', 'a'])).toEqual([])
    expect(orderProblems(['a', 'b', 'c'], ['b', 'b', 'x']).map((issue) => issue.path)).toEqual(['reasons/1/id', 'reasons/2/id', 'reasons'])
  })

  it('offers the design system closed sets (24 icons, 16 swatches) and declares its permissions and event', () => {
    expect(REASON_ICONS).toHaveLength(24)
    expect(REASON_COLOURS).toHaveLength(16)
    expect(FACTORY_PERMISSIONS.get('reasons.view')?.risk).toBe('read')
    expect(FACTORY_PERMISSIONS.get('reasons.manage')?.risk).toBe('write')
    expect(templateOf('production_manager')?.permissions).toEqual(expect.arrayContaining(['reasons.view', 'reasons.manage']))
    expect(templateOf('admin')?.permissions).toEqual(expect.arrayContaining(['reasons.view', 'reasons.manage']))
    expect(templateOf('read_only')?.permissions).toContain('reasons.view')
    expect(templateOf('read_only')?.permissions).not.toContain('reasons.manage')
    expect(EVENT_CATALOGUE.parse('reason.changed', 1, { list: 'RETURN', change: 'EDITED', codes: ['WRONG_SIZE'] })).toEqual({ list: 'RETURN', change: 'EDITED', codes: ['WRONG_SIZE'] })
  })
})
