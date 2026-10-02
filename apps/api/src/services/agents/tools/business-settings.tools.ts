/**
 * MCP full control P10 — `set-business-settings`: the business's own company, legal and display details, changed with
 * a person's approval (plan section 09 §4).
 *
 * What it may change: the brand and legal fields of Settings › Company & fiscal (company name, address, VAT and tax
 * ids, SDI code, PEC, VAT scheme, contact details, website, logo, the document signature and default PO notes) and,
 * of Settings › Business, the business's name and primary market. Nothing else: never the country, currency or time
 * zone (they change how every report and price is counted), never the purchase-order approval ladder or the factory's
 * sending address (a safety setting and an e-mail identity), and never anything on the "never for Claude" list —
 * security, API keys, webhooks, privacy, integrations, AI providers and budgets (09 §2).
 *
 * The dry run writes nothing. It applies the settings pages' own sanitizing and checks (brand-settings.service.ts,
 * the code PATCH /api/settings/brand runs: after the save a P.IVA keeps an SDI code or a PEC address). The preview
 * shows each field from → to and
 * the legal identity as invoices and documents will show it after the change; both are what a person approves (and
 * MATERIAL_PREVIEW_FIELDS: a value that moved since hands the approval back). The run saves through the same code as
 * the pages, with their settings audit rows, in one transaction. Undo is a new request of this tool with the values
 * it replaced, through the same gate — what a settings revert does, and refused once a value changed since.
 *
 * Reaches no one outside Nexus by itself; documents made after the change use it. Always a person's decision (`ask`).
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { inDatabaseTransaction } from '../../../lib/database-context.js'
import { VAT_SCHEMES } from '../../../lib/italian-fiscal.js'
import {
  accountDisplayRefusal,
  checkBrandUpdate,
  readBrandSettings,
  sanitizeBrandUpdate,
  saveAccountDisplay,
  writeBrandSettings,
  type BrandSettingsInput,
} from '../../settings/brand-settings.service.js'
import type { AgentTool, ToolChange, ToolResult, ToolUndo } from '../tool-types.js'

/** Brand fields Claude may set, as the settings page names them. */
const BRAND_FIELDS = [
  'companyName', 'addressLines', 'taxId', 'piva', 'codiceFiscale', 'sdiCode', 'pecEmail', 'vatScheme',
  'contactEmail', 'contactPhone', 'websiteUrl', 'logoUrl', 'signatureBlockText', 'defaultPoNotes',
] as const
/** Account-settings fields Claude may set (`displayName` is the argument for `businessName`). */
const ACCOUNT_FIELDS = ['businessName', 'primaryMarketplace'] as const
/** The argument a field is set by, where the two differ. */
const ARGUMENT_OF: Partial<Record<string, string>> = { businessName: 'displayName' }
const argumentOf = (field: string) => ARGUMENT_OF[field] ?? field
const FIELDS = [...BRAND_FIELDS, ...ACCOUNT_FIELDS] as const
type Field = (typeof FIELDS)[number]
/** What documents show as the business's legal identity: always in the preview, as it will be after the change. */
const LEGAL_FIELDS = ['companyName', 'addressLines', 'piva', 'codiceFiscale', 'taxId', 'sdiCode', 'pecEmail', 'vatScheme'] as const

const text = (max: number, what: string) => z.string().max(max).nullable().optional().describe(`${what}; null or "" clears it`)

const INPUT = z.object({
  companyName: text(200, 'the company name on invoices and documents'),
  addressLines: z.array(z.string().max(200)).max(6).optional().describe('the company address, one line each (at most 6); empty lines are dropped'),
  taxId: text(64, 'a tax id other than the Italian ones'),
  piva: text(32, 'the Italian P.IVA, 11 digits'),
  codiceFiscale: text(32, 'the Italian codice fiscale'),
  sdiCode: text(16, 'the 7-character SDI code for e-invoices'),
  pecEmail: text(254, 'the PEC address for e-invoices'),
  vatScheme: z.enum(VAT_SCHEMES).nullable().optional().describe('the VAT scheme; null clears it'),
  contactEmail: text(254, 'the company contact e-mail shown on documents'),
  contactPhone: text(64, 'the company contact phone'),
  websiteUrl: text(500, 'the company website'),
  logoUrl: text(1000, 'the address of the logo image'),
  signatureBlockText: text(2000, 'the signature block on documents'),
  defaultPoNotes: text(2000, 'the default notes on purchase orders'),
  // Not `businessName`: no argument may name a business (tool contract rule 3); this is the business's own name.
  displayName: z.string().trim().min(2).max(80).optional().describe('the name this business goes by in Nexus, Settings › Business (2–80 characters)'),
  primaryMarketplace: z.string().trim().max(2).nullable().optional()
    .describe('the main market, a country code such as IT or DE; null clears it'),
})

type Values = Partial<Record<Field, unknown>>

/** One text per value whatever its key order, to tell a real change from the same value. */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

interface Plan {
  brandUpdate: Record<string, unknown>
  account: { businessName?: string; primaryMarketplace?: string | null }
  /** Only the fields whose value changes: what they hold now and what they will hold. */
  before: Values
  after: Values
  existingBrand: Awaited<ReturnType<typeof readBrandSettings>>
  legal: Record<string, unknown>
}

/**
 * What a call would change, read now, with the settings pages' own sanitizing and checks; or why it may not. The
 * dry run and the run both start here, so the run saves exactly what the preview showed.
 */
async function planOf(args: Record<string, unknown>): Promise<Plan | { error: string }> {
  const given = FIELDS.filter((field) => argumentOf(field) in args && args[argumentOf(field)] !== undefined)
  if (given.length === 0) return { error: 'Nothing to change: name at least one setting and its new value.' }

  const brandInput: Record<string, unknown> = {}
  for (const field of BRAND_FIELDS) if (field in args && args[field] !== undefined) brandInput[field] = args[field]
  const brandUpdate = sanitizeBrandUpdate(brandInput as BrandSettingsInput)
  const [existingBrand, settings] = await Promise.all([
    readBrandSettings(),
    prisma.accountSettings.findFirst({ select: { businessName: true, primaryMarketplace: true } }),
  ])
  // The page's own checks, on what the row will hold after the save (a P.IVA keeps an SDI code or a PEC).
  const fieldErrors = checkBrandUpdate(brandUpdate, existingBrand)
  const current = (field: string) => (existingBrand as Record<string, unknown> | null)?.[field] ?? null
  if (Object.keys(fieldErrors).length) {
    return { error: `Not changed: ${Object.entries(fieldErrors).map(([field, reason]) => `${field} — ${reason}`).join('; ')}` }
  }

  const account: Plan['account'] = {}
  if (typeof args.displayName === 'string') account.businessName = args.displayName.trim()
  if ('primaryMarketplace' in args && args.primaryMarketplace !== undefined) {
    account.primaryMarketplace = typeof args.primaryMarketplace === 'string' ? args.primaryMarketplace.trim().toUpperCase() || null : null
  }
  const refusal = accountDisplayRefusal(account)
  if (refusal) return { error: `Not changed: ${refusal}` }
  if (Object.keys(account).length && !settings) {
    return { error: 'Not changed: this business has no settings yet. Save them once in Nexus (Settings › Business).' }
  }

  const before: Values = {}
  const after: Values = {}
  for (const [field, value] of Object.entries(brandUpdate)) {
    if (!same(current(field), value)) {
      before[field as Field] = current(field)
      after[field as Field] = value
    }
  }
  for (const [field, value] of Object.entries(account)) {
    const now = (settings as Record<string, unknown> | null)?.[field] ?? null
    if (!same(now, value)) {
      before[field as Field] = now
      after[field as Field] = value
    }
  }
  if (Object.keys(after).length === 0) return { error: 'Nothing to change: every value given is already the business’s.' }

  const legal: Record<string, unknown> = {}
  for (const field of LEGAL_FIELDS) legal[field] = field in brandUpdate ? brandUpdate[field] : current(field) ?? (field === 'addressLines' ? [] : null)
  return { brandUpdate, account, before, after, existingBrand, legal }
}

/** The fields a change wrote, read back now (the shape of `change.after`). */
async function currentValues(fields: string[]): Promise<Values> {
  const [brand, settings] = await Promise.all([readBrandSettings(), prisma.accountSettings.findFirst({ select: { businessName: true, primaryMarketplace: true } })])
  const out: Values = {}
  for (const field of fields) {
    const row = (ACCOUNT_FIELDS as readonly string[]).includes(field) ? settings : brand
    out[field as Field] = (row as Record<string, unknown> | null)?.[field] ?? (field === 'addressLines' && row ? [] : null)
  }
  return out
}

/**
 * Undo: the values it replaced, through this tool again (a settings revert, with its own preview, approval and
 * audit). A business name cannot be emptied, so a change that set the first one cannot be put back.
 */
const UNDO: ToolUndo = {
  current: (change: ToolChange) => currentValues(Object.keys((change.after ?? {}) as object)),
  request(change: ToolChange) {
    const before = (change.before ?? {}) as Values
    if (Object.keys(before).length === 0) return { refusal: 'This change does not say what it replaced.' }
    if ('businessName' in before && (typeof before.businessName !== 'string' || before.businessName.trim().length < 2)) {
      return { refusal: 'The business had no name before this change, and a business name cannot be taken away.' }
    }
    if (typeof before.vatScheme === 'string' && !(VAT_SCHEMES as readonly string[]).includes(before.vatScheme)) {
      return { refusal: `The VAT scheme before this change (${before.vatScheme}) is not one Nexus accepts any more; set it in Nexus.` }
    }
    return { tool: 'set-business-settings', args: Object.fromEntries(Object.entries(before).map(([field, value]) => [argumentOf(field), value])) }
  },
}

const setBusinessSettings: AgentTool = {
  name: 'set-business-settings',
  title: 'Change business settings',
  category: 'settings',
  description:
    'Change this business\'s company and legal details (company name, address, P.IVA, codice fiscale, tax id, SDI '
    + 'code, PEC, VAT scheme, contact e-mail and phone, website, logo, document signature, default PO notes) or its '
    + 'name and primary market in Nexus. The preview shows every field from → to and the legal identity documents will '
    + 'show; a person approves it in Nexus before anything is saved. Saved in Nexus only: invoices and documents made '
    + 'afterwards use it. Country, currency, time zone, the purchase-order approval rules and every security, key, '
    + 'webhook, privacy, integration and AI setting stay a person\'s own change in Nexus. Undo puts the old values back.',
  input: INPUT,
  requires: [F.settingsWorkspaceEdit],
  riskTier: 'medium',
  readOnly: false,
  openWorld: false,
  // C1 — the replaced values are recorded and undo writes them back through this tool.
  reversibility: 'full',
  // Legal identity on invoices: always a person's decision.
  maxClaudeTrust: 'ask',
  requiresApprovalDefault: true,
  undo: UNDO,
  async handler(args): Promise<ToolResult> {
    const plan = await planOf(args)
    if ('error' in plan) return { ok: false, error: plan.error }
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const field of Object.keys(plan.after)) changes[field] = { from: plan.before[field as Field], to: plan.after[field as Field] }
    return {
      ok: true,
      preview: {
        action: 'set-business-settings',
        changes,
        legal: plan.legal,
        note: 'Saved in Nexus only, as Settings › Company & fiscal and Settings › Business save it (with their history). Invoices and documents made after the change use it. Undo puts the old values back.',
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planOf(args)
    if ('error' in plan) return { ok: false, error: plan.error }
    const brandChanged = Object.keys(plan.after).some((field) => (BRAND_FIELDS as readonly string[]).includes(field))
    const accountUpdate = Object.fromEntries(Object.entries(plan.account).filter(([field]) => field in plan.after))
    const refused = new Error('account settings refused')
    let accountError: string | null = null
    try {
      await inDatabaseTransaction(prisma, async () => {
        if (brandChanged) await writeBrandSettings(plan.brandUpdate, plan.existingBrand)
        if (Object.keys(accountUpdate).length) {
          const saved = await saveAccountDisplay(accountUpdate)
          if (saved.ok === false) {
            accountError = saved.error
            throw refused
          }
        }
      })
    } catch (error) {
      if (error === refused) return { ok: false, error: `Not changed: ${accountError}` }
      throw error
    }
    return {
      ok: true,
      data: { changed: Object.keys(plan.after) },
      // C1 — only the fields it changed: what they held and what it wrote (`undo.current` reads them back).
      change: { before: plan.before, after: plan.after },
    }
  },
}

export const BUSINESS_SETTINGS_TOOLS: AgentTool[] = [setBusinessSettings]
