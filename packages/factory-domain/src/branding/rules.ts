import type { Issue } from '../core/errors'

/**
 * Company branding (B-W2b-161; PLT-228, SAL-064; design admin.documents › Branding, portal.signin › brand head,
 * links.frame › sender head), pure. A company may give its logo (and a logo for dark pages), an accent colour, the name its
 * mail to partners is sent under and the name its portal calls itself (factory-db CompanyBranding, one row per company,
 * its id the company's). What is not given falls back: the company's trade name, else its legal name; the design
 * system's colours.
 *
 * The accent is stored as given (normalised to `#rrggbb`); the design system decides where it may go
 * (packages/ui tokens/branding.ts checkBranding: the main action only where it clears 7:1 in that theme, decoration where
 * it clears 3:1), so a colour that fails is simply not used there, and the office screen says so before it is saved.
 * Logos are PNG or JPEG pictures of the company (the documents' PDF can draw only those; an SVG served from our address
 * could carry a script), at most 1 MiB, checked by their first bytes as well as their declared type.
 */

/** The fields of a company's branding, as the event and the audit name them. */
export const BRANDING_FIELDS = ['logo', 'logoDark', 'accentColour', 'senderDisplayName', 'portalLabel'] as const
export type BrandingField = (typeof BRANDING_FIELDS)[number]

/** The record type of a logo's StoredFile (its record id is the company's id): uploaded only through the branding routes. */
export const BRANDING_RECORD_TYPE = 'CompanyBranding'
/** A logo is a picture: StoredFile kind PHOTO (the database refuses any other kind or another company's file). */
export const LOGO_FILE_KIND = 'PHOTO'
export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number]
/** 1 MiB: a logo, not a photo (it is read into every PDF the company prints and served on every portal page). */
export const LOGO_MAX_BYTES = 1024 * 1024

/** The database's bounds (CompanyBranding guard): the sender name goes into a mail header. */
export const SENDER_NAME_MAX = 80
export const PORTAL_LABEL_MAX = 60

/** What a company's branding holds (null: not given). */
export interface BrandingValues {
  readonly logoFileId: string | null
  readonly logoDarkFileId: string | null
  /** `#rrggbb`, lower case. */
  readonly accentColour: string | null
  readonly senderDisplayName: string | null
  readonly portalLabel: string | null
}

export const NO_BRANDING: BrandingValues = Object.freeze({ logoFileId: null, logoDarkFileId: null, accentColour: null, senderDisplayName: null, portalLabel: null })

/** `#rrggbb` (lower case) for `#rgb` / `#rrggbb` in any case, spaces around allowed; null for anything else. */
export function normaliseAccent(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`
  return null
}

/** A typed text as stored: trimmed, inner runs of spaces kept; empty means not given. */
export function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v === '' ? null : v
}

// C0 and C1 control characters, DEL, the line and paragraph separators and the bidirectional controls: none of them
// belongs in a name a page or a mail header shows.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/
// A mail header's display name: no angle brackets (the database's rule), and no quotes or backslashes (the From line
// would change them into spaces, so the mail would not say what was typed).
const HEADER_UNSAFE = /[<>"\\]/

/** A text holds a control character, a line or paragraph separator or a bidirectional control. */
export const hasControlCharacters = (text: string): boolean => CONTROL.test(text)
/** A sender name holds what a mail's From line cannot show as typed (angle brackets, quotes, backslashes). */
export const isHeaderUnsafe = (text: string): boolean => HEADER_UNSAFE.test(text)

/** What a save sends, as typed. */
export interface BrandingInput {
  readonly logoFileId: string | null
  readonly logoDarkFileId: string | null
  readonly accentColour: string | null
  readonly senderDisplayName: string | null
  readonly portalLabel: string | null
}

/** The values a save stores (normalised) and what is wrong with it, by the body's paths. */
export function brandingOf(input: BrandingInput): { readonly values: BrandingValues; readonly problems: Issue[] } {
  const problems: Issue[] = []
  const accentGiven = cleanText(input.accentColour)
  const accentColour = normaliseAccent(accentGiven)
  if (accentGiven !== null && accentColour === null) problems.push({ path: 'body/accentColour', message: 'A colour as #rrggbb (or #rgb), for example #1f5fa8.' })
  const senderDisplayName = cleanText(input.senderDisplayName)
  if (senderDisplayName !== null) {
    if ([...senderDisplayName].length > SENDER_NAME_MAX) problems.push({ path: 'body/senderDisplayName', message: `At most ${SENDER_NAME_MAX} characters.` })
    if (CONTROL.test(senderDisplayName)) problems.push({ path: 'body/senderDisplayName', message: 'One line, without control characters.' })
    if (HEADER_UNSAFE.test(senderDisplayName)) problems.push({ path: 'body/senderDisplayName', message: 'No angle brackets, quotes or backslashes: the name goes into the From line of a mail.' })
  }
  const portalLabel = cleanText(input.portalLabel)
  if (portalLabel !== null) {
    if ([...portalLabel].length > PORTAL_LABEL_MAX) problems.push({ path: 'body/portalLabel', message: `At most ${PORTAL_LABEL_MAX} characters.` })
    if (CONTROL.test(portalLabel)) problems.push({ path: 'body/portalLabel', message: 'One line, without control characters.' })
  }
  if (input.logoDarkFileId !== null && input.logoFileId === null) problems.push({ path: 'body/logoDarkFileId', message: 'A logo for dark pages goes beside a logo for light ones: give that one first.' })
  if (input.logoDarkFileId !== null && input.logoDarkFileId === input.logoFileId) problems.push({ path: 'body/logoDarkFileId', message: 'The logo for dark pages is another picture (leave it out to use the same one).' })
  return { values: { logoFileId: input.logoFileId, logoDarkFileId: input.logoDarkFileId, accentColour, senderDisplayName, portalLabel }, problems }
}

/** The fields that differ between two brandings, in BRANDING_FIELDS order. */
export function changedFields(before: BrandingValues, after: BrandingValues): BrandingField[] {
  const pairs: Record<BrandingField, readonly [unknown, unknown]> = {
    logo: [before.logoFileId, after.logoFileId],
    logoDark: [before.logoDarkFileId, after.logoDarkFileId],
    accentColour: [before.accentColour, after.accentColour],
    senderDisplayName: [before.senderDisplayName, after.senderDisplayName],
    portalLabel: [before.portalLabel, after.portalLabel],
  }
  return BRANDING_FIELDS.filter((field) => pairs[field][0] !== pairs[field][1])
}

/** A picture's type by its first bytes (PNG's signature, JPEG's SOI marker); null for anything else. */
export function logoTypeOf(bytes: Uint8Array): LogoContentType | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  return null
}

/**
 * A PNG's or JPEG's size in pixels from its header (PNG: the IHDR chunk; JPEG: the first start-of-frame marker), for the
 * PDF to keep the logo's proportions; null when the bytes do not say.
 */
export function imageSizeOf(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  const type = logoTypeOf(bytes)
  const u16 = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!
  const u32 = (at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!
  if (type === 'image/png') {
    if (bytes.length < 24 || String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return null
    const width = u32(16)
    const height = u32(20)
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (type === 'image/jpeg') {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1]!
      if (marker === 0xff) {
        at += 1
        continue
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = u16(at + 5)
        const width = u16(at + 7)
        return width > 0 && height > 0 ? { width, height } : null
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2
        continue
      }
      at += 2 + u16(at + 2)
    }
  }
  return null
}

/** What is wrong with a logo announced for upload, by the body's paths. */
export function logoUploadProblems(input: { readonly contentType: string; readonly sizeBytes: number }): Issue[] {
  const problems: Issue[] = []
  const type = input.contentType.split(';')[0]!.trim().toLowerCase()
  if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(type)) problems.push({ path: 'body/contentType', message: 'A logo is a PNG or JPEG picture.' })
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > LOGO_MAX_BYTES) problems.push({ path: 'body/sizeBytes', message: 'A logo holds 1 byte to 1 MiB.' })
  return problems
}

/** The company's own names, as the fallbacks need them. */
export interface CompanyNames {
  readonly legalName: string
  readonly tradeName?: string | null
}

/** The company's name as partners know it: its trade name, else its legal name. */
export const companyNameOf = (company: CompanyNames): string => cleanText(company.tradeName) ?? company.legalName.trim()

/** What partners see: the portal's name and the name mail is sent under, each with the company's name as fallback. */
export function shownNames(company: CompanyNames, branding: Pick<BrandingValues, 'senderDisplayName' | 'portalLabel'> | null): { readonly portal: string; readonly sender: string } {
  const name = companyNameOf(company)
  return { portal: branding?.portalLabel ?? name, sender: branding?.senderDisplayName ?? name }
}

/**
 * The public address of a company's logo (apps/factory-api `GET /branding/public/:companyId/logo/:fileId`): served to
 * anyone while it is the company's logo or logo for dark pages, never another file. A stored file never changes, so the
 * address may be cached for good.
 */
export const publicLogoPath = (companyId: string, fileId: string): string => `/branding/public/${companyId}/logo/${fileId}`
