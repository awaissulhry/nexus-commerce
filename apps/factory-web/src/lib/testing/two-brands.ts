/**
 * B-TH-203 (threads plan TH-0, §0 the brand wall; Owner rule 2026-11-16: "One brand must not be able to see anything related to
 * any other brand. But we, as the production unit, should be able to see it all."): the two made-up customers every screen test
 * of a portal, link or record-thread view renders — Brand Alpha (brand A, whose data must never show to the other) and Brand
 * Beta (brand B, the reader). The SAME identities as the API's golden-flow helper
 * (apps/factory-api/src/golden-flow/portal/testing/two-brands.ts, B-TH-002): change both together. The screens add the numbers a
 * fixture needs (an order, a quote, a request, a file id), made up and of the same shape the API answers.
 *
 * A test renders Brand Beta's copy of a view and scans it with `scanText(rendered, BRAND_ALPHA)` (./brand-scan.ts): it must find
 * nothing. Every name, address and number is invented (`example.com`; no real company).
 */

export interface BrandFixture {
  readonly key: 'alpha' | 'beta'
  readonly legalName: string
  readonly tradeName: string
  readonly code: string
  /** The office's contact at the brand (orders and invoices). */
  readonly contact: { readonly name: string; readonly email: string }
  /** The brand's portal admin. */
  readonly portalPerson: { readonly name: string; readonly email: string }
  readonly address: { readonly line1: string; readonly postalCode: string; readonly city: string; readonly province?: string; readonly country: string }
  /** A file of the brand's (a tech pack, a size chart). */
  readonly fileName: string
  /** The brand's own purchase-order reference. */
  readonly customerRef: string
  /** Words the brand writes in its thread. */
  readonly message: string
  /** The screens' made-up record numbers of the brand (the office's series, as the API answers them). */
  readonly numbers: { readonly order: string; readonly quote: string; readonly request: string; readonly invoice: string; readonly style: string }
  /** The screens' made-up record ids of the brand (a file, an order, a thread). */
  readonly ids: { readonly order: string; readonly file: string; readonly thread: string }
}

export const BRAND_ALPHA: BrandFixture = Object.freeze({
  key: 'alpha',
  legalName: 'Brand Alpha S.r.l.',
  tradeName: 'Brand Alpha',
  code: 'BRAND-ALPHA',
  contact: { name: 'Alma Alfieri', email: 'alma.alfieri@brand-alpha.example' },
  portalPerson: { name: 'Anna Alfieri', email: 'anna.alfieri@brand-alpha.example' },
  address: { line1: 'Via Alfa 11', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
  fileName: 'Brand Alpha tech pack AX-100.pdf',
  customerRef: 'ALPHA-PO-0042',
  message: 'Alpha asks: keep the yellow piping on the collar of AX-100.',
  numbers: { order: 'SO-2026-0101', quote: 'Q-2026-0101', request: 'RQ-0101', invoice: 'FT-2026-0101', style: 'AX-100' },
  ids: { order: 'a1a1a1a1-0000-4000-8000-000000000101', file: 'a1a1a1a1-0000-4000-8000-000000000102', thread: 'a1a1a1a1-0000-4000-8000-000000000103' },
})

export const BRAND_BETA: BrandFixture = Object.freeze({
  key: 'beta',
  legalName: 'Brand Beta GmbH',
  tradeName: 'Brand Beta',
  code: 'BRAND-BETA',
  contact: { name: 'Bruno Becker', email: 'bruno.becker@brand-beta.example' },
  portalPerson: { name: 'Berta Becker', email: 'berta.becker@brand-beta.example' },
  address: { line1: 'Betastrasse 22', postalCode: '10115', city: 'Berlin', country: 'DE' },
  fileName: 'Brand Beta size chart BX-200.pdf',
  customerRef: 'BETA-PO-0077',
  message: 'Beta asks: the size chart BX-200 is the new one.',
  numbers: { order: 'SO-2026-0202', quote: 'Q-2026-0202', request: 'RQ-0202', invoice: 'FT-2026-0202', style: 'BX-200' },
  ids: { order: 'b2b2b2b2-0000-4000-8000-000000000201', file: 'b2b2b2b2-0000-4000-8000-000000000202', thread: 'b2b2b2b2-0000-4000-8000-000000000203' },
})

export const TWO_BRANDS = Object.freeze({ alpha: BRAND_ALPHA, beta: BRAND_BETA })

/** The other brand of the two: what a view rendered for `reader` must never show. */
export const otherBrandOf = (reader: BrandFixture): BrandFixture => (reader.key === 'alpha' ? BRAND_BETA : BRAND_ALPHA)
