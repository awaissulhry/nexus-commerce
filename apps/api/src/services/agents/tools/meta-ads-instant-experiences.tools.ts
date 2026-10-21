/**
 * Meta ads changes, step 27b (2026-10-21) — Instant Experiences of the business's CHOSEN Facebook Page (master rows CR-473 …
 * CR-485, CR-488: the parts and the experience; CR-491 … CR-493: edit while unpublished, publish, hide — Meta has no delete):
 *   create-meta-instant-experience  its parts (photo, video, automatic video from a product set, product set, product list,
 *                                   button, text, store locator, lead form, an existing post; a carousel, header or footer
 *                                   holding parts) and the experience from them, always UNPUBLISHED; undo hides it
 *   set-meta-instant-experience     edit an UNPUBLISHED one (name, colour, parts in order — new or existing —, swipe to open,
 *                                   hero asset, template); publish it (ONE way, its own approval); hide it or show it again
 * A Nexus change like every other Meta change (meta-ads-kit.ts): a preview from the live state (Meta has no check for any of
 * these: said), an approvalId, a person approves it, it runs as that person, request by request, undo puts back what it can.
 *
 * Every request goes AS the Page: the gateway reads the chosen Page's own token for that one call (gateway/meta-page-token.ts,
 * step 36's Page token mode — the one mode, reused) and sends it only for the chosen Page or an Instant Experience of it, with
 * every id inside each part confirmed the business's own (gateway/meta-page-owner.ts). The tools never see a token. Nothing
 * spends: an Instant Experience is shown, and reviewed, only once an ad links to it.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolUndo } from '../tool-types.js'
import { metaChangePreview, metaConnectionArg, metaWhyArg, META_CHANGE_RULES, recordAccount, runMetaChange, type MetaDraftBuilder } from './meta-ads-kit.js'
import { META_IX_CREATE_TOOL, META_IX_SET_TOOL } from '../../gateway/account.js'
import {
  META_CANVAS_ALIGNMENTS, META_CANVAS_BUTTON_STYLES, META_CANVAS_COLOR, META_CANVAS_FONT, META_CANVAS_LAYOUTS, META_CANVAS_LIMITS, META_CANVAS_OVERLAY,
  META_CANVAS_PHOTO_STYLES, META_CANVAS_SECTION_TITLES,
} from '../../gateway/meta-canvas-rules.js'
import {
  IX_PART_TYPES, ixCreateDraft, ixEditDraft, ixHiddenDraft, ixPublishDraft, ixRefsOf, madeIdOf, madePartIds, IX_TEMPLATE_BY_NAME,
  type IxCreateInput, type IxCreateRecord, type IxEditFields, type IxEditInput, type IxPartInput, type IxSetRecord,
} from '../../marketing/meta-ads/change-instant-experiences.js'
import { liveIxCanvas, liveIxContext, liveIxRefsProblem, type IxCanvasState } from '../../marketing/meta-ads/live-instant-experiences.js'
import { MetaLiveRefusal } from '../../marketing/meta-ads/live.js'
import { createdIdOf } from '../../marketing/meta-ads/write-client.js'
import type { MetaChangeDraft } from '../../marketing/meta-ads/change-draft.js'

const L = META_CANVAS_LIMITS
const TEMPLATES = Object.keys(IX_TEMPLATE_BY_NAME) as [string, ...string[]]
const words = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what)
const idArg = (what: string) => z.string().trim().regex(/^[1-9]\d{0,24}$/, 'a Meta id is digits only').describe(what)
const hex = (what: string) => z.string().regex(META_CANVAS_COLOR, 'RRGGBB or AARRGGBB, upper case').describe(what)
const padding = (what: string) => z.number().min(0).max(L.padding).describe(what)
const postArg = (what: string) => z.string().trim().regex(/^[1-9]\d{0,24}(_[1-9]\d{0,24})?$/, 'a post as <Page id>_<post id>, or a photo\'s or video\'s own id').describe(what)

/** A builder's refusal in words (MetaLiveRefusal: the chosen Page, the experience's owner check, Meta's words). */
const refused = (build: MetaDraftBuilder): MetaDraftBuilder => async (account) => {
  try {
    return await build(account)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

// ── a part ────────────────────────────────────────────────────────────────────────────────────────────────────────

const partFields = {
  elementId: idArg('an EXISTING part of the chosen Page instead of a new one (meta-instant-experiences view elements lists them): name it alone').optional(),
  type: z.enum(IX_PART_TYPES).optional().describe('a NEW part: photo, video, templateVideo (an automatic video from a product set), productSet (a storefront grid or carousel from the catalog), productList (fixed catalog items), button, text, storeLocator (the Page\'s store locations; not on Instagram), leadForm (a published lead form of the chosen Page), existingPost (a post or photo of the chosen Page, or a media of the chosen Instagram account), carousel / header / footer (hold parts: children)'),
  name: words(L.name, 'the part\'s name in Meta\'s editor (people do not see it)').optional(),
  photoId: idArg('photo: a photo already on the chosen Facebook Page (its id)').optional(),
  photoUrl: z.string().trim().max(L.link).optional().describe('photo: a public https link of the picture, which Meta fetches (never one of Meta\'s own links)'),
  videoId: idArg('video: a video of the chosen Page or of the chosen ad account\'s library').optional(),
  videoUrl: z.string().trim().max(L.link).optional().describe('video: a public https link of the video, which Meta fetches'),
  style: z.enum(META_CANVAS_PHOTO_STYLES).optional().describe('photo, video, carousel: FIT_TO_WIDTH (default), FIT_TO_HEIGHT, FIT_TO_WIDTH_EXPANDABLE (photo only)'),
  link: z.string().trim().max(L.link).optional().describe('photo, button: what a tap opens — a website (https), or another Instant Experience of the chosen Page (exactly https://fb.com/canvas_doc/<id>; not on Instagram)'),
  productTags: z.array(z.object({
    productId: idArg('a catalog item of the business (checked by the catalog rule)'),
    x: z.number().min(0).max(1).describe('where on the photo, from the left (0 to 1)'),
    y: z.number().min(0).max(1).describe('where on the photo, from the top (0 to 1)'),
  })).min(1).max(L.productIds).optional().describe(`photo: products tagged on it (at most ${L.productIds})`),
  hidePrices: z.boolean().optional().describe('photo: hide the tagged products\' prices'),
  productSetId: idArg('productSet, templateVideo: a product set of the business\'s catalog (checked by the catalog rule)').optional(),
  maxItems: z.number().int().min(1).max(L.maxItems).optional().describe(`productSet: how many products at most (Meta's default ${L.maxItems})`),
  showInFeed: z.boolean().optional().describe('productSet: show its products in the feed unit — true for a collection ad'),
  itemHeadline: words(L.token, 'productSet, productList: the product field shown as the headline, e.g. {{product.name}}').optional(),
  itemDescription: words(L.token, 'productSet, productList: the product field shown below it, e.g. {{product.current_price}}').optional(),
  overlay: z.object({
    template: z.enum(META_CANVAS_OVERLAY.overlay_template).describe('the overlay\'s shape'),
    textType: z.enum(META_CANVAS_OVERLAY.text_type).describe('what it shows'),
    font: z.enum(META_CANVAS_OVERLAY.text_font).describe('its font'),
    position: z.enum(META_CANVAS_OVERLAY.position).describe('its corner'),
    themeColor: z.enum(META_CANVAS_OVERLAY.theme_color).describe('its colours'),
    floatWithMargin: z.boolean().optional().describe('float it with a margin'),
    customTextType: z.enum(META_CANVAS_OVERLAY.custom_text_type).optional().describe('custom text (textType custom)'),
  }).optional().describe('productSet: an overlay on each product\'s picture (price, discount …)'),
  layout: z.enum(META_CANVAS_LAYOUTS).optional().describe('productSet: GRID_2COL, GRID_3COL, CAROUSEL or HSCROLL_LIST'),
  sections: z.boolean().optional().describe('productSet: split the storefront into sections'),
  sectionTitles: z.array(z.object({
    titleId: z.enum(META_CANVAS_SECTION_TITLES).describe('Meta\'s section whose title is replaced'),
    title: words(L.sectionTitle, 'the title shown instead'),
  })).min(1).max(L.sectionTitles).optional().describe('productSet: section titles of your own (needs sections true)'),
  videoTemplate: z.object({
    textColor: hex('its text colour').optional(),
    textBackgroundColor: hex('its text background').optional(),
    nameTemplate: words(L.token, 'the product field as its title, e.g. {{product.name}}').optional(),
    bodyTemplate: words(L.token, 'the product field as its text, e.g. {{product.current_price strip_zeros}}').optional(),
  }).optional().describe('templateVideo: its settings as Meta\'s collection-ads example shows them (LIVE-PROBES IX27b-06)'),
  productIds: z.array(idArg('a catalog item of the business (checked by the catalog rule)')).min(1).max(L.productIds).optional().describe(`productList: the catalog items, in order (at most ${L.productIds})`),
  text: z.string().trim().min(1).max(L.text).optional().describe(`button (at most ${L.buttonText}), text (at most ${L.text}; line breaks kept): the words`),
  buttonStyle: z.enum(META_CANVAS_BUTTON_STYLES).optional().describe('button: BUTTON_OUTLINE (Meta\'s default, always sent) or BUTTON_FILLED'),
  buttonColor: hex('button: its colour').optional(),
  textColor: hex('button, text: the text colour').optional(),
  alignment: z.enum(META_CANVAS_ALIGNMENTS).optional().describe('button, text: LEFT, CENTER or RIGHT'),
  fontSize: z.number().int().min(L.fontSizeMin).max(L.fontSizeMax).optional().describe('button, text: the font size'),
  fontFamily: z.string().regex(META_CANVAS_FONT).optional().describe('button, text: the font (e.g. sans-serif)'),
  lineHeight: z.number().min(L.lineHeightMin).max(L.lineHeightMax).optional().describe('button, text: the line height'),
  backgroundColor: hex('button, text, header, footer: the background colour').optional(),
  typeface: z.string().regex(META_CANVAS_FONT).optional().describe('storeLocator: the font of the store details'),
  headerBackgroundColor: hex('storeLocator: the header\'s colour').optional(),
  formId: idArg('leadForm: a published (ACTIVE) lead form of the chosen Page (meta-lead-forms; create-meta-lead-form makes one)').optional(),
  facebookPostId: postArg('existingPost: a post of the chosen Page (<Page id>_<post id>) or a photo or video it posted').optional(),
  instagramMediaId: idArg('existingPost: a media of the chosen Instagram account').optional(),
  paddingTop: padding('space above the part').optional(),
  paddingBottom: padding('space below the part').optional(),
}
const childArg = z.object(partFields)
const partArg = z.object({
  ...partFields,
  children: z.array(childArg).min(1).max(L.children).optional().describe(`carousel (photos or videos), header (usually a photo), footer (usually a button): the parts it holds, new or existing (at most ${L.children})`),
})

const canvasFields = {
  backgroundColor: hex('the background colour (RRGGBB or AARRGGBB; Meta\'s default FFFFFFFF)').optional(),
  swipeToOpen: z.boolean().optional().describe('open it by swiping (Instagram shows "Tap to open" instead)'),
  template: z.enum(TEMPLATES).optional().describe('one of Meta\'s templates (its layout is fixed: meta-instant-experiences view template lists the parts it takes); the AR template is Ads Manager only'),
  heroFacebookPostId: postArg('a hero asset: a post of the chosen Page (<Page id>_<post id>) or a photo or video it posted').optional(),
  heroInstagramMediaId: idArg('a hero asset: a media of the chosen Instagram account').optional(),
}

/** The undo's "is the Page still the one this was made on?" — else undo says so and sends nothing. */
async function recordCanvas(record: { pageId?: unknown; canvasId?: unknown }, connectionId: string): Promise<IxCanvasState | null> {
  if (typeof record.canvasId !== 'string') return null
  const canvas = await liveIxCanvas(connectionId, record.canvasId).catch(() => null)
  return canvas && canvas.pageId === record.pageId ? canvas : null
}

// ── create-meta-instant-experience ──────────────────────────────────────────────────────────────────────────────────

const createInput = z.object({
  connectionId: metaConnectionArg,
  name: words(L.name, 'the Instant Experience\'s name in Meta\'s editor (people do not see it)'),
  parts: z.array(partArg).min(1).max(L.bodyElements).describe(`its parts, top to bottom: new ones (at most ${L.elementsPerChange} new parts in one change, children included) or existing ones of the Page by elementId`),
  ...canvasFields,
  hidden: z.boolean().optional().describe('make it hidden'),
  why: metaWhyArg,
})

const buildCreate = (args: Record<string, unknown>): MetaDraftBuilder => refused(async (account) => {
  const input = args as unknown as IxCreateInput
  const ctx = await liveIxContext(account.accountId)
  const draft = ixCreateDraft(input, ctx)
  if ('refusal' in draft) return draft
  const problem = await liveIxRefsProblem(account.accountId, ixRefsOf(input.parts, input))
  return problem ? { refusal: `Nothing was asked of Meta: ${problem}` } : draft
})

/** Undo of a create: hide the Instant Experience it made (Meta deletes none); its parts are named for remove-meta-ads-items. */
const createUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as IxCreateRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    if (!after.canvasId) return after
    const canvas = await recordCanvas(after, account.accountId)
    return canvas ? { ...after, hidden: canvas.hidden } : null
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as IxCreateRecord & { accountId?: string }
    if (!after.canvasId) {
      return { refusal: `This change made ${after.elementIds?.length ? `${after.elementIds.length} part(s) (${after.elementIds.join(', ')})` : 'nothing'} but no Instant Experience. Meta documents a part's delete: remove-meta-ads-items (kind canvaselement) deletes them when a person explicitly asks.` }
    }
    return {
      tool: META_IX_SET_TOOL,
      args: { ...(after.accountId ? { connectionId: after.accountId } : {}), action: 'hide', canvasId: after.canvasId, why: 'undo of an earlier Instant Experience create (Meta deletes none: it is hidden; its parts stay on the Page)' },
    }
  },
}

const createMetaInstantExperience: AgentTool = {
  name: META_IX_CREATE_TOOL,
  title: 'Create a Meta Instant Experience',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // Its undo HIDES the experience (Meta documents no delete); its parts stay on the Page.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: createInput,
  description:
    'Make an Instant Experience (the full-screen page an ad opens; once called a canvas) on the business\'s chosen Facebook '
    + 'Page: its parts, top to bottom — photo (a photo of the Page or a public link; products tagged on it), video (a Page or '
    + 'ad-library video, or a public link), an automatic video from a product set, a product set (storefront grid, carousel '
    + 'or list; overlays; sections; showInFeed for a collection ad), a fixed product list, a button and text (colours, fonts, '
    + 'alignment; a link to a website or another Instant Experience of the Page), a store locator, a published lead form of '
    + 'the Page, an existing post (the Page\'s, or the chosen Instagram account\'s media), and a carousel, header or footer '
    + 'holding parts — new ones, or existing parts of the Page by elementId; then the experience from them, with its name, '
    + 'background colour, swipe to open, a hero asset and one of Meta\'s templates. It is always made UNPUBLISHED (it can '
    + 'still be edited): publishing is its own change (set-meta-instant-experience action publish, one way). Every product '
    + 'set and catalog item passes the catalog rule; every photo, video, post, media, form and part is checked the '
    + 'business\'s own before anything is sent. Each part is its own request (at most 20 new parts in one change), made AS '
    + 'the Page: Nexus\'s gateway reads the chosen Page\'s own token for each (the system user needs the Page\'s Advertise '
    + 'task) — a token is never shown — and Meta counts them against the Page\'s own rate limit. Meta has no check for it. '
    + 'Nothing spends, and Meta reviews nothing, until an ad links to it (create-meta-creative with '
    + 'https://fb.com/canvas_doc/<id>, then create-meta-ad). Undo HIDES it (Meta documents no delete; it stays in the '
    + 'Page\'s list); its parts stay (remove-meta-ads-items deletes a part on an explicit ask). Instagram shows Instant '
    + 'Experiences on a limited basis; meta-instant-experiences reads them.'
    + META_CHANGE_RULES,
  undo: createUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildCreate(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildCreate(args), (draft, done) => {
    const before = draft.before as IxCreateRecord
    const elementIds = madePartIds(done)
    const made = done.find(({ request }) => request.operation === 'canvas.create')
    const canvasId = made ? createdIdOf(made.result.node) : null
    const readHidden = made?.result.node && typeof made.result.node.is_hidden === 'boolean' ? made.result.node.is_hidden : null
    const hidden = canvasId ? readHidden ?? (args.hidden === true) : null
    return {
      data: {
        pageId: before.pageId, canvasId, name: before.name, elementIds, published: canvasId ? false : null,
        link: canvasId ? `https://fb.com/canvas_doc/${canvasId}` : null,
        note: canvasId
          ? 'Made UNPUBLISHED: set-meta-instant-experience edits it, then publishes it (one way); an ad then links to it with the link above (create-meta-creative, then create-meta-ad). meta-ad-preview view instant-experience shows it.'
          : 'The Instant Experience itself was not made: the parts made are named above and stay on the Page (remove-meta-ads-items deletes a part on an explicit ask; set-meta-instant-experience cannot use them before an experience exists).',
      },
      before: { ...before },
      after: { action: 'create', pageId: before.pageId, canvasId, name: before.name, elementIds, hidden } satisfies IxCreateRecord,
      ...(canvasId ? {} : { noUndo: `Meta made ${elementIds.length} part(s) but not the Instant Experience: a part has no undo but a delete a person asks for (remove-meta-ads-items, kind canvaselement).` }),
    }
  }),
}

// ── set-meta-instant-experience ─────────────────────────────────────────────────────────────────────────────────────

const ACTIONS = ['edit', 'publish', 'hide', 'unhide'] as const

const setInput = z.object({
  connectionId: metaConnectionArg,
  action: z.enum(ACTIONS).describe('edit (an UNPUBLISHED one: name, colour, parts, swipe to open, hero asset, template) · publish (ONE way: it can never be edited again; confirmPublish) · hide (Meta has no delete) · unhide'),
  canvasId: idArg('the Instant Experience, of the chosen Facebook Page (meta-instant-experiences view list)'),
  name: words(L.name, 'edit: the new name').optional(),
  ...canvasFields,
  parts: z.array(partArg).min(1).max(L.bodyElements).optional().describe(`edit: the WHOLE body in its new order — existing parts by elementId, new parts made by this change (at most ${L.elementsPerChange}); a part left out leaves the experience (it stays on the Page)`),
  confirmPublish: z.literal(true).optional().describe('publish: true — the person knows a published Instant Experience can never be edited again'),
  why: metaWhyArg,
})

type SetArgs = z.infer<typeof setInput>
const EDIT_KEYS = ['name', 'backgroundColor', 'swipeToOpen', 'template', 'heroFacebookPostId', 'heroInstagramMediaId', 'parts'] as const

const buildSet = (args: Record<string, unknown>): MetaDraftBuilder => refused(async (account) => {
  const a = args as unknown as SetArgs
  const editArgs = EDIT_KEYS.filter((k) => a[k] !== undefined)
  if (a.action !== 'edit' && editArgs.length) return { refusal: `${editArgs.join(', ')} ${editArgs.length === 1 ? 'is' : 'are'} for action edit only.` }
  if (a.action !== 'publish' && a.confirmPublish) return { refusal: 'confirmPublish is for action publish only.' }
  if (a.action === 'publish' && a.confirmPublish !== true) return { refusal: 'Publishing is ONE way (a published Instant Experience can never be edited again): ask again with confirmPublish: true once the person knows.' }
  if (a.action === 'edit' && !editArgs.length) return { refusal: 'Name what the edit changes: name, backgroundColor, swipeToOpen, template, a hero asset, or the parts.' }
  const canvas = await liveIxCanvas(account.accountId, a.canvasId)
  if (a.action === 'publish') return ixPublishDraft(canvas)
  if (a.action === 'hide' || a.action === 'unhide') return ixHiddenDraft(a.action === 'hide', canvas)
  const input: IxEditInput = Object.fromEntries(EDIT_KEYS.filter((k) => a[k] !== undefined).map((k) => [k, a[k]])) as IxEditInput
  const draft = ixEditDraft(input, canvas)
  if ('refusal' in draft || !draft.requests.length) return draft
  const problem = await liveIxRefsProblem(account.accountId, ixRefsOf((input.parts ?? []) as IxPartInput[], input))
  return problem ? { refusal: `Nothing was asked of Meta: ${problem}` } : draft
})

/** What a canvas reads now, for the fields an edit changed (the shape of its record's `fields`). */
function liveFields(fields: IxEditFields, canvas: IxCanvasState): IxEditFields {
  const templateName = Object.entries(IX_TEMPLATE_BY_NAME).find(([, id]) => id === canvas.templateId)?.[0] ?? null
  const now: IxEditFields = {}
  for (const key of Object.keys(fields) as Array<keyof IxEditFields>) {
    if (key === 'name') now.name = canvas.name
    else if (key === 'backgroundColor') now.backgroundColor = canvas.backgroundColor
    else if (key === 'elementIds') now.elementIds = canvas.elementIds
    else if (key === 'heroFacebookPostId') now.heroFacebookPostId = canvas.heroFacebookPostId
    else if (key === 'heroInstagramMediaId') now.heroInstagramMediaId = canvas.heroInstagramMediaId
    else if (key === 'template') now.template = templateName
  }
  return now
}

const setUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as IxSetRecord & { accountId?: string; adAccountId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const canvas = await recordCanvas(after, account.accountId)
    if (!canvas) return null
    if (after.action === 'edit') return { ...after, fields: liveFields(after.fields ?? {}, canvas) }
    if (after.action === 'publish') return { ...after, published: canvas.published }
    return { ...after, hidden: canvas.hidden }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as IxSetRecord
    const after = (change.after ?? {}) as IxSetRecord & { accountId?: string }
    const connection = after.accountId ? { connectionId: after.accountId } : {}
    if (after.action === 'hide') return { tool: META_IX_SET_TOOL, args: { ...connection, action: 'unhide', canvasId: after.canvasId, why: 'undo of an earlier Instant Experience hide' } }
    if (after.action === 'unhide') return { tool: META_IX_SET_TOOL, args: { ...connection, action: 'hide', canvasId: after.canvasId, why: 'undo of an earlier Instant Experience show-again' } }
    if (after.action === 'publish') return { refusal: 'A published Instant Experience cannot be un-published or edited (Meta documents no way back): hide it with set-meta-instant-experience action hide, or make a new one.' }
    if (!before.undo) return { refusal: `This edit cannot be put back: ${before.noUndo?.join(' ') || 'Nexus did not read the old values.'}` }
    return { tool: META_IX_SET_TOOL, args: { ...connection, ...before.undo, why: 'undo of an earlier Instant Experience edit (only while it is unpublished)' } }
  },
}

const setMetaInstantExperience: AgentTool = {
  name: META_IX_SET_TOOL,
  title: 'Change a Meta Instant Experience',
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  // An edit is put back while unpublished (a value Meta does not read back cannot be), a hide ⇄ show again in full, a publish never.
  reversibility: 'partial',
  consequencesFor: (args) => {
    if (args.action === 'publish') return { reversibility: 'none' }
    if (args.action === 'hide' || args.action === 'unhide') return { reversibility: 'full' }
    return null
  },
  maxClaudeTrust: 'ask',
  requires: [F.adsCampaignsManage],
  input: setInput,
  description:
    'Change an Instant Experience of the business\'s chosen Facebook Page: EDIT an unpublished one (Meta: "You can only update '
    + 'an unpublished Instant Experience") — its name, background colour, swipe to open, hero asset, template, and its parts '
    + 'as the whole new body in order (existing parts by elementId, new parts made in the same change, checked like '
    + 'create-meta-instant-experience\'s); PUBLISH it (ONE way: it can never be edited again — confirmPublish true; its own '
    + 'approval; ads can then link to it); HIDE it or show it again (Meta documents no delete). Nexus reads first whether it '
    + 'is published and refuses an edit of a published one in words. Meta has no check for these. Nothing spends by itself: '
    + 'an ad that links to it does (create-meta-creative with https://fb.com/canvas_doc/<id>, then create-meta-ad); showing '
    + 'a published one again may let such an ad show it again (SPENDS MONEY is said). Every request goes AS the Page: '
    + 'Nexus\'s gateway reads the chosen Page\'s own token for it (the system user needs the Page\'s Advertise task) — a '
    + 'token is never shown. Undo: an edit puts the old values back while unpublished (swipe to open and a hero asset or '
    + 'template that was not there cannot be put back: said), hide ⇄ show again; a publish has none.'
    + META_CHANGE_RULES,
  undo: setUndo,
  handler: (args, ctx) => metaChangePreview(args, ctx, buildSet(args)),
  execute: (args, ctx) => runMetaChange(args, ctx, buildSet(args), (draft: MetaChangeDraft, done) => {
    const before = draft.before as IxSetRecord
    const after = draft.after as IxSetRecord
    const node = done[done.length - 1]?.result.node ?? null
    let record: IxSetRecord = { ...after }
    if (after.action === 'edit') {
      const update = done.find(({ request }) => request.operation === 'canvas.update')
      const sent = update ? (update.request.planParams ?? update.request.params).body_element_ids : undefined
      const made = madePartIds(done)
      // The parts as sent: an existing part's id, or the id Meta answered for a part this run made (`@<step>`).
      const elementIds = sent ? (JSON.parse(sent) as string[]).map((ref) => (ref.startsWith('@') ? madeIdOf(done, Number(ref.slice(1)), 'canvas.update') : ref)) : undefined
      record = { ...after, fields: { ...(after.fields ?? {}), ...(elementIds ? { elementIds } : {}) }, ...(made.length ? { madeElementIds: made } : {}) }
    } else if (after.action === 'publish') {
      record = { ...after, published: node && typeof node.is_published === 'boolean' ? node.is_published : after.published ?? null }
    } else {
      record = { ...after, hidden: node && typeof node.is_hidden === 'boolean' ? node.is_hidden : after.hidden ?? null }
    }
    return {
      data: {
        action: after.action, pageId: after.pageId, canvasId: after.canvasId,
        ...(after.action === 'edit' ? { fields: record.fields, ...(record.madeElementIds ? { madeElementIds: record.madeElementIds } : {}) } : {}),
        ...(after.action === 'publish' ? { published: record.published, link: `https://fb.com/canvas_doc/${after.canvasId}`, note: 'Published: it can never be edited again. An ad links to it with the link above (create-meta-creative, then create-meta-ad).' } : {}),
        ...(after.action === 'hide' || after.action === 'unhide' ? { from: before.hidden ?? null, to: record.hidden ?? null } : {}),
      },
      before: { ...before },
      after: record,
      ...(after.action === 'publish' ? { noUndo: 'A publish has no undo (Meta documents no way back): hide it with set-meta-instant-experience action hide.' } : {}),
    }
  }),
}

export const META_ADS_INSTANT_EXPERIENCE_TOOLS: AgentTool[] = [createMetaInstantExperience, setMetaInstantExperience]
