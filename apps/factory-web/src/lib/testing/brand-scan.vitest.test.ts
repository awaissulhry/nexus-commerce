import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { brandMarkers, scanText } from './brand-scan'
import { BRAND_ALPHA, BRAND_BETA, otherBrandOf, TWO_BRANDS } from './two-brands'

/** B-TH-203: the brand wall's name scan for screens finds every planted marker of the other brand and never the reader's own. */

/** A made-up rendering of Brand Beta's own view, as a portal page shows it. */
const betaView = [
  `Orders of ${BRAND_BETA.tradeName} (${BRAND_BETA.code})`,
  `Order ${BRAND_BETA.numbers.order} — your reference ${BRAND_BETA.customerRef}`,
  `Delivery: ${BRAND_BETA.address.line1}, ${BRAND_BETA.address.postalCode} ${BRAND_BETA.address.city}`,
  `Files: ${BRAND_BETA.fileName}`,
  `Messages: ${BRAND_BETA.portalPerson.name} <${BRAND_BETA.portalPerson.email}> wrote: ${BRAND_BETA.message}`,
].join('\n')

describe('scanText (B-TH-203)', () => {
  it('finds nothing of Brand Alpha in Brand Beta’s own view, and ignores the reader’s own brand', () => {
    expect(scanText(betaView, BRAND_ALPHA)).toEqual([])
    expect(scanText(betaView, BRAND_BETA).length).toBeGreaterThan(5)
  })

  it('finds a planted name, code, number, file name and address of Brand Alpha, in any case and across a wrapped line', () => {
    const planted = (text: string) => scanText(`${betaView}\n${text}`, BRAND_ALPHA)
    expect(planted('Also ordered by brand ALPHA this week.')).toEqual(['trade name: Brand Alpha'])
    expect(planted(`Code ${BRAND_ALPHA.code.toLowerCase()}`)).toEqual([`code: ${BRAND_ALPHA.code}`])
    expect(planted(`See ${BRAND_ALPHA.numbers.order}.`)).toEqual([`order number: ${BRAND_ALPHA.numbers.order}`])
    expect(planted(`Attached: ${BRAND_ALPHA.fileName}`)).toContain(`file name: ${BRAND_ALPHA.fileName}`)
    // The address's domain is the brand's code as well: both are said.
    expect(planted(`Write to ${BRAND_ALPHA.contact.email}`)).toEqual([`code: ${BRAND_ALPHA.code}`, `contact address: ${BRAND_ALPHA.contact.email}`])
    expect(planted(`Ship to Via   Alfa\n11`)).toEqual([`address line: ${BRAND_ALPHA.address.line1}`])
    expect(planted(`Brand\nAlpha S.r.l.`)).toEqual(expect.arrayContaining([`legal name: ${BRAND_ALPHA.legalName}`]))
    expect(planted(`file ${BRAND_ALPHA.ids.file}`)).toEqual([`file id: ${BRAND_ALPHA.ids.file}`])
  })

  it('counts a marker only as a whole token: a longer number or word that contains it is not a match', () => {
    expect(scanText(`${BRAND_ALPHA.numbers.order}9 and XBRAND-ALPHA and brand-alphanumeric`, BRAND_ALPHA)).toEqual([])
  })

  it('lists every marker of a brand once, and knows the other brand of each', () => {
    const markers = brandMarkers(BRAND_ALPHA)
    expect(new Set(markers.map((marker) => marker.text.toLowerCase())).size).toBe(markers.length)
    expect(markers.length).toBeGreaterThanOrEqual(16)
    expect(otherBrandOf(BRAND_BETA)).toBe(BRAND_ALPHA)
    expect(otherBrandOf(BRAND_ALPHA)).toBe(BRAND_BETA)
    expect(Object.keys(TWO_BRANDS)).toEqual(['alpha', 'beta'])
  })

  it('holds the same identities as the API’s golden-flow two-brands helper (B-TH-002): change both together', () => {
    const api = readFileSync(fileURLToPath(new URL('../../../../factory-api/src/golden-flow/portal/testing/two-brands.ts', import.meta.url)), 'utf8')
    for (const brand of [BRAND_ALPHA, BRAND_BETA]) {
      for (const text of [brand.legalName, brand.tradeName, brand.code, brand.contact.name, brand.contact.email, brand.portalPerson.name, brand.portalPerson.email, brand.address.line1, brand.address.postalCode, brand.address.city, brand.fileName, brand.customerRef, brand.message]) {
        expect(api, `${brand.key}: ${text}`).toContain(`'${text}'`)
      }
    }
  })
})
