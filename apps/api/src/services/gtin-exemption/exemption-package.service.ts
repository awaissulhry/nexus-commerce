/**
 * Phase 5.4: build the downloadable submission ZIP. We never persist
 * the ZIP itself — it's regenerated on every download from the stored
 * brand letter text + image URLs + form data, so updates to any of
 * those flow through immediately.
 */

import JSZip from 'jszip'
import {
  generateBrandLetterText,
  renderBrandLetterPdf,
  type BrandLetterParams,
} from './brand-letter.service.js'

export interface PackageInputs {
  applicationId: string
  brandName: string
  marketplace: string
  brandRegistrationType: string
  trademarkNumber?: string | null
  trademarkCountry?: string | null
  trademarkDate?: Date | null
  brandWebsite?: string | null
  imageUrls: string[]
  ownerName: string
  ownerTitle?: string
  companyName?: string
  companyAddress?: string
  productLines: BrandLetterParams['productLines']
  /** When the user has customised the letter, we render that text
   *  rather than regenerating from the template. */
  brandLetterOverride?: string
}

const SELLER_CENTRAL_HOSTS: Record<string, string> = {
  IT: 'sellercentral.amazon.it',
  DE: 'sellercentral.amazon.de',
  FR: 'sellercentral.amazon.fr',
  ES: 'sellercentral.amazon.es',
  UK: 'sellercentral.amazon.co.uk',
  US: 'sellercentral.amazon.com',
}

function sellerCentralUrl(marketplace: string): string {
  const host =
    SELLER_CENTRAL_HOSTS[marketplace.toUpperCase()] ??
    'sellercentral.amazon.com'
  return `https://${host}/`
}

function instructionsMarkdown(p: PackageInputs): string {
  const dateLine = p.trademarkDate
    ? `   Registration Date: ${p.trademarkDate.toISOString().slice(0, 10)}`
    : ''
  const trademarkBlock = p.trademarkNumber
    ? [
        `   Trademark Number: ${p.trademarkNumber}`,
        p.trademarkCountry
          ? `   Country of Registration: ${p.trademarkCountry}`
          : '',
        dateLine,
      ]
        .filter(Boolean)
        .join('\n')
    : '   (No trademark — submitting via brand-stand-in / website-only path)'

  const websiteBlock = p.brandWebsite
    ? `\n   Brand Website: ${p.brandWebsite}`
    : ''

  return `# GTIN Exemption Submission Instructions

## Brand: ${p.brandName}
## Marketplace: Amazon ${p.marketplace}
## Application ID: ${p.applicationId}

---

## What's in this package

- \`brand-letter.pdf\` — signed brand letter in Amazon's expected format
- \`image-XX.<ext>\` — the validated product images (one file per image)
- \`instructions.md\` — this file

---

## Steps to submit (5–10 minutes)

1. Open Amazon Seller Central:
   ${sellerCentralUrl(p.marketplace)}

2. Navigate to:
   **Catalog → Add Products → "Don't have a product ID?" → Apply for GTIN exemption**

3. Fill the form with these values (copy / paste each):

   Brand Name: **${p.brandName}**
${trademarkBlock}${websiteBlock}

4. When prompted for documents, upload from this package:
   - \`brand-letter.pdf\` (the brand letter we generated)
${
  p.brandRegistrationType === 'TRADEMARK'
    ? `   - Your trademark certificate (PDF you have on file separately)\n`
    : ''
}   - All ${p.imageUrls.length} image files (\`image-01\` through \`image-${String(
    p.imageUrls.length,
  ).padStart(2, '0')}\`)

5. Submit. Note the **case ID** Amazon shows you on the next screen.

---

## After submitting

Return to Nexus and click **"Mark as submitted"** on this application
— optionally paste the Amazon case ID. We'll cache the approval the
moment you confirm Amazon's email response so every future ${p.brandName}
listing on Amazon ${p.marketplace} skips this step entirely.

## If Amazon rejects

Click **"Mark as rejected"** and paste the reason from Amazon's email.
We'll regenerate the package with the issue addressed and you can
re-submit through Seller Central.

## Common things Amazon checks for

- Brand name clearly visible on **product** in at least 3 images
- Brand name clearly visible on **packaging** in at least 1 image
- White background on the main image
- No competitor brands or distracting elements in any image
- Brand letter on company letterhead, dated, signed (this PDF qualifies)
- Trademark certificate **must be currently valid** (if used)
`
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`)
  }
  const ab = await res.arrayBuffer()
  return Buffer.from(ab)
}

function extOfUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.toLowerCase()
    const e = path.split('.').pop() ?? 'jpg'
    return (e.split('?')[0] || 'jpg').slice(0, 4)
  } catch {
    return 'jpg'
  }
}

export async function buildPackageZip(inputs: PackageInputs): Promise<Buffer> {
  const zip = new JSZip()

  // 1. Brand letter PDF (regenerated each time so customisations
  //    flow through immediately).
  const letterText =
    inputs.brandLetterOverride ??
    generateBrandLetterText({
      brandName: inputs.brandName,
      ownerName: inputs.ownerName,
      ownerTitle: inputs.ownerTitle,
      companyName: inputs.companyName,
      companyAddress: inputs.companyAddress,
      trademarkNumber: inputs.trademarkNumber ?? undefined,
      trademarkCountry: inputs.trademarkCountry ?? undefined,
      productLines: inputs.productLines,
      marketplace: inputs.marketplace,
    })
  const letterPdf = await renderBrandLetterPdf(letterText)
  zip.file('brand-letter.pdf', letterPdf)
  // Also include the editable text version so the user can tweak +
  // re-render if they want to take it out of band.
  zip.file('brand-letter.txt', letterText)

  // 2. Images — fetched in parallel. Failures don't abort the whole
  //    package; the user gets whichever images we could grab + a
  //    note in the package.
  const imagesNote: string[] = []
  await Promise.all(
    inputs.imageUrls.map(async (url, idx) => {
      const num = String(idx + 1).padStart(2, '0')
      try {
        const bytes = await fetchBytes(url)
        const ext = extOfUrl(url)
        zip.file(`image-${num}.${ext}`, bytes)
      } catch (err: any) {
        imagesNote.push(
          `image-${num}: failed to fetch (${err?.message ?? String(err)}) — original URL ${url}`,
        )
      }
    }),
  )
  if (imagesNote.length > 0) {
    zip.file('IMAGE-FETCH-ERRORS.txt', imagesNote.join('\n'))
  }

  // 3. Instructions.
  zip.file('instructions.md', instructionsMarkdown(inputs))

  return zip.generateAsync({ type: 'nodebuffer' })
}
