import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../../lib/api/client'
import { ApiError } from '../../../lib/api/errors'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { designScreen as frameScreen } from '../fixtures'
import { designScreen as draftScreen } from '../drafts/fixtures'
import { draftBandStep, draftBytes, DRAFT_MAX_BYTES, finishLaterHeld, idleBand } from '../drafts/model'
import { askForNewLink } from './api'
import { LINK_RENEW_NOTE_MAX } from '@nexus/factory-domain/links/renew'
import { ASKS_FOR_NEW_LINK, noteToSend, offersNote, renewButton, renewEnd, renewFailure, renewLine, RENEW_NOTE_MAX, RENEW_STATES, wantsChallenge } from './model'

const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../../messages/${locale}/link-frame.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))

const NOW = new Date('2026-11-09T09:45:00.000Z')

describe('Ask for a new link (links.frame sec:ask-new-link)', () => {
  it('is offered on a used, expired or unavailable link only', () => {
    expect([...ASKS_FOR_NEW_LINK].sort()).toEqual(['expired', 'unavailable', 'used'])
  })

  it('pressed once → held "Asked — we passed it on"; a wait says when; a failure asks again', () => {
    expect(renewButton({ state: 'done' })).toMatchObject({ done: 'ask.done' })
    expect(renewButton({ state: 'busy' })).toMatchObject({ busy: true })
    expect(renewButton({ state: 'wait' })).toMatchObject({ held: 'ask.waitHeld' })
    expect(renewButton({ state: 'failed' })).toMatchObject({ label: 'ask.again', held: null })
    expect(renewLine({ state: 'done' })).toBe('ask.answerAnonymous')
    expect(renewLine({ state: 'idle' })).toBe('ask.onFile')
    const end = renewEnd({ state: 'done', waitUntil: null, ask: () => undefined }, (key) => `<${key}>`)
    expect(end.action).toMatchObject({ label: '<ask.label>', done: '<ask.done>', variant: 'primary' })
  })

  it('B-W2b-F17: the answer says who was told (the sender by name when the page knows it); the note goes with the ask', () => {
    expect(renewLine({ state: 'done' }, 'Made-up Srl')).toBe('ask.answer')
    expect(renewEnd({ state: 'done', waitUntil: null, ask: () => undefined }, (key) => `<${key}>`, 'Made-up Srl').next).toBe('<ask.answer>')
    for (const locale of ['it', 'en'] as const) {
      const words = flat(catalogue(locale))
      expect(words['ask.answer'], locale).toContain('{sender}')
      expect(words['ask.answerAnonymous'], locale).not.toContain('{sender}')
      expect([words['ask.noteLabel'], words['ask.noteHint']].every(Boolean), locale).toBe(true)
    }
    // The note: offered while nothing was asked (or it may be asked again), only where the page keeps one.
    const setNote = () => undefined
    expect(RENEW_STATES.filter((state) => offersNote({ state, setNote }))).toEqual(['idle', 'wait', 'failed'])
    expect(offersNote({ state: 'idle' })).toBe(false)
    expect([noteToSend(undefined), noteToSend('   '), noteToSend('  by Friday please ')]).toEqual([undefined, undefined, 'by Friday please'])
    expect(RENEW_NOTE_MAX).toBe(LINK_RENEW_NOTE_MAX)
    expect(noteToSend('x'.repeat(RENEW_NOTE_MAX + 20))).toHaveLength(RENEW_NOTE_MAX)
  })

  it('a 429 waits for its Retry-After; anything else did not reach us', () => {
    const wait = new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [{ path: 'retryAfter', message: '120' }])
    expect(renewFailure(wait, NOW)).toEqual({ state: 'wait', waitUntil: '2026-11-09T09:47:00.000Z' })
    expect(renewFailure(new ApiError('unavailable', 0, 'network', 'x'), NOW)).toEqual({ state: 'failed', waitUntil: null })
    expect(wantsChallenge(new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [{ path: 'challenge', message: 'Required.' }]))).toBe(true)
    expect(wantsChallenge(wait)).toBe(false)
  })

  it('sends the dead token’s ask once, and once more with a solved challenge when the API asks for one', async () => {
    const calls: string[] = []
    let first = true
    const api = {
      post: vi.fn(async (path: string, options: { body: unknown; idempotencyKey?: string }) => {
        calls.push(`POST ${path} ${JSON.stringify(options.body)}`)
        expect(options.idempotencyKey).toBeTruthy()
        if (first) {
          first = false
          throw new ApiError('rate_limited', 429, 'rate_limited', 'x', null, [{ path: 'challenge', message: 'Required.' }])
        }
        return { status: 'requested', message: 'x' }
      }),
      get: vi.fn(async (path: string, options: { query: Record<string, string> }) => {
        calls.push(`GET ${path} ${options.query.policy}`)
        return { challenge: 'made-up', bits: 1 }
      }),
    } as unknown as ApiClient
    const checking = vi.fn()
    await askForNewLink(api, checking)
    expect(checking).toHaveBeenCalledTimes(1)
    expect(calls[0]).toBe('POST /link/renew {}')
    expect(calls[1]).toBe('GET /abuse/challenge links.renew')
    expect(calls[2]).toMatch(/^POST \/link\/renew \{"proof":\{"challenge":"made-up","nonce":"[0-9a-z]+"\}\}$/)
    // B-W2b-F17: the reader's note travels in the body.
    first = false
    await askForNewLink(api, checking, 'Made-up: by Friday please')
    expect(calls.at(-1)).toBe('POST /link/renew {"note":"Made-up: by Friday please"}')
  })
})

describe('Finish later (links.frame sec:drafts)', () => {
  it('the band follows the saves; a dead link stops it', () => {
    let band = draftBandStep(idleBand(), { type: 'read', until: '2026-11-12T17:00:00.000Z', restoredAt: '2026-11-08T16:05:00.000Z' })
    expect(band).toMatchObject({ until: '2026-11-12T17:00:00.000Z', restoredAt: '2026-11-08T16:05:00.000Z', status: { kind: 'saved' } })
    band = draftBandStep(band, { type: 'changed' })
    expect(band.status.kind).toBe('unsaved')
    band = draftBandStep(draftBandStep(band, { type: 'saving' }), { type: 'saved', at: '2026-11-09T09:42:00.000Z', later: true })
    expect(band).toMatchObject({ status: { kind: 'saved', at: '2026-11-09T09:42:00.000Z' }, later: true })
    expect(draftBandStep(band, { type: 'changed' }).later).toBe(false)
    expect(draftBandStep(band, { type: 'dismiss' }).restoredAt).toBeNull()
    const dead = draftBandStep(band, { type: 'dead' })
    expect(dead.dead).toBe(true)
    expect(draftBandStep(dead, { type: 'changed' })).toBe(dead)
  })

  it('Finish later is held with why: nothing to keep, too large, saving, a dead link', () => {
    const band = { ...idleBand(), until: '2026-11-12T17:00:00.000Z' }
    expect(finishLaterHeld(band, true, false)).toBeNull()
    expect(finishLaterHeld(band, false, false)).toBe('drafts.held.empty')
    expect(finishLaterHeld(band, true, true)).toBe('drafts.held.tooBig')
    expect(finishLaterHeld({ ...band, status: { kind: 'saving' } }, true, false)).toBe('drafts.held.saving')
    expect(finishLaterHeld({ ...band, dead: true }, true, false)).toBe('drafts.held.dead')
    expect(draftBytes({ note: 'x'.repeat(DRAFT_MAX_BYTES) })).toBeGreaterThan(DRAFT_MAX_BYTES)
  })
})

describe('the frame’s words', () => {
  it('both languages have the same keys and placeholders', () => {
    const it = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it).sort()).toEqual(Object.keys(en).sort())
    for (const state of RENEW_STATES) {
      const button = renewButton({ state })
      for (const key of [button.label, button.held, button.done, renewLine({ state })].filter((value): value is string => !!value)) expect(en[key], key).toBeTruthy()
    }
  })

  const KEY = /\b(ask|drafts|links|state)\.[a-zA-Z_-]+/
  for (const screen of [frameScreen, draftScreen]) {
    it(`${screen.screen}: every case in both languages, no key on screen`, () => {
      for (const locale of ['it', 'en'] as const) {
        for (const entry of screen.cases) {
          const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(screen.view as never, { model: entry.model })))
          expect(html, `${entry.id} (${locale})`).not.toMatch(KEY)
          expect(html, `${entry.id} (${locale})`).not.toMatch(/\{[a-z]+\}/i)
        }
      }
    })
  }

  it('a dead link in Italian offers "Chiedi un nuovo link"; asked, it holds', () => {
    const render = (id: string) =>
      renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', ['shell']) }, createElement(frameScreen.view, { model: frameScreen.cases.find((entry) => entry.id === id)!.model })))
    expect(render('unavailable')).toContain('Chiedi un nuovo link')
    expect(render('ask-done')).toContain('Richiesto — l’abbiamo inoltrato')
    expect(render('withdrawn')).not.toContain('Chiedi un nuovo link')
    expect(render('wrong-person')).not.toContain('Chiedi un nuovo link')
  })
})
