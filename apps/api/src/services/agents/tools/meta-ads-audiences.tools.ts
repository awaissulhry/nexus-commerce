/**
 * Meta ads, step 11 (2026-10-21) — Claude's audience reads for Meta (Facebook + Instagram ads). Read only: nothing here
 * changes Meta, and the gateway lets only GET through.
 *
 *   meta-audiences  the chosen ad account's custom and lookalike audiences: list (own and shared-in, by subtype or
 *                   pixel), detail (size range, status, source, rule, flags, lookalike spec, labels, capabilities),
 *                   expiring, flagged, lookalikes, ads-using (grouped by ad set), sessions (customer-list uploads),
 *                   health (value data), sharing (recipients, their campaigns, ad accounts), business-sharing (the
 *                   portfolio's requests and permissions), saved audiences, terms (Custom Audience terms and the
 *                   existing-customers list). Master rows AU-001…AU-018, AU-067…AU-069, AU-076.
 * The caller never names a Graph path, field or parameter: each view sends a fixed request (live-audiences.ts).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { MetaReadError } from '../../marketing/meta-ads/errors.js'
import { AUDIENCE_SUBTYPES, AUDIENCE_VIEWS, audiencesView, SHARE_PERMISSIONS, SHARING_REQUEST_STATUSES, type AudienceView } from '../../marketing/meta-ads/live-audiences.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of meta-audiences: the value data an audience shares through the Audience API (view health). */
export const META_AUDIENCES_MONEY = { valueHealth: ADSPEND } as const

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const metaId = (what: string) => z.string().trim().regex(/^\d{1,25}$/).optional().describe(what)
const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(what)
const connectionArg = z.string().trim().min(1).max(64).optional().describe('the Meta connection (from meta-connection); default: this business\'s one')
const str = (v: unknown) => (typeof v === 'string' ? v : null)

async function guarded(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { ok: true, data: await work() }
  } catch (err) {
    if (err instanceof MetaLiveRefusal || err instanceof MetaReadError) return { ok: false, error: err.message }
    throw err
  }
}

const metaAudiences: AgentTool = {
  name: 'meta-audiences',
  title: 'Meta audiences',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsView],
  restrictedFields: META_AUDIENCES_MONEY,
  input: z.object({
    view: z.preprocess(lower, z.enum(AUDIENCE_VIEWS)).default('list').describe(
      'list (default) | detail | expiring | flagged | lookalikes | ads-using | sessions | health | sharing (audienceId) | business-sharing | saved | terms',
    ),
    audienceId: metaId('detail, ads-using, sessions, health, sharing: the custom or lookalike audience (an id from view list)'),
    subtype: z.preprocess(upper, z.enum(AUDIENCE_SUBTYPES)).optional().describe('list: only audiences of this subtype (CUSTOM = customer list, WEBSITE, ENGAGEMENT, LOOKALIKE, VIDEO, OFFLINE_CONVERSION, …)'),
    pixelId: metaId('list: only the website audiences of this pixel (one of the chosen ad account\'s; meta-datasets view list)'),
    sessionId: metaId('sessions: one upload session only'),
    calculatedDate: dayArg('health: Meta\'s calculated date (YYYY-MM-DD, UTC)'),
    processedDate: dayArg('health: the date Meta received the data (YYYY-MM-DD, UTC)'),
    permissions: z.enum(SHARE_PERMISSIONS).optional().describe('sharing: only ad accounts with targeting, or targeting_and_insights, permission'),
    requestStatus: z.preprocess(upper, z.enum(SHARING_REQUEST_STATUSES)).optional().describe('business-sharing: only requests in this status (PENDING, APPROVE, DECLINE, …)'),
    partnerBusinessId: metaId('business-sharing: only with this partner business portfolio'),
    savedAudienceId: metaId('saved: one saved audience with its targeting (default: the list)'),
    maxRows: z.number().int().min(1).max(1000).optional().describe('at most this many rows (default 200)'),
    connectionId: connectionArg,
  }),
  description:
    'The business\'s Meta audiences, read live from Meta. view list (default): the chosen ad account\'s custom and '
    + 'lookalike audiences — its own and those shared with it — with size, delivery (ready / too small / unusable), '
    + 'operation status in words, type and source, retention, integrity flags and expiry; filter by subtype or by the pixel '
    + 'a website audience is built on. detail (audienceId): one audience in full — rule, lookalike spec and seeds, '
    + 'permissions, opt-out link, labels (for a shared-in one: the labels the chosen account set), what Meta says it may be '
    + 'used for. expiring: audiences Meta will delete (unused in active ad sets for 2 years; deleted 90 days later unless an '
    + 'active ad set uses one). flagged: integrity flags. lookalikes: each with its spec. ads-using: the ads (and ad sets) '
    + 'that use an audience — check before deleting, unsharing or editing it (Meta has no list of ad sets: grouped from the '
    + 'ads). sessions: customer-list upload sessions (received, matched, invalid). health: the value data shared through '
    + 'the Audience API (not delivery). sharing: recipients, their campaigns, the ad accounts it is shared with. '
    + 'business-sharing: the business portfolio\'s audience-sharing requests sent and received and permissions (accepting '
    + 'one is Meta\'s screens). saved: saved audiences (Meta has no API to create or edit one). terms: whether the Custom '
    + 'Audience terms are signed (a person signs them in Meta; a system user cannot) and the existing-customers list. '
    + 'Sizes are Meta\'s ranges (lowerBound to upperBound), never one number; Meta gives no size for lookalikes. Meta '
    + 'never gives the people in an audience, and Nexus never asks. Only the chosen ad account\'s audiences (and those '
    + 'shared with it) are read; a shared-in audience shows only its name, type, size, status and the chosen account\'s '
    + 'labels (its rule, source, uploads, value data and sharing are its owner\'s: refused); an ad account another '
    + 'business in Nexus uses is its id only. Read only: audience changes '
    + 'are set-meta-… tools, each a request a person approves.',
  async handler(args): Promise<ToolResult> {
    return guarded(() => audiencesView({
      connectionId: str(args.connectionId),
      view: (args.view ?? 'list') as AudienceView,
      audienceId: str(args.audienceId),
      subtype: str(args.subtype),
      pixelId: str(args.pixelId),
      sessionId: str(args.sessionId),
      calculatedDate: str(args.calculatedDate),
      processedDate: str(args.processedDate),
      permissions: str(args.permissions),
      requestStatus: str(args.requestStatus),
      partnerBusinessId: str(args.partnerBusinessId),
      savedAudienceId: str(args.savedAudienceId),
      maxRows: typeof args.maxRows === 'number' ? args.maxRows : undefined,
    }))
  },
}

export const META_ADS_AUDIENCES_TOOLS: AgentTool[] = [metaAudiences]
