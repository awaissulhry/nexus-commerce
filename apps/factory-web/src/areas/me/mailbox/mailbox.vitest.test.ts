import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import { LOCALES, type Locale } from '../../../lib/i18n/locales'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { readMailbox } from './api'
import { designScreen } from './fixtures'

/** B-W2b-F58: the Local mailbox page (SCR-007-mailbox) — local only; a 404 wherever the API has no mailbox (made-up mail). */

const MAIL = { id: 'fake-1', sentAt: '2026-11-15T17:40:12.000Z', templateKey: 'auth.invitation', from: 'noreply@demo.example.com', to: ['nina.nuova@example.com'], cc: [], bcc: [], subject: 'You are invited', text: 'Set your password: http://localhost:3300/accept-invitation#token=made-up', links: ['http://localhost:3300/accept-invitation#token=made-up'] }

function apiAnswering(status: number, body: unknown): ApiClient {
  const fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  return createApiClient({ baseUrl: 'http://api.test', fetch: fetch as unknown as typeof globalThis.fetch })
}

describe('reading the mailbox (GET /local/mailbox)', () => {
  it('the mails; absent where the API has no such route; signed out; failed with the code', async () => {
    expect(await readMailbox(apiAnswering(200, { messages: [MAIL] }))).toEqual({ kind: 'ok', messages: [MAIL] })
    expect(await readMailbox(apiAnswering(404, { error: { code: 'not_found', message: 'Not found.' } }))).toEqual({ kind: 'absent' })
    expect(await readMailbox(apiAnswering(401, { error: { code: 'unauthenticated', message: 'Sign in.' } }))).toEqual({ kind: 'signed_out' })
    expect(await readMailbox(apiAnswering(503, { error: { code: 'not_ready', message: 'Down.' } }))).toEqual({ kind: 'failed', code: 'not_ready' })
  })
})

// The page, with the server's API client, the session and Next's notFound / redirect stood in.
const state = vi.hoisted(() => ({ api: null as unknown as ApiClient }))
vi.mock('../../../lib/api/server', () => ({ serverApi: async () => state.api }))
vi.mock('../../../lib/session/server', () => ({
  SIGN_IN_PATH: '/sign-in',
  loadOfficeSession: async () => ({ kind: 'signed_in', session: { user: { locale: 'en' } } }),
}))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND')
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`)
  },
  useRouter: () => ({ refresh() {}, push() {} }),
}))

describe('the page /w/<company>/me/mailbox', () => {
  beforeEach(() => {
    state.api = apiAnswering(200, { messages: [MAIL] })
  })

  it('answers 404 where the API keeps no mailbox (every environment but the local test server)', async () => {
    const { MailboxPage } = await import('./MailboxPage')
    state.api = apiAnswering(404, { error: { code: 'not_found', message: 'Not found.' } })
    await expect(MailboxPage({ params: Promise.resolve({ company: 'SCA' }) })).rejects.toThrow('NOT_FOUND')
    state.api = apiAnswering(401, { error: { code: 'unauthenticated', message: 'Sign in.' } })
    await expect(MailboxPage({ params: Promise.resolve({ company: 'SCA' }) })).rejects.toThrow('REDIRECT /sign-in')
  })

  it('lists the mails on the local test server', async () => {
    const { MailboxPage } = await import('./MailboxPage')
    const html = renderToStaticMarkup((await MailboxPage({ params: Promise.resolve({ company: 'SCA' }) })) as never)
    expect(html).toContain('You are invited')
    expect(html).toContain('href="http://localhost:3300/accept-invitation#token=made-up"')
  })
})

describe('SCR-007-mailbox in both languages', () => {
  const page = (locale: Locale, id: string) =>
    renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'me']) }, createElement(designScreen.view, { model: designScreen.cases.find((entry) => entry.id === id)!.model })))

  it('each mail with who to, the subject, its links (a new tab) and its text; the empty and failed cases in words', () => {
    for (const locale of LOCALES) {
      const html = page(locale, 'normal')
      expect(html, locale).toContain('Quote Q-2026-00042 for the spring jackets')
      expect(html, locale).toContain('target="_blank"')
      expect(html, locale).toContain('href="http://localhost:3300/reset-password#token=made-up-reset-token"')
      expect(html, locale).not.toMatch(/mailbox\.\w+/)
      expect(page(locale, 'empty'), locale).not.toMatch(/mailbox\.\w+/)
      expect(page(locale, 'failed'), locale).toContain('unavailable')
    }
    expect(page('en', 'normal')).toContain('Local mailbox')
    expect(page('it', 'normal')).toContain('Posta locale')
  })
})
