/**
 * B-TH-084 (threads plan TH-7, gap G12; schema wave 6/9, B-TH-082): design files and the types never stored, pure — shared by
 * apps/factory-api's files rules (platform/files/rules.ts) and the factory web's upload checks, so both say the same as the
 * database (`…_files_measurements_th_guards`: `factory_files_is_design_type`, `factory_files_is_page_type`).
 *
 *   design files   Illustrator, EPS and PostScript, Photoshop and ZIP, with the aliases browsers and tools announce: accepted
 *                  DOWNLOAD-ONLY — an attachment or a document (a ZIP a document only, T6-F05), never a photo, never previewed
 *                  (no inline link, no small preview, no stripped copy), scanned like every file
 *   page types     HTML, XHTML, SVG and JavaScript: a browser runs or renders them as a page, so no file of these types is
 *                  ever stored; the refusal names the way out ("send a PDF or PNG")
 *
 * Types are compared as the files platform does: lower case, without parameters.
 */

const typeOf = (contentType: string): string => contentType.split(';')[0]!.trim().toLowerCase()

/** Illustrator, EPS / PostScript, Photoshop and ZIP: the database's `factory_files_is_design_type` list, word for word. */
export const DESIGN_TYPES: readonly string[] = Object.freeze([
  'application/postscript',
  'application/eps',
  'application/x-eps',
  'image/eps',
  'image/x-eps',
  'application/illustrator',
  'application/vnd.adobe.illustrator',
  'image/vnd.adobe.photoshop',
  'application/vnd.adobe.photoshop',
  'application/photoshop',
  'application/x-photoshop',
  'image/photoshop',
  'image/x-photoshop',
  'image/psd',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
])

/** HTML, XHTML, SVG and JavaScript: the database's `factory_files_is_page_type` list, word for word. */
export const PAGE_TYPES: readonly string[] = Object.freeze([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
])

/** A ZIP's types: a ZIP is filed as a DOCUMENT only (T6-F05; B-W2b-278's evidence pack ZIP is one too). */
export const ZIP_TYPES: readonly string[] = Object.freeze(['application/zip', 'application/x-zip-compressed', 'application/x-zip'])

/** Illustrator, EPS and Photoshop: an attachment or a document. */
export const ARTWORK_TYPES: readonly string[] = Object.freeze(DESIGN_TYPES.filter((type) => !ZIP_TYPES.includes(type)))

/** The type a file name says when the browser says none (a design file often comes without one). */
export const DESIGN_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ai: 'application/illustrator',
  eps: 'application/postscript',
  ps: 'application/postscript',
  psd: 'image/vnd.adobe.photoshop',
  zip: 'application/zip',
})

/** A design file: download-only. */
export const isDesignType = (contentType: string): boolean => DESIGN_TYPES.includes(typeOf(contentType))

/** A type a browser runs or renders as a page: never stored. */
export const isPageType = (contentType: string): boolean => PAGE_TYPES.includes(typeOf(contentType))

/** The kinds a design file may be filed as (the database's rule): never a PHOTO, a certificate, an archive or a voice note. */
export const DESIGN_KINDS = Object.freeze(['ATTACHMENT', 'DOCUMENT'] as const)

/** The kinds this design file may be filed as: a ZIP a DOCUMENT only, Illustrator, EPS and Photoshop either. */
export const designKindsOf = (contentType: string): readonly string[] => (ZIP_TYPES.includes(typeOf(contentType)) ? ['DOCUMENT'] : DESIGN_KINDS)
