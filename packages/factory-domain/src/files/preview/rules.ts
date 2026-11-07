/**
 * In-browser preview (COL-047; B-W2b-160), pure: which files open in the browser and how the link says so. Pictures a
 * browser shows everywhere (JPEG, PNG, WebP) and PDFs open in place through a 60-second link served `inline`; every other
 * kind (HEIC, office documents, CSV, XML, audio, patterns) is downloaded as an attachment, as before. Nothing a browser
 * would run as a page is ever stored (the kinds' types in platform/files/rules.ts), so an inline answer is a picture or a
 * PDF only.
 */

export const PREVIEW_URL_SECONDS = 60

/** The types a browser shows in place. */
export const INLINE_TYPES: readonly string[] = Object.freeze(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])

export type PreviewMode = 'inline' | 'download'

const normalised = (contentType: string): string => contentType.split(';')[0]!.trim().toLowerCase()

/** inline for a picture or a PDF, download for anything else. */
export const previewModeOf = (contentType: string): PreviewMode => (INLINE_TYPES.includes(normalised(contentType)) ? 'inline' : 'download')

/** `Content-Disposition` for a link: inline or attachment, with an ASCII fallback and the UTF-8 name (RFC 6266). */
export function dispositionOf(mode: PreviewMode, fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${mode === 'inline' ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
