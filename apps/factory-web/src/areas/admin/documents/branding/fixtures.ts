import { createElement } from 'react'
import type { BrandingView as Branding } from '@nexus/factory-domain/branding/contracts'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import { at, COMPANIES, inShell } from '../../shared/fixtures'
import { legalOf } from '../model'
import { draftOf, SAVED_NOTICE, type BrandingDraft, type BrandingSectionModel, type CompanyChoice } from './model'
import { BrandingView } from './view/BrandingView'

/**
 * SCR-014-branding — Documents & numbering › Branding (B-W2b-161; PLT-228, SAL-064; design admin.documents/sec:branding,
 * a W2b section of a W0 page) with made-up data of the two Demo companies: an unbranded company, a branded one (a logo
 * for light and one for dark pages, an accent, a sender name, a portal name), a change being typed, colours that pass in
 * one theme only, fields the API would refuse (Save held with the reason), a logo on its way and one refused, read only
 * (documents.view without documents.branding.manage), the fresh code, a save refused, and the read's own states. Logos are
 * invented SVG wordmarks inline (a form whose draft holds them and changes nothing draws the saved branding). Without documents.view the section is absent (SCR-014's Branding option is not offered).
 */

const [demo, esempio] = COMPANIES as [(typeof COMPANIES)[number], (typeof COMPANIES)[number]]

const companies: CompanyChoice[] = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, status: company.status, legalReady: legalOf(company).legalReady }))

/** A made-up wordmark as an inline SVG (the DS takes `data:image/…` addresses). */
const wordmark = (ink: string, ground: string | null): string =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64">${ground ? `<rect width="240" height="64" fill="${ground}"/>` : ''}<rect x="8" y="14" width="36" height="36" rx="6" fill="${ink}"/><text x="56" y="43" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="${ink}">Officina Demo</text></svg>`,
  )}`
const LOGO = wordmark('#0b3d91', null)
const LOGO_DARK = wordmark('#dde6f2', null)

const fileId = (n: number) => `0190f0e2-7171-7000-8000-${String(n).padStart(12, '0')}`

const unbranded = (over: Partial<Branding> = {}): Branding => ({
  companyId: demo.id,
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

const BRANDED: Branding = unbranded({
  saved: true,
  logo: { fileId: fileId(1), path: `/branding/public/${demo.id}/logo/${fileId(1)}`, name: 'officina-demo.png', contentType: 'image/png' },
  logoDark: { fileId: fileId(2), path: `/branding/public/${demo.id}/logo/${fileId(2)}`, name: 'officina-demo-chiaro.png', contentType: 'image/png' },
  accentColour: '#0b3d91',
  senderDisplayName: 'Officina Demo Ordini',
  portalLabel: 'Portale Officina Demo',
  shown: { portal: 'Portale Officina Demo', sender: 'Officina Demo Ordini' },
  version: 3,
  updatedAt: at(28, 15, 12),
})

/** The branded company's form with the made-up pictures in place of the API's addresses (no API in the design index). */
const brandedDraft = (over: Partial<BrandingDraft> = {}): BrandingDraft => {
  const draft = draftOf(BRANDED)
  return { ...draft, logo: { ...draft.logo!, src: LOGO }, logoDark: { ...draft.logoDark!, src: LOGO_DARK }, ...over }
}

const base = (over: Partial<BrandingSectionModel> = {}): BrandingSectionModel => ({ companies, companyId: demo.id, read: { status: 'ready', branding: unbranded() }, draft: null, ...over })
const branded = (draft: Partial<BrandingDraft> = {}, over: Partial<BrandingSectionModel> = {}): BrandingSectionModel =>
  base({ read: { status: 'ready', branding: BRANDED }, draft: brandedDraft(draft), ...over })

function BrandingDesign({ model }: { model: BrandingSectionModel }) {
  const readOnly = model.read.status === 'ready' && !model.read.branding.mayChange
  // documents.view without the right to change: the Admin pages a sales lead reaches, plus Documents & numbering.
  return inShell('/admin/documents', createElement(BrandingView, { model }), readOnly ? ['home.view', 'numbering.view', 'documents.view'] : undefined)
}

export const designScreen = defineDesignScreen<BrandingSectionModel>({
  screen: 'SCR-014-branding',
  title: 'Documents & numbering › Branding',
  view: BrandingDesign,
  cases: [
    { id: 'unbranded', label: 'No branding yet: the name in text, the standard colours', model: base(), note: 'Start with the logo; the logo for dark pages waits for it (held with the reason).' },
    {
      id: 'branded',
      label: 'Branded: a logo for light and one for dark pages, a colour, a sender name, a portal name',
      model: branded(),
      note: 'The colour leads buttons and links on light pages (8.8:1) and is not used on dark ones (1.4:1). The pictures are made up and inline here; the screen loads them from the API\'s public address.',
    },
    { id: 'trimmed', label: 'A space typed at the end of a name is no change: no bar', model: branded({ label: 'Portale Officina Demo ' }) },
    {
      id: 'editing',
      label: 'A change being typed: Save and Discard in the EditModeBar (⌘S)',
      model: branded({ accent: '#e8590c', sender: 'Officina Demo · Ordini e spedizioni', label: 'Portale clienti e fornitori' }),
      note: 'An orange that reaches 3:1 in both themes: lines and marks only; buttons and links keep the standard colour.',
    },
    { id: 'accent-dark-only', label: 'A colour that works on dark pages only', model: branded({ accent: '#ffcc00' }), note: 'Light pages keep the standard colours (1.3:1); dark pages take it for buttons and links (9.3:1).' },
    {
      id: 'invalid',
      label: 'Fields the API would refuse: Save held with the reason',
      model: branded({ accent: 'blu', sender: 'Officina Demo <ordini@example.com>', label: 'Il portale per clienti, fornitori, terzisti e consulenti di Officina Demo' }),
    },
    { id: 'uploading', label: 'A logo on its way to the store', model: base({ draft: { ...draftOf(unbranded()) }, uploading: 'logo' }), note: 'Save waits for it; it becomes the logo only when the branding is saved.' },
    {
      id: 'new-logo',
      label: 'A new logo picked, not saved yet',
      model: base({ draft: { ...draftOf(unbranded()), logo: { fileId: fileId(3), name: 'logo-officina.png', src: LOGO } } }),
      note: 'The portal preview shows it at once; the documents print it once saved.',
    },
    { id: 'upload-refused', label: 'A file that says it is a PNG but is not a picture', model: base({ uploadProblem: { slot: 'logo', key: 'brand.logo.problem.notPicture' } }) },
    { id: 'upload-too-large', label: 'A picture larger than 1 MB, refused before it is sent', model: base({ uploadProblem: { slot: 'logo', key: 'brand.logo.problem.size' } }) },
    {
      id: 'read-only',
      label: 'Read only: documents.view without documents.branding.manage',
      model: base({ read: { status: 'ready', branding: { ...BRANDED, mayChange: false } }, draft: brandedDraft() }),
      note: 'Every control is held with the reason; nothing can be typed.',
    },
    { id: 'step-up', label: 'Save asks a fresh code (the sender name changes who mail appears to come from)', model: branded({ sender: 'Officina Demo Vendite' }, { busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.default', problem: null } }) },
    { id: 'conflict', label: 'Someone saved first: the branding is read again', model: branded({}, { problem: 'problem.conflict' }) },
    { id: 'saved', label: 'Saved', model: branded({}, { notice: SAVED_NOTICE }) },
    {
      id: 'other-company',
      label: 'The second company: its legal data is not complete, so no document preview',
      model: base({ companyId: esempio.id, read: { status: 'ready', branding: unbranded({ companyId: esempio.id, companyName: DEMO_COMPANIES[1].name, shown: { portal: DEMO_COMPANIES[1].name, sender: DEMO_COMPANIES[1].name } }) } }),
    },
    { id: 'one-company', label: 'One company: no company picker', model: base({ companies: companies.slice(0, 1) }) },
    {
      id: 'no-company-list',
      label: 'Without companies.view (finance): the companies of the session, the document preview offered',
      model: base({ companies: companies.map((company) => ({ ...company, legalReady: null })), read: { status: 'ready', branding: { ...BRANDED, mayChange: false } }, draft: brandedDraft() }),
      note: 'The company list is not read; whether the legal data is complete is then not known, so the preview link stays (the PDF says it if not).',
    },
    { id: 'loading', label: 'Reading the branding', model: base({ read: { status: 'loading' } }) },
    { id: 'failed', label: 'The branding could not be read', model: base({ read: { status: 'failed', problem: 'problem.unavailable' } }), note: 'Try again reads it once more; the Numbers and Documents lists keep working.' },
  ],
})
