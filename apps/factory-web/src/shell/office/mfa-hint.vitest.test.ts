import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../lib/i18n/messages'
import { I18nProvider } from '../../lib/i18n/provider'
import { permissionCheck } from '../../lib/session/session'
import { rolePermissions } from '../design-data'
import { officeNavFor } from '../nav/office-nav'
import { phoneNav } from './phone-bar'
import { designScreen } from './fixtures'
import { MFA_HINT_HREF, MFA_HINT_ID, mfaWaits, navWithMfaHint } from './mfa-hint'
import { NO_TEST_MODES, testModeBanner } from './test-mode'
import { OfficeShellView } from './view/OfficeShellView'

/** B-W2b-F58: the two-factor row of the navigation, and the TEST MODE bar the local test server hides (made-up people). */

const WAITS = { enabled: false, required: true, satisfied: false }
const render = (locale: Locale, id: string) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(OfficeShellView, { model: designScreen.cases.find((entry) => entry.id === id)!.model })))

describe('the navigation while the role waits for two-factor (mfa-hint.ts)', () => {
  it('says what it waits for: the app set up, or a sign-in with its code; nothing once proved or not asked', () => {
    expect(mfaWaits(WAITS)).toBe('setup')
    expect(mfaWaits({ ...WAITS, enabled: true })).toBe('signIn')
    expect(mfaWaits({ ...WAITS, satisfied: true })).toBeNull()
    expect(mfaWaits({ enabled: false, required: false, satisfied: true })).toBeNull()
  })

  it('holds ONE row in words, first, that opens Me › Authenticator; the areas replace it once the code is proved', () => {
    const empty = officeNavFor(permissionCheck([]))
    expect(empty.areas).toEqual([])
    const waiting = navWithMfaHint(empty, WAITS)
    expect(waiting.areas).toEqual([expect.objectContaining({ id: MFA_HINT_ID, href: MFA_HINT_HREF, label: 'shell:nav.mfaHint.setup', phone: 'tab' })])
    expect(MFA_HINT_HREF).toBe('/me#authenticator')
    // Once: applied twice, still one row. On a phone it is the one tab.
    expect(navWithMfaHint(waiting, WAITS).areas).toHaveLength(1)
    expect(phoneNav(waiting).areas.map((area) => [area.id, area.phone])).toEqual([[MFA_HINT_ID, 'tab']])
    // Proved (after the set-up, the session reloads): the person's areas, no row.
    const owner = officeNavFor(permissionCheck(rolePermissions('owner')))
    expect(navWithMfaHint(owner, { ...WAITS, enabled: true, satisfied: true })).toBe(owner)
    expect(navWithMfaHint(owner, { enabled: false, required: false, satisfied: true })).toBe(owner)
    expect(navWithMfaHint(empty, { ...WAITS, enabled: true }).areas[0]!.label).toBe('shell:nav.mfaHint.signIn')
  })

  it('the rail draws it in the person’s language, linked to the card, with the “needs you” dot', () => {
    for (const locale of LOCALES) {
      const html = render(locale, 'authenticator-first')
      const words = CATALOGUE[locale].shell?.['nav.mfaHint.setup'] as string
      expect(words.length, locale).toBeGreaterThan(10)
      expect(html, locale).toContain(words.replace(/'/g, '&#x27;'))
      expect(html, locale).toContain('href="/w/DEMO/me#authenticator"')
      expect(html, locale).toContain('h10-dot action')
    }
    expect(render('en', 'authenticator-first')).toContain('Set up your authenticator app to see your work')
    expect(render('en', 'owner')).not.toContain('authenticator app to see your work')
  })
})

describe('the TEST MODE bar on the local test server (B-W2b-F58)', () => {
  const notices = { carrierSites: [{ siteId: 's1', name: 'Plant A' }], eInvoicingCompanies: [{ companyId: 'c1', name: 'Company One' }] }
  const rights = { carrierPage: true, eInvoicingPage: true }
  it('no bar when GET /shell/notices says it is hidden, though the test modes are named; the bar otherwise', () => {
    expect(testModeBanner({ notices: { ...notices, bannerHidden: true }, rights })).toBeNull()
    expect(testModeBanner({ notices: { ...notices, bannerHidden: false }, rights })).toMatchObject({ carrierSites: ['Plant A'], eInvoicingCompanies: ['Company One'] })
    expect(testModeBanner({ notices, rights })).not.toBeNull()
    expect(NO_TEST_MODES.bannerHidden).toBe(false)
  })

  it('SCR-003 holds the case: no band, the mailbox offered in the person menu', () => {
    const local = designScreen.cases.find((entry) => entry.id === 'test-mode-hidden-local')!
    expect(local.model.banners).toEqual([])
    expect(local.model.localMailbox).toBe(true)
    const html = render('en', 'test-mode-hidden-local')
    expect(html).not.toContain(CATALOGUE.en.shell?.['banner.testMode.title'] as string)
    expect(render('en', 'test-mode')).toContain(CATALOGUE.en.shell?.['banner.testMode.title'] as string)
  })
})
