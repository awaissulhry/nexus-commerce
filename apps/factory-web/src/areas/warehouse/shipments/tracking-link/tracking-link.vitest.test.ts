import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { trackingLinksSchema } from './api'
import { designScreen } from './fixtures'
import { emailProblem, makeHeldKey, outcomeOfError, revokeHeldKey, sendHeldKey } from './model'

const read = (id: string) => designScreen.cases.find((entry) => entry.id === id)!.model.read!
const KEY = /\b(?:held|other|passOn|outcome|col|via|state)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-067-tracking-link — the shipment\'s tracking-page card (B-W2b-170)', () => {
  it('every fixture is an answer the API may give', () => {
    for (const entry of designScreen.cases) if (entry.model.read) expect(() => trackingLinksSchema.parse(entry.model.read), entry.id).not.toThrow()
  })

  it('holds Send with why: no right, a shipment that cannot be tracked, no orders contact, a write running', () => {
    expect(sendHeldKey(read('links'), null)).toBeNull()
    expect(sendHeldKey(read('read-only'), null)).toBe('held.noManage')
    expect(sendHeldKey(read('cancelled'), null)).toBe('held.CANCELLED')
    expect(sendHeldKey(read('no-recipients'), null)).toBe('held.noRecipients')
    expect(sendHeldKey(read('links'), 'copy')).toBe('held.busy')
    // A link to pass on needs no contact.
    expect(makeHeldKey(read('no-recipients'), null)).toBeNull()
  })

  it('withdraws only an open link, with the right to manage', () => {
    expect(revokeHeldKey(read('links'), 'LIVE', null)).toBeNull()
    expect(revokeHeldKey(read('links'), 'ENDED', null)).toBe('held.notLive')
    expect(revokeHeldKey(read('read-only'), 'LIVE', null)).toBe('held.noManage')
  })

  it('checks the address before sending, and says a refusal in words', () => {
    expect(emailProblem(' ')).toBe('EMPTY')
    expect(emailProblem('negozio@')).toBe('FORMAT')
    expect(emailProblem('shop@brand.example')).toBeNull()
    expect(outcomeOfError(new ApiError('forbidden', 403, 'forbidden', 'x'))).toEqual({ kind: 'failed', why: 'forbidden' })
    expect(outcomeOfError(new ApiError('conflict', 409, 'invalid_state', 'x'))).toEqual({ kind: 'failed', why: 'refused' })
    expect(outcomeOfError(new Error('offline'))).toEqual({ kind: 'failed', why: 'error' })
  })

  it('every case draws in Italian and English with no raw key', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const entry of designScreen.cases) {
        const html = renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'ds-words']) }, createElement(designScreen.view, { model: entry.model })))
        expect(html.match(KEY)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
      }
    }
  })
})
