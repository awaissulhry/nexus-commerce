import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import type { ApiClient } from '../../../lib/api/client'
import { checkMisSend, checkProblem } from './api'
import { designScreen } from './fixtures'
import { MIS_SEND_WARNINGS, needsAcknowledge, RECIPIENT_KINDS, recipientWords, sendHeld, titleOf, type MisSendCheck, type MisSendModel } from './model'

/** The mis-send guard (SCR-437; B-W2b-397; COL-004): its call, its rules and its words in it and en. */

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../../messages/${locale}/mail-depth.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
const has = (words: Record<string, string>, key: string) => key in words || `${key}_other` in words

const PARTY = { id: 'p', name: 'Pista Esempio' }
const clean: MisSendCheck = { party: PARTY, recipients: [{ address: 'a@x.example.invalid', kind: 'PARTY', source: 'CONTACT', organisation: PARTY, personName: 'A' }], warnings: [], attachments: [] }
const ready = (check: MisSendCheck): Pick<MisSendModel, 'state' | 'sending'> => ({ state: { status: 'ready', check }, sending: false })

describe('the check’s call', () => {
  it('posts what the composer holds to the record’s thread, without an empty subject', async () => {
    const calls: Array<{ path: string; body: unknown }> = []
    const api = { post: async (path: string, options: { body: unknown; schema: { parse: (value: unknown) => unknown } }) => (calls.push({ path, body: options.body }), options.schema.parse(clean)) } as unknown as ApiClient
    expect(await checkMisSend(api, { type: 'SalesOrder', id: 'o 1' }, { to: ['a@x.example.invalid'], subject: '  ', body: 'Ciao', attachments: ['f'] })).toEqual(clean)
    expect(calls).toEqual([{ path: '/threads/SalesOrder/o%201/emails/check', body: { to: ['a@x.example.invalid'], body: 'Ciao', attachments: ['f'] } }])
  })

  it('says why it could not run and whether a retry may help', () => {
    expect(checkProblem(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ problem: 'misSend.problem.forbidden', retry: false })
    expect(checkProblem(new ApiError('not_found', 404, 'not_found', 'x')).retry).toBe(false)
    expect(checkProblem(new ApiError('unavailable', 503, 'unavailable', 'x'))).toEqual({ problem: 'misSend.problem.unavailable', retry: true })
    expect(checkProblem(new Error('boom'))).toEqual({ problem: 'misSend.problem.failed', retry: true })
  })
})

describe('Send message is held with its reason', () => {
  it('while checking, after a failure, with an office-only file, until the warnings are ticked, while sending', () => {
    expect(sendHeld({ state: { status: 'checking' }, sending: false }, false)).toBe('misSend.held.checking')
    expect(sendHeld({ state: { status: 'error', problem: 'misSend.problem.failed', retry: true }, sending: false }, false)).toBe('misSend.held.failed')
    expect(sendHeld({ state: { status: 'error', problem: 'misSend.problem.forbidden', retry: false }, sending: false }, false)).toBe('misSend.held.refused')
    expect(sendHeld(ready({ ...clean, warnings: [{ code: 'OFFICE_FILE', items: ['x.pdf'] }] }), true)).toBe('misSend.held.officeFile')
    const warned = { ...clean, warnings: [{ code: 'MENTIONS_COST' as const, items: ['costo'] }] }
    expect(needsAcknowledge(warned)).toBe(true)
    expect(sendHeld(ready(warned), false)).toBe('misSend.held.acknowledge')
    expect(sendHeld(ready(warned), true)).toBeNull()
    expect(sendHeld(ready(clean), false)).toBeNull()
    expect(sendHeld({ ...ready(clean), sending: true }, true)).toBe('misSend.held.sending')
  })

  it('names the party in the title once known, and each recipient’s organisation', () => {
    expect(titleOf({ state: { status: 'checking' }, partyName: 'Dal pannello' })).toEqual({ key: 'misSend.title', params: { party: 'Dal pannello' } })
    expect(titleOf({ state: { status: 'ready', check: clean }, partyName: null })).toEqual({ key: 'misSend.title', params: { party: 'Pista Esempio' } })
    expect(titleOf({ state: { status: 'checking' }, partyName: null }).key).toBe('misSend.titlePlain')
    expect(recipientWords({ address: 'b@y', kind: 'OTHER_PARTY', source: 'DOMAIN', organisation: { id: 'o', name: 'Club' }, personName: null })).toEqual({ key: 'misSend.recipient.otherDomain', params: { name: 'Club' } })
    expect(recipientWords({ address: 'c@z', kind: 'OURS', source: 'OUR_DOMAIN', organisation: null, personName: null }).key).toBe('misSend.recipient.ours.domain')
  })
})

describe('its words', () => {
  it('every code, held reason and problem has words in it and en, with the same keys', () => {
    const it = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    const keys = [
      ...MIS_SEND_WARNINGS.flatMap((code) => [`misSend.warning.${code}.title`, `misSend.warning.${code}.body`]),
      ...['party', 'partyDomain', 'other', 'otherDomain', 'ours.colleague', 'ours.domain', 'unknown'].map((key) => `misSend.recipient.${key}`),
      ...['sending', 'checking', 'failed', 'refused', 'officeFile', 'acknowledge'].map((key) => `misSend.held.${key}`),
      ...['forbidden', 'notFound', 'invalid', 'signedOut', 'rateLimited', 'unavailable', 'failed', 'body'].map((key) => `misSend.problem.${key}`),
      'misSend.title', 'misSend.titlePlain', 'misSend.send', 'misSend.back', 'misSend.retry', 'misSend.checking', 'misSend.clean', 'misSend.warnings', 'misSend.recipients', 'misSend.attachments', 'misSend.acknowledge', 'misSend.subject', 'misSend.subjectNone', 'misSend.noUndo', 'misSend.theParty', 'misSend.file.party', 'misSend.file.office',
    ]
    for (const key of keys) {
      expect(has(it, key), `it: ${key}`).toBe(true)
      expect(has(en, key), `en: ${key}`).toBe(true)
    }
    expect(RECIPIENT_KINDS).toHaveLength(4)
  })

  it('the design cases are made up and hold every state', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const wanted of ['warnings', 'clean', 'office-file', 'checking', 'failed', 'no-permission', 'sending']) expect(ids).toContain(wanted)
    expect(JSON.stringify(designScreen.cases)).not.toMatch(/@[a-z0-9-]+\.(com|it|net)\b/i)
  })
})
