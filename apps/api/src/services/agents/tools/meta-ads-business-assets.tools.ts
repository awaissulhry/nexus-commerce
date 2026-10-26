/**
 * Meta ads step 43 (2026-10-26) — the business portfolio's ASSET acts, by the Owner's decision D1 = A: only an admin of the
 * portfolio may make them (Meta: "For all add and remove endpoints: Access token's user needs to be an admin of the
 * business"), so the Owner makes them in Meta's own screens; Nexus shows the exact steps, how to put it back and what to
 * watch out for, from what Meta reads now, and reads the result when asked again. Nexus sends NOTHING to Meta here (no admin
 * token, no write, no approval: nothing changes, so there is nothing to approve) — step 42's shape.
 *
 *   set-meta-business-assets    claim an ad account, ask a client for one, let the chosen ad account advertise for the chosen
 *                               Instagram account, claim or ask for a Page, claim or ask for an app, make an asset group —
 *                               AA-063, AA-064, AA-066, BM-044, BM-045, BM-055, BM-056
 *   remove-meta-business-asset  take an ad account, a Page or an Instagram account out of the portfolio — AA-065, BM-047, BM-049
 *   create-meta-ad-account      a new ad account in the portfolio (money said plainly) — AA-062
 *   create-meta-appeal          an appeal of the restricted chosen ad account or of the portfolio — LG-015, LG-016
 * The three writes of this step Nexus's own token may make (a Page-backed Instagram account, an Instagram- or Page-backed
 * Threads account: BM-051, CR-228, CR-230) and the invoice groups (BM-903 … BM-907) are real changes:
 * meta-ads-business-assets-changes.tools.ts.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { ACCESS_LEVELS, APPEAL_SUBJECTS, ASSET_ACTIONS, REMOVE_ASSETS, type AccessLevel, type AppealSubject, type AssetAction, type RemoveAsset } from '../../marketing/meta-ads/business-assets-admin.js'
import { appealAdmin, businessAssetsAdmin, newAdAccountAdmin, removeBusinessAssetAdmin } from '../../marketing/meta-ads/live-business-assets-admin.js'
import { META_NAME_TEXT } from '../../gateway/meta-write-text.js'
import { connectionArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const opt = <T>(v: unknown): T | undefined => (v === undefined || v === null ? undefined : v as T)
const sinceArg = (what: string) => z.string().trim().datetime({ offset: true }).optional().describe(what)
/** An ad account id as Meta writes it (act_123…) or its digits: the digits are kept. */
const actDigits = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/^act_/i, '') : v)
const adAccountArg = (what: string) => z.preprocess(actDigits, z.string().regex(/^\d{1,25}$/, 'an ad account id: its digits, or act_ and its digits')).optional().describe(what)

/** The line every description ends with (D1, in plain words). */
const D1_TOOL_LINE = 'Nexus changes NOTHING and sends nothing to Meta with this tool (Owner decision D1: only an admin of the business portfolio may make this, and it stays in the hands of a person with full access to it, who makes it in Meta\'s own screens). It reads Meta now — only the business portfolio of the business\'s chosen ad account, and nothing at all when another business in Nexus uses that portfolio — and answers what is asked from → to, the exact steps in Meta\'s screens (from Meta\'s Business Help Center), how to put it back (or plainly that Meta cannot) and what to watch out for; asked again, it reads the result and says what is done (state). An asset another business in Nexus uses gets no steps.'

const common = { category: 'insights' as const, riskTier: 'low' as const, readOnly: true, openWorld: true, requires: [F.adsView] as AgentTool['requires'] }

// ── set-meta-business-assets ────────────────────────────────────────────────────────────────────────────────────────

const setMetaBusinessAssets: AgentTool = {
  ...common,
  name: 'set-meta-business-assets',
  title: 'Meta business assets (Owner steps)',
  input: z.object({
    action: z.preprocess(lower, z.enum(ASSET_ACTIONS)).describe('claim-ad-account | request-ad-account | link-instagram | claim-page | request-page | claim-app | request-app | asset-group'),
    adAccountId: adAccountArg('claim-ad-account: an ad account to bring into this portfolio; request-ad-account: another portfolio\'s ad account to ask access to'),
    pageId: metaIdArg('claim-page: a Page to bring into this portfolio as its owner; request-page: another\'s Page to ask access to'),
    appId: metaIdArg('claim-app, request-app: the Meta App ID (its App Dashboard\'s Basic settings page)'),
    name: z.string().trim().min(1).max(100).regex(META_NAME_TEXT, 'plain text only (no control characters)').optional().describe('asset-group: the new business asset group\'s name'),
    access: z.preprocess(lower, z.enum(ACCESS_LEVELS)).optional().describe('request-ad-account, request-page: partial (Meta\'s default: only the tasks named in its screen) | full (full control)'),
    connectionId: connectionArg,
  }),
  description:
    'What the business portfolio holds, as the Owner changes it in Meta Business settings › Accounts. action claim-ad-account '
    + '(adAccountId: moves it into this portfolio for good; one an admin of the ad account must accept in Ads Manager waits), '
    + 'request-ad-account (adAccountId, access: partner access to another portfolio\'s ad account — Meta\'s API for it is '
    + 'limited to apps that used it in the last 30 days, so it is the Owner\'s step in any case), link-instagram (the chosen ad '
    + 'account may then advertise for the chosen Instagram account), claim-page (pageId: a Page admin of more than 7 days makes '
    + 'it this portfolio\'s at once), request-page (pageId, access: too many requests reported as spam lock the portfolio), '
    + 'claim-app / request-app (appId), asset-group (name: Meta cannot make one by its API at all). Each answer says whether it '
    + 'is so already, what waits for someone else\'s approval, and how it is put back. Taking an asset out: '
    + 'remove-meta-business-asset; a new ad account: create-meta-ad-account; a Page-backed Instagram or Threads account (made '
    + 'by Nexus, a person approves): create-meta-backed-account. ' + D1_TOOL_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => businessAssetsAdmin({
      connectionId: str(args.connectionId), action: args.action as AssetAction, adAccountId: opt<string>(args.adAccountId), pageId: opt<string>(args.pageId),
      appId: opt<string>(args.appId), name: opt<string>(args.name), access: opt<AccessLevel>(args.access),
    }))
  },
}

// ── remove-meta-business-asset ──────────────────────────────────────────────────────────────────────────────────────

const removeMetaBusinessAsset: AgentTool = {
  ...common,
  name: 'remove-meta-business-asset',
  title: 'Remove a Meta asset (Owner steps)',
  input: z.object({
    asset: z.preprocess(lower, z.enum(REMOVE_ASSETS)).describe('ad-account | page | instagram'),
    id: z.preprocess(actDigits, z.string().regex(/^\d{1,25}$/, 'a Meta id: digits (an ad account may be act_ and its digits)')).describe('the ad account, Page or Instagram account (meta-business-assets / meta-ad-accounts list them)'),
    since: sinceArg('asked again after the Owner acted: the readAt of the first answer — an asset Meta no longer lists is then the result (without since, an id Nexus cannot find is refused)'),
    connectionId: connectionArg,
  }),
  description:
    'Take an ad account, a Page or an Instagram account out of the business portfolio, as the Owner does it in Meta Business '
    + 'settings › Accounts. Only what Nexus may name: one of the portfolio\'s own, the business\'s chosen one (the answer warns '
    + 'what it stops in Nexus), or a partner\'s whose owner portfolio Meta names and no other business in Nexus uses. Meta does '
    + 'not let a portfolio remove an ad account it OWNS (only a waiting request or partner access): the answer says so and '
    + 'names deactivating instead. A Page is first disconnected from its Instagram and WhatsApp accounts (Meta: 42001). Putting '
    + 'it back: a Page is claimed again (a Page admin of more than 7 days), an Instagram account is added again with its '
    + 'username and password, partner access is asked again. ' + D1_TOOL_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => removeBusinessAssetAdmin({ connectionId: str(args.connectionId), asset: args.asset as RemoveAsset, id: String(args.id), since: opt<string>(args.since) }))
  },
}

// ── create-meta-ad-account ──────────────────────────────────────────────────────────────────────────────────────────

const createMetaAdAccount: AgentTool = {
  ...common,
  name: 'create-meta-ad-account',
  title: 'A new Meta ad account (Owner steps)',
  input: z.object({
    name: z.string().trim().min(1).max(100).regex(META_NAME_TEXT, 'plain text only (no control characters)').describe('the new ad account\'s name'),
    currency: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{3}$/, 'a currency code (ISO 4217, three letters)')).optional().describe('its currency (default: the chosen ad account\'s); Meta never changes it later'),
    timeZone: z.string().trim().regex(/^[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+){0,2}$/, 'a time zone name such as Europe/Rome').max(64).optional().describe('its time zone, as named in Meta\'s list (default: the chosen ad account\'s); Meta never changes it later'),
    since: sinceArg('asked again after the Owner made it: the readAt of the first answer'),
    connectionId: connectionArg,
  }),
  description:
    'A new ad account in the business portfolio, as the Owner makes it in Meta Business settings › Accounts › Ad accounts › '
    + 'Add › Create a new ad account. MONEY: it spends nothing until it has a payment method (or the credit line) and an ad '
    + 'runs; then its ads spend that money — the answer says so plainly. No way back: Meta keeps a new ad account in the '
    + 'portfolio for good (it can only be deactivated, and a closed one still counts toward the limit); its currency and time '
    + 'zone never change. Meta\'s limits: one ad account for a new portfolio, up to 3 after a campaign delivered and a payment, '
    + 'more with spend. Nexus keeps working in the chosen ad account until a person chooses the new one (set-meta-connection). '
    + 'Asked again with since = the first answer\'s readAt, Nexus finds it by its name. ' + D1_TOOL_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => newAdAccountAdmin({ connectionId: str(args.connectionId), name: String(args.name), currency: opt<string>(args.currency), timeZone: opt<string>(args.timeZone), since: opt<string>(args.since) }))
  },
}

// ── create-meta-appeal ──────────────────────────────────────────────────────────────────────────────────────────────

const createMetaAppeal: AgentTool = {
  ...common,
  name: 'create-meta-appeal',
  title: 'Appeal a Meta restriction (Owner steps)',
  input: z.object({
    subject: z.preprocess(lower, z.enum(APPEAL_SUBJECTS)).default('ad-account').describe('ad-account (default: the business\'s chosen ad account) | portfolio (its business portfolio)'),
    since: sinceArg('asked again after the Owner asked Meta for a review: the readAt of the first answer'),
    connectionId: connectionArg,
  }),
  description:
    'An appeal (Meta: "request a review") of a restriction on the business\'s chosen ad account or on its business portfolio, '
    + 'as an admin of it asks in Meta Business Support Home › Account status overview › What you can do › Request review. '
    + 'For the ad account Nexus reads its status first: Active — nothing to appeal; closed, a payment matter or already in '
    + 'Meta\'s review — said, no steps; Disabled — the steps (asked again with since, Active means Meta lifted it). Meta '
    + 'documents no field that says a portfolio is restricted, nor one that shows a review request: those answers say "cannot '
    + 'tell". An appeal cannot be withdrawn, Meta allows a limited number and its decision is final; ads do not start again by '
    + 'themselves after it (switching them on is set-meta-status — SPENDS MONEY). ' + D1_TOOL_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => appealAdmin({ connectionId: str(args.connectionId), subject: (args.subject ?? 'ad-account') as AppealSubject, since: opt<string>(args.since) }))
  },
}

export const META_ADS_BUSINESS_ASSETS_TOOLS: AgentTool[] = [setMetaBusinessAssets, removeMetaBusinessAsset, createMetaAdAccount, createMetaAppeal]
