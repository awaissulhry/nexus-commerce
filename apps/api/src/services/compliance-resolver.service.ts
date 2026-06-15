/**
 * C1 — canonical product-compliance resolver (the shared Track C foundation).
 *
 * One place resolves the EU product-safety payload (country of origin,
 * manufacturer, GPSR responsible person, PPE category, dangerous goods,
 * certificates / DoC) from the master Product + BrandSettings, so every channel
 * serializer reads the SAME data instead of each re-capturing it. The rule
 * engine (evaluateCompliance) is the compliance-status logic extracted into a
 * pure function, reused by the Amazon pre-flight and (later) the other channels.
 *
 * The pure functions (buildCompliancePayload / evaluateCompliance /
 * buildAmazonComplianceColumns) carry the logic and are unit-tested; the
 * DB-touching resolveComplianceForSkus is a thin batch loader.
 */

import prisma from '../db.js'

export interface ResponsiblePerson {
  name: string | null
  addressLines: string[]
  email: string | null
  phone: string | null
  taxId: string | null
}

export interface ComplianceCertificate {
  certType: string
  certNumber: string | null
  standard: string | null
  issuingBody: string | null
  issuedAt: Date | null
  expiresAt: Date | null
  fileUrl: string | null
}

export interface ImpactProtector {
  zone: string | null
  standard: string | null
  level: string | null
}

export interface CompliancePayload {
  productId: string
  sku: string | null
  countryOfOrigin: string | null
  manufacturer: string | null
  hsCode: string | null
  ppeCategory: string | null
  dangerousGoods: { hazmatClass: string | null; unNumber: string | null } | null
  responsiblePerson: ResponsiblePerson | null
  certificates: ComplianceCertificate[]
  ceCert: { certNumber: string | null; expiresAt: Date | null } | null
  // C4 — structured CE/PPE protective-gear data.
  garmentClass: string | null
  notifiedBody: { number: string | null; name: string | null } | null
  declarationOfConformityUrl: string | null
  impactProtectors: ImpactProtector[]
}

export interface ComplianceIssue {
  code: string
  message: string
  severity: 'block' | 'warn'
}

export interface ComplianceProductInput {
  id: string
  sku?: string | null
  countryOfOrigin?: string | null
  manufacturer?: string | null
  hsCode?: string | null
  ppeCategory?: string | null
  hazmatClass?: string | null
  hazmatUnNumber?: string | null
  garmentClass?: string | null
  notifiedBodyNumber?: string | null
  notifiedBodyName?: string | null
  declarationOfConformityUrl?: string | null
  impactProtectors?: unknown
  certificates?: ComplianceCertificate[]
}

// EU member markets + post-Brexit UK (EU-like) + the cross-border set — the
// exact sets the compliance-status endpoint uses, kept in lock-step here.
const EU_MARKETS = new Set(['IT', 'DE', 'FR', 'ES', 'NL', 'PL', 'SE', 'BE', 'IE', 'AT', 'PT', 'FI', 'DK', 'GR', 'CZ', 'HU', 'RO'])
const UK_MARKETS = new Set(['UK', 'GB'])
const CROSS_BORDER_MARKETS = new Set(['US', 'CA', 'MX', 'JP', 'AU', 'IN', 'AE', 'SA', 'TR'])

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** Pure — assemble the canonical payload from a product (+ certs) and the RP. */
export function buildCompliancePayload(
  product: ComplianceProductInput,
  rp: ResponsiblePerson | null,
): CompliancePayload {
  const certificates = product.certificates ?? []
  const ce = certificates.find((c) => c.certType === 'CE') ?? null
  const hasDg = Boolean(product.hazmatClass || product.hazmatUnNumber)
  const nb = product.notifiedBodyNumber || product.notifiedBodyName
    ? { number: product.notifiedBodyNumber ?? null, name: product.notifiedBodyName ?? null }
    : null
  const impactProtectors: ImpactProtector[] = Array.isArray(product.impactProtectors)
    ? (product.impactProtectors as any[])
        .map((p) => ({
          zone: p?.zone != null ? String(p.zone) : null,
          standard: p?.standard != null ? String(p.standard) : null,
          level: p?.level != null ? String(p.level) : null,
        }))
        .filter((p) => p.zone || p.standard || p.level)
    : []
  return {
    productId: product.id,
    sku: product.sku ?? null,
    countryOfOrigin: product.countryOfOrigin ?? null,
    manufacturer: product.manufacturer ?? null,
    hsCode: product.hsCode ?? null,
    ppeCategory: product.ppeCategory ?? null,
    dangerousGoods: hasDg ? { hazmatClass: product.hazmatClass ?? null, unNumber: product.hazmatUnNumber ?? null } : null,
    responsiblePerson: rp,
    certificates,
    ceCert: ce ? { certNumber: ce.certNumber, expiresAt: ce.expiresAt } : null,
    garmentClass: product.garmentClass ?? null,
    notifiedBody: nb,
    declarationOfConformityUrl: product.declarationOfConformityUrl ?? null,
    impactProtectors,
  }
}

/**
 * Pure — the EU/PPE/CE/REACH/hazmat/customs rules (lock-step with the
 * compliance-status endpoint) plus the GPSR responsible-person check. `now` is
 * injectable so the expiry math is deterministic in tests.
 */
export function evaluateCompliance(
  payload: CompliancePayload,
  marketplace: string,
  platform: string = 'AMAZON',
  now: Date = new Date(),
): ComplianceIssue[] {
  const mk = String(marketplace || '').toUpperCase()
  const isEU = EU_MARKETS.has(mk) || UK_MARKETS.has(mk)
  const isCrossBorder = CROSS_BORDER_MARKETS.has(mk) || isEU
  const issues: ComplianceIssue[] = []

  const ppeIIorIII = payload.ppeCategory === 'CAT_II' || payload.ppeCategory === 'CAT_III'
  const ce = payload.ceCert
  if (ppeIIorIII && isEU) {
    if (!ce) {
      issues.push({ code: 'ce_cert_missing', severity: 'block', message: `PPE Category ${payload.ppeCategory} requires a CE certificate for EU marketplaces (PPE Directive 2016/425).` })
    } else if (ce.expiresAt && ce.expiresAt < now) {
      issues.push({ code: 'ce_cert_expired', severity: 'block', message: `CE certificate ${ce.certNumber ?? ''} expired ${iso(ce.expiresAt)}.` })
    } else if (ce.expiresAt && ce.expiresAt < new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)) {
      issues.push({ code: 'ce_cert_expiring', severity: 'warn', message: `CE certificate expires within 90 days (${iso(ce.expiresAt)}).` })
    }
  }

  const reach = payload.certificates.find((c) => c.certType === 'REACH')
  if (reach?.expiresAt && reach.expiresAt < now && isEU) {
    issues.push({ code: 'reach_cert_expired', severity: 'warn', message: `REACH compliance certificate expired ${iso(reach.expiresAt)}.` })
  }

  if (payload.dangerousGoods && platform === 'AMAZON') {
    issues.push({ code: 'amazon_hazmat_declaration', severity: 'warn', message: `Hazmat product (UN class ${payload.dangerousGoods.hazmatClass ?? '?'}). Amazon requires a separate hazmat declaration upload on Seller Central.` })
  }

  if (!payload.hsCode && isCrossBorder) {
    issues.push({ code: 'hs_code_missing', severity: 'warn', message: 'HS code (customs classification) missing — required for cross-border shipments.' })
  }
  if (!payload.countryOfOrigin && isCrossBorder) {
    issues.push({ code: 'country_of_origin_missing', severity: 'warn', message: 'Country of origin missing — required on customs declarations for cross-border shipments.' })
  }

  // C1 — GPSR Art. 16: an EU market needs a responsible person. Warn (not block)
  // so a missing Brand Settings entry surfaces without blocking publishes.
  if (isEU && !payload.responsiblePerson?.name) {
    issues.push({ code: 'gpsr_responsible_person_missing', severity: 'warn', message: 'EU responsible person missing (GPSR Art. 16) — set it in Brand Settings.' })
  }

  return issues
}

/**
 * Pure — map the canonical payload to Amazon flat-file column values, using the
 * attribute keys the Amazon cockpit already reads (AC.4 ComplianceCard). Only
 * emits a key when there's a value. Dangerous-goods enum mapping is deferred to
 * C5 (it's product-type-specific). Country-of-origin keeps its label here; the
 * existing feed serializer converts label→code on submit.
 */
export function buildAmazonComplianceColumns(payload: CompliancePayload): Record<string, string> {
  const cols: Record<string, string> = {}
  if (payload.countryOfOrigin) cols.country_of_origin = payload.countryOfOrigin
  if (payload.manufacturer) {
    cols.manufacturer = payload.manufacturer
    cols.manufacturer_contact_information = payload.manufacturer
  }
  const rp = payload.responsiblePerson
  if (rp?.name) cols.eu_responsible_person = rp.name
  if (rp) {
    const addr = [...(rp.addressLines ?? []), rp.email, rp.phone].filter(Boolean).join(', ')
    if (addr) cols.responsible_person_address = addr
  }
  return cols
}

/**
 * C3 — map the canonical payload to Shopify product metafields (custom
 * `compliance` namespace; text field types). Returns [] when there's nothing to
 * push. Mapping to Shopify's STANDARD storefront GPSR metaobjects (for native
 * compliance-section display) is a follow-up (C3.1).
 */
export function buildShopifyComplianceMetafields(
  payload: CompliancePayload,
): Array<{ namespace: string; key: string; type: string; value: string }> {
  const out: Array<{ namespace: string; key: string; type: string; value: string }> = []
  const push = (key: string, type: string, value: string | null | undefined) => {
    if (value != null && String(value).trim() !== '') out.push({ namespace: 'compliance', key, type, value: String(value) })
  }
  push('country_of_origin', 'single_line_text_field', payload.countryOfOrigin)
  push('manufacturer', 'single_line_text_field', payload.manufacturer)
  const rp = payload.responsiblePerson
  if (rp?.name) {
    push('responsible_person', 'single_line_text_field', rp.name)
    const addr = [...(rp.addressLines ?? []), rp.email, rp.phone].filter(Boolean).join('\n')
    push('responsible_person_address', 'multi_line_text_field', addr)
  }
  return out
}

/** The single BrandSettings row → the canonical responsible person. */
export async function getResponsiblePerson(): Promise<ResponsiblePerson | null> {
  const b = await prisma.brandSettings.findFirst().catch(() => null)
  if (!b) return null
  return {
    name: b.companyName ?? null,
    addressLines: b.addressLines ?? [],
    email: b.contactEmail ?? null,
    phone: b.contactPhone ?? null,
    taxId: b.piva ?? b.taxId ?? null,
  }
}

/** Single-product resolve (cockpit publish paths). */
export async function resolveComplianceById(productId: string): Promise<CompliancePayload | null> {
  const [rp, product] = await Promise.all([
    getResponsiblePerson(),
    prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true, sku: true, countryOfOrigin: true, manufacturer: true, hsCode: true,
        ppeCategory: true, hazmatClass: true, hazmatUnNumber: true,
        garmentClass: true, notifiedBodyNumber: true, notifiedBodyName: true,
        declarationOfConformityUrl: true, impactProtectors: true,
        certificates: {
          select: { certType: true, certNumber: true, standard: true, issuingBody: true, issuedAt: true, expiresAt: true, fileUrl: true },
        },
      },
    }),
  ])
  return product ? buildCompliancePayload(product as ComplianceProductInput, rp) : null
}

/**
 * Batch loader for the submit path: one BrandSettings read + one products+certs
 * read → Map<sku, CompliancePayload>. Keyed by SKU because flat-file rows carry
 * item_sku.
 */
export async function resolveComplianceForSkus(skus: string[]): Promise<Map<string, CompliancePayload>> {
  const map = new Map<string, CompliancePayload>()
  const unique = [...new Set(skus.filter(Boolean))]
  if (unique.length === 0) return map
  const [rp, products] = await Promise.all([
    getResponsiblePerson(),
    prisma.product.findMany({
      where: { sku: { in: unique } },
      select: {
        id: true, sku: true, countryOfOrigin: true, manufacturer: true, hsCode: true,
        ppeCategory: true, hazmatClass: true, hazmatUnNumber: true,
        garmentClass: true, notifiedBodyNumber: true, notifiedBodyName: true,
        declarationOfConformityUrl: true, impactProtectors: true,
        certificates: {
          select: { certType: true, certNumber: true, standard: true, issuingBody: true, issuedAt: true, expiresAt: true, fileUrl: true },
        },
      },
    }),
  ])
  for (const p of products) {
    if (p.sku) map.set(p.sku, buildCompliancePayload(p as ComplianceProductInput, rp))
  }
  return map
}
