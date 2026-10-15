/**
 * Google Ads changes (2026-10-15, programme 2 group G3 "edit in place + URLs and tracking"). Every tool here is a Nexus
 * change: a preview Google has checked (validate_only), an approvalId, a person approves it in Nexus, it runs as that
 * person (google-ads-kit.ts). Never by rule.
 *
 *   edit-google-rsa          edit responsive search ads in place: headlines, descriptions, pins, paths, final URLs (the
 *                            ad keeps its id and its numbers)
 *   edit-google-assets       edit sitelinks, callouts and structured snippets in place (everywhere they are linked), or
 *                            replace them in one campaign (a new asset there, the old one unlinked there)
 *   set-google-urls          tracking template, final URL suffix and custom parameters of campaigns, ad groups, keywords
 *                            and ads; a keyword's own final URL and final mobile URL
 *   replace-google-keywords  a keyword's new text, match type or ad group: added anew and the old one REMOVED (Google
 *                            cannot change them) — only when the person asked (confirmRemove)
 *   move-google-ads          responsive search ads to another ad group: made again there and the old ones REMOVED — only
 *                            when the person asked (confirmRemove)
 *
 * The builders are in marketing/google-ads/change-edit-ads.ts, change-edit-assets.ts, change-urls.ts and
 * change-replace-keywords.ts (with what was checked in Google's v25 reference); the live reads in live-edit.ts.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, matchTypeArg, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import { DESCRIPTION_PINS, HEADLINE_PINS, httpsUrlProblem, isGoogleId, RSA_LIMITS } from '../../marketing/google-ads/change-ads.js'
import { ASSET_LIMITS } from '../../marketing/google-ads/change-assets.js'
import {
  adMoveDraft, adMoveRecordAfterRun, MAX_EDIT_ADS, MAX_MOVE_ADS, rsaEditDraft, rsaNow, type AdMoveRecord, type RsaEditEntry, type RsaEditRecord, type RsaEditRequest,
} from '../../marketing/google-ads/change-edit-ads.js'
import {
  assetEditDraft, assetEditRecordAfterRun, assetNow, MAX_EDIT_ASSETS,
  type AssetContent, type AssetEditRecord, type AssetEditRequest, type AssetReplaceBefore, type AssetReplaceRecord,
} from '../../marketing/google-ads/change-edit-assets.js'
import { MAX_URL_ITEMS, URL_LEVELS, urlsChangeDraft, urlsNow, type UrlItem, type UrlsLiveState, type UrlsRecord } from '../../marketing/google-ads/change-urls.js'
import {
  keywordReplaceDraft, keywordReplaceRecordAfterRun, MAX_REPLACE_KEYWORDS, type KeywordReplaceRecord, type KeywordReplaceRequest,
} from '../../marketing/google-ads/change-replace-keywords.js'
import { liveAssets, liveCampaigns } from '../../marketing/google-ads/live.js'
import { liveAdGroupPlace } from '../../marketing/google-ads/live-ads-assets.js'
import { liveAdGroups, liveCampaignKeywordMatchType } from '../../marketing/google-ads/live-keywords.js'
import {
  liveAdGroupAds, liveAdGroupUrls, liveAssetsForEdit, liveCampaignKeywordUrls, liveCampaignUrls, liveEditAds, liveEditAssets, liveKeywordUrls,
} from '../../marketing/google-ads/live-edit.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'
import type { GoogleAdsTarget } from '../../marketing/google-ads/types.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of replace-google-keywords' previews (its from → to table and sentences quote max CPCs; bidCents is in the shared registry). */
const GOOGLE_REPLACE_MONEY = { changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND } as const

/** A record as the run stamped it: the Google account it was made on (google-ads-kit runGoogleChange). */
type Stamped = { accountId?: string; customerId?: string }
const accountArgOf = (record: Stamped) => (record.accountId ? { accountId: record.accountId } : {})
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const PAIR = /^\d{1,20}~\d{1,20}$/
const DIGITS = /^\d{1,20}$/
/** Only the keys a record entry holds, read from what is there now (undo compares exactly those). */
function pick<T extends object>(now: T, keys: string[]): Partial<T> {
  return Object.fromEntries(keys.filter((k) => k in now).map((k) => [k, (now as Record<string, unknown>)[k]])) as Partial<T>
}
/** A record entry without the keys a tool does not take back as arguments. */
const omit = (entry: object, keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(entry).filter(([k]) => !keys.includes(k)))

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

const adPairArg = z.string().trim().regex(PAIR, 'an ad is adGroupId~adId').describe('the ad: adGroupId~adId (google-ads-live view ads shows both)')
const keywordPairArg = z.string().trim().regex(PAIR, 'a keyword is adGroupId~criterionId').describe('the keyword: adGroupId~criterionId (google-ads-live view campaign shows both)')

// ── edit-google-rsa ─────────────────────────────────────────────────────────────────────────────────────────────

const rsaTextArg = (what: string, pins: readonly string[]) => z.object({
  text: z.string().trim().min(1).max(200).describe(`the ${what} text (Google counts its length: a double-width character counts 2)`),
  pin: z.preprocess(upper, z.enum([...HEADLINE_PINS, ...DESCRIPTION_PINS])).optional().describe(`pin it to one position (${pins.join(', ')}); leave out to let Google choose`),
})

const rsaEditRequest = (args: Record<string, unknown>): RsaEditRequest => ({ ads: (args.ads as RsaEditRequest['ads']) ?? [] })

const buildRsaEdit = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = rsaEditRequest(args)
  const ads = request.ads.length ? await liveEditAds(account.target, request.ads.map((a) => a.id)) : []
  return rsaEditDraft(customerResource(account.target), request, { ads })
}

const rsaEditUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as RsaEditRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.ads?.length) return null
    const now = new Map((await liveEditAds(account.target, after.ads.map((a) => a.id))).map((a) => [a.id, rsaNow(a)]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      ads: after.ads.map((e) => (now.has(e.id) ? { ...pick(now.get(e.id)!, Object.keys(e)), id: e.id, campaignId: e.campaignId } : { id: e.id, removed: true })),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as RsaEditRecord & Stamped
    const ads = before.ads ?? []
    if (!ads.length) return { refusal: 'This change does not record what the ads read before it.' }
    for (const e of ads) {
      if (e.finalUrl !== undefined && (e.finalUrl === null || httpsUrlProblem('', e.finalUrl))) {
        return { refusal: `Ad ${e.id} had the final URL "${e.finalUrl ?? '(none)'}" before: Nexus sends https addresses only — put it back in Google Ads.` }
      }
    }
    return { tool: 'edit-google-rsa', args: { ...accountArgOf(before), ads: ads.map((e: RsaEditEntry) => omit(e, ['campaignId'])), why: 'undo of an earlier ad edit: the texts and URLs it replaced, back in place' } }
  },
}

const editGoogleRsa: AgentTool = {
  ...common,
  name: 'edit-google-rsa',
  title: 'Edit Google responsive search ads',
  reversibility: 'full',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    ads: z.array(z.object({
      id: adPairArg,
      headlines: z.array(rsaTextArg('headline', HEADLINE_PINS)).max(RSA_LIMITS.maxHeadlines).optional()
        .describe(`the WHOLE new list of headlines (${RSA_LIMITS.minHeadlines}–${RSA_LIMITS.maxHeadlines}, each at most ${RSA_LIMITS.headlineWidth} characters, no two the same); left out = unchanged`),
      descriptions: z.array(rsaTextArg('description', DESCRIPTION_PINS)).max(RSA_LIMITS.maxDescriptions).optional()
        .describe(`the WHOLE new list of descriptions (${RSA_LIMITS.minDescriptions}–${RSA_LIMITS.maxDescriptions}, each at most ${RSA_LIMITS.descriptionWidth} characters); left out = unchanged`),
      path1: z.string().trim().max(60).nullable().optional().describe(`first display path part (at most ${RSA_LIMITS.pathWidth} characters); null = none (then path2 null too)`),
      path2: z.string().trim().max(60).nullable().optional().describe(`second display path part (at most ${RSA_LIMITS.pathWidth}; only with path1); null = none`),
      finalUrl: z.string().trim().min(1).max(2048).optional().describe('the page the ad leads to (one https address)'),
      finalMobileUrl: z.string().trim().max(2048).nullable().optional().describe('a separate page for mobile (https); null = none (the final URL on every device)'),
    })).min(1).max(MAX_EDIT_ADS).describe(`responsive search ads to edit (1 to ${MAX_EDIT_ADS}); only the fields given change`),
    why: googleWhyArg,
  }),
  description:
    'Edit responsive search ads of the business\'s chosen Google Ads account IN PLACE: the whole list of headlines or '
    + 'descriptions (each with its pin, or none), path1 / path2, the final URL and a final mobile URL. The ad keeps its id, '
    + 'so its numbers stay with it; Google reviews the changed ad again (google-ads-live view ads). Only the fields given '
    + `change. Every length, duplicate, pin or path problem is refused before the preview (same rules as create-google-rsa). `
    + 'Other ad types are refused. Nothing here spends money. Undo puts the old texts and URLs back exactly.' + GOOGLE_CHANGE_RULES,
  undo: rsaEditUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildRsaEdit(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildRsaEdit(args), (draft) => {
    const after = draft.after as RsaEditRecord
    return {
      data: { ads: after.ads.map((a) => a.id), review: 'Google reviews the changed ads now. Read it with google-ads-live view ads. Nexus does not wait for it.' },
      before: draft.before,
      after,
    }
  }),
}

// ── edit-google-assets ──────────────────────────────────────────────────────────────────────────────────────────

const assetEditRequest = (args: Record<string, unknown>): AssetEditRequest => ({
  assets: (args.assets as AssetEditRequest['assets']) ?? [],
  onlyInCampaignId: args.onlyInCampaignId as string | undefined,
})

const buildAssetEdit = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = assetEditRequest(args)
  const live = request.assets.length ? await liveEditAssets(account.target, request.assets.map((a) => a.assetId)) : { assets: [], links: [] }
  return assetEditDraft(customerResource(account.target), request, live)
}

const assetEditUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as (AssetEditRecord | AssetReplaceRecord) & Stamped
    const account = await recordAccount(after)
    if (!account) return null
    const stamp = { accountId: account.accountId, customerId: account.customerId }
    if (after.mode === 'replace') {
      const on = new Set((await liveAssets(account.target, after.campaignId)).map((a) => `${a.assetId}~${a.fieldType}`))
      return {
        ...after,
        ...stamp,
        // An id Google never answered for (op:N) is passed through: request() then says why it cannot undo.
        replaced: after.replaced.filter((r) => !isGoogleId(r.newAssetId) || (on.has(`${r.newAssetId}~${r.fieldType}`) && !on.has(`${r.oldAssetId}~${r.fieldType}`))),
      }
    }
    if (after.mode !== 'edit' || !after.assets?.length) return null
    const now = new Map((await liveAssetsForEdit(account.target, after.assets.map((a) => a.assetId))).map((a) => [a.assetId, assetNow(a)]))
    return {
      ...after,
      ...stamp,
      assets: after.assets.map((e) => {
        const n = now.get(e.assetId)
        return n ? { ...pick(n, Object.keys(e)), assetId: e.assetId, type: e.type } : { assetId: e.assetId, removed: true }
      }),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as (AssetEditRecord | AssetReplaceRecord) & Stamped
    if (after.mode === 'replace') {
      const before = (change.before ?? {}) as AssetReplaceBefore
      if (after.replaced.some((r) => !isGoogleId(r.newAssetId))) return { refusal: 'This change does not record the ids Google gave the assets it made: link the old ones again in Google Ads.' }
      if (!after.replaced.length) return { refusal: 'This change replaced no asset: there is nothing to put back.' }
      return {
        tool: 'set-google-assets',
        args: {
          ...accountArgOf(after),
          campaignId: after.campaignId,
          linkAssets: (before.links ?? []).map((l) => ({ assetId: l.assetId, fieldType: l.fieldType, status: l.status })),
          unlinkAssets: after.replaced.map((r) => ({ assetId: r.newAssetId, fieldType: r.fieldType })),
          why: 'undo of an earlier asset replacement: the old assets linked again, the new ones unlinked (they stay in the account)',
        },
      }
    }
    const before = (change.before ?? {}) as AssetEditRecord & Stamped
    if (before.mode !== 'edit' || !before.assets?.length) return { refusal: 'This change does not record what the assets read before it.' }
    const back: Array<Record<string, unknown>> = []
    for (const e of before.assets as AssetContent[]) {
      // The type is read from the asset itself; a language goes back only with its header.
      const fields = omit(e, ['type', 'language']) as Partial<AssetContent>
      if (e.header !== undefined) {
        if (!e.header || !e.language) return { refusal: `Asset ${e.assetId}: Nexus does not know the language of its old header "${e.header ?? ''}" — put it back in Google Ads.` }
        fields.language = e.language
      }
      if (fields.finalUrl !== undefined && (fields.finalUrl === null || httpsUrlProblem('', fields.finalUrl))) {
        return { refusal: `Asset ${e.assetId} had the final URL "${fields.finalUrl ?? '(none)'}" before: Nexus sends https addresses only — put it back in Google Ads.` }
      }
      if (fields.linkText === null || fields.calloutText === null) return { refusal: `Asset ${e.assetId} had no text before: there is nothing to put back.` }
      back.push(fields)
    }
    return { tool: 'edit-google-assets', args: { ...accountArgOf(before), assets: back, why: 'undo of an earlier asset edit: the texts and URLs it replaced, back in place' } }
  },
}

const editGoogleAssets: AgentTool = {
  ...common,
  name: 'edit-google-assets',
  title: 'Edit Google Ads assets',
  reversibility: 'full',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    assets: z.array(z.object({
      assetId: googleIdArg('the asset'),
      linkText: z.string().trim().min(1).max(100).optional().describe(`a sitelink's link text (at most ${ASSET_LIMITS.linkText} characters)`),
      description1: z.string().trim().max(100).nullable().optional().describe(`a sitelink's first description line (at most ${ASSET_LIMITS.sitelinkDescription}); null = none (both lines, or neither)`),
      description2: z.string().trim().max(100).nullable().optional().describe(`a sitelink's second description line (at most ${ASSET_LIMITS.sitelinkDescription}); null = none`),
      finalUrl: z.string().trim().min(1).max(2048).optional().describe('a sitelink\'s page (https)'),
      calloutText: z.string().trim().min(1).max(100).optional().describe(`a callout's text (at most ${ASSET_LIMITS.callout} characters)`),
      header: z.string().trim().min(1).max(60).optional().describe('a structured snippet\'s header, from Google\'s list in its language (the English name is translated)'),
      language: z.string().trim().min(2).max(10).optional().describe('the language of the header (en, it, de, …); default the language of the header it has now'),
      values: z.array(z.string().trim().min(1).max(100)).max(ASSET_LIMITS.maxSnippetValues).optional()
        .describe(`a structured snippet's WHOLE new list of values (${ASSET_LIMITS.minSnippetValues}–${ASSET_LIMITS.maxSnippetValues}, each at most ${ASSET_LIMITS.snippetValue}, none repeated)`),
    })).min(1).max(MAX_EDIT_ASSETS).describe(`sitelinks, callouts and structured snippets to change (1 to ${MAX_EDIT_ASSETS}), by asset id (google-ads-live view assets); only the fields given change`),
    onlyInCampaignId: googleIdArg('a campaign the assets are linked to').optional()
      .describe('replace the assets in this one campaign only: a new asset with the edited text is linked there (the old link\'s status) and the old one unlinked there; it stays wherever else it is linked. Left out: the assets are edited in place, everywhere they are linked'),
    why: googleWhyArg,
  }),
  description:
    'Change sitelinks (link text, description lines, final URL), callouts (text) and structured snippets (header, values) '
    + 'of the business\'s chosen Google Ads account. In place (default): the asset keeps its id and numbers and changes '
    + 'EVERYWHERE it is linked — the preview names every campaign, ad group or account link. With onlyInCampaignId: the '
    + 'assets are replaced in that campaign only (a new asset linked, the old one unlinked there and kept elsewhere; the new '
    + 'one starts from nothing) — also the way for an asset Google made, which Google does not let anyone change. Every '
    + 'length or header problem is refused before the preview. Nothing here spends money. Undo puts the old texts back '
    + '(in place), or links the old assets again and unlinks the new ones (replace).' + GOOGLE_CHANGE_RULES,
  undo: assetEditUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildAssetEdit(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildAssetEdit(args), (draft, responses) => {
    const after = assetEditRecordAfterRun(draft.after as AssetEditRecord | AssetReplaceRecord, responses)
    return {
      data: {
        ...(after.mode === 'replace' ? { campaignId: after.campaignId, replaced: after.replaced } : { assets: after.assets.map((a) => a.assetId) }),
        review: 'Google reviews the changed (or new) assets now. Read it with google-ads-live view assets. Nexus does not wait for it.',
      },
      before: draft.before,
      after,
    }
  }),
}

// ── set-google-urls ─────────────────────────────────────────────────────────────────────────────────────────────

const urlsRequest = (args: Record<string, unknown>): UrlItem[] => (args.items as UrlItem[] | undefined) ?? []

/** Each level's items read live (one query per level asked), or why an id cannot be one of that level. */
async function urlsLive(target: GoogleAdsTarget, items: Array<{ level: UrlItem['level']; id: string }>): Promise<UrlsLiveState | { refusal: string }> {
  for (const i of items) {
    const pair = i.level === 'keyword' || i.level === 'ad'
    if (pair ? !PAIR.test(i.id) : !DIGITS.test(i.id)) {
      return { refusal: `${i.level} "${i.id}": ${i.level === 'keyword' ? 'a keyword is adGroupId~criterionId' : i.level === 'ad' ? 'an ad is adGroupId~adId' : 'give its Google id (digits)'}.` }
    }
  }
  const ids = (level: string) => [...new Set(items.filter((i) => i.level === level).map((i) => i.id))]
  return {
    campaigns: ids('campaign').length ? await liveCampaignUrls(target, ids('campaign')) : [],
    adGroups: ids('ad-group').length ? await liveAdGroupUrls(target, ids('ad-group')) : [],
    keywords: ids('keyword').length ? await liveKeywordUrls(target, ids('keyword')) : [],
    ads: ids('ad').length ? await liveEditAds(target, ids('ad')) : [],
  }
}

const buildUrls = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const items = urlsRequest(args)
  if (items.length > MAX_URL_ITEMS) return { refusal: `At most ${MAX_URL_ITEMS} items in one request (${items.length} asked).` }
  const live = await urlsLive(account.target, items)
  if ('refusal' in live) return live
  return urlsChangeDraft(customerResource(account.target), { items }, live)
}

const urlsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as UrlsRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.items?.length) return null
    const live = await urlsLive(account.target, after.items)
    if ('refusal' in live) return null
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      items: after.items.map((e) => {
        const now = urlsNow(e, live)
        return now ? { ...pick(now, Object.keys(e)), level: e.level, id: e.id } : { level: e.level, id: e.id, removed: true }
      }),
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as UrlsRecord & Stamped
    const items = before.items ?? []
    if (!items.length) return { refusal: 'This change does not record the URLs it replaced.' }
    for (const i of items) {
      for (const url of [i.finalUrl, i.finalMobileUrl]) {
        if (url && httpsUrlProblem('', url)) return { refusal: `${i.level} ${i.id} had the URL "${url}" before: Nexus sends https addresses only — put it back in Google Ads.` }
      }
    }
    return { tool: 'set-google-urls', args: { ...accountArgOf(before), items, why: 'undo of an earlier URL and tracking change: the old values back (none where there was none)' } }
  },
}

const setGoogleUrls: AgentTool = {
  ...common,
  name: 'set-google-urls',
  title: 'Change Google Ads URLs and tracking',
  reversibility: 'full',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    items: z.array(z.object({
      level: z.enum(URL_LEVELS).describe('campaign, ad-group, keyword or ad'),
      id: z.string().trim().regex(/^\d{1,20}(~\d{1,20})?$/).describe('campaign / ad group: its id; keyword: adGroupId~criterionId; ad: adGroupId~adId'),
      trackingTemplate: z.string().trim().max(2048).nullable().optional().describe('the tracking template (starts with http://, https:// or {lpurl}); null = none at this level'),
      finalUrlSuffix: z.string().trim().max(2048).nullable().optional().describe('the final URL suffix (key=value&key2=value2, no "?" first); null = none at this level'),
      customParameters: z.array(z.object({
        key: z.string().trim().min(1).max(64).describe('the name, letters and digits only (at most 16); a URL uses it as {_name}'),
        value: z.string().trim().min(1).max(1000).describe('its value (at most 250 characters)'),
      })).max(20).nullable().optional().describe('the WHOLE new list of custom parameters (Google allows 8 at a level); null or [] = none'),
      finalUrl: z.string().trim().max(2048).nullable().optional().describe('keywords only: the keyword\'s own landing page (https; it wins over the ad\'s); null = none'),
      finalMobileUrl: z.string().trim().max(2048).nullable().optional().describe('keywords only: its own page for mobile (https); null = none'),
    })).min(1).max(MAX_URL_ITEMS).describe(`what to change (1 to ${MAX_URL_ITEMS} items); only the fields given change`),
    why: googleWhyArg,
  }),
  description:
    'URLs and tracking of the business\'s chosen Google Ads account, at campaign, ad group, keyword and ad level: the '
    + 'tracking template, the final URL suffix and the custom parameters (up to 8 a level; a URL uses them as {_name}); '
    + 'and a keyword\'s own final URL and final mobile URL. The most specific level wins (ad over keyword over ad group '
    + 'over campaign); null takes a value away, so the level above applies. An ad\'s final URLs: edit-google-rsa. All in '
    + 'one request. Google says a tracking template change can take 24–48 hours to reach the ads that serve. Nothing here '
    + 'spends money; taking tracking away is said in the warnings. Undo puts the old values back exactly.' + GOOGLE_CHANGE_RULES,
  undo: urlsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildUrls(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildUrls(args), (draft) => {
    const after = draft.after as UrlsRecord
    return { data: { items: after.items.map((i) => ({ level: i.level, id: i.id })) }, before: draft.before, after }
  }),
}

// ── replace-google-keywords ─────────────────────────────────────────────────────────────────────────────────────

const replaceRequest = (args: Record<string, unknown>): KeywordReplaceRequest => ({
  campaignId: String(args.campaignId ?? ''),
  keywords: (args.keywords as KeywordReplaceRequest['keywords']) ?? [],
  allowBroad: args.allowBroad === true,
})

const buildReplace = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = replaceRequest(args)
  const campaigns = await liveCampaigns(account.target)
  const there = campaigns.some((c) => c.campaignId === request.campaignId)
  const adGroups = there ? await liveAdGroups(account.target, request.campaignId) : []
  const keywords = there ? await liveCampaignKeywordUrls(account.target, request.campaignId) : []
  const keywordMatchType = there ? await liveCampaignKeywordMatchType(account.target, request.campaignId) : null
  return keywordReplaceDraft(customerResource(account.target), account.currency, request, { campaigns, adGroups, keywords, keywordMatchType })
}

const replaceUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as KeywordReplaceRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.campaignId) return null
    const byId = new Map((await liveCampaignKeywordUrls(account.target, after.campaignId)).filter((k) => !k.negative).map((k) => [k.id, k]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      // An id Google never answered for (new:N) is passed through: request() then says why it cannot undo. A new keyword
      // counts as untouched while its status and max CPC are what the change gave it.
      replaced: (after.replaced ?? []).filter((r) => {
        if (!PAIR.test(r.to.keywordId)) return true
        const k = byId.get(r.to.keywordId)
        return !!k && k.status === r.status && k.cpcBidCents === r.bidCents
      }),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as KeywordReplaceRecord & Stamped
    const replaced = after.replaced ?? []
    if (!replaced.length) return { refusal: 'This change replaced no keyword: there is nothing to put back.' }
    if (replaced.some((r) => !PAIR.test(r.to.keywordId))) return { refusal: 'This change does not record the id Google gave every keyword it added.' }
    return {
      tool: 'replace-google-keywords',
      args: {
        ...accountArgOf(after),
        campaignId: after.campaignId,
        keywords: replaced.map((r) => ({
          keywordId: r.to.keywordId,
          ...(r.from.text !== r.to.text ? { text: r.from.text } : {}),
          ...(r.from.matchType !== r.to.matchType ? { matchType: r.from.matchType } : {}),
          ...(r.from.adGroupId !== r.to.adGroupId ? { toAdGroupId: r.from.adGroupId } : {}),
        })),
        ...(replaced.some((r) => r.from.matchType === 'BROAD') ? { allowBroad: true } : {}),
        // The person asked for this undo: replacing back removes the keywords the change added (their numbers stay with them).
        confirmRemove: true,
        why: 'undo of an earlier keyword replacement: the old texts, match types and ad groups back (as new keywords)',
      },
    }
  },
}

const replaceGoogleKeywords: AgentTool = {
  ...common,
  name: 'replace-google-keywords',
  title: 'Replace or move Google Ads keywords',
  // The texts, match types and places go back; the numbers stay with the removed keywords.
  reversibility: 'partial',
  requires: [F.adsBidsEdit, F.adsCampaignsManage, ADSPEND],
  restrictedFields: GOOGLE_REPLACE_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Search campaign'),
    keywords: z.array(z.object({
      keywordId: keywordPairArg,
      text: z.string().trim().min(1).max(80).optional().describe('its new text (at most 80 characters, 10 words); left out = the same'),
      matchType: matchTypeArg.optional().describe('its new match type: EXACT, PHRASE or BROAD (BROAD only with allowBroad); left out = the same'),
      toAdGroupId: googleIdArg('another standard Search ad group of the same campaign').optional().describe('move it into this ad group (same campaign); left out = the same ad group'),
    })).min(1).max(MAX_REPLACE_KEYWORDS).describe(`keywords to replace or move (1 to ${MAX_REPLACE_KEYWORDS}); each changes text, match type, ad group or several`),
    allowBroad: z.boolean().optional().describe('true allows a BROAD match result (it matches many more searches)'),
    confirmRemove: z.literal(true).describe('true: the person asked for this — each old keyword is REMOVED (its numbers stay with it)'),
    why: googleWhyArg,
  }),
  description:
    'Change a keyword\'s text, match type or ad group (within ONE Search campaign) — which Google cannot change: each is '
    + 'added anew with the old one\'s own max CPC, status, final URLs and tracking, and the old one is REMOVED, in one '
    + 'request. Use it ONLY when the person asked for that replacement (confirmRemove true). The numbers (clicks, cost, '
    + 'conversions, Quality Score history) and labels stay with the removed keyword; the new one starts from nothing. A '
    + 'new keyword that can serve at once, a wider match type, and a higher ad group default max CPC are marked SPENDS '
    + 'MONEY. Undo replaces back the same way (new keywords again).' + GOOGLE_CHANGE_RULES,
  undo: replaceUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildReplace(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildReplace(args), (draft, responses) => {
    const after = keywordReplaceRecordAfterRun(draft.after as KeywordReplaceRecord, responses)
    return {
      data: { replaced: after.replaced.map((r) => ({ from: r.from.keywordId, to: r.to.keywordId, text: r.to.text, matchType: r.to.matchType, adGroupId: r.to.adGroupId, status: r.status })) },
      before: draft.before,
      after,
    }
  }),
}

// ── move-google-ads ─────────────────────────────────────────────────────────────────────────────────────────────

const buildMove = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const campaignId = String(args.campaignId ?? '')
  const adGroupId = String(args.adGroupId ?? '')
  const toAdGroupId = String(args.toAdGroupId ?? '')
  const from = await liveAdGroupPlace(account.target, campaignId, adGroupId)
  const to = from ? await liveAdGroupPlace(account.target, campaignId, toAdGroupId) : null
  const fromAds = from && to ? await liveAdGroupAds(account.target, adGroupId) : []
  const toAds = from && to ? await liveAdGroupAds(account.target, toAdGroupId) : []
  return adMoveDraft(customerResource(account.target), { campaignId, adGroupId, toAdGroupId, adIds: (args.adIds as string[] | undefined) ?? [] }, { from, to, fromAds, toAds })
}

const moveUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AdMoveRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.toAdGroupId) return null
    const there = new Map((await liveAdGroupAds(account.target, after.toAdGroupId)).map((a) => [a.adId, a]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      moved: (after.moved ?? []).filter((m) => !isGoogleId(m.toAdId) || there.get(m.toAdId)?.status === m.status),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as AdMoveRecord & Stamped
    const moved = after.moved ?? []
    if (!moved.length) return { refusal: 'This change moved no ad: there is nothing to put back.' }
    if (moved.some((m) => !isGoogleId(m.toAdId))) return { refusal: 'This change does not record the ids Google gave the ads it made.' }
    return {
      tool: 'move-google-ads',
      args: {
        ...accountArgOf(after),
        campaignId: after.campaignId,
        adGroupId: after.toAdGroupId,
        toAdGroupId: after.fromAdGroupId,
        adIds: moved.map((m) => m.toAdId),
        // The person asked for this undo: moving back removes the ads the change made (their numbers stay with them).
        confirmRemove: true,
        why: 'undo of an earlier ad move: the ads back in their ad group (as new ads)',
      },
    }
  },
}

const moveGoogleAds: AgentTool = {
  ...common,
  name: 'move-google-ads',
  title: 'Move Google responsive search ads',
  // The ads go back; their numbers stay with the removed ones.
  reversibility: 'partial',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Search campaign'),
    adGroupId: googleIdArg('the ad group the ads are in now'),
    toAdGroupId: googleIdArg('the standard Search ad group of the same campaign they move to'),
    adIds: z.array(googleIdArg('an ad of adGroupId')).min(1).max(MAX_MOVE_ADS).describe(`the responsive search ads to move (1 to ${MAX_MOVE_ADS})`),
    confirmRemove: z.literal(true).describe('true: the person asked for this — each ad is REMOVED from its ad group (its numbers stay with it)'),
    why: googleWhyArg,
  }),
  description:
    'Move responsive search ads from one ad group to another of the same Search campaign. Google cannot move an ad: each '
    + 'is made again in the other ad group (same texts, pins, paths, URLs and tracking, same status) and REMOVED from its '
    + 'ad group, in one request. Use it ONLY when the person asked for that move (confirmRemove true). The numbers stay '
    + 'with the removed ads; the new ones start from nothing and Google reviews them. Google allows 3 enabled responsive '
    + 'search ads per ad group. An enabled ad moved into an enabled ad group of the enabled campaign is marked SPENDS '
    + 'MONEY. Undo moves them back the same way (new ads again).' + GOOGLE_CHANGE_RULES,
  undo: moveUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildMove(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildMove(args), (draft, responses) => {
    const after = adMoveRecordAfterRun(draft.after as AdMoveRecord, responses)
    return { data: { campaignId: after.campaignId, toAdGroupId: after.toAdGroupId, moved: after.moved }, before: draft.before, after }
  }),
}

export const GOOGLE_ADS_EDIT_TOOLS: AgentTool[] = [editGoogleRsa, editGoogleAssets, setGoogleUrls, replaceGoogleKeywords, moveGoogleAds]
