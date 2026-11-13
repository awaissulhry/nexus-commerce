import { AREAS } from '../model'

/**
 * The area a search result is listed under (B-W2b-382; follow-up XF7:03, B-W2b-361's gap): the area of the page it opens,
 * so the Area column says where the person lands — a product-safety report (indexed under `sales`, B-W2b-351) opens
 * Compliance › PPE register & recalls and says Compliance. A result that opens no page of an area (its record panels,
 * `/records/…`) keeps the area its indexer gave. `href` is the result's address (`/w/<company>/<area>/…`). PURE.
 */
export function areaOfResult(href: string, indexed: string): string {
  const [, w, , area] = href.split(/[/?#]/)
  return w === 'w' && area && AREAS.has(area) ? area : indexed
}
