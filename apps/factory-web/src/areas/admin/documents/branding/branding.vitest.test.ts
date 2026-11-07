import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BrandingView } from '@nexus/factory-domain/branding/contracts'
import { LOGO_MAX_BYTES } from '@nexus/factory-domain/branding/rules'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen } from './fixtures'
import { accentUses, bodyOf, changesOf, companyFor, draftOf, logoHeld, pickProblem, problemsOf, ratioWords, saveHeld, shownOf, tokensOf, valuesOf, type BrandingDraft } from './model'

/** SCR-014-branding (B-W2b-161; PLT-228, SAL-064): the form's rules, pure, and every design case in it + en. */

const COMPANY = '0190f0e2-6161-7000-8000-000000000001'
const OTHER = '0190f0e2-6161-7000-8000-000000000002'
const FILE = '0190f0e2-7171-7000-8000-000000000001'
const DARK = '0190f0e2-7171-7000-8000-000000000002'

const view = (over: Partial<BrandingView> = {}): BrandingView => ({
  companyId: COMPANY,
  companyName: 'Officina Demo',
  saved: false,
  logo: null,
  logoDark: null,
  accentColour: null,
  senderDisplayName: null,
  portalLabel: null,
  shown: { portal: 'Officina Demo', sender: 'Officina Demo' },
  version: null,
  updatedAt: null,
  mayChange: true,
  ...over,
})
const SAVED = view({
  saved: true,
  logo: { fileId: FILE, path: `/branding/public/${COMPANY}/logo/${FILE}`, name: 'logo.png', contentType: 'image/png' },
  logoDark: { fileId: DARK, path: `/branding/public/${COMPANY}/logo/${DARK}`, name: 'logo-dark.png', contentType: 'image/png' },
  accentColour: '#0b3d91',
  senderDisplayName: 'Officina Demo Ordini',
  portalLabel: 'Portale Demo',
  version: 3,
})

describe('the form', () => {
  it('starts from the saved branding: logos at their address through /api, names and colour as saved', () => {
    expect(draftOf(view())).toEqual({ logo: null, logoDark: null, accent: '', sender: '', label: '' })
    expect(draftOf(SAVED)).toEqual({
      logo: { fileId: FILE, name: 'logo.png', src: `/api/branding/public/${COMPANY}/logo/${FILE}` },
      logoDark: { fileId: DARK, name: 'logo-dark.png', src: `/api/branding/public/${COMPANY}/logo/${DARK}` },
      accent: '#0b3d91',
      sender: 'Officina Demo Ordini',
      label: 'Portale Demo',
    })
  })

  it('counts what would change: trimmed names, the colour normalised, a dark logo only beside a light one', () => {
    const draft = draftOf(SAVED)
    expect(changesOf(SAVED, null)).toEqual([])
    expect(changesOf(SAVED, { ...draft, label: ' Portale Demo  ', accent: '#0B3D91' })).toEqual([])
    expect(changesOf(SAVED, { ...draft, sender: '' })).toEqual(['senderDisplayName'])
    // A colour still being typed is a change (Save then says why it waits).
    expect(changesOf(SAVED, { ...draft, accent: '#0b3' })).toEqual(['accentColour'])
    expect(changesOf(SAVED, { ...draft, accent: '#0b3d9' })).toEqual(['accentColour'])
    // Removing the light logo takes the dark one with it.
    expect(valuesOf({ ...draft, logo: null })).toMatchObject({ logoFileId: null, logoDarkFileId: null })
    expect(changesOf(SAVED, { ...draft, logo: null })).toEqual(['logo', 'logoDark'])
  })

  it('says what the API would refuse before anything is sent, one problem per field', () => {
    const draft: BrandingDraft = { logo: null, logoDark: null, accent: '', sender: '', label: '' }
    expect(problemsOf(draft)).toEqual({})
    expect(problemsOf({ ...draft, accent: 'blue' })).toEqual({ accent: 'brand.field.accent.invalid' })
    expect(problemsOf({ ...draft, accent: ' #ABC ' })).toEqual({})
    expect(problemsOf({ ...draft, sender: 'Demo <x@example.com>' })).toEqual({ sender: 'brand.field.sender.unsafe' })
    expect(problemsOf({ ...draft, sender: 'Demo "Ordini"' })).toEqual({ sender: 'brand.field.sender.unsafe' })
    expect(problemsOf({ ...draft, sender: 'Demo\nOrdini' })).toEqual({ sender: 'brand.field.oneLine' })
    expect(problemsOf({ ...draft, sender: 'x'.repeat(81) })).toEqual({ sender: 'brand.field.sender.tooLong' })
    expect(problemsOf({ ...draft, sender: 'x'.repeat(80) })).toEqual({})
    expect(problemsOf({ ...draft, label: 'x'.repeat(61) })).toEqual({ label: 'brand.field.label.tooLong' })
    expect(problemsOf({ ...draft, label: 'Portale‮Demo' })).toEqual({ label: 'brand.field.oneLine' })
    // A portal name may hold angle brackets or quotes (it is never a mail header).
    expect(problemsOf({ ...draft, label: 'Portale "Demo"' })).toEqual({})
  })

  it('sends the whole branding at the version read (none before the first save), names trimmed, null for empty', () => {
    expect(bodyOf(view(), { logo: null, logoDark: null, accent: ' #1F5FA8 ', sender: '  ', label: ' Portale ' })).toEqual({ logoFileId: null, logoDarkFileId: null, accentColour: '#1F5FA8', senderDisplayName: null, portalLabel: 'Portale' })
    expect(bodyOf(SAVED, draftOf(SAVED))).toEqual({ version: 3, logoFileId: FILE, logoDarkFileId: DARK, accentColour: '#0b3d91', senderDisplayName: 'Officina Demo Ordini', portalLabel: 'Portale Demo' })
  })

  it('holds Save and the logos with the reason', () => {
    const draft = draftOf(view())
    expect(saveHeld({}, view({ mayChange: false }), draft)).toBe('brand.held.noRight')
    expect(saveHeld({ uploading: 'logo' }, view(), draft)).toBe('brand.held.uploading')
    expect(saveHeld({}, view(), { ...draft, accent: 'blue' })).toBe('brand.held.problems')
    expect(saveHeld({}, view(), draft)).toBeNull()
    expect(logoHeld(view(), draft, 'logo', null)).toBeNull()
    expect(logoHeld(view(), draft, 'logoDark', null)).toBe('brand.held.lightFirst')
    expect(logoHeld(SAVED, draftOf(SAVED), 'logoDark', null)).toBeNull()
    expect(logoHeld(SAVED, draftOf(SAVED), 'logoDark', 'logo')).toBe('brand.held.uploading')
    expect(logoHeld(view({ mayChange: false }), draft, 'logo', null)).toBe('brand.held.noRight')
  })

  it('refuses a picked file that is not a PNG or JPEG or is larger than 1 MiB, before the upload', () => {
    expect(pickProblem({ type: 'image/png', size: 10 })).toBeNull()
    expect(pickProblem({ type: 'image/jpeg', size: LOGO_MAX_BYTES })).toBeNull()
    expect(pickProblem({ type: 'image/svg+xml', size: 10 })).toBe('brand.logo.problem.type')
    expect(pickProblem({ type: 'image/png', size: LOGO_MAX_BYTES + 1 })).toBe('brand.logo.problem.size')
  })
})

describe('what partners will see', () => {
  it('falls back to the company\'s name and the standard colours', () => {
    const empty = draftOf(view())
    expect(shownOf(empty, 'Officina Demo')).toEqual({ portal: 'Officina Demo', sender: 'Officina Demo' })
    expect(tokensOf(empty, 'Officina Demo')).toEqual({ name: 'Officina Demo', logoUrl: null, logoDarkUrl: null, accent: null })
    const draft = draftOf(SAVED)
    expect(shownOf(draft, 'Officina Demo')).toEqual({ portal: 'Portale Demo', sender: 'Officina Demo Ordini' })
    expect(tokensOf({ ...draft, accent: '#0B3D91' }, 'Officina Demo')).toEqual({ name: 'Portale Demo', logoUrl: draft.logo!.src, logoDarkUrl: draft.logoDark!.src, accent: '#0b3d91' })
  })

  it('says per theme where the colour goes, by the design system\'s rule (7:1 for buttons and links, 3:1 for marks)', () => {
    expect(accentUses('', 'X')).toEqual([
      { theme: 'light', use: 'NOT_GIVEN', ratio: null },
      { theme: 'dark', use: 'NOT_GIVEN', ratio: null },
    ])
    const navy = accentUses('#0b3d91', 'X')
    expect(navy.map((use) => use.use)).toEqual(['PRIMARY', 'NONE'])
    expect(navy[0]!.ratio).toBeGreaterThanOrEqual(7)
    expect(navy[1]!.ratio).toBeLessThan(3)
    const orange = accentUses('#e8590c', 'X')
    expect(orange.map((use) => use.use)).toEqual(['ACCENT', 'ACCENT'])
    for (const use of orange) expect(use.ratio).toBeLessThan(7)
    expect(accentUses('#ffcc00', 'X').map((use) => use.use)).toEqual(['NONE', 'PRIMARY'])
    expect(accentUses('blue', 'X').map((use) => use.use)).toEqual(['NOT_GIVEN', 'NOT_GIVEN'])
  })

  it('writes a ratio in the person\'s notation, never rounded up past the rule', () => {
    expect(ratioWords(7.46, 'it')).toBe('7,4:1')
    expect(ratioWords(7.46, 'en')).toBe('7.4:1')
    expect(ratioWords(6.99, 'en')).toBe('6.9:1')
  })

  it('shows the company in the address, else the session\'s, else the first active one', () => {
    const companies = [
      { id: COMPANY, name: 'A', status: 'ACTIVE', legalReady: true },
      { id: OTHER, name: 'B', status: 'ACTIVE', legalReady: false },
    ]
    expect(companyFor(companies, OTHER, COMPANY)).toBe(OTHER)
    expect(companyFor(companies, 'not-mine', OTHER)).toBe(OTHER)
    expect(companyFor(companies, null, null)).toBe(COMPANY)
    expect(companyFor([], null, COMPANY)).toBeNull()
  })
})

const flat = (o: Record<string, unknown>, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [`${p}${k}`]))

describe('the words', () => {
  it('exist in both languages with the same keys', () => {
    const [first, ...rest] = LOCALES.map((locale) => flat(CATALOGUE[locale]!['admin-branding'] as Record<string, unknown>).sort())
    for (const keys of rest) expect(keys).toEqual(first)
  })
})

const LEFT_KEY = /\b(?:brand|docs|problem|common|form|stepUp)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/

describe('SCR-014-branding draws every case in both languages with no key left on screen', () => {
  for (const locale of LOCALES) {
    it(`in ${locale}`, () => {
      const View = designScreen.view as ComponentType<{ model: unknown }>
      for (const item of designScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
        expect(html.length, item.id).toBeGreaterThan(500)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }
})
