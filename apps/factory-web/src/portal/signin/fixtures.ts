import { defineDesignScreen } from '../../lib/design/design-screen'
import { PortalSignInView, type PortalSignInViewModel, type SignInBrand, type SignInScreen } from './view/PortalSignInView'

/**
 * SCR-026's cases (B-W2b-164, design portal.signin) with made-up data: a made-up company, example.com addresses, made-up
 * terms and notice. No code or token appears anywhere (the view never holds one in its model).
 */

/** A made-up logo: a rounded square with two letters, in light and dark. */
const logo = (fill: string, text: string): string =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40"><rect x="0" y="4" width="32" height="32" rx="8" fill="${fill}"/><text x="16" y="26" font-family="Arial" font-size="14" font-weight="700" fill="${text}" text-anchor="middle">OD</text><text x="40" y="26" font-family="Arial" font-size="15" font-weight="700" fill="${fill}">Demo</text></svg>`,
  )}`

const LEGAL = {
  it: { name: 'Officina Demo S.r.l.', lines: ['Sede legale: Via Esempio 1, 00000 Demopoli (XX), Italia', 'P.IVA IT00000000000 · C.F. 00000000000', 'Capitale sociale € 10.000,00 i.v. · Socio unico'] },
  en: { name: 'Officina Demo S.r.l.', lines: ['Registered office: Via Esempio 1, 00000 Demopoli (XX), Italy', 'VAT IT00000000000 · Tax code 00000000000', 'Share capital € 10,000.00 fully paid · Sole shareholder'] },
}

const BRAND: SignInBrand = {
  companyId: '0190f0e2-1640-7000-8000-000000000001',
  name: 'Portale Officina Demo',
  companyName: 'Officina Demo',
  logoUrl: logo('#1f5fa8', '#ffffff'),
  logoDarkUrl: logo('#dde6f2', '#10243d'),
  accent: '#1f5fa8',
  contactEmail: 'ordini@officina-demo.example.com',
  legal: LEGAL,
}

/** A company without branding: its name in text and the design system's colours; no conversation address yet. */
const PLAIN: SignInBrand = { companyId: '0190f0e2-1640-7000-8000-000000000002', name: 'Laboratorio Esempio', companyName: 'Laboratorio Esempio', logoUrl: null, logoDarkUrl: null, accent: null, contactEmail: null, legal: null }

const EMAIL = 'anna.demo@brand.example.com'
const email = (value = ''): SignInScreen => ({ kind: 'email', email: value })
const code: SignInScreen = { kind: 'code', email: EMAIL, resendAt: null }
const TERMS = {
  state: 'ready' as const,
  label: 'Condizioni del portale — versione 3',
  locale: 'it',
  languageReady: true,
  body: 'Condizioni d’uso del portale (testo di esempio).\n\n1. Il portale è riservato alle persone invitate da Officina Demo.\n2. Ogni persona usa il proprio accesso e non lo condivide.\n3. I documenti del portale servono al lavoro tra le due aziende.\n4. Officina Demo può sospendere un accesso in qualsiasi momento.\n5. Le e-mail su ordini, consegne e fatture arrivano sempre.\n\nTesto di esempio: le condizioni vere le pubblica l’azienda in Sistema › Privacy.',
}
const first = (over: Partial<Extract<SignInScreen, { kind: 'first-visit' }>> = {}): SignInScreen => ({ kind: 'first-visit', displayName: 'Anna Demo', asksSummaries: true, terms: TERMS, ...over })
const NOTICE = {
  state: 'ready' as const,
  label: 'Informativa privacy — versione 2',
  locale: 'it',
  languageReady: true,
  body: 'Informativa sul trattamento dei dati personali (testo di esempio).\n\nTitolare del trattamento: Officina Demo S.r.l.\nDati trattati: nome, e-mail di lavoro, accessi al portale.\nFinalità: la gestione degli ordini e dei documenti tra le aziende.\nDiritti: accesso, rettifica, cancellazione, scrivendo a privacy@officina-demo.example.com.',
}
/**
 * A time some minutes after NOW, read each time the case is drawn (a getter): a value taken when this file was loaded would
 * be stale on a `next dev` server that loaded it long ago. The view draws clock-bound words in the browser only; half
 * minutes keep the shown count steady ("Wait 4 minutes…" for 3.5).
 */
function later<T extends object>(target: T, field: string, minutes: number): T {
  Object.defineProperty(target, field, { get: () => Date.now() + minutes * 60_000, enumerable: true, configurable: true })
  return target
}

const base = (screen: SignInScreen, extra: Partial<PortalSignInViewModel> = {}): PortalSignInViewModel => ({ brand: BRAND, screen, ...extra })

export const designScreen = defineDesignScreen<PortalSignInViewModel>({
  screen: 'SCR-026',
  title: 'Portal sign-in',
  view: PortalSignInView,
  cases: [
    { id: 'email', label: 'Step 1 — work e-mail (branded)', model: base(email()), note: 'The company’s logo (the dark one in dark), the portal’s name, the accent where it passes 7:1; language; one field, one button; the foot: by invitation, whom to ask, the privacy notice in a new tab, the legal block.' },
    { id: 'email-unbranded', label: 'Step 1 — a company without branding', model: base(email(), { brand: PLAIN }), note: 'The name in text, the design system’s colours; no contact address yet: "ask your contact" without an e-mail.' },
    { id: 'loading', label: 'Reading whose portal', model: { brand: null, screen: { kind: 'loading' } }, note: 'Skeleton in the card’s shape; "Still loading…" after about a second.' },
    { id: 'brand-failed', label: 'Branding could not load', model: { brand: null, brandFailed: true, screen: email() }, note: 'The page still works with the address it was given: generic name, DS colours.' },
    { id: 'unknown', label: 'Which portal? (no address)', model: { brand: null, screen: { kind: 'unknown', reason: 'none' } }, note: 'Opened without the invitation’s address on a device that never signed in: never a sign-up form.' },
    { id: 'unknown-not-found', label: 'Which portal? (unknown address)', model: { brand: null, screen: { kind: 'unknown', reason: 'not-found' } } },
    { id: 'email-field', label: 'Step 1 — form check', model: base(email('anna.demo'), { fieldErrors: { email: 'format' } }), note: 'After leaving the field or on submit; nothing is sent.' },
    { id: 'email-sending', label: 'Step 1 — sending', model: base(email(EMAIL), { busy: true }) },
    { id: 'email-wait', label: 'Step 1 — too many requests', model: later(base(email(EMAIL)), 'waitUntil', 3.5), note: 'After 3 e-mails in 10 minutes: the button is held with the wait, counting down.' },
    { id: 'email-check', label: 'Step 1 — checking it is a person', model: base(email(EMAIL), { checking: true }), note: 'Only after suspicious traffic from the network: a moment of the browser’s work (self-hosted, no third party), then the e-mail goes.' },
    { id: 'email-failed', label: 'Step 1 — our side failed', model: base(email(EMAIL), { problem: 'sendFailed' }), note: 'The typed address stays.' },
    { id: 'email-offline', label: 'Step 1 — offline', model: base(email(EMAIL), { offline: true }) },
    { id: 'ended-idle', label: 'You were signed out (idle)', model: base(email(EMAIL), { banner: { kind: 'ended', reason: 'idle' } }), note: 'The frame’s idle sign-out sends `ended=idle`: the banner above step 1, the e-mail of this tab prefilled.' },
    { id: 'ended-revoked', label: 'You were signed out (ended by the office)', model: base(email(EMAIL), { banner: { kind: 'ended', reason: 'revoked' } }) },
    { id: 'paused', label: 'Access paused', model: base(email(EMAIL), { banner: { kind: 'paused', problem: 'PAUSED', endedOn: null } }), note: 'Said only after a right code or Continue proved the address; Contact opens the mail program.' },
    { id: 'paused-ended', label: 'Access ended on a date', model: base(email(EMAIL), { banner: { kind: 'paused', problem: 'ENDED', endedOn: '31/10/2026' } }) },
    { id: 'paused-portal-off', label: 'Portal not switched on yet', model: base(email(EMAIL), { brand: PLAIN, banner: { kind: 'paused', problem: 'PORTAL_OFF', endedOn: null } }), note: 'A company without a contact address: "your contact at …".' },
    { id: 'code', label: 'Step 2 — the code', model: base(code), note: 'The same answer for every address. Six boxes, one input (one-time-code): a paste anywhere on the step fills it; the 6th digit signs in; Esc goes back with the address kept.' },
    { id: 'code-wrong', label: 'Step 2 — wrong code', model: base(code, { code: { kind: 'wrong', triesLeft: 4 } }) },
    { id: 'code-tried-out', label: 'Step 2 — too many tries', model: base(code, { code: { kind: 'triedOut' } }), note: 'The code is dead: the field is held with the reason; Send a new code stays.' },
    { id: 'code-expired', label: 'Step 2 — expired', model: base(code, { code: { kind: 'expired' } }) },
    { id: 'code-checking', label: 'Step 2 — checking', model: base(code, { busy: true }) },
    { id: 'code-resend-wait', label: 'Step 2 — new code waits', model: base(later({ kind: 'code', email: EMAIL, resendAt: null } as SignInScreen, 'resendAt', 0.7)), note: '"Send a new code" opens a minute after the last one.' },
    { id: 'code-resent', label: 'Step 2 — new code sent', model: base(code, { resent: true }) },
    { id: 'code-failed', label: 'Step 2 — our side failed', model: base(code, { problem: 'signInFailed' }) },
    { id: 'code-offline', label: 'Step 2 — offline', model: base(code, { offline: true }) },
    { id: 'link-checking', label: 'Mailed link — opening', model: base({ kind: 'link-checking' }) },
    { id: 'link', label: 'Mailed link — Continue', model: base({ kind: 'link', company: 'Officina Demo', email: EMAIL }), note: 'Reading the link does not use it: a mail scanner that opened it first burns nothing. Enter presses Continue.' },
    { id: 'link-unread', label: 'Mailed link — could not be read first', model: base({ kind: 'link', company: null, email: null }, { problem: 'signInFailed' }), note: 'Continue still works: it is the press that uses the link.' },
    { id: 'link-busy', label: 'Mailed link — signing in', model: base({ kind: 'link', company: 'Officina Demo', email: EMAIL }, { busy: true }) },
    { id: 'link-dead', label: 'Mailed link — no longer works', model: base({ kind: 'link-dead' }), note: 'Used, expired or not ours: one answer, and Send a new link (step 1).' },
    { id: 'first-visit', label: 'First visit', model: base(first()), note: 'Name (from the invitation), language, e-mail summaries, the portal terms once; saved in one step. Focus on the name.' },
    { id: 'first-visit-check', label: 'First visit — form check', model: base(first({ displayName: '' }), { fieldErrors: { name: 'required', terms: 'required' } }) },
    { id: 'first-visit-kept', label: 'First visit — summaries already chosen', model: base(first({ asksSummaries: false })), note: 'A newer version of the terms brings the first visit back; summaries set in E-mail settings are kept.' },
    { id: 'first-visit-language', label: 'First visit — terms not in the language', model: base(first({ terms: { ...TERMS, languageReady: false } })) },
    { id: 'first-visit-terms-loading', label: 'First visit — terms loading', model: base(first({ terms: { state: 'loading' } })) },
    { id: 'first-visit-terms-failed', label: 'First visit — terms failed', model: base(first({ terms: { state: 'failed' } })) },
    { id: 'first-visit-changed', label: 'First visit — terms changed meanwhile', model: base(first(), { problem: 'termsChanged' }) },
    { id: 'first-visit-saving', label: 'First visit — saving', model: base(first(), { busy: true }) },
    { id: 'first-visit-failed', label: 'First visit — save failed', model: base(first(), { problem: 'saveFailed' }) },
    { id: 'opening', label: 'Signed in — opening the portal', model: base({ kind: 'opening' }) },
    { id: 'privacy', label: 'Privacy notice (new tab)', model: base({ kind: 'privacy', notice: NOTICE }), note: '`/p/signin/privacy?company=<id>`: the notice the company published, beside the sign-in.' },
    { id: 'privacy-loading', label: 'Privacy notice — loading', model: base({ kind: 'privacy', notice: { state: 'loading' } }) },
    { id: 'privacy-missing', label: 'Privacy notice — none published', model: base({ kind: 'privacy', notice: { state: 'missing' } }) },
    { id: 'privacy-failed', label: 'Privacy notice — failed', model: base({ kind: 'privacy', notice: { state: 'failed' } }) },
  ],
})
