/**
 * Google Ads changes (2026-10-15, Owner's brief "full write control of Google Ads through Nexus") — PR 5: responsive
 * search ads and campaign assets. Every tool here is a Nexus change: a preview Google has checked (validate_only), an
 * approvalId, a person approves it in Nexus, it runs as that person (google-ads-kit.ts). Never by rule.
 *
 *   create-google-rsa    make responsive search ads in one Search ad group (or, its undo form, pause ads of it)
 *   set-google-assets    make and link sitelinks, callouts and structured snippets of one campaign; link and unlink
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange, type GoogleDraftBuilder,
} from './google-ads-kit.js'
import {
  adsChangeDraft, adsRecordAfterRun, DESCRIPTION_PINS, HEADLINE_PINS, isGoogleId, RSA_LIMITS, type AdsChangeRecord, type AdsChangeRequest,
} from '../../marketing/google-ads/change-ads.js'
import {
  ASSET_FIELD_TYPES, ASSET_LIMITS, assetsChangeDraft, assetsRecordAfterRun, SNIPPET_HEADER_NAMES, type AssetsChangeRecord, type AssetsChangeRequest,
} from '../../marketing/google-ads/change-assets.js'
import { liveAds, liveAssets, liveCampaigns } from '../../marketing/google-ads/live.js'
import { liveAdGroupPlace, liveAssetsById } from '../../marketing/google-ads/live-ads-assets.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
/** A record as the run stamped it: the Google account it was made on (google-ads-kit runGoogleChange). */
type Stamped = { accountId?: string; customerId?: string }
const accountArgOf = (record: Stamped) => (record.accountId ? { accountId: record.accountId } : {})
const ALL_PINS = [...HEADLINE_PINS, ...DESCRIPTION_PINS] as const

// ── create-google-rsa ───────────────────────────────────────────────────────────────────────────────────────────

const rsaRequest = (args: Record<string, unknown>): AdsChangeRequest => ({
  campaignId: String(args.campaignId),
  adGroupId: String(args.adGroupId),
  ads: args.ads as AdsChangeRequest['ads'],
  enable: args.enable as boolean | undefined,
  pauseAdIds: args.pauseAdIds as string[] | undefined,
})

const buildRsa = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = rsaRequest(args)
  const place = await liveAdGroupPlace(account.target, request.campaignId, request.adGroupId)
  const ads = place ? await liveAds(account.target, request.campaignId) : []
  return adsChangeDraft(customerResource(account.target), request, { place, ads })
}

const rsaUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AdsChangeRecord & Stamped
    if (!after.campaignId) return null
    const account = await recordAccount(after)
    if (!account) return null
    const byId = new Map((await liveAds(account.target, after.campaignId)).filter((a) => a.adGroupId === after.adGroupId).map((a) => [a.adId, a]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      created: (after.created ?? []).filter((c) => byId.has(c.adId)).map((c) => ({ adId: c.adId, status: byId.get(c.adId)!.status })),
      paused: (after.paused ?? []).filter((id) => byId.get(id)?.status === 'PAUSED'),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as AdsChangeRecord & Stamped
    if (!after.campaignId || !after.adGroupId) return { refusal: 'This change does not record the ad group it changed.' }
    if (after.paused?.length) {
      return { refusal: 'This change paused ads (the undo of ads made earlier): showing them again is an enable, which can spend money — ask for it as a change of its own.' }
    }
    const created = after.created ?? []
    if (created.some((c) => !isGoogleId(c.adId))) return { refusal: 'This change does not record the ids Google gave the ads it made: pause them in Google Ads.' }
    const enabled = created.filter((c) => c.status === 'ENABLED').map((c) => c.adId)
    if (!enabled.length) return { refusal: 'The ads this change made were made paused: they show nothing, so there is nothing to put back (remove them in Google Ads if they should go).' }
    return {
      tool: 'create-google-rsa',
      args: { ...accountArgOf(after), campaignId: after.campaignId, adGroupId: after.adGroupId, pauseAdIds: enabled, why: 'undo of ads made earlier: they are paused (Google keeps them, paused)' },
    }
  },
}

const adTextArg = (what: string, pins: readonly string[]) => z.object({
  text: z.string().trim().min(1).max(200).describe(`the ${what} text (Google counts its length: a double-width character counts 2)`),
  pin: z.preprocess(upper, z.enum(ALL_PINS)).optional()
    .describe(`pin it to one position (${pins.join(', ')}); leave out to let Google choose`),
})

const rsaArg = z.object({
  headlines: z.array(adTextArg('headline', HEADLINE_PINS)).max(RSA_LIMITS.maxHeadlines)
    .describe(`${RSA_LIMITS.minHeadlines} to ${RSA_LIMITS.maxHeadlines} headlines, each at most ${RSA_LIMITS.headlineWidth} characters, no two the same`),
  descriptions: z.array(adTextArg('description', DESCRIPTION_PINS)).max(RSA_LIMITS.maxDescriptions)
    .describe(`${RSA_LIMITS.minDescriptions} to ${RSA_LIMITS.maxDescriptions} descriptions, each at most ${RSA_LIMITS.descriptionWidth} characters, no two the same`),
  path1: z.string().trim().max(60).optional().describe(`first part of the display path after the domain (at most ${RSA_LIMITS.pathWidth} characters)`),
  path2: z.string().trim().max(60).optional().describe(`second part of the display path (at most ${RSA_LIMITS.pathWidth} characters; only with path1)`),
  finalUrl: z.string().trim().min(1).max(2048).describe('the page the ad leads to (one https address)'),
})

const createGoogleRsa: AgentTool = {
  name: 'create-google-rsa',
  title: 'Make Google responsive search ads',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Search campaign'),
    adGroupId: googleIdArg('the ad group of that campaign (a standard Search ad group)'),
    ads: z.array(rsaArg).min(1).max(RSA_LIMITS.adsPerRequest).optional()
      .describe(`responsive search ads to make in the ad group (1 to ${RSA_LIMITS.adsPerRequest}); give ads or pauseAdIds`),
    enable: z.boolean().optional()
      .describe('true: make them ENABLED even in an enabled ad group of an enabled campaign (SPENDS MONEY); false: make them PAUSED. Left out: ENABLED where nothing can serve yet, PAUSED where it could'),
    pauseAdIds: z.array(googleIdArg('an ad of this ad group')).max(50).optional()
      .describe('the undo form: pause these ads of the ad group (only ads, only a pause; give ads or pauseAdIds)'),
    why: googleWhyArg,
  }),
  description:
    'Make responsive search ads in ONE ad group of a Search campaign of the business\'s chosen Google Ads account (up to '
    + `${RSA_LIMITS.adsPerRequest} in one request): each with ${RSA_LIMITS.minHeadlines}–${RSA_LIMITS.maxHeadlines} headlines `
    + `(at most ${RSA_LIMITS.headlineWidth} characters each), ${RSA_LIMITS.minDescriptions}–${RSA_LIMITS.maxDescriptions} `
    + `descriptions (at most ${RSA_LIMITS.descriptionWidth}), an optional pin per text (HEADLINE_1/2/3, DESCRIPTION_1/2), `
    + `path1/path2 (at most ${RSA_LIMITS.pathWidth} each; path2 only with path1) and one https final URL. Google counts a `
    + 'double-width character (Chinese, Japanese, Korean) as 2. Every length, duplicate, pin or path problem is refused '
    + 'before the preview, all listed (which ad, which text, how long). Other campaign types are refused. A new ad cannot '
    + 'spend by itself: where the campaign or ad group is not enabled it is made ENABLED (nothing serves yet); in an '
    + 'enabled ad group of an enabled campaign it is made PAUSED unless enable: true (SPENDS MONEY). Google allows 3 '
    + 'enabled responsive search ads per ad group. After the run the answer gives the new ad ids; Google\'s policy review '
    + 'of them runs then — read it with google-ads-live view ads. Undo pauses the ads it made, through this tool\'s other '
    + 'form (pauseAdIds: pause ads of the ad group, nothing else).' + GOOGLE_CHANGE_RULES,
  undo: rsaUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildRsa(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildRsa(args), (draft, responses) => {
    const after = adsRecordAfterRun(draft.after as AdsChangeRecord, responses)
    if (after.paused.length) return { data: { campaignId: after.campaignId, adGroupId: after.adGroupId, pausedAdIds: after.paused }, before: draft.before, after }
    return {
      data: {
        campaignId: after.campaignId,
        adGroupId: after.adGroupId,
        adIds: after.created.map((c) => c.adId),
        status: after.created[0]?.status ?? null,
        review: `Google's policy review of the new ads runs now. Read it with google-ads-live view ads (campaignId ${after.campaignId}): each ad's approval and review status. Nexus does not wait for it.`,
      },
      before: draft.before,
      after,
    }
  }),
}

// ── set-google-assets ───────────────────────────────────────────────────────────────────────────────────────────

const assetsRequest = (args: Record<string, unknown>): AssetsChangeRequest => ({
  campaignId: String(args.campaignId),
  sitelinks: args.sitelinks as AssetsChangeRequest['sitelinks'],
  callouts: args.callouts as string[] | undefined,
  structuredSnippets: args.structuredSnippets as AssetsChangeRequest['structuredSnippets'],
  linkAssets: args.linkAssets as AssetsChangeRequest['linkAssets'],
  unlinkAssets: args.unlinkAssets as AssetsChangeRequest['unlinkAssets'],
})

const buildAssets = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = assetsRequest(args)
  const campaign = (await liveCampaigns(account.target)).find((c) => c.campaignId === request.campaignId) ?? null
  const linked = campaign ? await liveAssets(account.target, campaign.campaignId) : []
  const ids = [...new Set((request.linkAssets ?? []).map((r) => r.assetId))]
  const assets = campaign && ids.length ? await liveAssetsById(account.target, ids) : []
  return assetsChangeDraft(customerResource(account.target), request, { campaign, linked, assets })
}

const assetsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AssetsChangeRecord & Stamped
    if (!after.campaignId) return null
    const account = await recordAccount(after)
    if (!account) return null
    const on = new Set((await liveAssets(account.target, after.campaignId)).map((a) => `${a.assetId}~${a.fieldType}`))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      linked: (after.linked ?? []).filter((l) => on.has(`${l.assetId}~${l.fieldType}`)),
      unlinked: (after.unlinked ?? []).filter((l) => !on.has(`${l.assetId}~${l.fieldType}`)),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as AssetsChangeRecord & Stamped
    if (!after.campaignId) return { refusal: 'This change does not record the campaign it changed.' }
    const linked = after.linked ?? []
    const unlinked = after.unlinked ?? []
    if (linked.some((l) => !isGoogleId(l.assetId))) return { refusal: 'This change does not record the ids Google gave the assets it made: unlink them in Google Ads.' }
    if (!linked.length && !unlinked.length) return { refusal: 'This change linked and unlinked nothing: there is nothing to put back.' }
    const ref = (l: { assetId: string; fieldType: string }) => ({ assetId: l.assetId, fieldType: l.fieldType })
    return {
      tool: 'set-google-assets',
      args: {
        ...accountArgOf(after),
        campaignId: after.campaignId,
        ...(linked.length ? { unlinkAssets: linked.map(ref) } : {}),
        ...(unlinked.length ? { linkAssets: unlinked.map(ref) } : {}),
        why: `undo of an earlier asset change${linked.length ? ' (the assets it made stay in the account, unlinked)' : ''}`,
      },
    }
  },
}

const assetRefArg = z.object({
  assetId: googleIdArg('the asset'),
  fieldType: z.preprocess(upper, z.enum(ASSET_FIELD_TYPES)).describe('what it is in the campaign: SITELINK, CALLOUT or STRUCTURED_SNIPPET'),
})

const setGoogleAssets: AgentTool = {
  name: 'set-google-assets',
  title: 'Change Google campaign assets',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign'),
    sitelinks: z.array(z.object({
      linkText: z.string().trim().min(1).max(100).describe(`the link text (at most ${ASSET_LIMITS.linkText} characters)`),
      description1: z.string().trim().max(100).optional().describe(`first description line (at most ${ASSET_LIMITS.sitelinkDescription}; give both lines or neither)`),
      description2: z.string().trim().max(100).optional().describe(`second description line (at most ${ASSET_LIMITS.sitelinkDescription}; give both lines or neither)`),
      finalUrl: z.string().trim().min(1).max(2048).describe('the page the sitelink leads to (https)'),
    })).max(20).optional().describe('new sitelinks to make and link to the campaign (one with the same link text already linked: skipped)'),
    callouts: z.array(z.string().trim().min(1).max(100)).max(20).optional()
      .describe(`new callouts to make and link (each at most ${ASSET_LIMITS.callout} characters; one already linked: skipped)`),
    structuredSnippets: z.array(z.object({
      header: z.string().trim().min(1).max(60).describe(`a header from Google's list in the snippet's language (${SNIPPET_HEADER_NAMES.join(', ')} in English; their translation, e.g. "Tipi" in Italian — the English name is translated)`),
      language: z.string().trim().min(2).max(10).optional().describe('the language of the header and values, as Google names it (en, en-GB, it, de, fr, es, nl, …); default en'),
      values: z.array(z.string().trim().min(1).max(100)).max(ASSET_LIMITS.maxSnippetValues)
        .describe(`${ASSET_LIMITS.minSnippetValues} to ${ASSET_LIMITS.maxSnippetValues} values, each at most ${ASSET_LIMITS.snippetValue} characters, none repeated`),
    })).max(10).optional().describe('new structured snippets to make and link to the campaign'),
    linkAssets: z.array(assetRefArg).max(50).optional().describe('existing assets of the account to link to the campaign (again)'),
    unlinkAssets: z.array(assetRefArg).max(50).optional().describe('assets to unlink from the campaign: the link goes, the asset stays in the account (google-ads-live view assets lists them)'),
    why: googleWhyArg,
  }),
  description:
    'Campaign-level assets of ONE campaign of the business\'s chosen Google Ads account, in one request: make and link '
    + `sitelinks (link text at most ${ASSET_LIMITS.linkText} characters, two description lines of at most `
    + `${ASSET_LIMITS.sitelinkDescription} — both or neither — and an https final URL), callouts (at most ${ASSET_LIMITS.callout}) `
    + 'and structured snippets (a header from Google\'s fixed list in the snippet\'s language, '
    + `${ASSET_LIMITS.minSnippetValues}–${ASSET_LIMITS.maxSnippetValues} values of at most ${ASSET_LIMITS.snippetValue}, none `
    + 'repeated); link existing assets (linkAssets); unlink assets from the campaign by asset id and field type (the asset '
    + 'stays in the account; the ads show without it — said in the warnings). An asset already linked with the same text '
    + 'is skipped. Every length or header problem is refused before the preview, all listed. Assets raise no bid or '
    + 'budget. Google reviews new assets after the run (google-ads-live view assets). Undo unlinks what it linked and '
    + 'links again what it unlinked.' + GOOGLE_CHANGE_RULES,
  undo: assetsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildAssets(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildAssets(args), (draft, responses) => {
    const after = assetsRecordAfterRun(draft.after as AssetsChangeRecord, responses)
    return {
      data: {
        campaignId: after.campaignId,
        linked: after.linked,
        unlinked: after.unlinked,
        ...(after.linked.length ? { review: `Google reviews new assets now. Read it with google-ads-live view assets (campaignId ${after.campaignId}). Nexus does not wait for it.` } : {}),
      },
      before: draft.before,
      after,
    }
  }),
}

export const GOOGLE_ADS_ADS_ASSETS_TOOLS: AgentTool[] = [createGoogleRsa, setGoogleAssets]
