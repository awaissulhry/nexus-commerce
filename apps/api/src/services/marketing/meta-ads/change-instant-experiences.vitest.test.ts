/**
 * Meta step 27b — the Instant Experience drafts (pure): parts in order, children before what holds them, each ONE request
 * made as the Page; the experience always UNPUBLISHED, from the ids this run made (taken just before it is sent); an edit
 * only while unpublished, with what its undo can and cannot put back; a publish one way; a hide with its undo; nothing
 * spends; Meta has no check; the gateway's own judges refuse a part before it is queued. Made-up ids.
 */
import { describe, expect, it } from 'vitest'
import {
  IX_HIDE_UNPUBLISHED_WORDS, IX_NO_CHECK, IX_NO_DELETE, IX_ONE_WAY, ixCreateDraft, ixEditDraft, ixElementObject, ixHiddenDraft, ixPartContent, ixPublishDraft, ixRefsOf,
  ixSentBody, ixUnlistedParts, madeIdOf, madePartIds, type IxPartInput,
} from './change-instant-experiences.js'
import type { MetaChangeDraft, MetaChangeRequest } from './change-draft.js'
import type { IxCanvasState } from './live-instant-experiences.js'
import { metaCanvasElementOf } from '../../gateway/meta-canvas-rules.js'
import { MetaWriteError, readBackMismatch } from './write-client.js'

const PAGE = '120000000000010'
const CANVAS = '120000000000701'
const PART = '120000000000711'
const SET = '120000000000061'
const ITEM = '120000000000071'
const ctx = { connectionId: 'm-1', pageId: PAGE, instagramId: '17841400000000001', adAccountId: '1234567890' }
const canvas = (over: Partial<IxCanvasState> = {}): IxCanvasState => ({
  pageId: PAGE, canvasId: CANVAS, name: 'Experience A', published: false, hidden: false, backgroundColor: 'FFFFFFFF', elementIds: [PART],
  heroFacebookPostId: null, heroInstagramMediaId: null, templateId: null, link: `https://fb.com/canvas_doc/${CANVAS}`, ...over,
})
const draftOf = (d: MetaChangeDraft | { refusal: string }) => { if ('refusal' in d) throw new Error(d.refusal); return d }
const refusalOf = (d: MetaChangeDraft | { refusal: string }) => ('refusal' in d ? d.refusal : null)
const done = (pairs: Array<[MetaChangeRequest, Record<string, unknown> | null]>) => pairs.map(([request, node]) => ({ request, result: { node, readBack: 'none' as const, waitedMs: 0 } }))

const COLLECTION: IxPartInput[] = [
  { type: 'photo', photoId: '800000000000001', name: 'Cover' },
  { type: 'productSet', productSetId: SET, showInFeed: true, itemHeadline: '{{product.name}}', layout: 'GRID_2COL' },
  { type: 'footer', children: [{ type: 'button', text: 'Shop now', buttonStyle: 'BUTTON_FILLED', link: 'https://www.example.com/shop' }] },
]

describe('create-meta-instant-experience as a draft', () => {
  it('parts first (a footer\'s button before the footer), then the experience UNPUBLISHED from their ids; nothing spends; no check', () => {
    const d = draftOf(ixCreateDraft({ name: 'Experience A', parts: COLLECTION }, ctx))
    expect(d.requests.map((r) => [r.step, r.operation, r.edge, r.objectId, r.objectKind, r.check, r.raisesSpend])).toEqual([
      [1, 'canvas.element.create', 'canvas_elements', PAGE, 'page', 'none', false],
      [2, 'canvas.element.create', 'canvas_elements', PAGE, 'page', 'none', false],
      [3, 'canvas.element.create', 'canvas_elements', PAGE, 'page', 'none', false],
      [4, 'canvas.element.create', 'canvas_elements', PAGE, 'page', 'none', false],
      [5, 'canvas.create', 'canvases', PAGE, 'page', 'none', false],
    ])
    expect(d.spendsMoney).toEqual([])
    expect(d.warnings).toEqual(expect.arrayContaining([IX_NO_CHECK]))
    expect(d.warnings.join(' ')).toMatch(/AS the chosen Page .* at most 20 parts in one change/)
    expect(d.requests.every((r) => r.asPage === true)).toBe(true)
    expect(d.summary).toMatch(/UNPUBLISHED — nothing spends/)
    // Step 3 is the footer's button; step 4 the footer, which waits for it and names it at send time.
    expect(d.requests[2].params).toEqual({ canvas_button: JSON.stringify({ rich_text: { plain_text: 'Shop now' }, button_style: 'BUTTON_FILLED', open_url_action: { url: 'https://www.example.com/shop' } }) })
    expect(d.requests[3]).toMatchObject({ params: {}, needs: [3], planParams: { canvas_footer: JSON.stringify({ child_elements: ['@3'] }) } })
    expect(d.requests[4]).toMatchObject({
      params: { name: 'Experience A', is_published: 'false' }, needs: [1, 2, 3, 4], recordEvenIfNotAsAsked: true,
      planParams: { name: 'Experience A', is_published: 'false', body_element_ids: JSON.stringify(['@1', '@2', '@4']) },
      expect: { name: 'Experience A', is_published: 'false' },
    })
    expect(d.before).toEqual({ action: 'create', pageId: PAGE, canvasId: null, name: 'Experience A', elementIds: [], hidden: null })
  })
  it('at send time each container and the experience name the ids Meta answered for this run\'s parts (in order), and stop when one is missing', async () => {
    const d = draftOf(ixCreateDraft({ name: 'Experience A', parts: COLLECTION }, ctx))
    const made = done([[d.requests[0], { id: '120000000000801' }], [d.requests[1], { id: '120000000000802' }], [d.requests[2], { id: '120000000000803' }], [d.requests[3], { id: '120000000000804' }]])
    expect(await d.requests[3].prepare!(made)).toEqual({ canvas_footer: JSON.stringify({ child_elements: ['120000000000803'] }) })
    expect(await d.requests[4].prepare!(made)).toEqual({ body_element_ids: JSON.stringify(['120000000000801', '120000000000802', '120000000000804']) })
    // The gateway's judge takes what is sent.
    expect(metaCanvasElementOf(new Map(Object.entries(await d.requests[3].prepare!(made))))).toMatchObject({ key: 'canvas_footer' })
    await expect(d.requests[4].prepare!(made.slice(0, 2))).rejects.toBeInstanceOf(MetaWriteError)
    await expect(d.requests[4].prepare!(made.slice(0, 2))).rejects.toThrow(/step 4 \(a part\) was not made/)
    expect(madePartIds(made)).toEqual(['120000000000801', '120000000000802', '120000000000803', '120000000000804'])
    expect(() => madeIdOf(done([[d.requests[0], { success: true }]]), 1, 'canvas.create')).toThrow(/gave no id/)
  })
  it('existing parts of the Page by elementId: no request of their own; a body of existing parts only goes in one request', () => {
    const d = draftOf(ixCreateDraft({ name: 'Experience B', parts: [{ elementId: PART }, { type: 'text', text: 'Hallo' }] }, ctx))
    expect(d.requests).toHaveLength(2)
    expect(d.requests[1].planParams?.body_element_ids).toBe(JSON.stringify([PART, '@1']))
    const only = draftOf(ixCreateDraft({ name: 'Experience C', parts: [{ elementId: PART }], backgroundColor: 'FFFFFF', swipeToOpen: true, template: 'sell-products-grid', heroInstagramMediaId: '17900000000000001', hidden: true }, ctx))
    expect(only.requests).toHaveLength(1)
    expect(only.requests[0]).toMatchObject({
      params: { name: 'Experience C', is_published: 'false', background_color: 'FFFFFF', enable_swipe_to_open: 'true', hero_asset_instagram_media_id: '17900000000000001', source_template_id: '1932289657009030', is_hidden: 'true', body_element_ids: JSON.stringify([PART]) },
      expect: { is_hidden: 'true' },
    })
    expect(only.requests[0].prepare).toBeUndefined()
  })
  it('refuses in words before any call: an unknown or mixed part, a container in a container, stray fields, two heroes, more than 20 new parts', () => {
    const refuse = (parts: IxPartInput[], extra: Record<string, unknown> = {}) => refusalOf(ixCreateDraft({ name: 'X', parts, ...extra }, ctx))
    expect(refuse([{}])).toMatch(/name a new part's type, or an existing part by its elementId/)
    expect(refuse([{ elementId: PART, type: 'text' }])).toMatch(/named by its elementId alone/)
    expect(refuse([{ type: 'photo', photoId: '1', videoId: '2' }])).toMatch(/takes .* — not videoId/)
    expect(refuse([{ type: 'photo' }])).toMatch(/photoId or photoUrl, exactly one/)
    expect(refuse([{ type: 'button' }])).toMatch(/has its text/)
    expect(refuse([{ type: 'footer', children: [{ type: 'header', children: [{ type: 'text', text: 'x' }] }] }])).toMatch(/cannot be a part of a carousel, header or footer/)
    expect(refuse([{ type: 'carousel', children: [{ elementId: PART }, { elementId: PART }] }])).toMatch(/names each part once/)
    expect(refuse([{ elementId: PART }, { elementId: PART }])).toMatch(/each part once/)
    expect(refuse([{ type: 'text', text: 'x' }], { heroFacebookPostId: `${PAGE}_1`, heroInstagramMediaId: '1' })).toMatch(/one hero asset/)
    expect(refuse(Array.from({ length: 21 }, () => ({ type: 'text' as const, text: 'x' })))).toMatch(/at most 20 parts/)
    // The gateway's own judge: a value it would refuse is never queued.
    expect(refuse([{ type: 'button', text: 'x'.repeat(201) }])).toMatch(/Nexus would not send parts\[0\] \(a button\): .*1 to 200 characters/)
    expect(refuse([{ type: 'photo', photoUrl: 'https://scontent.xx.fbcdn.net/a.jpg' }])).toMatch(/links it returned/)
    expect(refuse([{ type: 'text', text: 'x' }], { template: 'ar' })).toMatch(/template is one of/)
  })
  it('the parts say Meta\'s Instagram limits, a collection ad\'s needs and the UNVERIFIED shapes in words', () => {
    const d = draftOf(ixCreateDraft({ name: 'X', parts: [...COLLECTION, { type: 'storeLocator' }, { type: 'templateVideo', productSetId: SET, videoTemplate: { textColor: 'FFFFFF' } }, { type: 'existingPost', facebookPostId: `${PAGE}_500000000000001` }] }, ctx))
    const all = d.warnings.join(' ')
    expect(all).toMatch(/store locator is not supported on Instagram/)
    expect(all).toMatch(/collection ad .* 4 collection_thumbnails/)
    expect(all).toMatch(/IX27b-06/)
    expect(all).toMatch(/IX27b-04/)
    expect(all).toMatch(/limited basis/)
  })
  it('review A-2 — the preview says WHAT goes into each part: words cut to ~100 characters, links in full, every id; one line and one request label per part', () => {
    const long = `Erste Zeile\n${'x'.repeat(150)}`
    const link = `https://www.example.com/shop/${'a'.repeat(120)}?ref=ix`
    const d = draftOf(ixCreateDraft({ name: 'Experience A', parts: [
      { type: 'photo', photoId: '800000000000001', link, productTags: [{ productId: ITEM, x: 0.5, y: 0.25 }] },
      { type: 'text', text: long },
      { type: 'productSet', productSetId: SET, showInFeed: true, itemHeadline: '{{product.name}}' },
      { type: 'leadForm', formId: '600000000000001' },
      { type: 'existingPost', instagramMediaId: '17900000000000001' },
      { type: 'footer', children: [{ type: 'button', text: 'Jetzt kaufen', link: 'https://www.example.com/shop' }] },
    ] }, ctx))
    const labels = d.requests.map((r) => r.label)
    expect(labels[0]).toBe(`Make part 1: photo on the Facebook Page ${PAGE} — photo 800000000000001 of the Page; opens ${link}; products tagged ${ITEM} at (0.5, 0.25)`)
    // 'Erste Zeile / ' (14) + 85 x + … = 100 characters.
    expect(labels[1]).toBe(`Make part 2: text on the Facebook Page ${PAGE} — "Erste Zeile / ${'x'.repeat(85)}…"`)
    expect(labels[2]).toMatch(new RegExp(`product set ${SET}, shown in the feed; headline "\\{\\{product.name\\}\\}"`))
    expect(labels[3]).toMatch(/— lead form 600000000000001$/)
    expect(labels[4]).toMatch(/— Instagram media 17900000000000001$/)
    expect(labels[5]).toMatch(/button on the Facebook Page .* — label "Jetzt kaufen"; opens https:\/\/www\.example\.com\/shop$/)
    expect(labels[6]).toMatch(/footer on the Facebook Page .* — holding step 6 \(button\)$/)
    // One change line per part, the same words (the experience's own line first).
    expect(d.changes['Part 1: photo']).toEqual({ from: 'none', to: `new — photo 800000000000001 of the Page; opens ${link}; products tagged ${ITEM} at (0.5, 0.25)` })
    expect(d.changes['Part 4: lead form']).toEqual({ from: 'none', to: 'new — lead form 600000000000001' })
    expect(ixPartContent({ type: 'photo', photoUrl: 'https://www.example.com/a.jpg' })).toBe('picture https://www.example.com/a.jpg')
    expect(ixPartContent({ type: 'video', videoId: '800000000000002' })).toBe('video 800000000000002')
    expect(ixPartContent({ type: 'productList', productIds: [ITEM, '120000000000072'] })).toBe(`products ${ITEM}, 120000000000072`)
    expect(ixPartContent({ type: 'existingPost', facebookPostId: `${PAGE}_500000000000001` })).toBe(`Facebook post / photo / video ${PAGE}_500000000000001`)
    expect(ixPartContent({ type: 'templateVideo', productSetId: SET })).toBe(`automatic video from product set ${SET}`)
    expect(ixPartContent({ type: 'storeLocator' })).toBe('the Page\'s own store locations')
    // An edit's new parts say it too.
    const edit = draftOf(ixEditDraft({ parts: [{ elementId: PART }, { type: 'button', text: 'Mehr', link: 'https://www.example.com/more' }] }, canvas()))
    expect(edit.requests[0].label).toBe(`Make part 1: button on the Facebook Page ${PAGE} — label "Mehr"; opens https://www.example.com/more`)
    expect(edit.changes['Part 1: button']).toEqual({ from: 'none', to: 'new — label "Mehr"; opens https://www.example.com/more' })
  })
  it('review B-4 / B-5 / B-1 — product tags, existing posts, an Instagram video, partnership collection ads and the parts the read-back does not list are said', () => {
    const all = (parts: IxPartInput[], extra: Record<string, unknown> = {}) => draftOf(ixCreateDraft({ name: 'X', parts, ...extra }, ctx)).warnings.join(' ')
    expect(all([{ type: 'photo', photoId: '800000000000001', productTags: [{ productId: ITEM, x: 0.5, y: 0.5 }] }])).toMatch(/only to partners and advertisers on its allow list/)
    const post = all([{ type: 'existingPost', facebookPostId: '800000000000003' }])
    expect(post).toMatch(/by its own media id .*"media ID \(photo or video\)".*<page>_<post>.*IX27b-04/)
    expect(post).toMatch(/branded_content\.parent_source_instagram_media_id or parent_source_facebook_post_id .*create-meta-creative sends it as introPost.*CR-331/)
    expect(post).toMatch(/lists no automatic video, lead form or existing post .*IX27b-12/)
    expect(post).not.toMatch(/\/advideos/)
    expect(all([{ type: 'existingPost', instagramMediaId: '17900000000000001' }])).toMatch(/If the Instagram media is a video, .*fully processed .*\/advideos/)
    const hero = all([{ type: 'text', text: 'x' }], { heroInstagramMediaId: '17900000000000001' })
    expect(hero).toMatch(/\/advideos/)
    expect(hero).toMatch(/CR-331/)
    expect(hero).not.toMatch(/IX27b-12/)
    expect(all([{ type: 'leadForm', formId: '600000000000001' }])).toMatch(/IX27b-12/)
    expect(all([{ type: 'text', text: 'x' }])).not.toMatch(/IX27b-12|CR-331|allow list/)
  })
  it('every id a request names is listed for the live check (children, tags, links, heroes included)', () => {
    expect(ixRefsOf([
      ...COLLECTION, { type: 'photo', photoUrl: 'https://www.example.com/a.jpg', productTags: [{ productId: ITEM, x: 0, y: 0 }], link: `https://fb.com/canvas_doc/${CANVAS}` },
      { type: 'carousel', children: [{ elementId: PART }, { type: 'video', videoId: '800000000000002' }] },
      { type: 'leadForm', formId: '600000000000001' }, { type: 'productList', productIds: [ITEM, '120000000000072'] },
    ], { heroFacebookPostId: `${PAGE}_1` })).toEqual({
      photos: ['800000000000001'], videos: ['800000000000002'], posts: [`${PAGE}_1`], instagramMedia: [], forms: ['600000000000001'],
      productSets: [SET], productItems: [ITEM, '120000000000072'], elements: [PART], canvases: [CANVAS],
    })
  })
  it('a part\'s Graph object is Nexus\'s one spelling of every field it takes', () => {
    expect(ixElementObject({ type: 'productSet', productSetId: SET, maxItems: 12, showInFeed: true, overlay: { template: 'pill_with_text', textType: 'price', font: 'dynads_hybrid_bold', position: 'top_left', themeColor: 'background_e50900_text_ffffff' }, sections: true, sectionTitles: [{ titleId: 'popular', title: 'Top' }], layout: 'CAROUSEL', paddingTop: 4 })).toEqual({
      product_set_id: SET, max_items: 12, show_in_feed: true,
      image_overlay_spec: { overlay_template: 'pill_with_text', text_type: 'price', text_font: 'dynads_hybrid_bold', position: 'top_left', theme_color: 'background_e50900_text_ffffff' },
      storefront_setting: { enable_sections: true, customized_section_titles: [{ title_id: 'popular', customized_title: 'Top' }], product_set_layout: { layout_type: 'CAROUSEL' } },
      top_padding: 4,
    })
    expect(ixElementObject({ type: 'button', text: 'Go' })).toEqual({ rich_text: { plain_text: 'Go' }, button_style: 'BUTTON_OUTLINE' })
    expect(ixElementObject({ type: 'photo', photoId: '1', productTags: [{ productId: ITEM, x: 0.1, y: 0.9 }], hidePrices: true })).toEqual({ photo_id: '1', product_tags: [{ product_id: ITEM, coordinates: [0.1, 0.9] }], hide_product_prices: true })
    expect(ixElementObject({ type: 'templateVideo', productSetId: SET, videoTemplate: { nameTemplate: '{{product.name}}' } })).toEqual({ product_set_id: SET, template_video_spec: { customization: { name_template: '{{product.name}}' } } })
  })
})

describe('set-meta-instant-experience as drafts', () => {
  it('edit: only while unpublished; the fields that change, ONE request on the experience, and what its undo puts back', () => {
    const d = draftOf(ixEditDraft({ name: 'Experience B', backgroundColor: '000000', swipeToOpen: true, parts: [{ type: 'text', text: 'Neu' }, { elementId: PART }] }, canvas()))
    expect(d.requests.map((r) => [r.step, r.operation, r.objectId, r.objectKind])).toEqual([[1, 'canvas.element.create', PAGE, 'page'], [2, 'canvas.update', CANVAS, 'canvas']])
    expect(d.requests[1]).toMatchObject({
      params: { name: 'Experience B', background_color: '000000', enable_swipe_to_open: 'true' }, needs: [1], undoable: true,
      planParams: { body_element_ids: JSON.stringify(['@1', PART]) }, expect: { is_published: 'false', name: 'Experience B', background_color: '000000' },
    })
    expect(d.before).toMatchObject({ action: 'edit', fields: { name: 'Experience A', backgroundColor: 'FFFFFFFF', elementIds: [PART] }, undo: { action: 'edit', canvasId: CANVAS, name: 'Experience A', backgroundColor: 'FFFFFFFF', parts: [{ elementId: PART }] } })
    expect((d.before as { noUndo: string[] }).noUndo.join(' ')).toMatch(/Swipe to open: Meta does not read enable_swipe_to_open back/)
    expect(d.after).toMatchObject({ action: 'edit', fields: { name: 'Experience B', backgroundColor: '000000' }, notReadBack: { swipeToOpen: true } })
    expect(d.spendsMoney).toEqual([])
  })
  it('edit: refused in words when published or unread; nothing to do is said, not sent; a hero that was not there cannot be put back', () => {
    expect(refusalOf(ixEditDraft({ name: 'X' }, canvas({ published: true })))).toMatch(/is published: Meta says "You can only update an unpublished Instant Experience"/)
    expect(refusalOf(ixEditDraft({ name: 'X' }, canvas({ published: null })))).toMatch(/could not read whether/)
    expect(draftOf(ixEditDraft({ name: 'Experience A', parts: [{ elementId: PART }] }, canvas()))).toMatchObject({ requests: [], skipped: ['Name is already Experience A.', 'The parts are already in this order.'] })
    const hero = draftOf(ixEditDraft({ heroFacebookPostId: `${PAGE}_500000000000001` }, canvas()))
    expect((hero.before as { undo: unknown; noUndo: string[] }).undo).toBeNull()
    expect((hero.before as { noUndo: string[] }).noUndo.join(' ')).toMatch(/Hero asset: there was none/)
    expect(refusalOf(ixEditDraft({ parts: [] }, canvas()))).toMatch(/at least one part/)
  })
  it('review B-1 — an edit whose new body leaves out a part the read-back does not list (Nexus sent it, or fb_body_elements names it) is refused, naming it; its undo cannot put such a body back', () => {
    const TV = '120000000000713'
    // A record without types (kept before re-review #2): its parts count as before, of a type unknown to Nexus.
    const sent = canvas({ elementIds: [PART], sentElementIds: [PART, TV] })
    expect(ixUnlistedParts(sent)).toEqual([TV])
    const lost = refusalOf(ixEditDraft({ parts: [{ elementId: PART }, { type: 'text', text: 'Neu' }] }, sent))
    expect(lost).toMatch(new RegExp(`holds part ${TV} \\(its type unknown to Nexus; Nexus last sent it, unless it was removed in Meta's editor\\), which Meta's read-back of its body \\(body_elements\\) does not list .* would be lost: name it in the parts .*Nothing was sent`))
    expect(refusalOf(ixEditDraft({ parts: [{ type: 'text', text: 'Neu' }] }, canvas({ elementIds: [PART], fbElementIds: [PART, TV] })))).toMatch(new RegExp(`part ${TV} \\(Meta's fb_body_elements names it\\)`))
    // Named in the body: sent; the parts have no undo (Meta's read-back does not list it) and are not recorded for one.
    const kept = draftOf(ixEditDraft({ name: 'Experience B', parts: [{ elementId: PART }, { elementId: TV }, { type: 'text', text: 'Neu' }] }, sent))
    expect(kept.requests.map((r) => r.operation)).toEqual(['canvas.element.create', 'canvas.update'])
    expect(kept.changes['Parts in order']).toMatchObject({ from: `${PART} (and ${TV}, which Meta's read-back does not list)` })
    expect(kept.before).toMatchObject({ fields: { name: 'Experience A' }, undo: { action: 'edit', canvasId: CANVAS, name: 'Experience A' } })
    expect((kept.before as { fields: Record<string, unknown> }).fields).not.toHaveProperty('elementIds')
    expect((kept.before as { undo: Record<string, unknown> }).undo.parts).toBeUndefined()
    expect((kept.before as { noUndo: string[] }).noUndo.join(' ')).toMatch(new RegExp(`Parts: the new body holds part ${TV} \\(its type unknown to Nexus\\), which Meta's read-back of its body \\(body_elements\\) does not list .*the undo cannot put the parts back`))
    expect(kept.after).toMatchObject({ bodyElementTypes: ['listed', null, 'text'] })
    // A name alone never touches the parts; a body the read-back lists in full is put back as before.
    expect(draftOf(ixEditDraft({ name: 'Experience B' }, sent)).requests).toHaveLength(1)
    expect(draftOf(ixEditDraft({ parts: [{ type: 'text', text: 'Neu' }, { elementId: PART }] }, canvas({ sentElementIds: [PART] }))).before).toMatchObject({ undo: { parts: [{ elementId: PART }] } })
  })
  it('re-review #2 — each part\'s type is kept: a photo removed in Meta\'s editor neither blocks an edit nor is made final by a publish; an automatic video, a lead form or an existing post Nexus sent still blocks', () => {
    const PHOTO = '120000000000712'
    const TV = '120000000000713'
    // Nexus sent [PART, PHOTO, TV]; a person removed PHOTO in Meta's editor; body_elements lists PART (no automatic video).
    const typed = canvas({ elementIds: [PART], sentElementIds: [PART, PHOTO, TV], sentElementTypes: ['photo', 'photo', 'templateVideo'] })
    expect(ixUnlistedParts(typed)).toEqual([TV])
    const edit = draftOf(ixEditDraft({ parts: [{ elementId: PART }, { elementId: TV }, { type: 'text', text: 'Neu' }] }, typed))
    expect(edit.requests.map((r) => r.operation)).toEqual(['canvas.element.create', 'canvas.update'])
    expect(edit.changes['Parts in order']).toMatchObject({ from: `${PART} (and ${TV}, which Meta's read-back does not list)` })
    expect(edit.after).toMatchObject({ bodyElementTypes: ['photo', 'templateVideo', 'text'] })
    expect(refusalOf(ixEditDraft({ parts: [{ elementId: PART }, { type: 'text', text: 'Neu' }] }, typed))).toMatch(new RegExp(`holds part ${TV} \\(an automatic video; Nexus last sent it, unless it was removed in Meta's editor\\), .* would be lost`))
    for (const [type, word] of [['leadForm', 'a lead form'], ['existingPost', 'an existing post']] as const) {
      const other = canvas({ elementIds: [PART], sentElementIds: [PART, TV], sentElementTypes: ['photo', type] })
      expect(refusalOf(ixEditDraft({ parts: [{ elementId: PART }, { type: 'text', text: 'Neu' }] }, other))).toMatch(new RegExp(`holds part ${TV} \\(${word}; Nexus last sent it, unless it was removed in Meta's editor\\)`))
    }
    // Only the photo removed in Meta's editor: nothing held, nothing refused, the parts keep their undo.
    const removed = canvas({ elementIds: [PART], sentElementIds: [PART, PHOTO], sentElementTypes: ['photo', 'photo'] })
    expect(ixUnlistedParts(removed)).toEqual([])
    const again = draftOf(ixEditDraft({ parts: [{ elementId: PART }, { type: 'text', text: 'Neu' }] }, removed))
    expect(again.changes['Parts in order']).toMatchObject({ from: PART })
    expect(again.before).toMatchObject({ fields: { elementIds: [PART] }, undo: { parts: [{ elementId: PART }] } })
    // … nor is it listed as made final by a publish; the automatic video is.
    const publish = draftOf(ixPublishDraft(removed))
    expect(Object.keys(publish.changes).join(' ')).not.toContain(PHOTO)
    expect(publish.summary).toMatch(/its 1 part is final/)
    expect(draftOf(ixPublishDraft(typed)).changes).toMatchObject({ [`Part ${TV}`]: { from: 'can be edited', to: `final (an automatic video; Nexus last sent it, unless it was removed in Meta's editor; Meta's read-back does not list it)` } })
    expect(Object.keys(draftOf(ixPublishDraft(typed)).changes).join(' ')).not.toContain(PHOTO)
    // 'listed' is a part Meta listed when Nexus sent it; a word Nexus does not know, or a null entry, counts as before.
    expect(ixUnlistedParts(canvas({ elementIds: [PART], sentElementIds: [PART, PHOTO], sentElementTypes: ['listed', 'listed'] }))).toEqual([])
    expect(ixUnlistedParts(canvas({ elementIds: [PART], sentElementIds: [PART, PHOTO], sentElementTypes: ['photo', 'gallery'] }))).toEqual([PHOTO])
    expect(ixUnlistedParts(canvas({ elementIds: [PART], sentElementIds: [PART, PHOTO], sentElementTypes: ['photo', null] }))).toEqual([PHOTO])
    // A create records the type of each part of its body (an existing part's: not known).
    expect(draftOf(ixCreateDraft({ name: 'Experience A', parts: [...COLLECTION, { elementId: PART }] }, ctx)).after).toMatchObject({ bodyElementTypes: ['photo', 'productSet', 'footer', null] })
  })
  it('re-review #1 — an edit that makes or keeps a part the read-back does not list says the parts have no undo; the name keeps its undo; the parts are neither recorded nor compared for it', () => {
    const d = draftOf(ixEditDraft({ name: 'Experience B', parts: [{ elementId: PART }, { type: 'templateVideo', productSetId: SET }] }, canvas()))
    expect(d.before).toMatchObject({ fields: { name: 'Experience A' }, undo: { action: 'edit', canvasId: CANVAS, name: 'Experience A' } })
    expect((d.before as { fields: Record<string, unknown> }).fields).not.toHaveProperty('elementIds')
    expect((d.before as { undo: Record<string, unknown> }).undo.parts).toBeUndefined()
    expect(d.warnings.join(' ')).toMatch(/Undo: Parts: the new body holds step 1 \(automatic video from a product set\), which Meta's read-back of its body \(body_elements\) does not list .*the undo cannot put the parts back/)
    expect(d.warnings.join(' ')).not.toMatch(/Its undo puts the old values back/)
    expect(d.after).toMatchObject({ fields: { name: 'Experience B' }, bodyElementTypes: ['listed', 'templateVideo'] })
    // A part of a type Meta lists: the parts keep their undo.
    expect(draftOf(ixEditDraft({ name: 'Experience B', parts: [{ elementId: PART }, { type: 'text', text: 'Neu' }] }, canvas())).before).toMatchObject({ fields: { elementIds: [PART] }, undo: { name: 'Experience A', parts: [{ elementId: PART }] } })
  })
  it('review B-6 — a colour Meta reads as AARRGGBB is already the RRGGBB asked; the read-back check takes FF + the six digits', () => {
    expect(draftOf(ixEditDraft({ backgroundColor: 'FFFFFF' }, canvas()))).toMatchObject({ requests: [], skipped: ['Background colour is already FFFFFF.'] })
    expect(draftOf(ixEditDraft({ backgroundColor: '000000' }, canvas())).requests).toHaveLength(1)
    expect(readBackMismatch({ background_color: 'FF000000', name: 'B' }, { background_color: '000000', name: 'B' })).toEqual([])
    expect(readBackMismatch({ background_color: '80000000' }, { background_color: '000000' })).toEqual(['background_color'])
    expect(readBackMismatch({ background_color: 'FFFFFFFF' }, { background_color: 'FFFFFFFF' })).toEqual([])
  })
  it('the body a run sent: its existing ids and the ids Meta answered for the parts it made', () => {
    const d = draftOf(ixCreateDraft({ name: 'Experience A', parts: [{ elementId: PART }, { type: 'text', text: 'Hallo' }] }, ctx))
    const made = done([[d.requests[0], { id: '120000000000801' }], [d.requests[1], { id: CANVAS }]])
    expect(ixSentBody(made, 'canvas.create')).toEqual([PART, '120000000000801'])
    expect(ixSentBody(made.slice(0, 1), 'canvas.create')).toBeUndefined()
    const only = draftOf(ixCreateDraft({ name: 'Experience C', parts: [{ elementId: PART }] }, ctx))
    expect(ixSentBody(done([[only.requests[0], { id: CANVAS }]]), 'canvas.create')).toEqual([PART])
  })
  it('publish: one way, said in plain words; already published is skipped; no parts is refused', () => {
    const d = draftOf(ixPublishDraft(canvas()))
    expect(d.requests).toEqual([expect.objectContaining({ operation: 'canvas.publish', objectId: CANVAS, objectKind: 'canvas', params: { is_published: 'true' }, expect: { is_published: 'true' }, undoable: false })])
    expect(d.warnings).toEqual(expect.arrayContaining([IX_ONE_WAY]))
    expect(d.summary).toMatch(/ONE WAY/)
    expect(d.spendsMoney).toEqual([])
    expect(draftOf(ixPublishDraft(canvas({ published: true }))).requests).toEqual([])
    expect(refusalOf(ixPublishDraft(canvas({ elementIds: [] })))).toMatch(/has no parts/)
    // Review A-2 — the parts it makes final, one line each (and those the read-back does not list).
    const listed = draftOf(ixPublishDraft(canvas({ elementIds: [PART, '120000000000712'], sentElementIds: [PART, '120000000000712', '120000000000713'] })))
    expect(listed.changes).toMatchObject({
      [`Part 1: ${PART}`]: { from: 'can be edited', to: 'final' },
      'Part 2: 120000000000712': { from: 'can be edited', to: 'final' },
      'Part 120000000000713': { from: 'can be edited', to: expect.stringMatching(/final \(its type unknown to Nexus; Nexus last sent it, unless it was removed in Meta's editor; Meta's read-back does not list it\)/) },
    })
    expect(listed.summary).toMatch(/its 3 parts are final/)
    expect(listed.totals).toMatchObject({ parts: 3 })
    expect(draftOf(ixPublishDraft(canvas({ elementIds: null }))).changes).toMatchObject({ Parts: { from: 'not read', to: 'made final as they are' } })
  })
  it('hide and show again: each other\'s undo; showing a published one again may let an ad show it (SPENDS MONEY)', () => {
    const hide = draftOf(ixHiddenDraft(true, canvas()))
    expect(hide.requests[0]).toMatchObject({ operation: 'canvas.hidden', params: { is_hidden: 'true' }, raisesSpend: false, undoable: true })
    expect(hide.after).toMatchObject({ action: 'hide', hidden: true })
    expect(hide.spendsMoney).toEqual([])
    const show = draftOf(ixHiddenDraft(false, canvas({ hidden: true, published: true })))
    expect(show.spendsMoney).toEqual([expect.stringMatching(/may show it again/)])
    expect(show.requests[0].raisesSpend).toBe(true)
    expect(draftOf(ixHiddenDraft(false, canvas({ hidden: true, published: false }))).spendsMoney).toEqual([])
    expect(draftOf(ixHiddenDraft(true, canvas({ hidden: true }))).requests).toEqual([])
    // Review A-3 — hiding an UNPUBLISHED one (every create's undo) is what Meta does not document: said, with why nothing is harmed.
    expect(hide.warnings).toEqual(expect.arrayContaining([IX_HIDE_UNPUBLISHED_WORDS]))
    expect(IX_HIDE_UNPUBLISHED_WORDS).toMatch(/not yet confirmed \(LIVE-PROBES IX27b-02\).*seen by no one and no ad can use it/)
    expect(IX_NO_DELETE).toContain(IX_HIDE_UNPUBLISHED_WORDS)
    expect(draftOf(ixHiddenDraft(true, canvas({ published: true }))).warnings).not.toContain(IX_HIDE_UNPUBLISHED_WORDS)
  })
})
