import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SWATCHES, TAG_ICONS } from '@nexus/ui/primitives'
import { REASON_LISTS } from '@nexus/factory-domain/reasons/lists'
import { REASON_COLOURS, REASON_ICONS } from '@nexus/factory-domain/reasons/rules'
import { ApiError } from '../../../lib/api/errors'
import { CATALOGUE } from '../../../lib/i18n/messages'
import type { Reason } from './api'
import { designScreen } from './fixtures'
import { activeHeld, draftBody, draftHeld, EMPTY_DRAFT, fieldOfEdit, firstList, languageName, moveHeld, moveOf, problemOf, readProblemOf, searchRows, typedCode, withEdit, wordEdit, wordsIn } from './model'

const row = (code: string, patch: Partial<Reason> = {}): Reason => ({
  id: `id-${code}`,
  list: 'RETURN',
  code,
  labelIt: `${code} it`,
  labelEn: `${code} en`,
  labelI18n: {},
  icon: null,
  colour: null,
  needsDetail: false,
  sortOrder: 10,
  active: true,
  usedCount: 0,
  version: 2,
  createdAt: '2026-10-30T08:00:00.000Z',
  updatedAt: '2026-10-30T08:00:00.000Z',
  ...patch,
})
const refusal = (status: number, kind: ApiError['kind'], issues: Array<{ path: string; message?: string }> = []) => new ApiError(kind, status, 'x', 'x', null, issues)

describe('the shared reason list editor (B-W2a-18; SCR-242)', () => {
  it("keeps the domain's closed sets equal to the design system's pickers, so a stored value always draws", () => {
    expect([...REASON_ICONS]).toEqual(TAG_ICONS.map((icon) => icon.id))
    expect([...REASON_COLOURS]).toEqual(SWATCHES.map((swatch) => swatch.hex.toLowerCase()))
  })

  it('sends one word cell at the version read: Italian and English never blank, another language blank is taken out', () => {
    const reason = row('WRONG_SIZE', { labelI18n: { ro: 'Mărime' } })
    expect(wordEdit(reason, 'labelIt', ' Taglia sbagliata ')).toEqual({ edit: { version: 2, labelIt: 'Taglia sbagliata' } })
    expect(wordEdit(reason, 'labelEn', '  ')).toEqual({ problem: 'problem.labelEn' })
    expect(wordEdit(reason, 'labelIt', 'WRONG_SIZE it')).toBeNull()
    expect(wordEdit(reason, 'lang:ro', '')).toEqual({ edit: { version: 2, labelI18n: { ro: null } } })
    expect(wordEdit(reason, 'lang:ur', 'سائز')).toEqual({ edit: { version: 2, labelI18n: { ur: 'سائز' } } })
    expect(wordEdit(reason, 'labelEn', 'x'.repeat(81))).toEqual({ problem: 'problem.tooLong' })
    expect(fieldOfEdit({ version: 1, labelI18n: { ro: null } })).toBe('lang:ro')
    expect(fieldOfEdit({ version: 1, colour: null })).toBe('look')
    expect(withEdit(reason, { version: 2, labelI18n: { ro: null, ur: 'x' }, active: false })).toMatchObject({ labelI18n: { ur: 'x' }, active: false, labelIt: 'WRONG_SIZE it' })
  })

  it('holds "Add code" until it is a free code with words in both languages, and sends only what the list keeps', () => {
    expect(draftHeld(EMPTY_DRAFT, [], false)).toBe('held.noCode')
    expect(draftHeld({ ...EMPTY_DRAFT, code: '1X' }, [], false)).toBe('held.badCode')
    expect(draftHeld({ ...EMPTY_DRAFT, code: 'LOST' }, ['LOST'], false)).toBe('held.codeTaken')
    expect(draftHeld({ ...EMPTY_DRAFT, code: 'LATE', labelIt: 'Tardi' }, [], false)).toBe('held.noWords')
    expect(draftHeld({ ...EMPTY_DRAFT, code: 'LATE', labelIt: 'Tardi', labelEn: 'Late' }, [], true)).toBe('held.busy')
    expect(draftHeld({ ...EMPTY_DRAFT, code: 'LATE', labelIt: 'Tardi', labelEn: 'Late' }, [], false)).toBeNull()
    expect(typedCode('wrong size-x')).toBe('WRONG_SIZE_X')
    const draft = { ...EMPTY_DRAFT, code: ' LATE ', labelIt: ' Tardi', labelEn: 'Late ', words: { ro: ' Târziu ', ur: ' ' }, icon: 'clock', colour: '#1f6fde', needsDetail: true }
    expect(draftBody(draft, { fields: { icon: true, colour: true, languages: true, needsDetail: true } })).toEqual({ code: 'LATE', labelIt: 'Tardi', labelEn: 'Late', labelI18n: { ro: 'Târziu' }, icon: 'clock', colour: '#1f6fde', needsDetail: true })
    expect(draftBody(draft, { fields: { icon: false, colour: false, languages: false, needsDetail: false } })).toEqual({ code: 'LATE', labelIt: 'Tardi', labelEn: 'Late' })
  })

  it("says the API's refusals in its own words; a lost answer is 'not known', never 'saved'", () => {
    expect(problemOf(refusal(409, 'conflict', [{ path: 'body/code', message: 'taken, inactive' }]))).toEqual({ key: 'problem.codeTakenInactive', unknown: false })
    expect(problemOf(refusal(409, 'conflict', [{ path: 'body/code', message: 'taken' }])).key).toBe('problem.codeTaken')
    expect(problemOf(refusal(409, 'conflict', [{ path: 'version' }])).key).toBe('problem.stale')
    expect(problemOf(refusal(400, 'invalid', [{ path: 'body/labelI18n/ro' }])).key).toBe('problem.language')
    expect(problemOf(refusal(400, 'invalid', [{ path: 'body/icon' }])).key).toBe('problem.icon')
    expect(problemOf(refusal(403, 'forbidden')).key).toBe('problem.forbidden')
    expect(problemOf(refusal(0, 'unavailable'))).toEqual({ key: 'problem.offline', unknown: true })
    expect(problemOf(new Error('boom'))).toEqual({ key: 'problem.failed', unknown: true })
    expect(readProblemOf(refusal(403, 'forbidden'))).toBe('problem.readForbidden')
    expect(readProblemOf(refusal(500, 'internal'))).toBe('problem.read')
  })

  it('searches codes and words in every language, moves a selection one place, holds the bulk actions with their reason', () => {
    const rows = [row('WRONG_SIZE', { labelI18n: { ro: 'Mărime greșită' } }), row('DEFECT', { active: false }), row('OTHER')]
    expect(searchRows(rows, 'marime').map((entry) => entry.code)).toEqual(['WRONG_SIZE'])
    expect(searchRows(rows, 'def').map((entry) => entry.code)).toEqual(['DEFECT'])
    expect(searchRows(rows, ' ')).toHaveLength(3)
    expect(moveOf(rows, ['id-OTHER'], -1)).toEqual(['id-WRONG_SIZE', 'id-OTHER', 'id-DEFECT'])
    expect(moveOf(rows, ['id-WRONG_SIZE'], -1)).toBeNull()
    expect(moveHeld(rows, ['id-WRONG_SIZE'], -1, false, false)).toBe('held.atTop')
    expect(moveHeld(rows, ['id-OTHER'], 1, false, false)).toBe('held.atBottom')
    expect(moveHeld(rows, ['id-OTHER'], -1, false, true)).toBe('held.searching')
    expect(activeHeld([rows[0]!], true, false)).toBe('held.allActive')
    expect(activeHeld([rows[1]!], false, false)).toBe('held.allInactive')
    expect(activeHeld(rows, false, false)).toBeNull()
    expect(firstList(['PAUSE', 'SCRAP'], 'SCRAP')).toBe('SCRAP')
    expect(firstList(['PAUSE', 'SCRAP'], 'RETURN')).toBe('PAUSE')
    expect(wordsIn(rows[0]!, 'ro')).toBe('Mărime greșită')
    expect(wordsIn(rows[1]!, 'ro')).toBe('DEFECT en')
    expect(languageName('ro', 'en')).toBe('Romanian')
    expect(languageName('ro', 'it')).toBe('Rumeno')
  })

  it('has words for every list, icon, colour and key the editor names, in both languages', () => {
    const files = readdirSync(fileURLToPath(new URL('.', import.meta.url)), { recursive: true, withFileTypes: false }) as string[]
    const source = files.filter((file) => /\.tsx?$/.test(file) && !file.includes('.vitest.')).map((file) => readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), file), 'utf8')).join('\n')
    const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]!)
    const named = [...source.matchAll(/'((?:problem|held|done|state|mark)\.[a-zA-Z]+)'/g)].map((match) => match[1]!)
    const lists = REASON_LISTS.flatMap((list) => [`list.${list}`, `listHint.${list}`])
    const looks = [...TAG_ICONS.map((icon) => `icon.${icon.id}`), ...SWATCHES.map((swatch) => `colour.${swatch.name}`)]
    for (const locale of ['it', 'en'] as const) {
      const words = CATALOGUE[locale].reasons ?? {}
      const has = (key: string) => key in words || `${key}_one` in words
      const missing = [...new Set([...literal, ...named, ...lists, ...looks])].filter((key) => !has(key))
      expect(missing, locale).toEqual([])
    }
  })

  it('shows every state of the design as a case', () => {
    expect(designScreen.screen).toBe('SCR-242')
    expect(designScreen.cases.map((entry) => entry.id)).toEqual(expect.arrayContaining(['floor-rules', 'saving', 'selected', 'new-reason', 'look', 'empty', 'read-only', 'scrap', 'loading', 'error', 'no-permission', 'changed-elsewhere', 'offline', 'one-list']))
  })
})
