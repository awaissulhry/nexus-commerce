/**
 * Phase 5.4: programmatically generate the GTIN-exemption brand
 * letter as both plain text and PDF. Amazon's review team has loose
 * but real format expectations: company letterhead, dated, signed,
 * states the brand owner relationship and that products carry the
 * brand exclusively.
 *
 * The plain-text version is stored on GtinExemptionApplication.brand
 * Letter so the user can edit it freely; the PDF is rendered on
 * demand whenever the package is downloaded — no Cloudinary upload
 * round-trip needed.
 */

import PDFDocument from 'pdfkit'

export interface BrandLetterParams {
  brandName: string
  ownerName: string
  ownerTitle?: string
  companyName?: string
  companyAddress?: string
  date?: Date
  trademarkNumber?: string
  trademarkCountry?: string
  productLines: Array<{
    sku: string
    name: string
  }>
  marketplace: string
}

const MARKETPLACE_AMAZON_ADDRESSES: Record<string, string> = {
  IT: 'Amazon EU S.à r.l., Italian Branch\nViale Monte Grappa 3/5\n20124 Milan, Italy',
  DE: 'Amazon EU S.à r.l., German Branch\nMarcel-Breuer-Straße 12\n80807 Munich, Germany',
  FR: 'Amazon EU S.à r.l., French Branch\n67 Boulevard du Général Leclerc\n92110 Clichy, France',
  ES: 'Amazon EU S.à r.l., Spanish Branch\nRamírez de Prado 5\n28045 Madrid, Spain',
  UK: 'Amazon UK Services Ltd.\n1 Principal Place, Worship Street\nLondon EC2A 2FA, United Kingdom',
  US: 'Amazon Services LLC\n410 Terry Avenue North\nSeattle, WA 98109-5210, USA',
}

function amazonAddressFor(marketplace: string): string {
  return (
    MARKETPLACE_AMAZON_ADDRESSES[marketplace.toUpperCase()] ??
    'Amazon Services Europe S.à r.l.\n38 avenue John F. Kennedy\nL-1855 Luxembourg'
  )
}

/**
 * Build the canonical brand letter text. Designed to read like a
 * normal business letter (Amazon's review team prefers natural
 * prose) while hitting the four claims they look for:
 *  1. owner of the brand
 *  2. brand applied permanently to products + packaging
 *  3. these specific products are covered
 *  4. no GTIN exists / will be assigned
 */
export function generateBrandLetterText(params: BrandLetterParams): string {
  const date = (params.date ?? new Date()).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const company = params.companyName ?? params.brandName
  const trademarkLine = params.trademarkNumber
    ? `Our brand is registered as trademark number ${params.trademarkNumber}${
        params.trademarkCountry ? ` (${params.trademarkCountry})` : ''
      }.`
    : ''

  const productList = params.productLines
    .map((p) => `  • ${p.sku} — ${p.name}`)
    .join('\n')

  const lines = [
    date,
    '',
    amazonAddressFor(params.marketplace),
    '',
    `Re: GTIN exemption request for ${params.brandName}`,
    '',
    'To Whom It May Concern,',
    '',
    `I, ${params.ownerName}${
      params.ownerTitle ? `, ${params.ownerTitle}` : ''
    }, write on behalf of ${company} regarding the brand "${params.brandName}".`,
    '',
    `${company} is the legal owner of the ${params.brandName} brand. ` +
      'The brand name is permanently affixed to all products manufactured ' +
      'under it, on both the products themselves and their packaging. ' +
      trademarkLine,
    '',
    `Because we manufacture these products exclusively under our own brand ` +
      'and do not assign or license GTIN, UPC, or EAN codes for them, we ' +
      'request a GTIN exemption to list them on Amazon.',
    '',
    'The exemption request covers the following products:',
    '',
    productList,
    '',
    `We confirm that no third party manufactures or distributes these ` +
      `products outside of ${company}, and that we hold the rights to use ` +
      `the ${params.brandName} brand on Amazon.`,
    '',
    'Please contact me at the address above if any further information is ' +
      'required.',
    '',
    'Sincerely,',
    '',
    '',
    params.ownerName,
    params.ownerTitle ?? `Owner, ${company}`,
    company,
    params.companyAddress ?? '',
  ]

  return lines.filter((l) => l !== undefined).join('\n')
}

/**
 * Render the (possibly-customised) letter text to a PDF buffer. The
 * PDF is one page on letter-size with a 50pt margin and a single
 * column of justified text — matches the format Amazon's review team
 * is used to seeing.
 */
export function renderBrandLetterPdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        info: {
          Title: 'GTIN Exemption Brand Letter',
          Creator: 'Nexus Commerce',
          Producer: 'Nexus Commerce',
        },
      })
      const chunks: Buffer[] = []
      doc.on('data', (c: Buffer) => chunks.push(c))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      doc.fontSize(11).font('Times-Roman')
      // Render the body. pdfkit handles word-wrapping inside
      // boundary; explicit \n in the source becomes a paragraph break.
      doc.text(text, {
        align: 'left',
        lineGap: 4,
      })
      doc.end()
    } catch (err) {
      reject(err)
    }
  })
}
