import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../lib/api/errors'
import { type Locale } from '../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { LINK_STATES, linkStateFromError, linkStateLook, linkStateOfOpened, type LinkState } from './link-state'
import { LinkFrameView, type LinkFrameViewModel } from './view/LinkFrameView'

const COMPANY = '0190f0e2-1111-7000-8000-000000000001'
const sender = { name: 'Officina Demo S.r.l.', accent: '#7a2e0e', companyId: COMPANY, contact: { name: 'Ufficio Demo', email: 'demo@example.com' } }

function render(model: LinkFrameViewModel, locale: Locale = 'en'): string {
  return renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(LinkFrameView, { model })))
}
const linkBody = (state: LinkState) => ({ kind: 'link' as const, state, purpose: null, expiresAt: null, usesLeft: null })
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

describe('the link states render (SCR-028, SAL-099)', () => {
  for (const locale of ['en', 'it'] as const) {
    const t = createTranslator(locale, messagesFor(locale, ['shell']).shell ?? {})
    for (const state of LINK_STATES.filter((s) => s !== 'valid')) {
      it(`${state} (${locale}): says what happened and whom to ask`, () => {
        const html = decode(render({ sender, title: 'Quote Q-2026-0042', body: linkBody(state) }, locale))
        expect(html).toContain(t(`links.state.${state}.title`))
        expect(html).toContain(t(`links.state.${state}.body`, { sender: sender.name }))
        if (linkStateLook(state).askSender) expect(html).toContain(sender.name)
      })
    }
  }

  it('without a known sender (what the API tells today) each state says "whoever sent it", in grammatical Italian too', () => {
    for (const locale of ['en', 'it'] as const) {
      const t = createTranslator(locale, messagesFor(locale, ['shell']).shell ?? {})
      for (const state of LINK_STATES) {
        const html = decode(render({ sender: null, title: null, body: linkBody(state) }, locale))
        expect(html).toContain(t(`links.state.${state}.bodyAnonymous`))
        expect(html).not.toMatch(/\{sender\}|il mittente|di il |a il /)
      }
    }
  })

  it('valid: what the link lets the holder do, until when, and how many uses are left', () => {
    const html = decode(render({ sender, title: 'Quote Q-2026-0042', timeZone: 'Europe/Rome', body: { kind: 'link', state: 'valid', purpose: 'QUOTE_ACCEPT', expiresAt: '2026-11-27T22:59:00.000Z', usesLeft: 1 } }))
    expect(html).toContain('The link is open')
    expect(html).toContain('read your quote and accept or decline it')
    expect(html).toContain('27/11/2026, 23:59')
    expect(html).toContain('1 use')
    expect(html).toContain('<h1 class="fw-link-title">Quote Q-2026-0042</h1>')
  })

  it('has no chrome: no navigation, no search, no switcher (the partner wall, PLT-007)', () => {
    const html = render({ sender, title: null, body: linkBody('valid') })
    expect(html).not.toMatch(/<nav\b|h10-rail|fw-topbar|nds-bottombar|nds-searchtrigger/)
  })

  it('is on the comfortable tier and carries the sender\'s branding only where its colour passed', () => {
    const html = render({ sender, title: null, body: linkBody('expired') })
    expect(html).toContain('data-density="comfortable"')
    expect(html).toMatch(/data-brand="[^"]*primary-light/)
    const plain = render({ sender: { name: 'Plain Demo', companyId: COMPANY }, title: null, body: linkBody('expired') })
    expect(plain).toContain('data-brand=""')
    expect(plain).toContain('Plain Demo')
    expect(render({ sender: null, title: null, body: linkBody('unavailable') })).not.toContain('data-brand')
  })

  it('links the sender\'s privacy notice (GAP-005, GDPR art. 13/14) on every link page, in both languages', () => {
    expect(decode(render({ sender, title: null, body: linkBody('valid') }))).toContain(`<a href="/privacy/${COMPANY}">How Officina Demo S.r.l. uses your data (privacy notice)</a>`)
    expect(decode(render({ sender, title: null, body: linkBody('used') }, 'it'))).toContain(`<a href="/privacy/${COMPANY}">Come Officina Demo S.r.l. usa i tuoi dati (informativa privacy)</a>`)
    // Without a known sender the page says where the notice is instead of linking nowhere.
    expect(decode(render({ sender: null, title: null, body: linkBody('unavailable') }))).toContain('privacy notice is linked in the email')
  })

  it('the privacy page says the notice is not published yet, and whom to ask', () => {
    const html = decode(render({ sender: { name: '', companyId: COMPANY }, title: null, body: { kind: 'privacy', notice: null } }))
    expect(html).toContain('<h1 class="fw-link-title">Privacy notice</h1>')
    expect(html).toContain('Not published here yet')
    expect(html).toContain('you have the right to receive it')
    expect(decode(render({ sender, title: null, body: { kind: 'privacy', notice: null } }, 'it'))).toContain('Informativa privacy di Officina Demo S.r.l.')
    expect(html).not.toContain(`href="/privacy/`)
  })

  it('shows whom to contact when the sender gave a contact', () => {
    expect(render({ sender, title: null, body: linkBody('expired') })).toContain('href="mailto:demo@example.com"')
  })
})

describe('which state a link is in', () => {
  it('maps what the API answered: one 404 for any link that opens nothing', () => {
    expect(linkStateFromError(new ApiError('not_found', 404, 'LINK_UNAVAILABLE', 'x'))).toBe('unavailable')
    expect(linkStateFromError(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('wrong_person')
    expect(linkStateFromError(new ApiError('unavailable', 0, 'network', 'x'))).toBe('error')
    expect(linkStateFromError(new ApiError('rate_limited', 429, 'rate_limited', 'x'))).toBe('error')
  })

  it('an opened link expires on the page when its time passes, and is used when no use is left', () => {
    const now = new Date('2026-10-28T10:00:00Z')
    expect(linkStateOfOpened({ expiresAt: '2026-10-29T10:00:00Z', usesLeft: 1 }, now)).toBe('valid')
    expect(linkStateOfOpened({ expiresAt: '2026-10-28T10:00:00Z', usesLeft: 1 }, now)).toBe('expired')
    expect(linkStateOfOpened({ expiresAt: '2026-10-29T10:00:00Z', usesLeft: 0 }, now)).toBe('used')
  })
})
