/**
 * MCP full control P3 — the business's brand settings (F.6.2) and primary marketplace (PSM.1), read in one place:
 * GET /api/settings/brand and GET /api/settings/primary-marketplace (brand-settings.routes.ts) call these, and so does
 * Claude's `business-overview` read.
 *
 * One BrandSettings row per business. The settings page's GET has always created an empty row when there is none, so
 * its PATCH never has to choose between create and update: that is `ensureBrandSettings`. A read for Claude must not
 * write, so `readBrandSettings` answers null instead. Moved from the route without a change in behaviour
 * (brand-settings.service.vitest.test.ts holds the route's answers byte for byte).
 *
 * MCP full control P10 — the brand save too (PATCH /api/settings/brand): sanitized by `sanitizeBrandUpdate`, checked by
 * `checkBrandUpdate` against the row as it is, written by `writeBrandSettings` with its settings audit row. The route
 * and Claude's `set-business-settings` save through these (brand-settings-save.service.vitest.test.ts holds the
 * route's answers byte for byte). `saveAccountDisplay` writes the two business fields Claude may change in the
 * account settings (name, primary market), as the settings page does.
 */

import { BUSINESS_COUNTRIES } from '@nexus/shared/business-profile'
import prisma from '../../db.js'
import { writeSettingsAudit } from '../../utils/settings-audit.js'
import {
  validatePiva,
  validateCodiceFiscale,
  validateSdi,
  validatePec,
  validateInvoicingRouting,
  isVatScheme,
} from '../../lib/italian-fiscal.js'

/** The business's brand row, or null when it has none. Never writes. */
export async function readBrandSettings() {
  return prisma.brandSettings.findFirst()
}

/** The business's brand row, created empty when it has none (what the settings page's GET has always done). */
export async function ensureBrandSettings() {
  let row = await readBrandSettings()
  if (!row) {
    row = await prisma.brandSettings.create({ data: {} })
  }
  return row
}

/** The marketplace the business set as its primary one, or null when it set none. Never writes. */
export async function readPrimaryMarketplace(): Promise<string | null> {
  const row = await (prisma as any).accountSettings.findFirst({
    select: { primaryMarketplace: true },
  })
  return row?.primaryMarketplace ?? null
}


// ── The brand save (PATCH /api/settings/brand) ──────────────────────────────────────────────────────

export const BRAND_SNAPSHOT_FIELDS = [
  'companyName',
  'addressLines',
  'taxId',
  'contactEmail',
  'contactPhone',
  'websiteUrl',
  'logoUrl',
  'signatureBlockText',
  'defaultPoNotes',
  'factoryEmailFrom',
  'piva',
  'codiceFiscale',
  'sdiCode',
  'pecEmail',
  'vatScheme',
] as const

/** The brand fields a settings audit row records (before and after a save). */
export function brandSnapshot(
  row: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const k of BRAND_SNAPSHOT_FIELDS) out[k] = row[k] ?? null
  return out
}

/** What PATCH /api/settings/brand takes. Unknown keys are dropped. */
export interface BrandSettingsInput {
  companyName?: string | null
  addressLines?: string[]
  taxId?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  websiteUrl?: string | null
  logoUrl?: string | null
  signatureBlockText?: string | null
  defaultPoNotes?: string | null
  factoryEmailFrom?: string | null
  // Phase D — Italian fiscal fields.
  piva?: string | null
  codiceFiscale?: string | null
  sdiCode?: string | null
  pecEmail?: string | null
  vatScheme?: string | null
  // PO.7 — purchase-order approval ladder.
  requireApprovalForPo?: boolean
  poApprovalThresholdCents?: number | null
  poApprovalApproverEmail?: string | null
}

/** The route's sanitizing: trimmed strings, null for an empty one, unknown keys dropped, clean address lines. */
export function sanitizeBrandUpdate(body: BrandSettingsInput): Record<string, unknown> {
  // Sanitize: trim strings, drop unknown keys, coerce addressLines.
  const update: Record<string, unknown> = {}
  const stringKeys = [
    'companyName',
    'taxId',
    'contactEmail',
    'contactPhone',
    'websiteUrl',
    'logoUrl',
    'signatureBlockText',
    'defaultPoNotes',
    'factoryEmailFrom',
    // Phase D additions — same trim/normalize treatment as other
    // string columns; specific validation happens below.
    'piva',
    'codiceFiscale',
    'sdiCode',
    'pecEmail',
    'vatScheme',
  ] as const
  for (const k of stringKeys) {
    if (k in body) {
      const v = (body as any)[k]
      update[k] = v == null || v === '' ? null : String(v).trim()
    }
  }
  if ('addressLines' in body && Array.isArray(body.addressLines)) {
    update.addressLines = body.addressLines
      .map((s) => (typeof s === 'string' ? s.trim() : ''))
      .filter((s) => s.length > 0)
  }

  // PO.7 — approval ladder fields, written through with the same
  // null-out-on-empty contract used by the string columns above.
  if ('requireApprovalForPo' in body) {
    update.requireApprovalForPo = !!body.requireApprovalForPo
  }
  if ('poApprovalThresholdCents' in body) {
    const v = body.poApprovalThresholdCents
    update.poApprovalThresholdCents =
      v == null ? null : Math.max(0, Math.round(Number(v)))
  }
  if ('poApprovalApproverEmail' in body) {
    const v = body.poApprovalApproverEmail
    update.poApprovalApproverEmail =
      v == null || v === '' ? null : String(v).trim().toLowerCase()
  }
  return update
}

type BrandRow = Awaited<ReturnType<typeof readBrandSettings>>

/**
 * The route's checks of a sanitized update against the row as it is (`existing`): the strict fiscal checks and the
 * invoicing routing. Field by field, in the route's order; empty when the update may be saved. Upper-cases the SDI
 * code and the codice fiscale in `update`, as the route did.
 */
export function checkBrandUpdate(update: Record<string, unknown>, existing: BrandRow): Record<string, string> {
  // Phase D — strict fiscal validation. Per the operator's
  // explicit choice (AskUserQuestion in the rebuild plan), bad
  // checksums reject the save outright. Per-field errors so the
  // UI can highlight exactly what's wrong instead of a
  // generic "save failed" toast.
  const fieldErrors: Record<string, string> = {}
  // Tiny helper: discriminated-union narrowing on `r.valid` via
  // !r.valid was flaky under TS 5's inference here, so we
  // narrow via `if (r.valid === false)` which always works.
  const check = (
    field: string,
    r: { valid: true } | { valid: false; reason: string },
  ) => {
    if (r.valid === false) fieldErrors[field] = r.reason
  }
  if (typeof update.piva === 'string' && update.piva) {
    check('piva', validatePiva(update.piva))
  }
  if (typeof update.codiceFiscale === 'string' && update.codiceFiscale) {
    check('codiceFiscale', validateCodiceFiscale(update.codiceFiscale))
  }
  if (typeof update.sdiCode === 'string' && update.sdiCode) {
    check('sdiCode', validateSdi(update.sdiCode))
  }
  if (typeof update.pecEmail === 'string' && update.pecEmail) {
    check('pecEmail', validatePec(update.pecEmail))
  }
  if (update.vatScheme != null && !isVatScheme(update.vatScheme)) {
    fieldErrors.vatScheme =
      'VAT scheme must be one of: ORDINARIO, FORFETTARIO, OSS, IOSS, ESENTE.'
  }
  // SDI-OR-PEC routing check: fires when the save touches the P.IVA, the SDI code or the PEC, on what the row will
  // hold AFTER the save. 2026-10-01: it read the OLD value of a field the save clears (null), so clearing the only
  // SDI code of a business with a P.IVA and no PEC was saved and left e-invoices with nowhere to go.
  const after = (field: 'piva' | 'sdiCode' | 'pecEmail') =>
    ((field in update ? update[field] : existing?.[field]) as string | null | undefined) ?? ''
  const effectivePiva = after('piva')
  const effectiveSdi = after('sdiCode')
  const effectivePec = after('pecEmail')
  if (effectivePiva && ('piva' in update || 'sdiCode' in update || 'pecEmail' in update)) {
    check('routing', validateInvoicingRouting({
      piva: effectivePiva,
      sdiCode: effectiveSdi,
      pecEmail: effectivePec,
    }))
  }
  // Uppercase normalisation for two fields where the spec is
  // case-insensitive but downstream parsers expect uppercase.
  if (typeof update.sdiCode === 'string' && update.sdiCode) {
    update.sdiCode = update.sdiCode.toUpperCase()
  }
  if (typeof update.codiceFiscale === 'string' && update.codiceFiscale) {
    update.codiceFiscale = update.codiceFiscale.toUpperCase()
  }
  return fieldErrors
}

/** Write a checked update: create the row or update it, and record the save in the settings audit. */
export async function writeBrandSettings(update: Record<string, unknown>, existing: BrandRow) {
  // Single-row upsert: read-then-update keeps the contract simple.
  // We already fetched `existing` above for the routing check;
  // reuse it instead of doing a second read.
  let row = existing
  const before = row
  if (!row) {
    row = await prisma.brandSettings.create({ data: update })
  } else {
    row = await prisma.brandSettings.update({
      where: { id: row.id },
      data: update,
    })
  }
  // Phase B — settings change history. Use the canonical helper so
  // /settings/audit surfaces these alongside web-action saves.
  await writeSettingsAudit({
    key: 'company',
    action: before ? 'update' : 'create',
    before: brandSnapshot(before as any),
    after: brandSnapshot(row as any),
  })
  return row
}

/** PATCH /api/settings/brand: sanitize, check against the row as it is, then write. */
export async function saveBrandSettings(body: BrandSettingsInput): Promise<{ fieldErrors: Record<string, string> } | { row: NonNullable<BrandRow> }> {
  const update = sanitizeBrandUpdate(body)
  const existing = await prisma.brandSettings.findFirst()
  const fieldErrors = checkBrandUpdate(update, existing)
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors }
  return { row: await writeBrandSettings(update, existing) }
}

// ── The business's display fields (account settings) ───────────────────────────────────────────────

/** The account-settings fields Claude may change: the business's name and its primary market. */
export interface AccountDisplayInput {
  businessName?: string
  primaryMarketplace?: string | null
}

/** Why these values may not be saved, as the settings page says it; null when they may. */
export function accountDisplayRefusal(input: AccountDisplayInput): string | null {
  if (input.businessName !== undefined) {
    const name = input.businessName.trim()
    if (name.length < 2 || name.length > 80) return 'Business name must contain 2–80 characters.'
  }
  if (input.primaryMarketplace != null && !BUSINESS_COUNTRIES.includes(input.primaryMarketplace.trim().toUpperCase())) {
    return 'Primary marketplace must be a valid country code.'
  }
  return null
}

/**
 * Save the business's name and primary market, as Settings › Business does (apps/web settings/account actions): only
 * when the row is still the one read (`updatedAt`), with a settings audit row of what changed. Refused when the
 * business has no settings row (the page creates it) or the row changed meanwhile.
 */
export async function saveAccountDisplay(input: AccountDisplayInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const refusal = accountDisplayRefusal(input)
  if (refusal) return { ok: false, error: refusal }
  const existing = await prisma.accountSettings.findFirst()
  if (!existing) return { ok: false, error: 'This business has no settings yet: save them once in Nexus (Settings › Business).' }
  const data: Record<string, unknown> = {}
  if (input.businessName !== undefined) data.businessName = input.businessName.trim()
  if (input.primaryMarketplace !== undefined) data.primaryMarketplace = input.primaryMarketplace?.trim().toUpperCase() || null
  const before: Record<string, unknown> = {}
  for (const key of Object.keys(data)) before[key] = (existing as Record<string, unknown>)[key] ?? null
  const result = await prisma.accountSettings.updateMany({
    where: { id: existing.id, updatedAt: existing.updatedAt },
    data: { ...data, updatedAt: new Date(Math.max(Date.now(), existing.updatedAt.getTime() + 1)) },
  })
  if (result.count !== 1) return { ok: false, error: 'The business settings changed meanwhile. Ask again.' }
  await writeSettingsAudit({ key: 'account', action: 'update', before, after: data })
  return { ok: true }
}
