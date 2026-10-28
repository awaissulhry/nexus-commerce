import { createElement, useMemo } from 'react'
import { defineDesignScreen } from '../../lib/design/design-screen'
import { messagesFor } from '../../lib/i18n/messages'
import { I18nProvider, useLocale } from '../../lib/i18n/provider'
import { permissionCheck } from '../../lib/session/session'
import { DEMO_COMPANIES, DEMO_SITES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../shell/design-data'
import { officeNavFor } from '../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../shell/office/view/OfficeShellView'
import type { MyProfileViewModel } from './me-model'
import { MyProfileView } from './view/MyProfileView'

/**
 * SCR-007's cases with made-up data: the demo person (example.com), a made-up company group, a made-up TOTP secret and
 * made-up recovery codes (they open nothing anywhere).
 */

/** The office around the page, as the person menu opens it (`/w/DEMO/me`): the page sits in no area, so no band. */
const SHELL: OfficeShellViewModel = {
  nav: officeNavFor(permissionCheck(OWNER_PERMISSIONS)),
  path: '/me',
  switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: DEMO_SITES, site: null, path: '/me' },
  user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
  tenantTag: DEMO_TAG,
  banners: [],
}
/** Two-factor required and not proved: the roles give nothing yet, so the rail is empty. */
const SHELL_NO_AREAS: OfficeShellViewModel = { ...SHELL, nav: officeNavFor(permissionCheck([])) }

/**
 * The page in the office shell, with its own text: the design frame gives the `shell` namespace only; the live page
 * gives `me`. The page's language follows the frame's.
 */
function MyProfileDesign({ model }: { model: MyProfileViewModel }) {
  const locale = useLocale()
  const messages = useMemo(() => messagesFor(locale, ['me']), [locale])
  const locked = model.authenticator.state === 'off' && model.authenticator.required
  return createElement(
    I18nProvider,
    { locale, messages },
    createElement(OfficeShellView, { model: locked ? SHELL_NO_AREAS : SHELL }, createElement(MyProfileView, { model: { ...model, locale } })),
  )
}

// A made-up base32 secret and its otpauth address (as the API's `otpauthUri` builds it).
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
const OTPAUTH = `otpauth://totp/Nexus%20Factory:${encodeURIComponent(DEMO_USER.email)}?secret=${SECRET}&issuer=Nexus%20Factory&algorithm=SHA1&digits=6&period=30`
const CODES = ['ABCDE-23456', 'FGHJK-78923', 'MNPQR-34567', 'STUVW-89234', 'XYZAB-45678', 'CDEFG-92345', 'HJKMN-56789', 'PQRST-23478', 'UVWXY-67892', 'ZABCD-34589']

const base: MyProfileViewModel = {
  person: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
  tenant: 'Officina Demo',
  locale: 'en',
  theme: 'system',
  timeZone: 'Europe/Rome',
  password: { state: 'closed' },
  authenticator: { state: 'on', required: false, recoveryCodesLeft: 8 },
  session: { createdAt: '2026-10-28T07:12:00.000Z', idleExpiresAt: '2026-10-28T17:40:00.000Z', absoluteExpiresAt: '2026-11-04T07:12:00.000Z' },
}

export const designScreen = defineDesignScreen<MyProfileViewModel>({
  screen: 'SCR-007',
  title: 'My profile & security',
  view: MyProfileDesign,
  cases: [
    { id: 'normal', label: 'Two-factor on', model: base, note: 'From the person menu in the top bar. Language is the person\'s (saved in the API); the theme is this device\'s.' },
    {
      id: 'required-off',
      label: 'Two-factor required, not set up',
      model: { ...base, authenticator: { state: 'off', required: true } },
      note: 'An owner or a role that needs two-factor: nothing but this page opens until it is set up (the sign-in lands here).',
    },
    { id: 'off', label: 'Two-factor off (optional)', model: { ...base, authenticator: { state: 'off', required: false } } },
    {
      id: 'setup',
      label: 'Set-up: scan and enter the code',
      model: { ...base, authenticator: { state: 'setup', secret: SECRET, otpauthUri: OTPAUTH } },
      note: 'The QR code holds the otpauth address; the key under it is for typing in.',
    },
    {
      id: 'setup-wrong',
      label: 'Set-up: the code does not match',
      model: { ...base, authenticator: { state: 'setup', secret: SECRET, otpauthUri: OTPAUTH, problem: 'wrongCode' } },
    },
    {
      id: 'recovery-codes',
      label: 'Recovery codes, shown once',
      model: { ...base, authenticator: { state: 'codes', recoveryCodes: CODES } },
      note: 'Only now: the API keeps their hashes. Copy, then "I have saved them".',
    },
    { id: 'turned-on', label: 'Two-factor just switched on', model: { ...base, authenticator: { state: 'on', required: false, recoveryCodesLeft: 10, turnedOn: true } } },
    {
      id: 'required-on',
      label: 'Two-factor on, required by the role',
      model: { ...base, authenticator: { state: 'on', required: true, recoveryCodesLeft: 2 } },
      note: 'No switch-off; few codes left (the warning about new codes is not offered: switching off is not allowed).',
    },
    { id: 'low-codes', label: 'Few recovery codes left', model: { ...base, authenticator: { state: 'on', required: false, recoveryCodesLeft: 2 } } },
    { id: 'disable', label: 'Switch off: password', model: { ...base, authenticator: { state: 'disable' } } },
    { id: 'disable-wrong', label: 'Switch off: wrong password', model: { ...base, authenticator: { state: 'disable', problem: 'wrongPassword' } } },
    { id: 'turned-off', label: 'Two-factor switched off', model: { ...base, authenticator: { state: 'off', required: false, turnedOff: true } } },
    { id: 'password-open', label: 'Change password', model: { ...base, password: { state: 'open' } } },
    {
      id: 'password-fields',
      label: 'Change password: form check',
      model: { ...base, password: { state: 'open', fieldErrors: { current: { key: 'field.currentRequired' }, password: { key: 'field.passwordName' } } } },
    },
    { id: 'password-wrong', label: 'Change password: current one wrong', model: { ...base, password: { state: 'open', problem: 'wrongPassword' } } },
    { id: 'password-locked', label: 'Change password: locked', model: { ...base, password: { state: 'open', problem: 'locked' } } },
    { id: 'password-done', label: 'Password changed', model: { ...base, password: { state: 'closed', done: { sessionsEnded: 2 } } }, note: 'Every other session ended; this one goes on.' },
    { id: 'language-saving', label: 'Language: saving', model: { ...base, language: { busy: true } } },
    { id: 'language-failed', label: 'Language: API not answering', model: { ...base, language: { problem: 'unavailable' } } },
    { id: 'signing-out', label: 'Signing out', model: { ...base, signOut: { busy: true } } },
  ],
})
