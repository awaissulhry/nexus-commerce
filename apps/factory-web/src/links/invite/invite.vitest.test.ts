import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHARE_HELD_REASONS, SHARE_PERMISSIONS } from '@nexus/factory-domain/shares/rules'
import { ApiError } from '../../lib/api/errors'
import { sharePageSchema } from './api'
import { designScreen } from './fixtures'
import { acceptOf, CODE_VALUES, daysLeft, FIELD_KEYS, fieldValueOf, pickedProblem, readRefusal, RECORD_TYPES, shownFields, threadOldestFirst, writeRefusal } from './model'

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../messages/${locale}/link-invite.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
const refused = (status: number, code: string, paths: string[] = []) => new ApiError(status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : status === 503 ? 'unavailable' : 'invalid', status, code, 'x', 'r', paths.map((path) => ({ path, message: 'x' })))

describe('SCR-270 Join a record (links.invite)', () => {
  it('says every shared field from its kind: codes in words, days, instants, numbers; empty values are left out', () => {
    expect(fieldValueOf({ key: 'status', kind: 'code', value: 'IN_PRODUCTION' })).toEqual({ kind: 'words', words: { key: 'code.status.IN_PRODUCTION' } })
    // A code the catalogue does not know is never shown as a key.
    expect(fieldValueOf({ key: 'status', kind: 'code', value: 'SOMETHING_NEW' })).toEqual({ kind: 'none' })
    expect(fieldValueOf({ key: 'orderDate', kind: 'date', value: '2026-10-28' })).toEqual({ kind: 'day', iso: '2026-10-28' })
    expect(fieldValueOf({ key: 'shippedAt', kind: 'instant', value: '2026-10-28T10:00:00.000Z' })).toEqual({ kind: 'instant', iso: '2026-10-28T10:00:00.000Z' })
    expect(fieldValueOf({ key: 'revision', kind: 'count', value: 2 })).toEqual({ kind: 'text', text: '2' })
    expect(shownFields([{ key: 'promiseDate', kind: 'date', value: null }, { key: 'number', kind: 'text', value: 'SO-1' }]).map((field) => field.key)).toEqual(['number'])
  })

  it('reads the thread oldest first without repeats, counts the days left, and checks a picked file before sending', () => {
    const message = (id: string, at: string) => ({ id, side: 'COMPANY' as const, channel: 'EMAIL', author: { name: null, mine: false }, body: '', attachments: [], at })
    expect(threadOldestFirst([message('b', '2026-11-02T00:00:00Z'), message('a', '2026-11-01T00:00:00Z')], [message('a', '2026-11-01T00:00:00Z'), message('z', '2026-10-30T00:00:00Z')]).map((row) => row.id)).toEqual(['z', 'a', 'b'])
    const now = Date.parse('2026-11-10T09:00:00Z')
    expect(daysLeft('2026-11-30T09:00:00Z', now)).toBe(20)
    expect(daysLeft('2026-11-10T15:00:00Z', now)).toBe(0)
    const page = { upload: { canUpload: true, held: null, contentTypes: ['application/pdf', 'image/png'], maxBytes: 1_048_576 } }
    expect(pickedProblem({ size: 10, type: 'application/pdf' }, page)).toBeNull()
    expect(pickedProblem({ size: 2_000_000, type: 'application/pdf' }, page)).toEqual({ key: 'files.problem.size', params: { mb: 1 } })
    expect(pickedProblem({ size: 10, type: 'video/quicktime' }, page)).toEqual({ key: 'files.problem.type' })
    expect(acceptOf(['application/pdf', 'image/jpeg', 'application/x-unknown'])).toBe('.pdf,.jpg,.jpeg')
  })

  it('says the API\'s refusals in its own words: a narrowed share reads again, a revoked one is the dead link', () => {
    expect(readRefusal(refused(404, 'not_found'))).toBe('unavailable')
    expect(readRefusal(new Error('offline'))).toBe('error')
    expect(writeRefusal(refused(403, 'forbidden', ['held/NO_COMMENT']))).toEqual({ words: { key: 'held.NO_COMMENT' }, reload: true })
    expect(writeRefusal(refused(404, 'not_found'))).toEqual({ words: { key: 'problem.gone' }, link: 'unavailable' })
    expect(writeRefusal(refused(503, 'not_ready')).words.key).toBe('files.problem.closed')
    expect(writeRefusal(refused(400, 'validation_failed', ['body/contentType'])).words.key).toBe('files.problem.type')
    expect(writeRefusal(refused(409, 'conflict', ['refusal/STALE']))).toEqual({ words: { key: 'problem.changed' }, reload: true })
  })

  it('has words in Italian and English for every record type, field, code, permission and held reason, and the same keys in both', () => {
    const it_ = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
    const needed = [
      ...RECORD_TYPES.map((type) => `type.${type}`),
      ...FIELD_KEYS.map((key) => `field.${key}`),
      ...Object.entries(CODE_VALUES).flatMap(([field, values]) => values.map((value) => `code.${field}.${value}`)),
      ...SHARE_PERMISSIONS.map((permission) => `may.${permission}`),
      ...SHARE_HELD_REASONS.map((reason) => `held.${reason}`),
    ]
    for (const key of needed) {
      expect(it_[key], `it ${key}`).toBeTruthy()
      expect(en[key], `en ${key}`).toBeTruthy()
    }
  })

  it('its design cases are made-up pages the API could answer', () => {
    for (const item of designScreen.cases) if (item.model.page) expect(() => sharePageSchema.parse(item.model.page), item.id).not.toThrow()
    expect(designScreen.cases.map((item) => item.id)).toEqual(expect.arrayContaining(['record', 'read-only', 'loading', 'error', 'withdrawn']))
  })
})
