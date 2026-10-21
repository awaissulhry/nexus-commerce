/**
 * Meta step 27b (2026-10-21) — Instant Experiences (once called canvases) as drafts (pure: built from a request and the live
 * state, no call). What Meta allows, checked on its v26 reference, guides and the Python SDK (gateway/meta-canvas-rules.ts
 * names each page; master rows CR-473 … CR-485, CR-488, CR-491 … CR-493; facts F1 M5-15, M5-16):
 *   - an Instant Experience is made ON THE CHOSEN Facebook Page from parts (`POST /{page_id}/canvas_elements`, ONE part per
 *     call: photo, video, template video, product set, product list, button, text, store locator, lead form, an existing
 *     post; a carousel, a header and a footer hold parts made before them), then the experience itself from those parts
 *     (`POST /{page_id}/canvases`) — always UNPUBLISHED: publishing is its own change with its own approval, because Meta
 *     says "You can only update an unpublished Instant Experience" (a published one can never be edited again);
 *   - an unpublished one can be edited (`POST /{canvas_id}`: its name, colour, parts in order, swipe to open, hero asset,
 *     template), published (`is_published`, ONE way) and hidden or shown again (`is_hidden`); Meta documents no delete of an
 *     Instant Experience ("You can't perform this operation on this endpoint"), so the undo of a create HIDES it (it stays in
 *     the Page's list); a part can be deleted (the guide's DELETE, remove-meta-ads-items — step 22);
 *   - Meta has no check (validate_only) for any of these: every preview says so;
 *   - nothing here spends money or is reviewed: an Instant Experience is shown (and reviewed) only once an ad links to it
 *     (create-meta-creative with https://fb.com/canvas_doc/<id>, then create-meta-ad);
 *   - every call goes AS the Page (the gateway reads the chosen Page's own token for it: gateway/meta-page-token.ts), and
 *     counts against the PAGE's own rate limit (80001), not the ad account's: one change makes at most 20 parts.
 */
import type { MetaChangeDraft, MetaChangeRequest } from './change-draft.js'
import { changeLines, plural } from './change-draft.js'
import {
  META_CANVAS_COLOR, META_CANVAS_ELEMENT_JUDGES, META_CANVAS_LIMITS, META_CANVAS_LINK, metaCanvasCreateProblem, metaCanvasUpdateProblem,
  type MetaCanvasElementKey,
} from '../../gateway/meta-canvas-rules.js'
import type { MetaWriteBodyId } from '../../gateway/meta-calls.js'
import { localFailure } from './errors.js'
import { createdIdOf, MetaWriteError, type MetaChangeResult } from './write-client.js'
import type { IxCanvasState, IxContext, IxRefs } from './live-instant-experiences.js'
import { IX_TEMPLATES } from './live-media.js'

// ── words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const IX_NO_CHECK = 'Meta has no check (validate_only) for Instant Experiences or their parts (neither the canvases nor the canvas_elements reference lists one): the preview is built from the live state, and Meta judges each request when it runs.'
export const IX_NO_SPEND = 'Nothing spends, and Meta reviews nothing yet: an Instant Experience is shown — and reviewed — only once an ad links to it (create-meta-creative with its link https://fb.com/canvas_doc/<id>, then create-meta-ad).'
export const IX_PAGE_LIMIT = 'Every request goes AS the chosen Page (Nexus\'s gateway reads the Page\'s own token for it), and Meta counts it against the Page\'s own rate limit: Nexus makes at most 20 parts in one change, one call each, in order.'
export const IX_ONE_WAY = 'Publishing is ONE WAY: Meta says "You can only update an unpublished Instant Experience" — once published it can never be edited again (a change means a new one, which can reuse its parts); it can still be hidden.'
export const IX_NO_DELETE = 'Meta documents no delete of an Instant Experience (its reference: "You can\'t perform this operation on this endpoint"): the undo HIDES it, and it stays in the Page\'s list (meta-instant-experiences view list). Its parts stay too; remove-meta-ads-items deletes a part on a person\'s explicit ask (Meta\'s guide documents that delete).'
export const IX_INSTAGRAM = 'Instagram shows Instant Experiences "on a limited basis" (Meta\'s guide), and ads with one do not run in Facebook Stories.'

/** Meta's codes an Instant Experience request may meet (reference "Error Codes"), in plain words. */
export const IX_EXPLAIN: Readonly<Record<string, string>> = {
  80001: 'Meta allows only so many calls to one Page in a while (they count against the Page, not the ad account): wait a few minutes and ask again.',
  105: 'Meta took too many parameters in one call: ask again with fewer parts or settings.',
  368: 'Meta judged this request abusive or not allowed for this Page (its own policy check, not Nexus\'s): a person looks at the Page in Meta\'s Business Support Home before asking again.',
  200: 'Instant Experiences need the Page\'s Advertise task ("Create ads") for the system user in Meta Business settings, and pages_manage_ads, pages_read_engagement and pages_show_list on its token (Meta\'s canvases reference also names pages_manage_posts and pages_read_user_content).',
  283: 'Meta asks for a Page permission the token does not carry (pages_read_engagement, pages_read_user_content, pages_manage_ads or pages_manage_metadata): a person adds it to the system user\'s token in Meta Business settings.',
  10: 'Instant Experiences need the Page\'s Advertise task ("Create ads") for the system user in Meta Business settings, and pages_manage_ads on its token.',
  190: 'Meta did not accept the Page\'s own token, which Nexus reads for each change: the system user may have lost its role or task on the chosen Page (Meta Business settings › Users › System users › Assign assets); the business\'s system-user token itself is not the problem.',
}

// ── the parts ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const IX_PART_TYPES = ['photo', 'video', 'templateVideo', 'productSet', 'productList', 'button', 'text', 'storeLocator', 'leadForm', 'existingPost', 'carousel', 'header', 'footer'] as const
export type IxPartType = typeof IX_PART_TYPES[number]
const TYPE_KEY: Readonly<Record<IxPartType, MetaCanvasElementKey>> = {
  photo: 'canvas_photo', video: 'canvas_video', templateVideo: 'canvas_template_video', productSet: 'canvas_product_set', productList: 'canvas_product_list',
  button: 'canvas_button', text: 'canvas_text', storeLocator: 'canvas_store_locator', leadForm: 'canvas_lead_form', existingPost: 'canvas_existing_post',
  carousel: 'canvas_carousel', header: 'canvas_header', footer: 'canvas_footer',
}
const WORD: Readonly<Record<IxPartType, string>> = {
  photo: 'photo', video: 'video', templateVideo: 'automatic video from a product set', productSet: 'product set', productList: 'product list', button: 'button',
  text: 'text', storeLocator: 'store locator', leadForm: 'lead form', existingPost: 'existing post', carousel: 'carousel', header: 'header', footer: 'footer',
}
const CONTAINERS: ReadonlySet<IxPartType> = new Set(['carousel', 'header', 'footer'])

export interface IxOverlayInput { template: string; textType: string; font: string; position: string; themeColor: string; floatWithMargin?: boolean; customTextType?: string }
export interface IxPartInput {
  /** An existing part of the chosen Page, by id (instead of a new part). */
  elementId?: string
  type?: IxPartType
  name?: string
  photoId?: string
  photoUrl?: string
  videoId?: string
  videoUrl?: string
  style?: string
  link?: string
  productTags?: Array<{ productId: string; x: number; y: number }>
  hidePrices?: boolean
  productSetId?: string
  maxItems?: number
  showInFeed?: boolean
  itemHeadline?: string
  itemDescription?: string
  overlay?: IxOverlayInput
  layout?: string
  sections?: boolean
  sectionTitles?: Array<{ titleId: string; title: string }>
  videoTemplate?: { textColor?: string; textBackgroundColor?: string; nameTemplate?: string; bodyTemplate?: string }
  productIds?: string[]
  text?: string
  buttonStyle?: string
  buttonColor?: string
  textColor?: string
  alignment?: string
  fontSize?: number
  fontFamily?: string
  lineHeight?: number
  backgroundColor?: string
  typeface?: string
  headerBackgroundColor?: string
  formId?: string
  facebookPostId?: string
  instagramMediaId?: string
  paddingTop?: number
  paddingBottom?: number
  /** A carousel's, header's or footer's parts (new ones, or existing ones by elementId). */
  children?: IxPartInput[]
}
type PartKey = Exclude<keyof IxPartInput, 'elementId' | 'type'>

/** The input fields each kind of part takes (anything else is refused in words). */
const PADDINGS: readonly PartKey[] = ['paddingTop', 'paddingBottom']
const STYLED: readonly PartKey[] = ['alignment', 'textColor', 'fontSize', 'fontFamily', 'lineHeight', 'backgroundColor', ...PADDINGS]
const TAKES: Readonly<Record<IxPartType, readonly PartKey[]>> = {
  photo: ['name', 'photoId', 'photoUrl', 'style', 'link', 'productTags', 'hidePrices', ...PADDINGS],
  video: ['name', 'videoId', 'videoUrl', 'style', ...PADDINGS],
  templateVideo: ['name', 'productSetId', 'videoTemplate', ...PADDINGS],
  productSet: ['name', 'productSetId', 'maxItems', 'showInFeed', 'itemHeadline', 'itemDescription', 'overlay', 'layout', 'sections', 'sectionTitles', ...PADDINGS],
  productList: ['name', 'productIds', 'itemHeadline', 'itemDescription', ...PADDINGS],
  button: ['name', 'text', 'buttonStyle', 'link', 'buttonColor', ...STYLED],
  text: ['name', 'text', ...STYLED],
  storeLocator: ['name', 'typeface', 'headerBackgroundColor'],
  leadForm: ['name', 'formId', ...PADDINGS],
  existingPost: ['facebookPostId', 'instagramMediaId'],
  carousel: ['name', 'children', 'style', ...PADDINGS],
  header: ['name', 'children', 'backgroundColor'],
  footer: ['name', 'children', 'backgroundColor'],
}

const has = (v: unknown) => v !== undefined
const paddings = (p: IxPartInput) => ({ ...(has(p.paddingTop) ? { top_padding: p.paddingTop } : {}), ...(has(p.paddingBottom) ? { bottom_padding: p.paddingBottom } : {}) })
const styled = (p: IxPartInput) => ({
  ...(has(p.alignment) ? { text_alignment: p.alignment } : {}), ...(has(p.textColor) ? { text_color: p.textColor } : {}), ...(has(p.fontSize) ? { font_size: p.fontSize } : {}),
  ...(has(p.fontFamily) ? { font_family: p.fontFamily } : {}), ...(has(p.lineHeight) ? { line_height: p.lineHeight } : {}), ...(has(p.backgroundColor) ? { background_color: p.backgroundColor } : {}),
})
const named = (p: IxPartInput) => (has(p.name) ? { name: p.name } : {})
const openUrl = (p: IxPartInput) => (has(p.link) ? { open_url_action: { url: p.link } } : {})

/**
 * The Graph object of one part, in Nexus's one spelling (what the gateway judges is what it sends); a container's
 * `child_elements` are its children's ids, given when they are known (made earlier in the same run, or existing).
 */
export function ixElementObject(p: IxPartInput & { type: IxPartType }, childIds: string[] = []): Record<string, unknown> {
  switch (p.type) {
    case 'photo': return {
      ...named(p), ...(has(p.photoId) ? { photo_id: p.photoId } : { photo_url: p.photoUrl }), ...(has(p.style) ? { style: p.style } : {}), ...openUrl(p),
      ...(p.productTags?.length ? { product_tags: p.productTags.map((t) => ({ product_id: t.productId, coordinates: [t.x, t.y] })) } : {}),
      ...(has(p.hidePrices) ? { hide_product_prices: p.hidePrices } : {}), ...paddings(p),
    }
    case 'video': return { ...named(p), ...(has(p.videoId) ? { video_id: p.videoId } : { video_url: p.videoUrl }), ...(has(p.style) ? { style: p.style } : {}), ...paddings(p) }
    case 'templateVideo': {
      const t = p.videoTemplate ?? {}
      return {
        ...named(p), product_set_id: p.productSetId,
        template_video_spec: { customization: { ...(has(t.textColor) ? { text_color: t.textColor } : {}), ...(has(t.textBackgroundColor) ? { text_background_color: t.textBackgroundColor } : {}), ...(has(t.nameTemplate) ? { name_template: t.nameTemplate } : {}), ...(has(t.bodyTemplate) ? { body_template: t.bodyTemplate } : {}) } },
        ...paddings(p),
      }
    }
    case 'productSet': {
      const o = p.overlay
      const storefront = has(p.sections) || p.sectionTitles?.length || has(p.layout)
        ? { storefront_setting: { ...(has(p.sections) ? { enable_sections: p.sections } : {}), ...(p.sectionTitles?.length ? { customized_section_titles: p.sectionTitles.map((s) => ({ title_id: s.titleId, customized_title: s.title })) } : {}), ...(has(p.layout) ? { product_set_layout: { layout_type: p.layout } } : {}) } }
        : {}
      return {
        ...named(p), product_set_id: p.productSetId, ...(has(p.maxItems) ? { max_items: p.maxItems } : {}), ...(has(p.showInFeed) ? { show_in_feed: p.showInFeed } : {}),
        ...(has(p.itemHeadline) ? { item_headline: p.itemHeadline } : {}), ...(has(p.itemDescription) ? { item_description: p.itemDescription } : {}),
        ...(o ? { image_overlay_spec: { overlay_template: o.template, text_type: o.textType, text_font: o.font, position: o.position, theme_color: o.themeColor, ...(has(o.floatWithMargin) ? { float_with_margin: o.floatWithMargin } : {}), ...(has(o.customTextType) ? { custom_text_type: o.customTextType } : {}) } } : {}),
        ...storefront, ...paddings(p),
      }
    }
    case 'productList': return { ...named(p), product_id_list: p.productIds, ...(has(p.itemHeadline) ? { item_headline: p.itemHeadline } : {}), ...(has(p.itemDescription) ? { item_description: p.itemDescription } : {}), ...paddings(p) }
    // The guide: "The button_style field is required" — Nexus always sends it (Meta's own default, BUTTON_OUTLINE, when none is asked).
    case 'button': return { ...named(p), rich_text: { plain_text: p.text }, button_style: p.buttonStyle ?? 'BUTTON_OUTLINE', ...openUrl(p), ...(has(p.buttonColor) ? { button_color: p.buttonColor } : {}), ...styled(p), ...paddings(p) }
    case 'text': return { ...named(p), rich_text: { plain_text: p.text }, ...styled(p), ...paddings(p) }
    case 'storeLocator': return { ...named(p), ...(has(p.typeface) ? { typeface: p.typeface } : {}), ...(has(p.headerBackgroundColor) ? { header_background_color: p.headerBackgroundColor } : {}) }
    case 'leadForm': return { ...named(p), leadgen_data_id: p.formId, ...paddings(p) }
    case 'existingPost': return has(p.facebookPostId) ? { source_facebook_post_id: p.facebookPostId } : { source_instagram_media_id: p.instagramMediaId }
    case 'carousel': return { ...named(p), child_elements: childIds, ...(has(p.style) ? { style: p.style } : {}), ...paddings(p) }
    case 'header':
    case 'footer': return { ...named(p), child_elements: childIds, ...(has(p.backgroundColor) ? { background_color: p.backgroundColor } : {}) }
  }
}

/** Why one part (or existing part) is refused before any call, in words, or null. */
function partRefusal(p: IxPartInput, where: string, child: boolean): string | null {
  if (p.elementId !== undefined) {
    const extra = (Object.keys(p) as Array<keyof IxPartInput>).filter((k) => k !== 'elementId' && p[k] !== undefined)
    return extra.length ? `${where}: an existing part is named by its elementId alone (not with ${extra.join(', ')})` : null
  }
  if (!p.type) return `${where}: name a new part's type, or an existing part by its elementId`
  const type = p.type
  if (child && CONTAINERS.has(type)) return `${where}: a ${WORD[type]} holds parts itself; it cannot be a part of a carousel, header or footer`
  const stray = (Object.keys(p) as Array<keyof IxPartInput>).filter((k) => k !== 'type' && p[k] !== undefined && !(TAKES[type] as readonly string[]).includes(k))
  if (stray.length) return `${where}: a ${WORD[type]} part takes ${TAKES[type].join(', ')} — not ${stray.join(', ')}`
  const one = (a: keyof IxPartInput, b: keyof IxPartInput, what: string) => ((p[a] === undefined) === (p[b] === undefined) ? `${where}: a ${WORD[type]} names ${what}: ${a} or ${b}, exactly one` : null)
  switch (type) {
    case 'photo': return one('photoId', 'photoUrl', 'its photo')
    case 'video': return one('videoId', 'videoUrl', 'its video')
    case 'existingPost': return one('facebookPostId', 'instagramMediaId', 'the post')
    case 'templateVideo':
    case 'productSet': return p.productSetId ? null : `${where}: a ${WORD[type]} names its product set (productSetId)`
    case 'productList': return p.productIds?.length ? null : `${where}: a product list names its catalog items (productIds)`
    case 'button':
    case 'text': return p.text ? null : `${where}: a ${WORD[type]} has its text`
    case 'leadForm': return p.formId ? null : `${where}: a lead form part names the form (formId: a published lead form of the chosen Page)`
    case 'carousel':
    case 'header':
    case 'footer': return p.children?.length ? null : `${where}: a ${WORD[type]} holds at least one part (children)`
    default: return null
  }
}

/** Every id a request names, by kind, for the live check before it is queued (live-instant-experiences.ts liveIxRefsProblem). */
export function ixRefsOf(items: IxPartInput[], canvas: { heroFacebookPostId?: string; heroInstagramMediaId?: string } = {}): IxRefs {
  const refs: IxRefs = { photos: [], videos: [], posts: [], instagramMedia: [], forms: [], productSets: [], productItems: [], elements: [], canvases: [] }
  const add = (list: string[], id: string | undefined) => { if (id && !list.includes(id)) list.push(id) }
  const walk = (p: IxPartInput) => {
    add(refs.elements, p.elementId)
    add(refs.photos, p.photoId); add(refs.videos, p.videoId); add(refs.posts, p.facebookPostId); add(refs.instagramMedia, p.instagramMediaId)
    add(refs.forms, p.formId); add(refs.productSets, p.productSetId)
    for (const id of p.productIds ?? []) add(refs.productItems, id)
    for (const t of p.productTags ?? []) add(refs.productItems, t.productId)
    const linked = p.link ? META_CANVAS_LINK.exec(p.link) : null
    if (linked) add(refs.canvases, linked[1])
    for (const c of p.children ?? []) walk(c)
  }
  for (const item of items) walk(item)
  add(refs.posts, canvas.heroFacebookPostId)
  add(refs.instagramMedia, canvas.heroInstagramMediaId)
  return refs
}

/** A made-up id for judging a container or an experience before its parts exist (never sent). */
const PLACEHOLDER = (n: number) => String(9_000_000_000_000_000 + n)

/** The id Meta answered for a part made in this run (its step), or a MetaWriteError that ends the run (nothing more is sent). */
export function madeIdOf(done: ReadonlyArray<{ request: MetaChangeRequest; result: MetaChangeResult }>, step: number, operation: string): string {
  const made = done.find((d) => d.request.step === step)
  const id = made ? createdIdOf(made.result.node) : null
  if (!id) throw new MetaWriteError(localFailure(`Not sent: step ${step} (a part) ${made ? 'gave no id in Meta\'s answer' : 'was not made'}, so nothing that holds it was sent.`, 'IX_NO_PART_ID'), operation, 'not_sent')
  return id
}

/** A part as the body or a container names it: an existing part's id, or the step of this change that makes it. */
type Ref = { id: string } | { step: number; word: string }
const refWord = (r: Ref) => ('id' in r ? `part ${r.id}` : `step ${r.step} (${r.word})`)

interface Planned { requests: MetaChangeRequest[]; refs: Ref[]; made: number; lines: Array<[string, unknown, unknown]> }

/**
 * The requests that make a body's new parts, children before the part that holds them, each ONE call on the chosen Page's
 * canvas_elements; and how the body names each item. Judged here by the gateway's own judges (a container with made-up
 * child ids), so a part the gateway would refuse is never queued.
 */
function planParts(items: IxPartInput[], pageId: string, firstStep: number): Planned | { refusal: string } {
  const requests: MetaChangeRequest[] = []
  const lines: Array<[string, unknown, unknown]> = []
  let made = 0
  const emit = (p: IxPartInput, where: string, child: boolean): Ref | { refusal: string } => {
    const refusal = partRefusal(p, where, child)
    if (refusal) return { refusal }
    if (p.elementId !== undefined) return { id: p.elementId }
    const type = p.type!
    let childRefs: Ref[] = []
    if (CONTAINERS.has(type)) {
      if (p.children!.length > META_CANVAS_LIMITS.children) return { refusal: `${where}: a ${WORD[type]} holds at most ${META_CANVAS_LIMITS.children} parts` }
      for (const [i, c] of p.children!.entries()) {
        const ref = emit(c, `${where}.children[${i}]`, true)
        if ('refusal' in ref) return ref
        childRefs.push(ref)
      }
      const ids = childRefs.map((r) => ('id' in r ? r.id : `step:${r.step}`))
      if (new Set(ids).size !== ids.length) return { refusal: `${where}: a ${WORD[type]} names each part once` }
    }
    made += 1
    if (made > META_CANVAS_LIMITS.elementsPerChange) return { refusal: `One change makes at most ${META_CANVAS_LIMITS.elementsPerChange} parts (each is its own call made as the Page, counted against the Page's own rate limit, and Meta has no all-or-nothing request): make the rest in a second change and add them with set-meta-instant-experience action edit.` }
    const key = TYPE_KEY[type]
    const sample = ixElementObject(p as IxPartInput & { type: IxPartType }, childRefs.map((r, i) => ('id' in r ? r.id : PLACEHOLDER(i + 1))))
    const ids: MetaWriteBodyId[] = []
    const judged = META_CANVAS_ELEMENT_JUDGES[key](sample, key, ids)
    if (judged) return { refusal: `Nexus would not send ${where} (a ${WORD[type]}): ${judged}.` }
    const step = firstStep + requests.length
    const childSteps = childRefs.filter((r): r is { step: number; word: string } => 'step' in r).map((r) => r.step)
    const operation = 'canvas.element.create'
    const label = `Make part ${step}: ${WORD[type]}${CONTAINERS.has(type) ? ` holding ${childRefs.map(refWord).join(', ')}` : ''}${p.name ? ` "${p.name}"` : ''} on the Facebook Page ${pageId}`
    const params = childSteps.length ? {} : { [key]: JSON.stringify(sample) }
    requests.push({
      step, label, objectId: pageId, objectKind: 'page', edge: 'canvas_elements', operation,
      params,
      // The plan hash names the structure (which earlier step each child is), never a made-up id.
      ...(childSteps.length ? { planParams: { [key]: JSON.stringify(ixElementObject(p as IxPartInput & { type: IxPartType }, childRefs.map((r) => ('id' in r ? r.id : `@${r.step}`)))) } } : {}),
      ...(childSteps.length ? {
        needs: childSteps,
        prepare: async (done) => ({ [key]: JSON.stringify(ixElementObject(p as IxPartInput & { type: IxPartType }, childRefs.map((r) => ('id' in r ? r.id : madeIdOf(done, r.step, operation))))) }),
      } : {}),
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, skipReadBack: true, explain: IX_EXPLAIN, asPage: true,
    })
    lines.push([`Part ${step}: ${WORD[type]}${p.name ? ` "${p.name}"` : ''}`, 'none', CONTAINERS.has(type) ? `new, holding ${childRefs.map(refWord).join(', ')}` : 'new'])
    return { step, word: WORD[type] }
  }
  const refs: Ref[] = []
  for (const [i, item] of items.entries()) {
    const ref = emit(item, `parts[${i}]`, false)
    if ('refusal' in ref) return ref
    refs.push(ref)
  }
  const named = refs.map((r) => ('id' in r ? r.id : `step:${r.step}`))
  if (new Set(named).size !== named.length) return { refusal: 'The body names each part once.' }
  if (refs.length > META_CANVAS_LIMITS.bodyElements) return { refusal: `An Instant Experience names at most ${META_CANVAS_LIMITS.bodyElements} parts in Nexus.` }
  return { requests, refs, made, lines }
}

/** The body_element_ids form value: existing ids and the ids this run's steps made, in order. */
const bodyValue = (refs: Ref[], idOf: (step: number) => string) => JSON.stringify(refs.map((r) => ('id' in r ? r.id : idOf(r.step))))

/** Warnings a body's parts bring (Instagram's limits, a collection ad's needs), each said once. */
function partWarnings(items: IxPartInput[]): string[] {
  const all: IxPartInput[] = []
  const walk = (p: IxPartInput) => { all.push(p); for (const c of p.children ?? []) walk(c) }
  items.forEach(walk)
  const out: string[] = []
  if (all.some((p) => p.type === 'storeLocator')) out.push('A store locator is not supported on Instagram (Meta\'s guide), and it shows the Page\'s own store locations (set up in Meta\'s screens).')
  if (all.some((p) => p.link && META_CANVAS_LINK.test(p.link))) out.push('On Instagram a button cannot link to another Instant Experience, and a carousel photo\'s link to one is not clickable (Meta\'s guide).')
  if (all.some((p) => p.type === 'video')) out.push('On Instagram no 360 video plays in an Instant Experience (Meta\'s guide).')
  if (all.some((p) => p.type === 'productSet' && p.showInFeed)) out.push('For a collection ad (collection-ads guide): the experience holds a photo, video or automatic video, a product set with showInFeed true and a footer; the creative then names 4 collection_thumbnails (element_crops with the 100x100 key only).')
  if (all.some((p) => p.type === 'templateVideo')) out.push('An automatic video\'s settings (videoTemplate) are only shown by Meta\'s collection-ads example (text_color, text_background_color, name_template, body_template); Meta\'s answer says whether it takes them (LIVE-PROBES IX27b-06).')
  if (all.some((p) => p.overlay)) out.push('A product set\'s overlay is sent in lower case, as Meta\'s collection-ads example writes it (its reference lists the same values in upper case); Meta\'s answer settles it (LIVE-PROBES IX27b-05).')
  if (all.some((p) => p.type === 'existingPost' || (p.facebookPostId !== undefined))) out.push('An existing post part (or hero asset) is the chosen Page\'s own post or photo or video, or the chosen Instagram account\'s own media; which id form Meta takes for a Facebook post (<page>_<post> or the photo\'s or video\'s own id) is settled live (LIVE-PROBES IX27b-04).')
  return out
}

/**
 * The template id of a template's name: step 10's IX_TEMPLATES (the guide's five; meta-instant-experiences view template shows
 * the parts each takes), never a copy. The gateway holds the same ids (META_IX_TEMPLATE_IDS; a test keeps them equal).
 */
export const IX_TEMPLATE_BY_NAME: Readonly<Record<string, string>> = IX_TEMPLATES
const templateName = (id: string | null) => Object.entries(IX_TEMPLATE_BY_NAME).find(([, v]) => v === id)?.[0] ?? null

// ── create ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface IxCreateInput {
  name: string
  parts: IxPartInput[]
  backgroundColor?: string
  swipeToOpen?: boolean
  template?: string
  heroFacebookPostId?: string
  heroInstagramMediaId?: string
  hidden?: boolean
}

/** What a create records (undo hides the experience it made; its parts are named so remove-meta-ads-items can delete them). */
export interface IxCreateRecord { action: 'create'; pageId: string; canvasId: string | null; name: string; elementIds: string[]; hidden: boolean | null }

const canvasFields = (c: { backgroundColor?: string; swipeToOpen?: boolean; template?: string; heroFacebookPostId?: string; heroInstagramMediaId?: string }) => ({
  ...(has(c.backgroundColor) ? { background_color: c.backgroundColor! } : {}),
  ...(has(c.swipeToOpen) ? { enable_swipe_to_open: String(c.swipeToOpen) } : {}),
  ...(has(c.heroFacebookPostId) ? { hero_asset_facebook_post_id: c.heroFacebookPostId! } : {}),
  ...(has(c.heroInstagramMediaId) ? { hero_asset_instagram_media_id: c.heroInstagramMediaId! } : {}),
  ...(has(c.template) ? { source_template_id: IX_TEMPLATE_BY_NAME[c.template!] ?? c.template! } : {}),
})

/** create-meta-instant-experience as a draft: its new parts (children first), then the experience UNPUBLISHED from them. */
export function ixCreateDraft(input: IxCreateInput, ctx: IxContext): MetaChangeDraft | { refusal: string } {
  if (!input.parts.length) return { refusal: 'An Instant Experience has at least one part.' }
  if (has(input.heroFacebookPostId) && has(input.heroInstagramMediaId)) return { refusal: 'An Instant Experience has one hero asset: a Facebook post or an Instagram media, not both.' }
  if (input.template !== undefined && !IX_TEMPLATE_BY_NAME[input.template]) return { refusal: `template is one of ${Object.keys(IX_TEMPLATE_BY_NAME).join(', ')} (the AR template is Ads Manager only).` }
  const planned = planParts(input.parts, ctx.pageId, 1)
  if ('refusal' in planned) return planned
  const step = planned.requests.length + 1
  const madeSteps = planned.requests.map((r) => r.step)
  const fixed: Record<string, string> = { name: input.name, is_published: 'false', ...canvasFields(input), ...(has(input.hidden) ? { is_hidden: String(input.hidden) } : {}) }
  const needsIds = planned.refs.some((r) => 'step' in r)
  const judged = metaCanvasCreateProblem(new Map(Object.entries({ ...fixed, body_element_ids: bodyValue(planned.refs, (s) => PLACEHOLDER(s)) })))
  if (judged) return { refusal: `Nexus would not send this Instant Experience: ${judged}.` }
  const operation = 'canvas.create'
  const request: MetaChangeRequest = {
    step,
    label: `Make the Instant Experience "${input.name}" (UNPUBLISHED) on the Facebook Page ${ctx.pageId} from ${planned.refs.map(refWord).join(', ')}`,
    objectId: ctx.pageId, objectKind: 'page', edge: 'canvases', operation,
    params: needsIds ? fixed : { ...fixed, body_element_ids: bodyValue(planned.refs, () => '') },
    ...(needsIds ? {
      planParams: { ...fixed, body_element_ids: JSON.stringify(planned.refs.map((r) => ('id' in r ? r.id : `@${r.step}`))) },
      needs: madeSteps,
      prepare: async (done) => ({ body_element_ids: bodyValue(planned.refs, (s) => madeIdOf(done, s, operation)) }),
    } : {}),
    check: 'none', raisesSpend: false, readBackInPost: false, readBackFields: 'id,name,is_published,is_hidden',
    expect: { name: input.name, is_published: 'false', ...(has(input.hidden) ? { is_hidden: String(input.hidden) } : {}) },
    recordEvenIfNotAsAsked: true, budget: false,
    // Its undo (a hide) changes the new experience, not the Page.
    undoable: false, explain: IX_EXPLAIN, asPage: true,
  }
  const { changes, more } = changeLines([
    [`Instant Experience "${input.name}"`, 'none', `new, UNPUBLISHED, on the chosen Facebook Page ${ctx.pageId}`],
    ...planned.lines,
    ['Parts in order', null, planned.refs.map(refWord).join(', ')],
    ...(has(input.backgroundColor) ? [['Background colour', null, input.backgroundColor] as [string, unknown, unknown]] : []),
    ...(has(input.swipeToOpen) ? [['Swipe to open', null, input.swipeToOpen ? 'on' : 'off'] as [string, unknown, unknown]] : []),
    ...(input.template ? [['Template', null, `${input.template} (${IX_TEMPLATE_BY_NAME[input.template]})`] as [string, unknown, unknown]] : []),
    ...(input.heroFacebookPostId ? [['Hero asset', null, `Facebook post ${input.heroFacebookPostId}`] as [string, unknown, unknown]] : []),
    ...(input.heroInstagramMediaId ? [['Hero asset', null, `Instagram media ${input.heroInstagramMediaId}`] as [string, unknown, unknown]] : []),
    ...(has(input.hidden) ? [['Hidden', null, input.hidden ? 'yes' : 'no'] as [string, unknown, unknown]] : []),
  ])
  const warnings = [
    IX_NO_CHECK, IX_NO_SPEND, IX_PAGE_LIMIT,
    'It is made UNPUBLISHED, so it can still be edited (set-meta-instant-experience action edit). An ad can use it only once it is published (set-meta-instant-experience action publish — its own change, one way).',
    IX_NO_DELETE, IX_INSTAGRAM,
    ...(input.template ? [`A template's layout is fixed: its parts must match it in order (meta-instant-experiences view template ${input.template} lists them); Meta's answer says when they do not.`] : []),
    ...(has(input.heroFacebookPostId) || has(input.heroInstagramMediaId) ? ['A hero asset that differs from the hero of a part is refused by Meta ("the API returns an error"); an empty one takes the part\'s (partnership-ads guide).'] : []),
    ...partWarnings(input.parts),
    ...(planned.made ? [`Each part is its own request (${plural(planned.made, 'part')}); a part Meta refuses stops what holds it and the experience itself — the parts already made stay on the Page and are named in the answer (remove-meta-ads-items deletes a part on a person's explicit ask).`] : []),
  ]
  const before: IxCreateRecord = { action: 'create', pageId: ctx.pageId, canvasId: null, name: input.name, elementIds: [], hidden: null }
  return {
    summary: `Make the Instant Experience "${input.name}" with ${plural(planned.refs.length, 'part')} (${plural(planned.made, 'new part')}) on the chosen Facebook Page, UNPUBLISHED — nothing spends and Meta reviews nothing until an ad links to it.`,
    changes,
    totals: { parts: planned.refs.length, newParts: planned.made, requests: planned.requests.length + 1, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped: [],
    requests: [...planned.requests, request],
    stands: { pageId: ctx.pageId, existingParts: planned.refs.filter((r): r is { id: string } => 'id' in r).map((r) => r.id) },
    before,
    after: { ...before },
  }
}

// ── set: edit, publish, hide ───────────────────────────────────────────────────────────────────────────────────────

export type IxSetAction = 'edit' | 'publish' | 'hide' | 'unhide'

/** The fields an edit changes, as Nexus reads them back (enable_swipe_to_open is not a Canvas field Meta reads: not here). */
export interface IxEditFields { name?: string | null; backgroundColor?: string | null; elementIds?: string[] | null; heroFacebookPostId?: string | null; heroInstagramMediaId?: string | null; template?: string | null }

/** set-meta-instant-experience's record: what a change replaced and wrote, for undo (the Page and experience always named). */
export interface IxSetRecord {
  action: IxSetAction
  pageId: string
  canvasId: string
  name?: string | null
  /** edit: the fields changed (before: their old values; after: the new ones). */
  fields?: IxEditFields
  /** edit: what Meta does not read back, as asked (never compared). */
  notReadBack?: { swipeToOpen?: boolean }
  /** edit (before): set-meta-instant-experience's arguments that put the old values back, or null with noUndo. */
  undo?: Record<string, unknown> | null
  noUndo?: string[]
  /** edit (after): the parts this change made new. */
  madeElementIds?: string[]
  published?: boolean | null
  hidden?: boolean | null
}

export interface IxEditInput {
  name?: string
  backgroundColor?: string
  swipeToOpen?: boolean
  template?: string
  heroFacebookPostId?: string
  heroInstagramMediaId?: string
  /** The WHOLE body in its new order: existing parts by elementId, new parts made by this change. */
  parts?: IxPartInput[]
}

const whoOf = (c: IxCanvasState) => `Instant Experience "${c.name ?? 'no name'}" (${c.canvasId})`
const sameList = (a: string[] | null | undefined, b: string[] | null | undefined) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i])

/** The edit of an unpublished Instant Experience as a draft: new parts first, then ONE POST /{canvas} with the fields changed. */
export function ixEditDraft(input: IxEditInput, canvas: IxCanvasState): MetaChangeDraft | { refusal: string } {
  const who = whoOf(canvas)
  if (canvas.published === true) return { refusal: `The ${who} is published: Meta says "You can only update an unpublished Instant Experience", so Nexus changes nothing in it. Make a new one with create-meta-instant-experience (it can reuse its parts by elementId), or hide this one (set-meta-instant-experience action hide).` }
  if (canvas.published !== false) return { refusal: `Nexus could not read whether the ${who} is published, so it changes nothing in it (Meta takes an edit of an unpublished one only).` }
  if (has(input.heroFacebookPostId) && has(input.heroInstagramMediaId)) return { refusal: 'An Instant Experience has one hero asset: a Facebook post or an Instagram media, not both.' }
  if (input.template !== undefined && !IX_TEMPLATE_BY_NAME[input.template]) return { refusal: `template is one of ${Object.keys(IX_TEMPLATE_BY_NAME).join(', ')} (the AR template is Ads Manager only).` }
  const skipped: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const fixed: Record<string, string> = {}
  const oldFields: IxEditFields = {}
  const newFields: IxEditFields = {}
  const noUndo: string[] = []
  const undo: Record<string, unknown> = {}
  const field = <K extends keyof IxEditFields>(key: K, label: string, now: IxEditFields[K], wanted: IxEditFields[K], param: string, value: string) => {
    if (now !== null && now !== undefined && JSON.stringify(now) === JSON.stringify(wanted)) { skipped.push(`${label} is already ${String(wanted)}.`); return }
    fixed[param] = value
    oldFields[key] = now ?? null
    newFields[key] = wanted
    lines.push([label, now ?? 'not read', wanted])
  }
  if (input.name !== undefined) field('name', 'Name', canvas.name, input.name, 'name', input.name)
  if (input.backgroundColor !== undefined) field('backgroundColor', 'Background colour', canvas.backgroundColor, input.backgroundColor, 'background_color', input.backgroundColor)
  if (input.heroFacebookPostId !== undefined) field('heroFacebookPostId', 'Hero asset (Facebook post)', canvas.heroFacebookPostId, input.heroFacebookPostId, 'hero_asset_facebook_post_id', input.heroFacebookPostId)
  if (input.heroInstagramMediaId !== undefined) field('heroInstagramMediaId', 'Hero asset (Instagram media)', canvas.heroInstagramMediaId, input.heroInstagramMediaId, 'hero_asset_instagram_media_id', input.heroInstagramMediaId)
  if (input.template !== undefined) field('template', 'Template', templateName(canvas.templateId), input.template, 'source_template_id', IX_TEMPLATE_BY_NAME[input.template])
  if (input.swipeToOpen !== undefined) {
    fixed.enable_swipe_to_open = String(input.swipeToOpen)
    lines.push(['Swipe to open', 'not read (Meta does not read it back)', input.swipeToOpen ? 'on' : 'off'])
    noUndo.push('Swipe to open: Meta does not read enable_swipe_to_open back (it is no Canvas field in Meta\'s SDK), so the undo cannot put the old setting back.')
  }
  let planned: Planned | null = null
  if (input.parts !== undefined) {
    if (!input.parts.length) return { refusal: 'An Instant Experience keeps at least one part: name the whole body in its new order.' }
    const p = planParts(input.parts, canvas.pageId, 1)
    if ('refusal' in p) return p
    const newIds = p.refs.map((r) => ('id' in r ? r.id : null))
    if (!p.made && sameList(newIds as string[], canvas.elementIds)) skipped.push('The parts are already in this order.')
    else {
      planned = p
      oldFields.elementIds = canvas.elementIds
      lines.push(...p.lines)
      lines.push(['Parts in order', canvas.elementIds?.join(', ') ?? 'not read', p.refs.map(refWord).join(', ')])
    }
  }
  if (!Object.keys(fixed).length && !planned) {
    return { summary: `Nothing to change in the ${who}.`, changes: {}, totals: {}, warnings: [], spendsMoney: [], skipped: skipped.length ? skipped : ['Nothing was asked to change.'], requests: [], stands: {}, before: null, after: null }
  }
  // What the undo sends: the old values Meta read (a value it did not read, or none to send back, cannot be put back).
  for (const [key, old] of Object.entries(oldFields) as Array<[keyof IxEditFields, unknown]>) {
    if (key === 'elementIds') {
      if (Array.isArray(old) && old.length) undo.parts = (old as string[]).map((id) => ({ elementId: id }))
      else noUndo.push('Parts: Nexus could not read the old parts (or there were none), so the undo cannot put them back.')
    } else if (old === null || old === undefined) {
      noUndo.push(`${key === 'heroFacebookPostId' || key === 'heroInstagramMediaId' ? 'Hero asset' : key === 'template' ? 'Template' : key}: there was none (or Meta did not read it), and Meta documents no way to clear it, so the undo leaves it.`)
    } else if (key === 'name') undo.name = old
    else if (key === 'backgroundColor') {
      if (typeof old === 'string' && META_CANVAS_COLOR.test(old)) undo.backgroundColor = old
      else noUndo.push(`Background colour: Meta read it as "${String(old).slice(0, 20)}", which Nexus cannot send back as written.`)
    }
    else if (key === 'heroFacebookPostId') undo.heroFacebookPostId = old
    else if (key === 'heroInstagramMediaId') undo.heroInstagramMediaId = old
    else if (key === 'template') undo.template = old
  }
  const operation = 'canvas.update'
  const needsIds = !!planned?.refs.some((r) => 'step' in r)
  const firstStep = (planned?.requests.length ?? 0) + 1
  const body = planned ? { body_element_ids: bodyValue(planned.refs, (s) => PLACEHOLDER(s)) } : {}
  const judged = metaCanvasUpdateProblem(new Map(Object.entries({ ...fixed, ...body })))
  if (judged) return { refusal: `Nexus would not send this edit: ${judged}.` }
  const expect: Record<string, string> = { is_published: 'false', ...(fixed.name !== undefined ? { name: fixed.name } : {}), ...(fixed.background_color !== undefined ? { background_color: fixed.background_color } : {}) }
  const request: MetaChangeRequest = {
    step: firstStep,
    label: `Change the ${who}${planned ? `: parts ${planned.refs.map(refWord).join(', ')}` : ''}`,
    objectId: canvas.canvasId, objectKind: 'canvas', operation,
    params: planned && !needsIds ? { ...fixed, body_element_ids: bodyValue(planned.refs, () => '') } : fixed,
    ...(needsIds ? {
      planParams: { ...fixed, body_element_ids: JSON.stringify(planned!.refs.map((r) => ('id' in r ? r.id : `@${r.step}`))) },
      needs: planned!.requests.map((r) => r.step),
      prepare: async (done) => ({ body_element_ids: bodyValue(planned!.refs, (s) => madeIdOf(done, s, operation)) }),
    } : {}),
    check: 'none', raisesSpend: false, readBackInPost: false, readBackFields: 'id,name,is_published,background_color', expect, budget: false, undoable: true, explain: IX_EXPLAIN, asPage: true,
  }
  const record = (fields: IxEditFields, extra: Partial<IxSetRecord>): IxSetRecord => ({ action: 'edit', pageId: canvas.pageId, canvasId: canvas.canvasId, name: canvas.name, fields, ...extra })
  const { changes, more } = changeLines(lines)
  return {
    summary: `Edit the UNPUBLISHED ${who} (${lines.length} change${lines.length === 1 ? '' : 's'}) — nothing spends: no ad can use it before it is published.`,
    changes,
    totals: { fields: Object.keys(fixed).length, newParts: planned?.made ?? 0, requests: (planned?.requests.length ?? 0) + 1, ...(more ? { moreLines: more } : {}) },
    warnings: [
      IX_NO_CHECK, IX_PAGE_LIMIT,
      'Meta takes an edit of an UNPUBLISHED Instant Experience only; Nexus read that it is unpublished just now, and reads it again before the change runs.',
      ...(planned ? ['The parts are sent as the WHOLE new body in order: a part left out is no longer in the experience (it stays on the Page).'] : []),
      ...(noUndo.length ? [`Undo: ${noUndo.join(' ')}`] : ['Its undo puts the old values back (while the experience is still unpublished).']),
      ...(planned ? partWarnings(input.parts!) : []),
    ],
    spendsMoney: [],
    skipped,
    requests: [...(planned?.requests ?? []), request],
    stands: { canvasId: canvas.canvasId, pageId: canvas.pageId, published: canvas.published, name: canvas.name, backgroundColor: canvas.backgroundColor, elementIds: canvas.elementIds, heroFacebookPostId: canvas.heroFacebookPostId, heroInstagramMediaId: canvas.heroInstagramMediaId, templateId: canvas.templateId },
    before: record(oldFields, { undo: Object.keys(undo).length ? { action: 'edit', canvasId: canvas.canvasId, ...undo } : null, noUndo }),
    after: record(newFields, { ...(input.swipeToOpen !== undefined ? { notReadBack: { swipeToOpen: input.swipeToOpen } } : {}) }),
  }
}

/** The publish as a draft: ONE way (`is_published=true`), its own change, its own approval. */
export function ixPublishDraft(canvas: IxCanvasState): MetaChangeDraft | { refusal: string } {
  const who = whoOf(canvas)
  const record = (published: boolean | null): IxSetRecord => ({ action: 'publish', pageId: canvas.pageId, canvasId: canvas.canvasId, name: canvas.name, published })
  if (canvas.published === true) {
    return { summary: `The ${who} is already published.`, changes: {}, totals: {}, warnings: [], spendsMoney: [], skipped: [`The ${who} is already published: nothing to send.`], requests: [], stands: {}, before: record(true), after: record(true) }
  }
  if (canvas.published !== false) return { refusal: `Nexus could not read whether the ${who} is published, so it sends no publish.` }
  if (canvas.elementIds !== null && !canvas.elementIds.length) return { refusal: `The ${who} has no parts: add them first (set-meta-instant-experience action edit).` }
  return {
    summary: `Publish the ${who} — ONE WAY: it can never be edited again, and ads can then link to it.`,
    changes: changeLines([[who, 'unpublished (can be edited)', 'PUBLISHED (can never be edited again)']]).changes,
    totals: { experiences: 1 },
    warnings: [
      IX_ONE_WAY, IX_NO_CHECK,
      'Publishing spends nothing by itself: an ad that links to it does (create-meta-creative with its link https://fb.com/canvas_doc/<id>, then create-meta-ad — Meta reviews it with that ad).',
      IX_INSTAGRAM,
      'Its undo cannot un-publish it: Meta documents no way back. It can be hidden afterwards (set-meta-instant-experience action hide).',
    ],
    spendsMoney: [],
    skipped: [],
    requests: [{
      step: 1, label: `Publish the ${who} (one way)`, objectId: canvas.canvasId, objectKind: 'canvas', operation: 'canvas.publish', params: { is_published: 'true' },
      check: 'none', raisesSpend: false, readBackInPost: false, readBackFields: 'id,is_published', expect: { is_published: 'true' }, budget: false, undoable: false, explain: IX_EXPLAIN, asPage: true,
    }],
    stands: { canvasId: canvas.canvasId, pageId: canvas.pageId, published: canvas.published, elementIds: canvas.elementIds },
    before: record(false),
    after: record(true),
  }
}

/** Hide (or show again) as a draft: ONE POST /{canvas} is_hidden; undo shows it again (or hides it). */
export function ixHiddenDraft(hide: boolean, canvas: IxCanvasState): MetaChangeDraft | { refusal: string } {
  const who = whoOf(canvas)
  const action: IxSetAction = hide ? 'hide' : 'unhide'
  const record = (hidden: boolean | null): IxSetRecord => ({ action, pageId: canvas.pageId, canvasId: canvas.canvasId, name: canvas.name, hidden })
  if (canvas.hidden === hide) {
    return { summary: `The ${who} is already ${hide ? 'hidden' : 'shown'}.`, changes: {}, totals: {}, warnings: [], spendsMoney: [], skipped: [`The ${who} is already ${hide ? 'hidden' : 'shown'}: nothing to send.`], requests: [], stands: {}, before: record(hide), after: record(hide) }
  }
  // Nexus cannot list the ads that link to an Instant Experience: showing a published one again may let such an ad show it again.
  const spends = !hide && canvas.published !== false ? ['an ad that links to this published Instant Experience may show it again once it is shown again (Nexus cannot list the ads that link to one; check them in Ads Manager)'] : []
  return {
    summary: hide ? `Hide the ${who} (Meta documents no delete; it stays in the Page's list, hidden).` : `Show the ${who} again.`,
    changes: changeLines([[who, canvas.hidden === null ? 'not read' : canvas.hidden ? 'hidden' : 'shown', hide ? 'hidden' : 'shown']]).changes,
    totals: { experiences: 1 },
    warnings: [
      IX_NO_CHECK,
      ...(canvas.published ? ['Meta\'s reference says is_hidden hides a PUBLISHED Instant Experience, while its guide says only an unpublished one can be updated: Meta\'s answer settles it (LIVE-PROBES IX27b-09).'] : []),
      ...(hide && canvas.published !== false ? ['Meta does not say what hiding does to an ad that already links to it: check such ads in Ads Manager first.'] : []),
      hide ? 'Its undo shows it again.' : 'Its undo hides it again.',
    ],
    spendsMoney: spends,
    skipped: [],
    requests: [{
      step: 1, label: `${hide ? 'Hide' : 'Show again'} the ${who}`, objectId: canvas.canvasId, objectKind: 'canvas', operation: 'canvas.hidden', params: { is_hidden: String(hide) },
      check: 'none', raisesSpend: spends.length > 0, readBackInPost: false, readBackFields: 'id,is_hidden', expect: { is_hidden: String(hide) }, budget: false, undoable: true, explain: IX_EXPLAIN, asPage: true,
    }],
    stands: { canvasId: canvas.canvasId, pageId: canvas.pageId, hidden: canvas.hidden, published: canvas.published },
    before: record(canvas.hidden),
    after: record(hide),
  }
}

/** The ids of the parts a run made (in step order), from what Meta answered. */
export function madePartIds(done: ReadonlyArray<{ request: MetaChangeRequest; result: MetaChangeResult }>): string[] {
  return done.filter((d) => d.request.operation === 'canvas.element.create').map((d) => createdIdOf(d.result.node)).filter((id): id is string => !!id)
}
