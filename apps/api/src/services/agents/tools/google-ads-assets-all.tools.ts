/**
 * Google Ads changes (2026-10-15, programme 2 group G6 "every asset type, at every level"). Every tool here is a Nexus
 * change: a preview Google has checked (validate_only), an approvalId, a person approves it in Nexus, it runs as that
 * person (google-ads-kit.ts). Never by rule.
 *
 *   add-google-assets       make assets of every type Nexus makes — images (from an https link or the Nexus image
 *                           library), business name, call, price, promotion, lead form, app link, sitelink, callout,
 *                           structured snippet — and link them at the account, at campaigns and at ad groups
 *   set-google-asset-links  existing assets: link at the account, a campaign or an ad group; pause or enable a link;
 *                           unlink (the asset stays in the account)
 *
 * The builders are in marketing/google-ads/change-assets-all.ts (with what was checked in Google's v25 reference, and
 * why location assets are not made here), the live reads in live-assets-all.ts, the image fetch in asset-images.ts.
 * set-google-assets (PR 5) keeps the campaign-level sitelinks, callouts and snippets; edit-google-assets (G3) edits them.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange, type GoogleDraftBuilder,
} from './google-ads-kit.js'
import { isGoogleId } from '../../marketing/google-ads/change-ads.js'
import { ASSET_LIMITS, SNIPPET_HEADER_NAMES } from '../../marketing/google-ads/change-assets.js'
import {
  APP_STORES, assetLinksDraft, IMAGE_FIELD_TYPES, LEAD_FORM_CTAS, LEAD_FORM_INTENTS, LEAD_FORM_POST_SUBMIT_CTAS, LINK_ACTIONS,
  LINK_FIELD_TYPES, LINK_LEVELS, linksUndoItems, MAX_IMAGE_BYTES_TOTAL, MAX_LINK_ITEMS, MAX_NEW_ASSETS, MAX_PLACES, newAssetsDraft, newAssetsRecordAfterRun,
  PRICE_QUALIFIERS, PRICE_TYPES, PRICE_UNITS, PROMOTION_OCCASIONS, UPLOAD_ONLY_IMAGES,
  type AssetPlace, type LinkItemRequest, type LinksRecord, type NewAssetsRecord, type NewAssetsRequest,
} from '../../marketing/google-ads/change-assets-all.js'
import { liveCampaigns } from '../../marketing/google-ads/live.js'
import {
  liveAdGroupsById, liveAssetDetails, liveLeadFormTerms, livePlaceLinks, placeLinkKey, type LinkFilter, type LinkLevel,
} from '../../marketing/google-ads/live-assets-all.js'
import { prepareImage, type PreparedImage } from '../../marketing/google-ads/asset-images.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'
import type { GoogleAdsTarget } from '../../marketing/google-ads/types.js'

/** A record as the run stamped it: the Google account it was made on (google-ads-kit runGoogleChange). */
type Stamped = { accountId?: string; customerId?: string }
const accountArgOf = (record: Stamped) => (record.accountId ? { accountId: record.accountId } : {})
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const unique = (ids: Array<string | null | undefined>) => [...new Set(ids.filter((id): id is string => !!id))]

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

/** The places a set of links stands at, as the live read takes them. */
function placesOf(items: Array<{ level: LinkLevel; campaignId?: string | null; adGroupId?: string | null }>) {
  return {
    account: items.some((i) => i.level === 'account'),
    campaignIds: unique(items.filter((i) => i.level === 'campaign').map((i) => i.campaignId)),
    adGroupIds: unique(items.filter((i) => i.level === 'ad-group').map((i) => i.adGroupId)),
  }
}

/** The links at those places now (of the assets or field types asked); nothing when no place is named. */
async function linksAt(target: GoogleAdsTarget, items: Array<{ level: LinkLevel; campaignId?: string | null; adGroupId?: string | null }>, filter: LinkFilter) {
  const places = placesOf(items)
  if (!places.account && !places.campaignIds.length && !places.adGroupIds.length) return []
  if ((filter.assetIds && !filter.assetIds.length) || (filter.fieldTypes && !filter.fieldTypes.length)) return []
  return livePlaceLinks(target, places, filter)
}

const placeArg = z.object({
  level: z.preprocess(lower, z.enum(LINK_LEVELS)).describe('account (every campaign of the account), campaign or ad-group'),
  campaignId: googleIdArg('the campaign (level campaign; optional for ad-group, then checked)').optional(),
  adGroupId: googleIdArg('the ad group (level ad-group)').optional(),
})

/** A library image needs the image library permission (as image-library itself does). */
function libraryRefusal(args: Record<string, unknown>, ctx: ToolContext): ToolResult | null {
  const usesLibrary = ((args.images as Array<{ libraryImageId?: string }> | undefined) ?? []).some((i) => !!i.libraryImageId)
  return usesLibrary && !ctx.can(F.assetsManage) ? { ok: false, error: `An image from the Nexus image library needs the ${F.assetsManage} permission (as image-library does). Give imageUrl instead, or ask a person who has it.` } : null
}

// ── add-google-assets ───────────────────────────────────────────────────────────────────────────────────────────

const newRequest = (args: Record<string, unknown>): NewAssetsRequest => ({
  images: args.images as NewAssetsRequest['images'],
  businessNames: args.businessNames as string[] | undefined,
  calls: args.calls as NewAssetsRequest['calls'],
  prices: args.prices as NewAssetsRequest['prices'],
  promotions: args.promotions as NewAssetsRequest['promotions'],
  leadForms: args.leadForms as NewAssetsRequest['leadForms'],
  mobileApps: args.mobileApps as NewAssetsRequest['mobileApps'],
  sitelinks: args.sitelinks as NewAssetsRequest['sitelinks'],
  callouts: args.callouts as string[] | undefined,
  structuredSnippets: args.structuredSnippets as NewAssetsRequest['structuredSnippets'],
  linkTo: args.linkTo as AssetPlace[] | undefined,
  enable: args.enable === true,
})

/** The field types a request makes and links (upload-only images are linked nowhere). */
function linkedFieldTypes(r: NewAssetsRequest): string[] {
  const out = new Set<string>()
  for (const i of r.images ?? []) if (!UPLOAD_ONLY_IMAGES.includes(i.fieldType)) out.add(i.fieldType)
  const kinds: Array<[unknown[] | undefined, string]> = [
    [r.businessNames, 'BUSINESS_NAME'], [r.calls, 'CALL'], [r.prices, 'PRICE'], [r.promotions, 'PROMOTION'], [r.leadForms, 'LEAD_FORM'],
    [r.mobileApps, 'MOBILE_APP'], [r.sitelinks, 'SITELINK'], [r.callouts, 'CALLOUT'], [r.structuredSnippets, 'STRUCTURED_SNIPPET'],
  ]
  for (const [list, fieldType] of kinds) if (list?.length) out.add(fieldType)
  return [...out]
}

const buildNew = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = newRequest(args)
  const places = request.linkTo ?? []
  const campaigns = await liveCampaigns(account.target)
  const adGroups = await liveAdGroupsById(account.target, unique(places.filter((p) => p.level === 'ad-group').map((p) => p.adGroupId)))
  const fieldTypes = linkedFieldTypes(request)
  // Only places that exist are read (a place that does not is refused by the builder).
  const known = places.filter((p) => p.level === 'account'
    || (p.level === 'campaign' && campaigns.some((c) => c.campaignId === p.campaignId))
    || (p.level === 'ad-group' && adGroups.some((g) => g.adGroupId === p.adGroupId)))
  const links = await linksAt(account.target, known, { fieldTypes })
  // One image at a time: each is at most 5 MB, and nothing is sent to Google before all are read. Once the images read
  // pass what one request carries, the rest are not fetched (the builder refuses the request and says so).
  const images: Array<PreparedImage | { problem: string }> = []
  let imageBytes = 0
  for (const image of request.images ?? []) {
    if (imageBytes > MAX_IMAGE_BYTES_TOTAL) { images.push({ problem: 'not read: the images before it already pass what one request carries' }); continue }
    const got = await prepareImage(image)
    if (!('problem' in got)) imageBytes += got.bytes
    images.push(got)
  }
  const leadFormTerms = request.leadForms?.length ? await liveLeadFormTerms(account.target) : null
  return newAssetsDraft(customerResource(account.target), account.currency, request, { campaigns, adGroups, links, images, leadFormTerms })
}

const placeOfLink = (l: { level: LinkLevel; campaignId: string | null; adGroupId: string | null }) =>
  ({ level: l.level, ...(l.level === 'campaign' ? { campaignId: l.campaignId } : {}), ...(l.level === 'ad-group' ? { adGroupId: l.adGroupId } : {}) })

const newUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as NewAssetsRecord & Stamped
    const account = await recordAccount(after)
    if (!account) return null
    const linked = after.linked ?? []
    const ids = unique(linked.filter((l) => isGoogleId(l.assetId)).map((l) => l.assetId))
    const now = new Map((await linksAt(account.target, linked, { assetIds: ids })).map((l) => [placeLinkKey(l), l.status]))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      // An id Google never answered for (op:N) is passed through as it is: request() then says why it cannot undo.
      linked: linked.filter((l) => !isGoogleId(l.assetId) || now.get(placeLinkKey(l)) === l.status),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as NewAssetsRecord & Stamped
    const linked = after.linked ?? []
    if (linked.some((l) => !isGoogleId(l.assetId))) return { refusal: 'This change does not record the ids Google gave the assets it made: unlink them in Google Ads.' }
    if (!linked.length) return { refusal: 'This change only made assets, linked nowhere: Google never removes an asset, and one linked nowhere does nothing — there is nothing to put back.' }
    return {
      tool: 'set-google-asset-links',
      args: {
        ...accountArgOf(after),
        items: linked.map((l) => ({ ...placeOfLink(l), assetId: l.assetId, fieldType: l.fieldType, action: 'unlink' })),
        why: 'undo of assets made earlier: their links are taken off (Google keeps the assets, linked nowhere)',
      },
    }
  },
}

const textArg = (what: string, max = 200) => z.string().trim().min(1).max(max).describe(what)
const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(`${what} (YYYY-MM-DD)`)
const httpsArg = (what: string) => z.string().trim().min(1).max(2048).describe(`${what} (https)`)

const addGoogleAssets: AgentTool = {
  ...common,
  name: 'add-google-assets',
  title: 'Make Google Ads assets of any type',
  // Undo unlinks what it linked; Google never removes an asset (it stays in the account, linked nowhere).
  reversibility: 'partial',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    images: z.array(z.object({
      fieldType: z.preprocess(upper, z.enum(IMAGE_FIELD_TYPES)).describe('what the image is for: AD_IMAGE (an image on Search ads: square 1:1 at least 300×300, or landscape 1.91:1 at least 600×314; JPG or PNG; campaign or ad group), BUSINESS_LOGO (Search: square, at least 128×128; account or campaign), LOGO (square, 128×128) or LANDSCAPE_LOGO (4:1, 512×128) for a Performance Max campaign with brand guidelines (campaign), MARKETING_IMAGE (1.91:1), SQUARE_MARKETING_IMAGE (1:1) or PORTRAIT_MARKETING_IMAGE (4:5): made only, for Performance Max asset groups and display ads'),
      imageUrl: z.string().trim().min(1).max(2048).optional().describe('the image\'s https link (a public address; JPG, PNG or GIF, at most 5120 KB); give imageUrl or libraryImageId'),
      libraryImageId: z.string().trim().min(3).max(80).optional().describe('an image of the Nexus image library (its id from image-library: da_… or pi_…); needs the image library permission'),
      name: z.string().trim().min(1).max(120).optional().describe('the asset\'s name in Google Ads (default: the library label or file name and a short fingerprint)'),
    })).max(10).optional().describe('new image assets (Google checks each image\'s shape where it is linked)'),
    businessNames: z.array(textArg('the business name (at most 25 characters; it must match the verified legal name or the domain)', 100)).max(3).optional()
      .describe('new BUSINESS_NAME text assets (account or campaign)'),
    calls: z.array(z.object({
      countryCode: z.string().trim().min(2).max(2).describe('the phone number\'s country, two letters (IT, DE, …)'),
      phoneNumber: z.string().trim().min(3).max(40).describe('the phone number as people dial it'),
      callConversion: z.preprocess(upper, z.enum(['ACCOUNT', 'OFF'])).optional().describe('call conversions: ACCOUNT (the account\'s call conversion setting) or OFF; left out = Google\'s default'),
      conversionActionId: googleIdArg('a call conversion action of the account to count calls as (instead of callConversion)').optional(),
    })).max(5).optional().describe('new CALL assets: a phone number shown with the ads (a call from the ad is charged like a click)'),
    prices: z.array(z.object({
      priceType: z.preprocess(upper, z.enum(PRICE_TYPES)).describe(`the price asset's type: ${PRICE_TYPES.join(', ')}`),
      qualifier: z.preprocess(upper, z.enum(PRICE_QUALIFIERS)).optional().describe('FROM, UP_TO or AVERAGE (left out: none)'),
      languageCode: z.string().trim().min(2).max(20).describe('the language of the texts (en, it, de, …)'),
      currency: z.string().trim().length(3).optional().describe('the prices\' currency (ISO 4217); default the account\'s'),
      offerings: z.array(z.object({
        header: textArg('the offering\'s header (at most 25 characters)', 100),
        description: textArg('its description (at most 25 characters; not the same as the header)', 100),
        priceCents: z.coerce.number().int().min(0).max(1_000_000_000).describe('its price in minor units (cents)'),
        unit: z.preprocess(upper, z.enum(PRICE_UNITS)).optional().describe('PER_HOUR, PER_DAY, PER_WEEK, PER_MONTH, PER_YEAR or PER_NIGHT (left out: none)'),
        finalUrl: httpsArg('the page it leads to'),
        finalMobileUrl: z.string().trim().max(2048).optional().describe('a page for mobile (https)'),
      })).max(8).describe('3 to 8 offerings'),
    })).max(3).optional().describe('new PRICE assets'),
    promotions: z.array(z.object({
      target: textArg('what is on promotion (e.g. "Winter jackets")', 100),
      percentOff: z.coerce.number().positive().max(99.9).optional().describe('percent off (e.g. 15 or 12.5); give percentOff or amountOffCents'),
      amountOffCents: z.coerce.number().int().min(1).max(1_000_000_000).optional().describe('money off, in minor units (cents)'),
      upTo: z.boolean().optional().describe('true: "up to" the discount'),
      currency: z.string().trim().length(3).optional().describe('the currency of the amounts (ISO 4217); default the account\'s'),
      promotionCode: z.string().trim().min(1).max(50).optional().describe('a code to use (give promotionCode or ordersOverCents, not both)'),
      ordersOverCents: z.coerce.number().int().min(1).max(1_000_000_000).optional().describe('for orders over this amount, in minor units (cents)'),
      occasion: z.preprocess(upper, z.enum(PROMOTION_OCCASIONS)).optional().describe('an occasion (BLACK_FRIDAY, CHRISTMAS, SUMMER_SALE, …): its dates must fall in its window'),
      languageCode: z.string().trim().min(2).max(20).optional().describe('the language of the promotion (en, it, …)'),
      startDate: dayArg('the first day it shows'),
      endDate: dayArg('the last day it shows'),
      redemptionStartDate: dayArg('the first day it can be redeemed'),
      redemptionEndDate: dayArg('the last day it can be redeemed'),
      finalUrl: httpsArg('the page it leads to'),
    })).max(5).optional().describe('new PROMOTION assets'),
    leadForms: z.array(z.object({
      nameOnForm: textArg('the business name shown on the form (at most 25 characters)', 100),
      headline: textArg('the form\'s headline'),
      description: textArg('what the form is for', 500),
      callToActionType: z.preprocess(upper, z.enum(LEAD_FORM_CTAS)).describe(`the button that opens the form: ${LEAD_FORM_CTAS.join(', ')}`),
      callToActionDescription: textArg('the line next to the button'),
      privacyPolicyUrl: httpsArg('the business\'s privacy policy page'),
      finalUrl: httpsArg('the business\'s page the form belongs to'),
      fields: z.array(z.object({
        inputType: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,60}$/).describe('what is asked, as Google names it: FULL_NAME, EMAIL, PHONE_NUMBER, POSTAL_CODE, CITY, COUNTRY, COMPANY_NAME, … (Google\'s LeadFormFieldUserInputType)'),
        choices: z.array(z.string().trim().min(1).max(100)).max(12).optional().describe('for one of Google\'s fixed questions: 2 to 12 answers to choose from'),
      })).max(15).describe('the fields the form asks, in order'),
      postSubmitHeadline: z.string().trim().min(1).max(200).optional().describe('the headline after sending'),
      postSubmitDescription: z.string().trim().min(1).max(500).optional().describe('what happens next, shown after sending'),
      postSubmitCallToActionType: z.preprocess(upper, z.enum(LEAD_FORM_POST_SUBMIT_CTAS)).optional().describe('the button after sending: VISIT_SITE, DOWNLOAD, LEARN_MORE or SHOP_NOW'),
      desiredIntent: z.preprocess(upper, z.enum(LEAD_FORM_INTENTS)).optional().describe('LOW_INTENT (more leads) or HIGH_INTENT (more qualified leads)'),
    })).max(2).optional().describe('new LEAD_FORM assets (campaign level only; the account must have accepted Google\'s lead form terms in Google Ads)'),
    mobileApps: z.array(z.object({
      appStore: z.preprocess(upper, z.enum(APP_STORES)).describe('APPLE_APP_STORE or GOOGLE_APP_STORE'),
      appId: z.string().trim().min(1).max(200).describe('the app\'s id: digits for the App Store (e.g. 12345689), the package name for Google Play (com.example.app)'),
      linkText: textArg('the link\'s text (at most 25 characters)', 100),
      startDate: dayArg('the first day it shows'),
      endDate: dayArg('the last day it shows'),
    })).max(3).optional().describe('new MOBILE_APP assets (a link to the app in the store)'),
    sitelinks: z.array(z.object({
      linkText: z.string().trim().min(1).max(100).describe(`the link text (at most ${ASSET_LIMITS.linkText} characters)`),
      description1: z.string().trim().max(100).optional().describe(`first description line (at most ${ASSET_LIMITS.sitelinkDescription}; both lines or neither)`),
      description2: z.string().trim().max(100).optional().describe(`second description line (at most ${ASSET_LIMITS.sitelinkDescription})`),
      finalUrl: httpsArg('the page the sitelink leads to'),
    })).max(20).optional().describe('new sitelinks (at any level; set-google-assets does campaign sitelinks too)'),
    callouts: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe(`new callouts (each at most ${ASSET_LIMITS.callout} characters)`),
    structuredSnippets: z.array(z.object({
      header: z.string().trim().min(1).max(60).describe(`a header from Google's list in the snippet's language (${SNIPPET_HEADER_NAMES.join(', ')} in English; the English name is translated)`),
      language: z.string().trim().min(2).max(10).optional().describe('the language of the header and values (en, it, de, …); default en'),
      values: z.array(z.string().trim().min(1).max(100)).max(ASSET_LIMITS.maxSnippetValues)
        .describe(`${ASSET_LIMITS.minSnippetValues} to ${ASSET_LIMITS.maxSnippetValues} values, each at most ${ASSET_LIMITS.snippetValue} characters, none repeated`),
    })).max(10).optional().describe('new structured snippets'),
    linkTo: z.array(placeArg).max(MAX_PLACES).optional()
      .describe('where every new asset is linked: the account, campaigns, ad groups (each type only where Google allows it); left out = made and linked nowhere'),
    enable: z.boolean().optional()
      .describe('true: make new call and lead form links ENABLED where they serve (SPENDS MONEY: new paid calls or form opens); left out: PAUSED there (they show nothing until a person enables them)'),
    why: googleWhyArg,
  }),
  description:
    `Make Google Ads assets of the business's chosen Google Ads account (up to ${MAX_NEW_ASSETS} in one request) and link `
    + 'them where Google allows each type: images (from an https link or the Nexus image library; Google\'s shape, size and '
    + 'file type checked per use: AD_IMAGE on Search, BUSINESS_LOGO, LOGO / LANDSCAPE_LOGO for Performance Max, and '
    + 'marketing images made only for asset groups and display ads), business name, call (phone number, call conversions), '
    + 'price (type, qualifier, 3–8 offerings), promotion (percent or money off, code or minimum order, occasion, dates), '
    + 'lead form (campaign level; the lead form terms must be accepted in Google Ads first), app link (App Store or Google '
    + 'Play), sitelinks, callouts and structured snippets. Places (linkTo): the account (every campaign), campaigns, ad '
    + 'groups. An asset already linked at a place with the same content is skipped. Location assets are not made here: '
    + 'Google makes them from a Business Profile linked in Google Ads (that link needs a Business Profile sign-in Nexus '
    + 'does not have); google-ads-live view asset-links shows them. Money: assets raise no bid or budget; a call or a lead '
    + 'form link where it serves can bring new paid clicks — it is made PAUSED there unless enable: true (SPENDS MONEY). '
    + 'Every rule Nexus knows is checked before the preview, all problems listed; Google\'s check judges the rest. Google '
    + 'reviews new assets after the run. Undo unlinks what it linked (Google never removes an asset).' + GOOGLE_CHANGE_RULES,
  undo: newUndo,
  handler: async (args, ctx) => libraryRefusal(args, ctx) ?? googleChangePreview(args, ctx, buildNew(args)),
  execute: async (args, ctx) => libraryRefusal(args, ctx) ?? runGoogleChange(args, ctx, buildNew(args), (draft, responses) => {
    const after = newAssetsRecordAfterRun(draft.after as NewAssetsRecord, responses)
    return {
      data: {
        created: after.created,
        linked: after.linked,
        review: 'Google reviews new assets now. Read it with google-ads-live view asset-links. Nexus does not wait for it.',
      },
      before: draft.before,
      after,
    }
  }),
}

// ── set-google-asset-links ──────────────────────────────────────────────────────────────────────────────────────

const linkItems = (args: Record<string, unknown>): LinkItemRequest[] => (args.items as LinkItemRequest[] | undefined) ?? []

const buildLinks = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const items = linkItems(args)
  const campaigns = await liveCampaigns(account.target)
  const adGroups = await liveAdGroupsById(account.target, unique(items.filter((i) => i.level === 'ad-group').map((i) => i.adGroupId)))
  const known = items.filter((i) => i.level === 'account'
    || (i.level === 'campaign' && campaigns.some((c) => c.campaignId === i.campaignId))
    || (i.level === 'ad-group' && adGroups.some((g) => g.adGroupId === i.adGroupId)))
  const links = await linksAt(account.target, known, { assetIds: unique(items.map((i) => i.assetId)) })
  const assets = await liveAssetDetails(account.target, unique(items.filter((i) => i.action === 'link').map((i) => i.assetId)))
  return assetLinksDraft(customerResource(account.target), { items }, { campaigns, adGroups, links, assets })
}

const linksUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as LinksRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.items?.length) return null
    const now = new Map((await linksAt(account.target, after.items, { assetIds: unique(after.items.map((i) => i.assetId)) })).map((l) => [placeLinkKey(l), l.status === 'PAUSED' ? 'PAUSED' : 'ENABLED']))
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      // A link counts as untouched since while it is as the change left it (unlinked: not linked now).
      items: after.items.filter((i) => (i.to === null ? !now.has(placeLinkKey(i)) : now.get(placeLinkKey(i)) === i.to)),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as LinksRecord & Stamped
    const items = after.items ?? []
    if (!items.length) return { refusal: 'This change linked, paused, enabled and unlinked nothing: there is nothing to put back.' }
    return {
      tool: 'set-google-asset-links',
      args: { ...accountArgOf(after), items: linksUndoItems(items), why: 'undo of an earlier asset link change: each link back as it was (linked, paused, enabled or not linked)' },
    }
  },
}

const setGoogleAssetLinks: AgentTool = {
  ...common,
  name: 'set-google-asset-links',
  title: 'Change Google Ads asset links',
  reversibility: 'full',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    items: z.array(placeArg.extend({
      assetId: googleIdArg('the asset (google-ads-live view asset-links lists them)'),
      fieldType: z.preprocess(upper, z.enum(LINK_FIELD_TYPES)).describe(`what the asset is at that place: ${LINK_FIELD_TYPES.join(', ')}`),
      action: z.preprocess(lower, z.enum(LINK_ACTIONS)).describe('link (link an existing asset there), pause, enable, or unlink (the link goes, the asset stays in the account)'),
      status: z.preprocess(upper, z.enum(['ENABLED', 'PAUSED'])).optional()
        .describe('action link only: the new link\'s status. Default ENABLED; a call or lead form link where it serves defaults to PAUSED (ENABLED there SPENDS MONEY)'),
    })).min(1).max(MAX_LINK_ITEMS).describe(`the links to change (1 to ${MAX_LINK_ITEMS}), each at the account, a campaign or an ad group`),
    why: googleWhyArg,
  }),
  description:
    'The asset links of the business\'s chosen Google Ads account, at every level — the account (every campaign), a '
    + 'campaign, an ad group — in one request: link an existing asset (by id and field type: sitelink, callout, '
    + 'structured snippet, call, price, promotion, app link, lead form, business name, business logo, image, logo), pause '
    + 'or enable a link, unlink (the asset stays in the account; the ads there show without it). Each field type only '
    + 'where Google allows it (a lead form at a campaign; a business name or logo at the account or a campaign; an image '
    + 'at a campaign or an ad group). A link that is already so is skipped. Money: links raise no bid or budget; enabling '
    + 'a call or lead form link where it serves is SPENDS MONEY (new paid clicks); pausing or unlinking is safe. New '
    + 'assets: add-google-assets. Undo puts every link back as it was.' + GOOGLE_CHANGE_RULES,
  undo: linksUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildLinks(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildLinks(args), (draft) => {
    const after = draft.after as LinksRecord
    return { data: { items: after.items }, before: draft.before, after }
  }),
}

export const GOOGLE_ADS_ASSETS_ALL_TOOLS: AgentTool[] = [addGoogleAssets, setGoogleAssetLinks]
