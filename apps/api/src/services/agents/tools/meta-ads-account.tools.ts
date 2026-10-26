/**
 * Meta ads, step 3 (2026-10-21) — Claude's reads of the chosen Meta ad account ITSELF, live from Meta
 * (marketing/meta-ads/live-account.ts). Read only: nothing here changes Meta, and the gateway lets only GET through.
 *
 *   meta-ad-account      the account's full settings: identity, portfolio, end advertiser, business address, promotable
 *                        objects, invoice / legal addresses, agency declaration (settings); EU DSA payer / beneficiary and
 *                        Meta's suggestions (dsa); terms accepted and the Custom Audience terms (terms); capabilities;
 *                        account controls; tracking specs; minimum budgets and Page ad limits (limits); MCME conversions
 *                        and conversion goals (goals); an app event's attribution options; insights features (switched on
 *                        or not) — master AA-010, AA-011, AA-015…AA-018, AA-020…AA-024, AA-031, AA-032, AA-034, AS-025,
 *                        AS-030, IN-049, IN-050
 *   meta-billing         spend against the spending limit, the payment set-up (Meta's masked words only), tax, billing
 *                        events of the activity log, and — only when no other business in Nexus uses the portfolio —
 *                        monthly invoices, credit lines, invoice groups, credit allocations, saved cards, credit
 *                        applications — AA-012…AA-014, BM-025…BM-027, BM-902, BM-908, LG-003
 *   meta-account-access  people and system users on the account with their tasks, agencies, apps, promoted Pages,
 *                        Instagram accounts (and which ad accounts may advertise for the chosen one), what one person or
 *                        the system user can reach, who holds tasks on the chosen Page / Instagram account, a catalog or
 *                        a pixel — AA-025…AA-030, AA-067, BM-008, BM-009
 * Money is in minor units (cents) of the account currency (a credit line's in its own currency), under money keys.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { ACCESS_VIEWS, ACCOUNT_VIEWS, accessView, adAccountView, ASSET_KINDS, BILLING_VIEWS, billingView, INVOICE_TYPES, PERSON_ASSET_KINDS, type AccessView, type AccountView, type AssetKind, type BillingView } from '../../marketing/meta-ads/live-account.js'
import { addDays, dayCount } from '../../marketing/meta-ads/dates.js'
import { connectionArg, dayArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'

const ADSPEND = FIELDS.financialsAdspendView
/** meta-ad-account's money keys: the minimum budgets (and the manual bid they are read for). */
export const META_ACCOUNT_MONEY = {
  minDailyBudgetImpressionsCents: ADSPEND, minDailyBudgetVideoViewsCents: ADSPEND, minDailyBudgetHighFrequencyCents: ADSPEND,
  minDailyBudgetLowFrequencyCents: ADSPEND, bidAmountCents: ADSPEND,
} as const
/** meta-billing's money keys: every amount it answers (the tool needs the ad-spend permission as a whole). */
export const META_BILLING_MONEY = {
  amountSpentCents: ADSPEND, spendCapCents: ADSPEND, spendLeftCents: ADSPEND, balanceCents: ADSPEND, minDailyBudgetCents: ADSPEND,
  minCampaignSpendCapCents: ADSPEND, displayAmount: ADSPEND, originalDisplayAmount: ADSPEND, amountMeta: ADSPEND, amountDueCents: ADSPEND,
  billedAmountMeta: ADSPEND, creditAvailableCents: ADSPEND, maxBalanceCents: ADSPEND, onlineMaxBalanceCents: ADSPEND, allocatedCents: ADSPEND,
  amountCents: ADSPEND, proposedCreditLimitCents: ADSPEND, originalOnlineLimitCents: ADSPEND, metaRaw: ADSPEND,
} as const

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const conn = (args: Record<string, unknown>) => str(args.connectionId)
const maxRowsArg = z.number().int().min(1).max(500).optional().describe('at most this many rows (default 100; at most 500)')

const READ_LINE = 'Read only: Meta is never changed here (a change is a set-meta-… tool a person approves). Only the business\'s chosen ad account, its own business portfolio, Page and Instagram account are read; a Page, Instagram account, ad account or portfolio another business in Nexus uses is its id and a flag only.'

// ── meta-ad-account ─────────────────────────────────────────────────────────────────────────────────────────────────

const metaAdAccount: AgentTool = {
  name: 'meta-ad-account',
  title: 'Meta ad account, in full',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: META_ACCOUNT_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(ACCOUNT_VIEWS)).default('settings')
      .describe('settings | dsa | terms | capabilities | controls | tracking | limits | goals | attribution-options | insights-features'),
    bidAmountCents: z.number().int().min(1).max(100_000_000).optional().describe('limits: the minimum budgets for this manual bid (minor units of the account currency)'),
    appId: metaIdArg('attribution-options: an app connected to the ad account (meta-account-access view apps)'),
    optimizationGoal: z.preprocess(upper, z.string().regex(/^[A-Z_]{2,60}$/)).optional().describe('attribution-options: the ad set goal, Meta\'s name (e.g. APP_INSTALLS, OFFSITE_CONVERSIONS)'),
    eventName: z.preprocess(upper, z.string().regex(/^[A-Z0-9_]{2,60}$/)).optional().describe('attribution-options: a standard app event, Meta\'s name (e.g. PURCHASE; not OTHER)'),
    feature: z.preprocess(lower, z.string().regex(/^[a-z_]{2,60}$/)).optional().describe('insights-features: only this feature (comscore, impression_device, time_of_day_viewer_tz, frequency_value)'),
    connectionId: connectionArg,
  }),
  description:
    'The business\'s chosen Meta ad account itself, read LIVE from Meta in full (meta-ads-live view account is the quick look: '
    + 'status, money, opportunity score). view settings (default): name, status and why it is disabled, age, currency and time '
    + 'zone, business portfolio, owner, end advertiser / agency / partner, personal-use flag (VAT), what Nexus\'s system user '
    + 'may do on it, notifications, inventory filter levels, business address, the Pages, apps and links it may promote, '
    + 'marketing-message settings, invoice and legal addresses, who it is shared with, the agency declaration (without '
    + 'e-mail). dsa: the EU payer and beneficiary every EU ad set needs, and Meta\'s suggestions. terms: terms accepted, '
    + 'the Custom Audience terms. capabilities: what Meta lets the account do (Meta calls the list legacy). controls: '
    + 'Advantage+ account controls (minimum age, places, exclusions) and campaigns they could not apply to. tracking: '
    + 'account-level tracking specs. limits: Meta\'s minimum daily budgets (optionally for a manual bid), each Page\'s ad '
    + 'limit, the account\'s object limits. goals: Meta\'s MCME conversions and conversion goals. attribution-options '
    + '(appId, optimizationGoal): the attribution choices for an app\'s events. insights-features: the breakdowns that '
    + 'must be switched on, and which are on. Meta cannot: change an account\'s currency or time zone (a new account is '
    + 'the way); tell a system user whether a person signed the Custom Audience terms, or accept them (a person does, in '
    + 'Ads Manager); switch an insights feature off again. Billing: meta-billing; people and access: meta-account-access. '
    + READ_LINE + ' Money in minor units (cents) of the account currency.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => adAccountView({
      connectionId: conn(args), view: (args.view ?? 'settings') as AccountView,
      bidAmountCents: typeof args.bidAmountCents === 'number' ? args.bidAmountCents : null,
      appId: str(args.appId), optimizationGoal: str(args.optimizationGoal), eventName: str(args.eventName), feature: str(args.feature),
    }))
  },
}

// ── meta-billing ────────────────────────────────────────────────────────────────────────────────────────────────────

const metaBilling: AgentTool = {
  name: 'meta-billing',
  title: 'Meta billing (read only)',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  // Every view is money (limits, payments, invoices, credit): it is judged with the ad-spend money permission.
  requires: [F.adsView, ADSPEND],
  restrictedFields: META_BILLING_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(BILLING_VIEWS)).default('spend')
      .describe('spend | payment | tax | events | invoices | credit-lines | invoice-groups | credit-allocations | cards | credit-applications'),
    from: dayArg('events: first day (default 30 days before to); invoices: billing periods after this one (the first day of a month)'),
    to: dayArg('events: last day (default today); invoices: billing periods before this one (not included)'),
    issuedFrom: dayArg('invoices: issued on or after this day'),
    issuedTo: dayArg('invoices: issued before this day (only with issuedFrom)'),
    invoiceId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/).optional().describe('invoices: only this invoice or credit memo number (every other filter is then ignored)'),
    invoiceType: z.preprocess(upper, z.enum(INVOICE_TYPES)).optional().describe('invoices: INV (invoice) | CM (credit memo) | DM (debit memo) | PRO_FORMA'),
    creditLineId: metaIdArg('invoice-groups, credit-allocations: only this credit line (from view credit-lines); default every one'),
    pendingOnly: z.boolean().optional().describe('credit-applications: only those still waiting'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'The business\'s chosen Meta ad account\'s billing, read LIVE from Meta. READ ONLY. view spend (default): amount spent '
    + 'against the spending limit, what is left, the balance owed, minimum daily budget and campaign spend cap. payment: '
    + 'whether a payment method is set, its kind and Meta\'s own masked words for it (e.g. a card type and its last four '
    + 'digits — Nexus never reads a card number, expiry, holder or bank detail), expired method, coupons, prepaid or not, '
    + 'invoice group (the method needs the MANAGE task, else Meta says so). tax: VAT number and its status, personal use, '
    + 'invoice and legal addresses. events (from, to): charges, failed charges, refunds, chargebacks and payment-method '
    + 'changes from the activity log. The business portfolio\'s billing, only when no other business in Nexus uses that '
    + 'portfolio (else its id and a flag, no call): invoices (monthly invoicing; without Meta\'s PDF links — a person '
    + 'downloads them in Business settings › Billing and payments), credit-lines (one another portfolio shares in: no legal '
    + 'names; its invoice groups and allocations are never read), invoice-groups (which ad accounts share one invoice; never '
    + 'its e-mail addresses; no tax numbers on a personal-use account), credit-allocations, cards (type and last four only), '
    + 'credit-applications. Meta cannot, by any API: add or change a payment method, add prepaid funds, give card '
    + 'receipts, open or raise a credit line — a person does these in Meta Business settings. Changing the spending limit '
    + 'or invoice groups is a change a person approves (set-meta-spend-cap, set-meta-billing). ' + READ_LINE
    + ' Needs the ad-spend money permission. Money in minor units (cents) of the account currency; a credit line\'s in its own currency.',
  async handler(args): Promise<ToolResult> {
    const view = (args.view ?? 'spend') as BillingView
    let from = str(args.from)
    let to = str(args.to)
    if (view === 'events') {
      to = to ?? new Date().toISOString().slice(0, 10)
      from = from ?? addDays(to, -29)
      if (to < from || dayCount({ from, to }) > 366) return { ok: false, error: 'events reads at most 366 days at once, from before to.' }
    }
    return guarded(() => billingView({
      connectionId: conn(args), view, from, to, issuedFrom: str(args.issuedFrom), issuedTo: str(args.issuedTo), invoiceId: str(args.invoiceId),
      invoiceType: str(args.invoiceType), creditLineId: str(args.creditLineId), pendingOnly: args.pendingOnly === true,
      maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined,
    }))
  },
}

// ── meta-account-access ─────────────────────────────────────────────────────────────────────────────────────────────

const metaAccountAccess: AgentTool = {
  name: 'meta-account-access',
  title: 'Who can use the Meta ad account',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(ACCESS_VIEWS)).default('people').describe('people | agencies | apps | pages | instagram | by-person | asset-people'),
    personId: metaIdArg('by-person: a person or system user assigned to the ad account (view people); default Nexus\'s own system user'),
    kinds: z.array(z.enum(PERSON_ASSET_KINDS as [string, ...string[]])).min(1).max(PERSON_ASSET_KINDS.length).optional()
      .describe(`by-person: only these kinds (${PERSON_ASSET_KINDS.join(', ')}); default every one`),
    asset: z.preprocess(lower, z.enum(ASSET_KINDS)).optional().describe('asset-people: page (the chosen Page) | instagram (the chosen Instagram account) | catalog | pixel'),
    assetId: metaIdArg('asset-people: the catalog (of the chosen account\'s portfolio) or pixel (of the chosen ad account); a Page or Instagram account only when it is the chosen one'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'Who and what can use the business\'s chosen Meta ad account, read LIVE from Meta. view people (default): the business\'s '
    + 'people and system users on it with their tasks and role (Admin, Advertiser, Analyst), Nexus\'s own system user marked, '
    + 'and the people as Meta shows them to Nexus\'s app — names and tasks only, never an e-mail address or token. agencies: '
    + 'other business portfolios with access and their tasks. apps: the apps connected to the account (the business\'s own '
    + 'Meta app marked) and the advertisable ones. pages: the Pages promoted under the account. instagram: its Instagram '
    + 'accounts (also through the portfolio) and which of the portfolio\'s ad accounts may advertise for the chosen one. '
    + 'by-person (personId, default Nexus\'s system user): everything that person can reach in the portfolio — ad accounts, '
    + 'Pages, Instagram accounts, catalogs, pixels, apps, asset groups, folders, datasets, WhatsApp accounts (each named '
    + 'only when it is the one chosen here, or this portfolio owns it and no other business in Nexus uses the portfolio; '
    + 'else its id) — proving the system user holds only this business\'s assets. asset-people (asset, assetId): who '
    + 'holds tasks on the chosen Page or '
    + 'Instagram account, a catalog of the portfolio or a pixel of the account (a Page may need its own Page token: Meta says '
    + 'so). Giving, changing or removing people\'s tasks is set-meta-user-access; sharing an asset with a partner, taking a '
    + 'partner off or ending a relationship is set-meta-partner-access (an ad account\'s share: Meta names the route, its '
    + 'parameters are in its SDK only, so Meta\'s answer decides) — each a change a person approves. ' + READ_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => {
      const view = (args.view ?? 'people') as AccessView
      if (view === 'asset-people' && !args.asset) throw new MetaLiveRefusal('Name the asset (asset: page, instagram, catalog or pixel; assetId for a catalog or pixel).')
      return accessView({
        connectionId: conn(args), view, personId: str(args.personId), kinds: Array.isArray(args.kinds) ? args.kinds as string[] : null,
        asset: (args.asset as AssetKind | undefined) ?? null, assetId: str(args.assetId), maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined,
      })
    })
  },
}

export const META_ADS_ACCOUNT_TOOLS: AgentTool[] = [metaAdAccount, metaBilling, metaAccountAccess]
