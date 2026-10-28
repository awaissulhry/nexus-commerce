/**
 * SKUs and barcodes of the colour x size matrix (features PRD-005, PRD-047), pure.
 *
 * SKU: one per colourway and size, built by the tenant's pattern from the three codes. The pattern is deterministic: the
 * same codes always give the same SKU, and a SKU never changes once made (its codes never change once used: ./rules,
 * ./colourways, ../sizes/rules). The default, `<style>-<colourway>-<size>` ("GT-JKT-01-BLK-52"), is unique by
 * construction: the style code is unique in the tenant, the colourway code in the style and the size code in the
 * scale, and neither a colourway nor a size code holds the separator, so a SKU reads back into exactly one triple from
 * the right. The API still checks every new SKU against the tenant's (a SKU typed by another route, a later pattern).
 * Tenant patterns are one value of SkuPattern; until a tenant setting holds one, every tenant uses DEFAULT_SKU_PATTERN.
 *
 * GTIN (the barcode, EAN-13 in Italy): optional per SKU; GTIN-8, -12 (UPC-A), -13 or -14, its GS1 check digit right.
 * It is stored in one canonical form, so one trade item can never hold two rows by being typed two ways: a GTIN-12 or a
 * GTIN-14 with a leading 0 becomes its GTIN-13, a zero-padded GTIN-8 its GTIN-8.
 */

export const SKU_PARTS = ['style', 'colourway', 'size'] as const
export type SkuPart = (typeof SKU_PARTS)[number]

export interface SkuPattern {
  /** The parts in order, each once. */
  readonly parts: readonly SkuPart[]
  /** Between the parts. */
  readonly separator: '-'
}

export const DEFAULT_SKU_PATTERN: SkuPattern = Object.freeze({ parts: Object.freeze(['style', 'colourway', 'size'] as const), separator: '-' })

/** A SKU: 1 to 64 capital letters or digits, with . _ - inside. */
export const SKU = /^[A-Z0-9](?:[A-Z0-9._-]{0,62}[A-Z0-9])?$/

export interface SkuCodes {
  readonly style: string
  readonly colourway: string
  readonly size: string
}

/** The SKU of a colourway in a size, by the pattern. */
export function skuOf(codes: SkuCodes, pattern: SkuPattern = DEFAULT_SKU_PATTERN): string {
  return pattern.parts.map((part) => codes[part]).join(pattern.separator)
}

/** What is wrong with a SKU the pattern made (too long, or a character a SKU may not hold), or null. */
export function skuProblem(sku: string): string | null {
  return SKU.test(sku) ? null : `SKU ${sku.slice(0, 80)} is not 1 to 64 capital letters or digits with . _ - inside: shorten the style, colourway or size code.`
}

// ---- GTIN --------------------------------------------------------------------------------------------------------------

export const GTIN_LENGTHS = [8, 12, 13, 14] as const

/** The GS1 check digit of the digits before it (weights 3 and 1 from the right). */
export function gtinCheckDigit(body: string): number {
  let sum = 0
  for (let index = 0; index < body.length; index++) {
    const digit = body.charCodeAt(body.length - 1 - index) - 48
    sum += digit * (index % 2 === 0 ? 3 : 1)
  }
  return (10 - (sum % 10)) % 10
}

export type GtinOutcome = { readonly ok: true; readonly gtin: string } | { readonly ok: false; readonly message: string }

/**
 * A GTIN as typed (spaces allowed between digit groups): checked and put in its canonical form. Messages never repeat
 * the value (it may come from an import's cell).
 */
export function parseGtin(value: string): GtinOutcome {
  const digits = value.replace(/[\s-]+/g, '')
  if (!/^\d+$/.test(digits) || !(GTIN_LENGTHS as readonly number[]).includes(digits.length)) {
    return { ok: false, message: 'A GTIN is 8, 12, 13 or 14 digits (EAN-13 for a garment sold in the EU).' }
  }
  if (/^0+$/.test(digits)) return { ok: false, message: 'A GTIN is not all zeros.' }
  const check = gtinCheckDigit(digits.slice(0, -1))
  if (check !== digits.charCodeAt(digits.length - 1) - 48) return { ok: false, message: 'The last digit of the GTIN is not its check digit: it was mistyped.' }
  const padded = digits.padStart(14, '0')
  const gtin = padded.startsWith('000000') ? padded.slice(6) : padded.startsWith('0') ? padded.slice(1) : padded
  return { ok: true, gtin }
}
