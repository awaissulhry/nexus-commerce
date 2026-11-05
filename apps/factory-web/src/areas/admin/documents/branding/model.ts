import type { BrandingBody, BrandingView } from '@nexus/factory-domain/branding/contracts'
import {
  changedFields,
  cleanText,
  hasControlCharacters,
  isHeaderUnsafe,
  LOGO_MAX_BYTES,
  normaliseAccent,
  PORTAL_LABEL_MAX,
  SENDER_NAME_MAX,
  type BrandingField,
  type BrandingValues,
} from '@nexus/factory-domain/branding/rules'
import { checkBranding, type BrandingTokens, type BrandTheme, type BrandThemeVerdict } from '@nexus/ui/tokens/branding'
import type { StepUpModel } from '../../shared/model'

/**
 * SCR-014 › Branding (B-W2b-161; design admin.documents/sec:branding; PLT-228, SAL-064): a company's logo (and logo for
 * dark pages), its accent colour, the name its mail to partners goes out under and the name of its portal, edited in place
 * and saved with the EditModeBar (⌘S). Pure: the container (BrandingSection.tsx) reads and writes the API, the view draws
 * this model, the tests hold every rule.
 *
 * The accent is judged by the design system's own rule (packages/ui tokens/branding.ts checkBranding): the main buttons and
 * links only where it clears 7:1 in that theme, lines and marks where it clears 3:1, else the standard colours stay. The
 * screen says which, per theme, before anything is saved; the API stores the colour as given.
 */

export const BRANDING_VIEWS = ['numbers', 'documents', 'branding'] as const
export type BrandingPageView = (typeof BRANDING_VIEWS)[number]

/** A logo on the form: a saved one (its public path) or one just uploaded (shown from its bytes until it is saved). */
export interface LogoChoice {
  readonly fileId: string
  readonly name: string
  /** What an `<img>` loads: `/api/branding/public/…` for a saved logo, a `data:` image for a new one. */
  readonly src: string
}

/** The form as typed. Names and the accent stay as typed; the save cleans them (factory-domain branding rules). */
export interface BrandingDraft {
  readonly logo: LogoChoice | null
  readonly logoDark: LogoChoice | null
  readonly accent: string
  readonly sender: string
  readonly label: string
}

export type LogoSlot = 'logo' | 'logoDark'

export interface CompanyChoice {
  readonly id: string
  readonly name: string
  readonly status: string
  /** Its legal data lets a sample document print (documents' own rule). */
  readonly legalReady: boolean
}

export type BrandingRead = { readonly status: 'loading' } | { readonly status: 'failed'; readonly problem: string } | { readonly status: 'ready'; readonly branding: BrandingView }

export interface BrandingNotice {
  readonly key: string
  readonly tone: 'success' | 'warning' | 'danger'
  readonly params?: Readonly<Record<string, string | number>>
}

export interface BrandingSectionModel {
  /** The companies the person reaches (the picker shows the ACTIVE ones when there are two or more). */
  readonly companies: readonly CompanyChoice[]
  /** The company shown; null while none can be (no company read yet). */
  readonly companyId: string | null
  readonly read: BrandingRead
  /** What is typed; null: nothing changed since the read. */
  readonly draft: BrandingDraft | null
  /** A logo on its way to the store. */
  readonly uploading?: LogoSlot | null
  /** Why the last upload failed (a message key), and for which logo. */
  readonly uploadProblem?: { readonly slot: LogoSlot; readonly key: string } | null
  readonly busy?: boolean
  /** Why the last save failed (a message key). */
  readonly problem?: string | null
  readonly notice?: BrandingNotice | null
  readonly stepUp?: StepUpModel
}

// ---- the form ------------------------------------------------------------------------------------------------------------

/** The public path of a saved logo as this browser reaches it. */
export const savedLogoSrc = (path: string): string => `/api${path}`

/** The form as the saved branding fills it. */
export function draftOf(branding: BrandingView): BrandingDraft {
  const logo = (value: BrandingView['logo']): LogoChoice | null => (value ? { fileId: value.fileId, name: value.name, src: savedLogoSrc(value.path) } : null)
  return { logo: logo(branding.logo), logoDark: logo(branding.logoDark), accent: branding.accentColour ?? '', sender: branding.senderDisplayName ?? '', label: branding.portalLabel ?? '' }
}

/** What the form would save (the domain's normalisation: trimmed names, `#rrggbb`; an accent that is not a colour stays null here). */
export function valuesOf(draft: BrandingDraft): BrandingValues {
  return {
    logoFileId: draft.logo?.fileId ?? null,
    logoDarkFileId: draft.logo ? (draft.logoDark?.fileId ?? null) : null,
    accentColour: normaliseAccent(draft.accent),
    senderDisplayName: cleanText(draft.sender),
    portalLabel: cleanText(draft.label),
  }
}

const savedValues = (branding: BrandingView): BrandingValues => ({
  logoFileId: branding.logo?.fileId ?? null,
  logoDarkFileId: branding.logoDark?.fileId ?? null,
  accentColour: branding.accentColour,
  senderDisplayName: branding.senderDisplayName,
  portalLabel: branding.portalLabel,
})

/** The fields the form changes against the saved branding (an accent that is not a colour yet counts as a change). */
export function changesOf(branding: BrandingView, draft: BrandingDraft | null): BrandingField[] {
  if (!draft) return []
  const fields = changedFields(savedValues(branding), valuesOf(draft))
  const accentTyped = cleanText(draft.accent)
  if (accentTyped !== null && normaliseAccent(accentTyped) === null && !fields.includes('accentColour')) return [...fields, 'accentColour']
  return fields
}

/** What is wrong with a field, as a message key of `admin-branding`; none: the field is fine. */
export interface DraftProblems {
  readonly accent?: string
  readonly sender?: string
  readonly label?: string
}

/** The form's problems, in the order the API checks them (factory-domain branding rules), before anything is sent. */
export function problemsOf(draft: BrandingDraft): DraftProblems {
  const problems: { accent?: string; sender?: string; label?: string } = {}
  const accent = cleanText(draft.accent)
  if (accent !== null && normaliseAccent(accent) === null) problems.accent = 'brand.field.accent.invalid'
  const sender = cleanText(draft.sender)
  if (sender !== null) {
    if ([...sender].length > SENDER_NAME_MAX) problems.sender = 'brand.field.sender.tooLong'
    else if (hasControlCharacters(sender)) problems.sender = 'brand.field.oneLine'
    else if (isHeaderUnsafe(sender)) problems.sender = 'brand.field.sender.unsafe'
  }
  const label = cleanText(draft.label)
  if (label !== null) {
    if ([...label].length > PORTAL_LABEL_MAX) problems.label = 'brand.field.label.tooLong'
    else if (hasControlCharacters(label)) problems.label = 'brand.field.oneLine'
  }
  return problems
}

/** The save's body: the whole branding as it should be, with the version read. */
export function bodyOf(branding: BrandingView, draft: BrandingDraft): BrandingBody {
  const values = valuesOf(draft)
  return {
    ...(branding.version !== null ? { version: branding.version } : {}),
    logoFileId: values.logoFileId,
    logoDarkFileId: values.logoDarkFileId,
    accentColour: cleanText(draft.accent),
    senderDisplayName: cleanText(draft.sender),
    portalLabel: cleanText(draft.label),
  }
}

/** Why Save waits (a message key), or null. */
export function saveHeld(model: Pick<BrandingSectionModel, 'uploading' | 'busy'>, branding: BrandingView, draft: BrandingDraft | null): string | null {
  if (!branding.mayChange) return 'brand.held.noRight'
  if (model.uploading) return 'brand.held.uploading'
  if (draft && Object.keys(problemsOf(draft)).length > 0) return 'brand.held.problems'
  return null
}

/** Why a logo cannot be picked now (a message key), or null. */
export function logoHeld(branding: BrandingView, draft: BrandingDraft, slot: LogoSlot, uploading: LogoSlot | null | undefined): string | null {
  if (!branding.mayChange) return 'brand.held.noRight'
  if (uploading) return 'brand.held.uploading'
  if (slot === 'logoDark' && !draft.logo) return 'brand.held.lightFirst'
  return null
}

/** A picked file the API would refuse, said before the upload (a message key), or null. */
export function pickProblem(file: { readonly type: string; readonly size: number }): string | null {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') return 'brand.logo.problem.type'
  if (file.size > LOGO_MAX_BYTES) return 'brand.logo.problem.size'
  return null
}

// ---- what partners see -----------------------------------------------------------------------------------------------------

/** The design system's tokens of the form as typed: what the portal and the link pages will draw. */
export function tokensOf(draft: BrandingDraft, companyName: string): BrandingTokens {
  return { name: cleanText(draft.label) ?? companyName, logoUrl: draft.logo?.src ?? null, logoDarkUrl: draft.logo ? (draft.logoDark?.src ?? null) : null, accent: normaliseAccent(draft.accent) }
}

/** The names partners see with the fallbacks: the portal's name and the name mail goes out under. */
export function shownOf(draft: BrandingDraft, companyName: string): { readonly portal: string; readonly sender: string } {
  return { portal: cleanText(draft.label) ?? companyName, sender: cleanText(draft.sender) ?? companyName }
}

/** What the accent does in one theme, in words: the role it takes and the weakest ratio that decided it. */
export interface ThemeUse {
  readonly theme: BrandTheme
  /** PRIMARY: main buttons, links and marks; ACCENT: lines and marks only; NONE: the standard colours; NOT_GIVEN: no colour. */
  readonly use: 'PRIMARY' | 'ACCENT' | 'NONE' | 'NOT_GIVEN'
  /** The weakest contrast measured against the page (`7.4`), null without a colour. */
  readonly ratio: number | null
}

const weakest = (verdict: BrandThemeVerdict, role: 'primary' | 'accent'): number | null => {
  const pairs = verdict.pairs.filter((pair) => (role === 'accent' ? pair.pair.startsWith('accent on') : !pair.pair.startsWith('accent on')))
  return pairs.length === 0 ? null : Math.min(...pairs.map((pair) => pair.ratio))
}

/** The accent's use in light and in dark (design system checkBranding), for the screen to say before it is saved. */
export function accentUses(accent: string, name: string): readonly ThemeUse[] {
  const check = checkBranding({ name: name || '-', accent: normaliseAccent(accent) })
  return (['light', 'dark'] as const).map((theme) => {
    const verdict = check[theme]
    if (!verdict.colour) return { theme, use: 'NOT_GIVEN', ratio: null }
    if (verdict.primary) return { theme, use: 'PRIMARY', ratio: weakest(verdict, 'primary') }
    if (verdict.accent) return { theme, use: 'ACCENT', ratio: weakest(verdict, 'primary') }
    return { theme, use: 'NONE', ratio: weakest(verdict, 'accent') }
  })
}

/** A ratio as the screen writes it (`7.4:1`), in the person's notation. */
export function ratioWords(ratio: number, locale: string): string {
  return `${new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(Math.floor(ratio * 10) / 10)}:1`
}

/** The company the section shows: the one in the address, else the session's, else the first ACTIVE one. */
export function companyFor(companies: readonly CompanyChoice[], asked: string | null, sessionCompanyId: string | null): string | null {
  const active = companies.filter((company) => company.status === 'ACTIVE')
  if (asked && companies.some((company) => company.id === asked)) return asked
  if (sessionCompanyId && active.some((company) => company.id === sessionCompanyId)) return sessionCompanyId
  return active[0]?.id ?? companies[0]?.id ?? null
}

/** The words of an API refusal on save or upload, as `admin` problem keys (the API's English is never shown). */
export const SAVED_NOTICE: BrandingNotice = { key: 'brand.done.saved', tone: 'success' }
