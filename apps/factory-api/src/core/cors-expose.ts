import { REQUEST_ID_HEADER } from './ids'

/**
 * The answer headers a web page may read (B-W2b-383; follow-up XF8:05). A browser hands a cross-origin page only the
 * CORS-safelisted answer headers unless `Access-Control-Expose-Headers` names the others; core/security.ts sends this
 * list to the web origin. A route that answers a header of its own for the web names it here, by this constant, so the
 * name is written once.
 *
 *   x-request-id      every answer: the id a problem report quotes (core/ids.ts)
 *   x-labels-refused  POST /inventory/locations/labels/pdf: how many of the asked places got no label (archived, a kind
 *                     that carries none), beside the PDF's bytes (modules/inventory/locations-depth/routes.ts)
 */

export const LABELS_REFUSED_HEADER = 'x-labels-refused'

export const EXPOSED_HEADERS: readonly string[] = Object.freeze([REQUEST_ID_HEADER, LABELS_REFUSED_HEADER])
