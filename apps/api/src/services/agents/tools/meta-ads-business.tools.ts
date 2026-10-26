/**
 * Meta ads, step 4 (2026-10-25) — Claude's reads of the business portfolio of the business's chosen Meta connection,
 * live from Meta (marketing/meta-ads/live-business.ts). Read only: nothing here changes Meta, and the gateway lets only
 * GET through.
 *
 *   meta-business           the portfolio itself: name, verification, time zone, primary Page, industry, two-factor rule,
 *                           who made it, messaging and collaborative-ads state (portfolio); the portfolios the system user
 *                           belongs to (businesses); its domains and their verification (domains) — master BM-001…BM-004
 *   meta-business-people    people with their roles, tasks and two-factor status; system users (Nexus's own marked);
 *                           pending invitations and the assets one will give; finance roles — BM-005…BM-007, BM-010,
 *                           BM-900, BM-901
 *   meta-business-assets    Pages (owned, client, pending), a global brand Page's children, a Page's store locations,
 *                           Instagram accounts and business assets, apps, asset groups, client objects, offsite signal
 *                           containers, WhatsApp accounts and their numbers — BM-011, BM-012, BM-015…BM-018, BM-910,
 *                           BM-911, EN-929, EN-934
 *   meta-business-partners  agencies and clients with their permissions, partners, partner relationships, sharing
 *                           agreements started here or received, child businesses — BM-019…BM-022, BM-024
 * No amount is read here (billing: meta-billing); the payment ids are money keys, shown with the ad-spend view as there.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import {
  AGREEMENT_LISTS, ASSET_LIST_NAMES, ASSET_VIEWS, assetsView, BUSINESS_VIEWS, businessView, META_CLIENT_OBJECT_TYPES, META_INVITATION_ASSET_TYPES,
  META_BUSINESS_ASSETS_MONEY, META_BUSINESS_MONEY, META_SHARING_AGREEMENT_STATUSES, PARTNER_VIEWS, partnersView, PEOPLE_VIEWS, peopleView,
  type AgreementList, type AssetView, type BusinessView, type PartnerView, type PeopleView,
} from '../../marketing/meta-ads/live-business.js'
import type { MetaClientObjectKind, MetaInvitationAssetType } from '../../meta/meta-business-lists.js'
import { connectionArg, guarded, lower, metaIdArg } from './meta-ads-read.tools.js'

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const conn = (args: Record<string, unknown>) => str(args.connectionId)
const rows = (args: Record<string, unknown>) => (typeof args.maxRows === 'number' ? args.maxRows : undefined)
const maxRowsArg = z.number().int().min(1).max(500).optional().describe('at most this many rows per list (default 100; at most 500)')

const READ_LINE = 'Read only: Meta is never changed here (the portfolio\'s admin acts are the Owner\'s own steps in Meta\'s screens: set-meta-business-settings, set-meta-business-people and create-meta-system-user show them). Only the business portfolio of the business\'s chosen ad account is read; a Page, Instagram account, ad account or portfolio another business in Nexus uses is its id and a flag only, and when another business in Nexus uses an ad account of this portfolio its people, partners and domains are not read (its other assets are ids only).'

// ── meta-business ───────────────────────────────────────────────────────────────────────────────────────────────────

const metaBusiness: AgentTool = {
  name: 'meta-business',
  title: 'Meta business portfolio',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  // Review A-F5 — the portfolio's payment account id: a money key, as meta-billing's payment ids (ad-spend view).
  restrictedFields: META_BUSINESS_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(BUSINESS_VIEWS)).default('portfolio').describe('portfolio | businesses | domains'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'The Meta business portfolio (Business Manager) of the business\'s chosen ad account, read LIVE from Meta. view portfolio '
    + '(default): name, business verification state, time zone, primary Page, industry, the two-factor rule, when and by whom '
    + 'it was made and changed (Nexus\'s system user by name, anyone else by id), its profile link and picture, payment account '
    + 'id (with the ad-spend permission), marketing-messages onboarding, WhatsApp messaging limit and collaborative-ads eligibility. businesses: the portfolios '
    + 'this connection\'s system user belongs to (works before an ad account is chosen). domains: the web domains the portfolio '
    + 'owns and whether each is verified (never the verification code). Meta has no API field for the business\'s legal '
    + 'name, address, phone or website, and documents no API to start or finish business verification or to add or verify a '
    + 'domain — a person does these in Meta Business settings. People: meta-business-people; assets: meta-business-assets; partners: '
    + 'meta-business-partners; billing: meta-billing. ' + READ_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => businessView({ connectionId: conn(args), view: (args.view ?? 'portfolio') as BusinessView, maxRows: rows(args) }))
  },
}

// ── meta-business-people ────────────────────────────────────────────────────────────────────────────────────────────

const metaBusinessPeople: AgentTool = {
  name: 'meta-business-people',
  title: 'People of the Meta business portfolio',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(PEOPLE_VIEWS)).default('people').describe('people | system-users | invitations | invitation-assets | finance'),
    invitationId: metaIdArg('invitation-assets: a pending invitation of the portfolio (view invitations)'),
    assetTypes: z.array(z.preprocess(upper, z.enum(META_INVITATION_ASSET_TYPES))).min(1).max(META_INVITATION_ASSET_TYPES.length).optional()
      .describe(`invitation-assets: only these asset types (${META_INVITATION_ASSET_TYPES.join(', ')}); default AD_ACCOUNT, PAGE, INSTAGRAM_ACCOUNT_V2, PRODUCT_CATALOG, PIXEL`),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'Who is in the Meta business portfolio of the business\'s chosen ad account, read LIVE from Meta. view people (default): '
    + 'each person\'s name, base role (Admin / Employee), finance and ads-rights role, tasks and whether two-factor is on, with '
    + 'the number of admins. system-users: the portfolio\'s system users, their role and who made them (Nexus\'s own marked), '
    + 'counted by role. invitations: invitations not accepted yet, their role, tasks and expiry. invitation-assets '
    + '(invitationId, assetTypes): the ad accounts, Pages, Instagram accounts, catalogs, pixels … one invitation will give, '
    + 'owned and client. finance: who holds a finance role. Names, roles and tasks only: never an e-mail address, a first or '
    + 'last name, a title, an invitation link or a token. Meta documents a system-user rename only — no role change and no '
    + 'delete (a person can invalidate its tokens) — and lists system users only to an admin token (when Nexus\'s system user '
    + 'is an Employee, Meta refuses). Meta documents no change on the finance edge; its business-user role update lists the '
    + 'finance roles, what that sets is not documented. What one person can reach on the '
    + 'chosen ad account: meta-account-access. ' + READ_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => peopleView({
      connectionId: conn(args), view: (args.view ?? 'people') as PeopleView, invitationId: str(args.invitationId),
      assetTypes: Array.isArray(args.assetTypes) ? args.assetTypes as MetaInvitationAssetType[] : null, maxRows: rows(args),
    }))
  },
}

// ── meta-business-assets ────────────────────────────────────────────────────────────────────────────────────────────

const CLIENT_OBJECT_KINDS = Object.keys(META_CLIENT_OBJECT_TYPES) as [MetaClientObjectKind, ...MetaClientObjectKind[]]

const metaBusinessAssets: AgentTool = {
  name: 'meta-business-assets',
  title: 'Assets of the Meta business portfolio',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  // Review A-F5 — a WhatsApp account's funding id: a money key, as meta-billing's payment ids (ad-spend view).
  restrictedFields: META_BUSINESS_ASSETS_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(ASSET_VIEWS)).default('pages')
      .describe('pages | page-children | store-locations | instagram | apps | asset-groups | client-objects | signal-containers | whatsapp | whatsapp-numbers'),
    list: z.preprocess(lower, z.enum(ASSET_LIST_NAMES)).optional()
      .describe('only this list of the view (default every one): pages owned | client | pending-owned | pending-client; instagram assets | owned | client | all | converted; apps owned | client | pending; asset-groups owned | client; signal-containers owned | client | pending'),
    objectType: z.preprocess(lower, z.enum(CLIENT_OBJECT_KINDS)).optional().describe(`client-objects: the kind (${CLIENT_OBJECT_KINDS.join(', ')})`),
    whatsappAccountId: metaIdArg('whatsapp-numbers: a WhatsApp Business Account of the portfolio (view whatsapp)'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'The assets of the Meta business portfolio of the business\'s chosen ad account, read LIVE from Meta. view pages '
    + '(default): the Pages it owns, the client Pages it may use (with its tasks) and the claims and requests still pending. '
    + 'page-children: the child Pages of the chosen Page when it is a global brand Page. store-locations: the chosen Page\'s '
    + 'shops (address, hours, phone). instagram: the Instagram business assets (the ids people get tasks on) and the Instagram '
    + 'accounts owned, shared in, reachable and converted. apps: owned, client and pending apps (the business\'s own Meta app '
    + 'marked, and whether this portfolio owns it). asset-groups: owned and client business asset groups. client-objects '
    + '(objectType): one kind of object other portfolios share with this one. signal-containers: Meta\'s offsite signal '
    + 'containers. whatsapp: the WhatsApp Business Accounts (review, verification, health, limits). whatsapp-numbers '
    + '(whatsappAccountId): their phone numbers and quality. An asset this portfolio does not own is named only when Meta '
    + 'names its owner portfolio and no other business in Nexus uses it; else its id only. Meta documents no API to make a '
    + 'business asset group; the store-locations edge is read only (Meta\'s Page Locations API, which Nexus does not use, '
    + 'manages location Pages); WhatsApp numbers are added and verified in WhatsApp Manager or WhatsApp\'s own API, which '
    + 'Nexus does not use (it only reads them). Claiming, requesting or removing a Page, Instagram account or app is an '
    + 'admin\'s change a person approves. The Pages the system user itself has a role on: meta-connection view choices; '
    + 'the chosen ad account\'s Pages and Instagram accounts: meta-account-access. ' + READ_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => assetsView({
      connectionId: conn(args), view: (args.view ?? 'pages') as AssetView, list: str(args.list), objectType: (args.objectType as MetaClientObjectKind | undefined) ?? null,
      whatsappAccountId: str(args.whatsappAccountId), maxRows: rows(args),
    }))
  },
}

// ── meta-business-partners ──────────────────────────────────────────────────────────────────────────────────────────

const metaBusinessPartners: AgentTool = {
  name: 'meta-business-partners',
  title: 'Partners of the Meta business portfolio',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(PARTNER_VIEWS)).default('agencies').describe('agencies | clients | partners | relationships | sharing-agreements | child-businesses'),
    list: z.preprocess(lower, z.enum(AGREEMENT_LISTS)).optional().describe('sharing-agreements: initiated (default: started by this portfolio) | received (started by others with it)'),
    includeDeclined: z.boolean().optional().describe('relationships: also the partner requests that were declined (default no)'),
    status: z.preprocess(upper, z.enum(META_SHARING_AGREEMENT_STATUSES)).optional().describe('sharing-agreements: only this status (e.g. PENDING, APPROVE, DECLINE)'),
    receivingPortfolioId: metaIdArg('sharing-agreements, list initiated: only those with this receiving portfolio'),
    requestingPortfolioId: metaIdArg('sharing-agreements, list received: only those started by this portfolio'),
    maxRows: maxRowsArg,
    connectionId: connectionArg,
  }),
  description:
    'The partners of the Meta business portfolio of the business\'s chosen ad account, read LIVE from Meta. view agencies '
    + '(default): partner portfolios that may use THIS portfolio\'s assets, with what each may do on which ad account, Page, '
    + 'catalog and app, and how many audiences are shared. clients: portfolios that let this one use their assets, with its '
    + 'tasks on each. partners: the portfolios that work with this one as partners. relationships (includeDeclined): every '
    + 'partner portfolio connected and how. sharing-agreements (list initiated with receivingPortfolioId, or received with '
    + 'requestingPortfolioId; status): asset-sharing agreements and their status. child-businesses: child portfolios it made '
    + 'through Meta\'s API (usually none). Giving a partner access (asset by asset) or ending it is an admin\'s change a '
    + 'person approves. The partners of the chosen ad account '
    + 'alone: meta-account-access view agencies. ' + READ_LINE,
  async handler(args): Promise<ToolResult> {
    return guarded(() => partnersView({
      connectionId: conn(args), view: (args.view ?? 'agencies') as PartnerView, includeDeclined: args.includeDeclined === true,
      list: (args.list as AgreementList | undefined) ?? null, status: str(args.status), receivingPortfolioId: str(args.receivingPortfolioId),
      requestingPortfolioId: str(args.requestingPortfolioId), maxRows: rows(args),
    }))
  },
}

export const META_ADS_BUSINESS_TOOLS: AgentTool[] = [metaBusiness, metaBusinessPeople, metaBusinessAssets, metaBusinessPartners]
