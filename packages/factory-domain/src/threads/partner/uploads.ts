import { isDesignType, designKindsOf } from '../../files/design'
import { partnerLocaleOf } from './rules'

/**
 * B-TH-085 (threads plan TH-7, the rest of G1; features T6-F01…F08, P-CUS-NEW.files, X-P-CUS-REQ.thread): a customer attaches files
 * from its portal — after Send on its own request ("New order" as an e-mail: the request is made, then its files go up), and from
 * the thread composer of any record of its own. Pure: apps/factory-api's platform/threads/partner and modules/sales/portal-requests
 * apply these rules; the files module holds the types and sizes (KIND_RULES), the database the wall (a file shared outside reaches
 * its record's own party only, a measurement sheet never a floor).
 *
 *   - which kind a file goes up as: a picture is a PHOTO (15 MiB), a ZIP a DOCUMENT (download-only), anything else an ATTACHMENT
 *     (25 MiB; PDFs, office documents, Illustrator / EPS / Photoshop download-only); an SVG, HTML or script never (the files
 *     module's words name the way out: "send a PDF or PNG");
 *   - "This is a measurement sheet": the tick files it as MEASUREMENTS (body data: in the office only holders of
 *     sales.measurements.view open it);
 *   - each upload is shared with the party (OFFICE, PARTNER) and waits for the virus scan before anyone outside the office sees it;
 *     outside uploads stay closed on staging and production until the scanner runs (the files module's sentence, GATE-SPEND);
 *   - at most PORTAL_FILES_PER_RECORD of the party's own uploads on one record.
 */

/** The most files a party uploads from its portal onto one record (its own uploads; the office's shares are not counted). */
export const PORTAL_FILES_PER_RECORD = 50

/** The kind a file the portal sends is filed as, from its content type (already normalised: `image/jpeg`). */
export function portalFileKindOf(contentType: string): 'PHOTO' | 'DOCUMENT' | 'ATTACHMENT' {
  if (contentType.startsWith('image/') && !isDesignType(contentType)) return 'PHOTO'
  if (isDesignType(contentType) && !designKindsOf(contentType).includes('ATTACHMENT')) return 'DOCUMENT'
  return 'ATTACHMENT'
}

export const PORTAL_UPLOAD_REFUSALS = ['NO_UPLOAD', 'TOO_MANY_FILES', 'REQUEST_CLOSED'] as const
export type PortalUploadRefusal = (typeof PORTAL_UPLOAD_REFUSALS)[number]

/** The portal's words for a refused upload, in Italian and English (`{max}`: PORTAL_FILES_PER_RECORD). Never naming another customer. */
export const PORTAL_UPLOAD_WORDS = Object.freeze({
  NO_UPLOAD: {
    it: 'Il vostro accesso non permette di inviare file. Il vostro amministratore può cambiarlo.',
    en: 'Your access does not let you send files. Your admin can change that.',
  },
  TOO_MANY_FILES: {
    it: 'Qui ci sono già {max} vostri file: scriveteci nei messaggi per il resto.',
    en: 'This already holds {max} of your files: write to us in the messages for the rest.',
  },
  REQUEST_CLOSED: {
    it: 'Questa richiesta è chiusa: aggiungete i file nei messaggi qui sotto.',
    en: 'This request is closed: add your files in the messages below.',
  },
} satisfies Record<PortalUploadRefusal, { readonly it: string; readonly en: string }>)

/** One of the words in the person's language. */
export function portalUploadWords(word: PortalUploadRefusal, locale: string | null | undefined): string {
  return PORTAL_UPLOAD_WORDS[word][partnerLocaleOf(locale)].replaceAll('{max}', String(PORTAL_FILES_PER_RECORD))
}
