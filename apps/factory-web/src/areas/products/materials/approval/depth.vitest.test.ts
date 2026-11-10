import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE } from '../../../../lib/i18n/messages'
import { approvalHeld, depthCan, needsNote, noteText, propertiesBodyOf, propertiesChanged, propertiesDraft, propertiesInvalid } from './depth-model'
import { LINING_DEPTH, PROTECTOR_DEPTH } from './demo'
import { rowKey } from '../whereused/whereused-model'

/** B-W2b-238: materials in depth on screen — the pure rules of the record's parts and every key they name, in it and en. */

describe('the approval draft', () => {
  const current = { approval: 'CONDITIONAL' as const, note: 'Away from the skin' }
  const free = { offline: false, busy: false }
  it('is held with the reason a person can act on', () => {
    expect(approvalHeld(current, { approval: 'CONDITIONAL', note: ' Away from the skin ' }, free)).toBe('approval.held.unchanged')
    expect(approvalHeld(current, { approval: 'BLOCKED', note: '' }, free)).toBe('approval.held.whyBlocked')
    expect(approvalHeld({ approval: 'PENDING', note: null }, { approval: 'CONDITIONAL', note: ' ' }, free)).toBe('approval.held.whyCondition')
    expect(approvalHeld(current, { approval: 'BLOCKED', note: 'a\nb' }, free)).toBe('approval.held.noteLong')
    expect(approvalHeld(current, { approval: 'APPROVED', note: '' }, { offline: true, busy: false })).toBe('wait.offline')
    expect(approvalHeld(current, { approval: 'APPROVED', note: '' }, { offline: false, busy: true })).toBe('wait.busy')
    expect(approvalHeld(current, { approval: 'APPROVED', note: '' }, free)).toBeNull()
    expect(needsNote('BLOCKED') && needsNote('CONDITIONAL') && !needsNote('APPROVED')).toBe(true)
    expect(noteText('  ')).toBeNull()
  })

  it('reads the rights from the permissions', () => {
    expect(depthCan(['product.materials.approve', 'workorders.view'])).toEqual({ approve: true, manage: false, styles: false, workOrders: true })
  })
})

describe('the properties draft', () => {
  it('types decimals in the person’s language, sends them plain, says what it cannot take', () => {
    const it = propertiesDraft(LINING_DEPTH, 'it')
    expect(it).toEqual({ weightGsm: '220', widthCm: '150', construction: 'knitted' })
    const typed = { ...it, weightGsm: '180,5', widthCm: '' }
    expect(propertiesBodyOf('TEXTILE', typed)).toEqual({ weightGsm: '180.5', construction: 'knitted' })
    expect(propertiesChanged('TEXTILE', it, typed)).toBe(2)
    expect(propertiesInvalid('TEXTILE', { weightGsm: '22o' })).toEqual(['weightGsm'])
    expect(propertiesBodyOf('TEXTILE', { weightGsm: '', widthCm: ' ', construction: '' })).toBeNull()
    expect(propertiesBodyOf('TRIM', { nickelFree: 'no', material: 'brass' })).toEqual({ material: 'brass', nickelFree: false })
    expect(propertiesDraft(PROTECTOR_DEPTH, 'en')).toEqual({ standard: 'EN 1621-1:2012', type: 'shoulder', level: '2', size: 'A' })
  })

  it('keys a where-used row by its line and alternate', () => {
    expect(rowKey({ lineId: 'a', priority: null })).toBe('a:0')
    expect(rowKey({ lineId: 'a', priority: 2 })).toBe('a:2')
  })
})

const HERE = fileURLToPath(new URL('..', import.meta.url))
const OWN = ['approval', 'properties', 'whereused'].map((folder) => join(HERE, folder))
const BESIDE = [join(HERE, 'view/MaterialsListView.tsx'), join(HERE, 'record/view/MaterialRecordView.tsx'), join(HERE, '../styles/compliance/materials.tsx')]
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) && !entry.name.includes('.vitest.') && entry.name !== 'demo.ts' ? [join(dir, entry.name)] : []))
const PREFIX = '(?:loading|retry|dismiss|discard|back|yes|no|notInRole|wait|tab|revisionStatus|role|csv|approval|properties|fibres|whereUsed|materialsList|styleChecks)'
const keysIn = (text: string, call: string): string[] => [
  ...[...text.matchAll(new RegExp(`\\b${call}\\(\\s*'(${PREFIX}(?:\\.[\\w]+)*)'`, 'g'))].map((match) => match[1]!),
  ...[...text.matchAll(new RegExp(`'(${PREFIX}\\.[\\w.]+)'`, 'g'))].map((match) => match[1]!),
]

describe('every key of materials in depth exists in it and en', () => {
  const keys = [...new Set([...OWN.flatMap(files).flatMap((file) => keysIn(readFileSync(file, 'utf8'), 't')), ...BESIDE.flatMap((file) => keysIn(readFileSync(file, 'utf8'), 'td'))])]
  for (const locale of LOCALES) {
    it(`products-materials-depth (${locale})`, () => {
      const dictionary = CATALOGUE[locale]?.['products-materials-depth'] ?? {}
      const has = (key: string) => key in dictionary || `${key}_other` in dictionary
      expect(keys.length).toBeGreaterThan(60)
      expect(keys.filter((key) => !has(key))).toEqual([])
      for (const state of ['PENDING', 'APPROVED', 'CONDITIONAL', 'BLOCKED']) expect(has(`approval.state.${state}`) && has(`approval.means.${state}`)).toBe(true)
    })
  }
})
