/**
 * Amazon A+ content (2026-10-19) — every module type Nexus can send to Amazon, in ONE declarative table (`MODULES`).
 *
 * The table is Amazon's own model (aplusContent_2020-11-01.json: the 39 ContentModuleType values, each module's fields,
 * which of them the model requires, its list sizes, which items are wrapped) with the limits Amazon's documents add
 * (characters per text, minimum image sizes: the A+ Premium Modules, A+ Brand Story Modules and A+ Content Examples
 * pages; hotspot placement: the A+ troubleshooting guide). Where the documents and the model disagree the table keeps
 * the stricter rule, and Amazon's own check (validateContentDocumentAsinRelations) stays the authority:
 *   - PREMIUM_COMPARISON_SCROLLER takes 4–7 products (documents; the model says 3–7).
 *   - PREMIUM_FAQ colorType and PREMIUM_TECH_SPECS columnCount are required (documents); PREMIUM_TECH_SPECS headline
 *     is required (model). A Premium "Required" in the documents is enforced throughout.
 *   - The comparison carousel's rows take no additionalInfo (only the scroller's do in the documents; the model shares
 *     one row type), and the scroller's products take no mobileImage.
 *   - A Brand Story question and answer are both required (model); every text holds at least one character (model).
 *   - BRAND_STORY_ABOUT logoImage is 315×145 (module documents; the troubleshooting guide's "logo 362×453" is the media
 *     asset card's size).
 *
 * From the table come: the strict zod schema of each module's payload (`APLUS_PAYLOAD_SCHEMAS` — Amazon's shape, with
 * Nexus's two extra image sources, assetId and url), the image slots of a document (`checkAplusDocument` → `images`),
 * the module summary (`summarizeModules`) and the guide Claude reads (`aplusModuleGuide`). Problems are plain sentences
 * that name the module (counted from 1), its type and the field path: `Module 2 (PREMIUM_IMAGE_TEXT) headline: at most
 * 80 characters (it has 95).` Pure: nothing here reads a database or the network.
 */
import { z } from 'zod'
import { factHash } from '../agents/tool-types.js'
import type { AplusDocument, AplusModule } from './aplus-client.js'

/** Amazon's ContentModuleType enum, in the model's order. */
export const APLUS_MODULE_TYPES = [
  'STANDARD_COMPANY_LOGO', 'STANDARD_COMPARISON_TABLE', 'STANDARD_FOUR_IMAGE_TEXT', 'STANDARD_FOUR_IMAGE_TEXT_QUADRANT',
  'STANDARD_HEADER_IMAGE_TEXT', 'STANDARD_IMAGE_SIDEBAR', 'STANDARD_IMAGE_TEXT_OVERLAY', 'STANDARD_MULTIPLE_IMAGE_TEXT',
  'STANDARD_PRODUCT_DESCRIPTION', 'STANDARD_SINGLE_IMAGE_HIGHLIGHTS', 'STANDARD_SINGLE_IMAGE_SPECS_DETAIL',
  'STANDARD_SINGLE_SIDE_IMAGE', 'STANDARD_TECH_SPECS', 'STANDARD_TEXT', 'STANDARD_THREE_IMAGE_TEXT',
  'PREMIUM_IMAGE_TEXT', 'PREMIUM_TEXT', 'PREMIUM_FULL_BACKGROUND_TEXT', 'PREMIUM_FULL_BACKGROUND_IMAGE',
  'PREMIUM_FOUR_COLUMN_IMAGES', 'PREMIUM_DUAL_IMAGE_TEXT', 'PREMIUM_IMAGE_CAROUSEL', 'PREMIUM_NAVIGATION_CAROUSEL',
  'PREMIUM_REGIMEN_CAROUSEL', 'PREMIUM_THREE_COLUMN_COMPARISON', 'PREMIUM_COMPARISON_CAROUSEL', 'PREMIUM_COMPARISON_SCROLLER',
  'PREMIUM_HOTSPOT_IMAGE', 'PREMIUM_HOTSPOT_IMAGE_TEXT', 'PREMIUM_FAQ', 'PREMIUM_TECH_SPECS', 'PREMIUM_VIDEO_TEXT',
  'PREMIUM_HERO_VIDEO', 'PREMIUM_VIDEO_IMAGE_CAROUSEL',
  'BRAND_STORY_IMAGE_WITH_LOGO', 'BRAND_STORY_FOUR_ASIN', 'BRAND_STORY_MEDIA_ASSET', 'BRAND_STORY_ABOUT', 'BRAND_STORY_QUESTIONS',
] as const
export type AplusModuleType = (typeof APLUS_MODULE_TYPES)[number]
export type AplusTier = 'STANDARD' | 'PREMIUM' | 'BRAND_STORY'

/**
 * The most modules a document of a tier holds. A seller's A+ document holds seven (the create-edit-publish guide; the
 * API itself caps Premium at seven and leaves Standard uncapped). Brand Story is a carousel; twenty is Nexus's bound.
 */
export const APLUS_MAX_MODULES: Readonly<Record<AplusTier, number>> = Object.freeze({ STANDARD: 7, PREMIUM: 7, BRAND_STORY: 20 })

/** The smallest crop Amazon takes in an image position; the crop must also keep this shape (width : height). */
export interface ImageSlot { minWidth: number; minHeight: number }
/** A crop in pixels of the photo: its size and its top-left corner. */
export interface CropSpec { width: number; height: number; x: number; y: number }
/** Where an image comes from: already at Amazon, a photo in Nexus (`da_…` library item, `pi_…` product photo), or a link. */
export type ImageSource = { kind: 'amazon'; uploadDestinationId: string } | { kind: 'asset'; assetId: string } | { kind: 'url'; url: string }
/** One image position of a checked document. */
export interface ImageUse {
  /** `${module}:${path}`, unique in the document. */
  key: string
  /** The module's index, 0-based. */
  module: number
  /** The position inside the module's payload, e.g. 'columns[1].imageColumn.image'. */
  path: string
  slot: ImageSlot
  source: ImageSource
  altText: string
  /** The crop given with the image (always given for an image at Amazon), or null: Nexus crops it to the slot. */
  crop: CropSpec | null
}
export interface CheckedAplusDocument {
  name: string
  contentType: 'EBC' | 'BrandStory'
  tier: AplusTier
  locale: string
  /** The modules as checked: Amazon's shape, nulls and empty decoratorSets dropped, new images still as assetId / url. */
  modules: AplusModule[]
  images: ImageUse[]
  /** Videos in the document (only ever already at Amazon). */
  videos: number
  /** ASINs named inside modules (comparison products, carousel buttons, Brand Story cards), sorted, once each. */
  asins: string[]
}

// ── The table's vocabulary ─────────────────────────────────────────────────────────────────────────

interface FieldBase { required: boolean; note?: string }
/**
 * One field of a module payload:
 *   text        TextComponent { value, decoratorSet? }, at most `max` characters, never empty
 *   paragraph   ParagraphComponent { textList: TextComponent[] }, `lines` items, at most `max` characters in all
 *   image       ImageComponent, a crop at least `slot` and in its shape
 *   video       VideoComponent, only as already at Amazon
 *   enum        a plain string, one of `values` (positionType, colorType)
 *   choice      TextComponent whose value is one of `values` (comparisonType)
 *   coordinate  TextComponent whose value is a whole number of pixels as text (hotspot x / y)
 *   number      a whole number from `min` to `max`
 *   boolean     true or false
 *   asin        an ASIN, as a plain string or as a TextComponent (`form`)
 *   string      a plain string of at most `max` characters
 *   item        PlainTextItem { position, value } with a value of at most `max` characters
 *   object      a nested block of `fields`
 *   list        `size` items of `of`, each inside `{ [wrapper]: … }` when Amazon wraps them; positions unique
 */
type Field =
  | (FieldBase & { kind: 'text'; max: number })
  | (FieldBase & { kind: 'paragraph'; max: number; lines: readonly [number, number] })
  | (FieldBase & { kind: 'image'; slot: ImageSlot })
  | (FieldBase & { kind: 'video' })
  | (FieldBase & { kind: 'enum'; values: readonly string[] })
  | (FieldBase & { kind: 'choice'; values: readonly string[] })
  | (FieldBase & { kind: 'coordinate'; min: number; max: number })
  | (FieldBase & { kind: 'number'; min: number; max: number })
  | (FieldBase & { kind: 'boolean' })
  | (FieldBase & { kind: 'asin'; form: 'string' | 'text' })
  | (FieldBase & { kind: 'string'; max: number })
  | (FieldBase & { kind: 'item'; max: number; positions: readonly [number, number] })
  | (FieldBase & { kind: 'object'; fields: Fields })
  | (FieldBase & { kind: 'list'; of: Field; size: readonly [number, number]; wrapper?: string })
type Fields = Readonly<Record<string, Field>>

type Path = ReadonlyArray<string | number>
type Payload = Record<string, any>
/** A rule across fields (counts that must match, spacing, one-of). Runs once every field passes. */
type ModuleRule = (payload: Payload, problem: (path: Path, message: string) => void) => void
interface ModuleSpec { tier: AplusTier; about: string; fields: Fields; rules?: readonly ModuleRule[] }

const text = (max: number, note?: string): Field => ({ kind: 'text', max, required: false, note })
const paragraph = (max: number, lines: readonly [number, number] = [1, 100]): Field => ({ kind: 'paragraph', max, lines, required: false })
const image = (minWidth: number, minHeight: number): Field => ({ kind: 'image', slot: { minWidth, minHeight }, required: false })
const video = (note?: string): Field => ({ kind: 'video', required: false, note })
const oneOf = (...values: string[]): Field => ({ kind: 'enum', values, required: false })
const choice = (...values: string[]): Field => ({ kind: 'choice', values, required: false })
const coordinate = (min: number, max: number): Field => ({ kind: 'coordinate', min, max, required: false })
const whole = (min: number, max: number): Field => ({ kind: 'number', min, max, required: false })
const flag = (): Field => ({ kind: 'boolean', required: false })
const asin = (form: 'string' | 'text' = 'text'): Field => ({ kind: 'asin', form, required: false })
const string = (max: number): Field => ({ kind: 'string', max, required: false })
const item = (max: number, positions: readonly [number, number] = [1, 100]): Field => ({ kind: 'item', max, positions, required: false })
const object = (fields: Fields): Field => ({ kind: 'object', fields, required: false })
const list = (of: Field, size: readonly [number, number], wrapper?: string): Field => ({ kind: 'list', of, size, wrapper, required: false })
const req = (field: Field): Field => ({ ...field, required: true })
const noted = (field: Field, note: string): Field => ({ ...field, note })

const POSITION = ['LEFT', 'RIGHT'] as const
const COLOR = ['DARK', 'LIGHT'] as const
const COMPARISON = ['checkbox', 'input-field'] as const
const ASIN = /^[A-Z0-9]{10}$/
const ASSET_ID = /^(da|pi)_[A-Za-z0-9_-]+$/
const DECORATOR_TYPES = ['LIST_ITEM', 'LIST_ORDERED', 'LIST_UNORDERED', 'STYLE_BOLD', 'STYLE_ITALIC', 'STYLE_LINEBREAK', 'STYLE_PARAGRAPH', 'STYLE_UNDERLINE'] as const

// Standard blocks the model reuses (StandardImageTextBlock, StandardTextBlock, StandardTextListBlock, …).
const imageTextBlock = (w: number, h: number, headline: number, body: number): Field =>
  object({ image: image(w, h), headline: text(headline), body: paragraph(body) })
const textBlock = (headline: number, body: number): Field => object({ headline: text(headline), body: paragraph(body) })
/** StandardTextListBlock: up to 8 bullet points, each { position 1–8, text }. */
const bullets = (max: number): Field => object({ textList: req(list(object({ position: req(whole(1, 8)), text: req(text(max)) }), [0, 8])) })
/** The two images of a full-width Premium panel. */
const DESKTOP = req(image(1464, 600))
const MOBILE = req(image(600, 450))
/** Hotspot markers sit on the 1464×600 desktop image, 23 px inside its edges (troubleshooting guide). */
const HOTSPOT_X = req(coordinate(23, 1441))
const HOTSPOT_Y = req(coordinate(23, 577))

// ── Rules across fields ──────────────────────────────────────────────────────────────────────────────

const valueOf = (component: unknown): string | null =>
  component && typeof component === 'object' && typeof (component as { value?: unknown }).value === 'string' ? (component as { value: string }).value : null

/** Hotspot markers at least 95 px apart (troubleshooting guide: "overlaps with hotspot at index N"). */
const HOTSPOT_SPACING = 95
const hotspotsApart = (wrapper: string): ModuleRule => (payload, problem) => {
  const spots = (payload.hotSpots as Array<Record<string, any>>).map((spot) => spot[wrapper])
  spots.forEach((spot, i) => {
    for (let j = 0; j < i; j++) {
      const dx = Number(valueOf(spot.xCoordinate)) - Number(valueOf(spots[j].xCoordinate))
      const dy = Number(valueOf(spot.yCoordinate)) - Number(valueOf(spots[j].yCoordinate))
      const distance = Math.hypot(dx, dy)
      if (distance < HOTSPOT_SPACING) {
        problem(['hotSpots', i], `the marker is ${Math.round(distance)} px from hotSpots[${j}]; markers sit at least ${HOTSPOT_SPACING} px apart`)
      }
    }
  })
}

/** Every comparison row has one field per product, at that product's position; a checkbox row says 'true' or 'false'. */
const comparisonFieldsMatch = (rowsKey: string): ModuleRule => (payload, problem) => {
  const positions = (payload.comparisonProducts as Array<Record<string, any>>).map((p) => p.comparisonProduct.position as number)
  const wanted = [...positions].sort((a, b) => a - b).join(', ')
  ;(payload[rowsKey] as Array<Record<string, any>>).forEach((wrapped, i) => {
    const row = wrapped.comparisonRow
    const fields = (row.comparisonFields as Array<Record<string, any>>).map((f) => f.comparisonField as { position: number; value: string })
    const at: Path = [rowsKey, i, 'comparisonRow', 'comparisonFields']
    if (fields.length !== positions.length) problem(at, `one field per product: ${positions.length} (it has ${fields.length})`)
    const given = fields.map((f) => f.position).sort((a, b) => a - b).join(', ')
    if (fields.length === positions.length && given !== wanted) problem(at, `the field positions are the products' positions (${wanted}); they are ${given}`)
    if (valueOf(row.comparisonType) === 'checkbox') {
      fields.forEach((field, k) => {
        if (field.value !== 'true' && field.value !== 'false') problem([...at, k, 'comparisonField', 'value'], `a checkbox row says "true" or "false" (it is "${field.value}")`)
      })
    }
  })
}

/** A carousel button is shown only with the ASIN it links to. */
const buttonNeedsAsin: ModuleRule = (payload, problem) => {
  ;(payload.carouselCards as Array<Record<string, any>>).forEach((card, i) => {
    if (card.imagePanel.buttonText !== undefined && card.imagePanel.asin === undefined) {
      problem(['carouselCards', i, 'imagePanel', 'buttonText'], 'is shown only with asin; give the asin it links to or leave buttonText out')
    }
  })
}

/** A video carousel panel shows a video, or a desktop and a mobile image — one of the two. */
const videoOrImages: ModuleRule = (payload, problem) => {
  ;(payload.carouselCards as Array<Record<string, any>>).forEach((card, i) => {
    const panel = card.videoCarouselPanel
    const images = [panel.desktopImage, panel.mobileImage].filter((x) => x !== undefined).length
    const at: Path = ['carouselCards', i, 'videoCarouselPanel']
    if (panel.video !== undefined && images > 0) problem(at, 'a panel shows a video or its two images, not both')
    else if (panel.video === undefined && images < 2) problem(at, 'a panel needs a video (already at Amazon) or both desktopImage and mobileImage')
  })
}

// ── The 39 module types ──────────────────────────────────────────────────────────────────────────────

const standard = (about: string, fields: Fields): ModuleSpec => ({ tier: 'STANDARD', about, fields })
const premium = (about: string, fields: Fields, rules?: ModuleRule[]): ModuleSpec => ({ tier: 'PREMIUM', about, fields, rules })
const brandStory = (about: string, fields: Fields): ModuleSpec => ({ tier: 'BRAND_STORY', about, fields })

const MODULES: Readonly<Record<AplusModuleType, ModuleSpec>> = {
  STANDARD_COMPANY_LOGO: standard('The company logo, one landscape image.', {
    companyLogo: req(image(600, 180)),
  }),
  STANDARD_COMPARISON_TABLE: standard('A comparison table of up to 6 products (columns) and up to 10 metrics (rows).', {
    productColumns: list(object({
      position: req(whole(1, 6)),
      image: image(150, 300),
      title: string(80),
      asin: asin('string'),
      highlight: flag(),
      metrics: noted(list(item(250), [0, 10]), 'one per metric row, its position the row\'s'),
    }), [0, 6]),
    metricRowLabels: list(item(100), [0, 10]),
  }),
  STANDARD_FOUR_IMAGE_TEXT: standard('Four images with text across one row.', {
    headline: text(200),
    block1: imageTextBlock(220, 200, 160, 1000),
    block2: imageTextBlock(220, 200, 160, 1000),
    block3: imageTextBlock(220, 200, 160, 1000),
    block4: imageTextBlock(220, 200, 160, 1000),
  }),
  STANDARD_FOUR_IMAGE_TEXT_QUADRANT: standard('Four images with text on a grid of four quadrants.', {
    block1: req(imageTextBlock(135, 135, 160, 1000)),
    block2: req(imageTextBlock(135, 135, 160, 1000)),
    block3: req(imageTextBlock(135, 135, 160, 1000)),
    block4: req(imageTextBlock(135, 135, 160, 1000)),
  }),
  STANDARD_HEADER_IMAGE_TEXT: standard('A headline, a wide image and body text.', {
    headline: text(150),
    block: imageTextBlock(970, 600, 150, 6000),
  }),
  STANDARD_IMAGE_SIDEBAR: standard('Two images, two paragraphs and two bullet lists; the smaller image sits in a sidebar.', {
    headline: text(160),
    imageCaptionBlock: object({ image: image(300, 400), caption: text(200) }),
    descriptionTextBlock: textBlock(200, 500),
    descriptionListBlock: bullets(200),
    sidebarImageTextBlock: imageTextBlock(300, 175, 200, 500),
    sidebarListBlock: bullets(200),
  }),
  STANDARD_IMAGE_TEXT_OVERLAY: standard('A background image with a floating text box, dark or light.', {
    overlayColorType: req(oneOf(...COLOR)),
    block: imageTextBlock(970, 300, 70, 300),
  }),
  STANDARD_MULTIPLE_IMAGE_TEXT: standard('Images with text shown one at a time; the shopper picks a thumbnail.', {
    blocks: noted(list(object({ block: imageTextBlock(300, 300, 160, 1000), caption: text(200) }), [1, 10]), 'Nexus sends at most 10 blocks'),
  }),
  STANDARD_PRODUCT_DESCRIPTION: standard('Product description text.', {
    body: req(paragraph(6000)),
  }),
  STANDARD_SINGLE_IMAGE_HIGHLIGHTS: standard('One image with several paragraphs and a bullet list.', {
    image: image(300, 300),
    headline: text(160),
    textBlock1: textBlock(200, 1000),
    textBlock2: textBlock(200, 400),
    textBlock3: textBlock(200, 400),
    bulletedListBlock: object({ headline: text(160), block: bullets(100) }),
  }),
  STANDARD_SINGLE_IMAGE_SPECS_DETAIL: standard('One image with paragraphs, a bullet list and room for technical details.', {
    headline: text(200),
    descriptionHeadline: text(160),
    image: image(300, 300),
    descriptionBlock1: textBlock(200, 400),
    descriptionBlock2: textBlock(200, 400),
    specificationHeadline: text(160),
    specificationListBlock: object({ headline: text(200), block: bullets(200) }),
    specificationTextBlock: textBlock(200, 1000),
  }),
  STANDARD_SINGLE_SIDE_IMAGE: standard('A headline and body text with an image on the left or right.', {
    imagePositionType: req(oneOf(...POSITION)),
    block: imageTextBlock(300, 300, 160, 1000),
  }),
  STANDARD_TECH_SPECS: standard('A table of technical specifications (4 to 16 pairs), in one or two tables.', {
    headline: text(80),
    specificationList: req(list(object({ label: text(30), description: text(500) }), [4, 16])),
    tableCount: whole(1, 2),
  }),
  STANDARD_TEXT: standard('A headline and body text.', {
    headline: text(160),
    body: req(paragraph(5000)),
  }),
  STANDARD_THREE_IMAGE_TEXT: standard('Three images with text across one row.', {
    headline: text(200),
    block1: imageTextBlock(300, 300, 160, 1000),
    block2: imageTextBlock(300, 300, 160, 1000),
    block3: imageTextBlock(300, 300, 160, 1000),
  }),

  PREMIUM_IMAGE_TEXT: premium('One image beside text; positionType LEFT puts the text on the left.', {
    positionType: req(oneOf(...POSITION)),
    headline: req(text(80)),
    image: req(image(800, 600)),
    subheadline: text(40),
    bodyText: paragraph(500, [1, 5]),
  }),
  PREMIUM_TEXT: premium('Text only, with more room than any other module.', {
    description: req(paragraph(5000, [1, 11])),
    headline: text(80),
  }),
  PREMIUM_FULL_BACKGROUND_TEXT: premium('A full-width background image with a text box on the left or right, dark or light.', {
    positionType: req(oneOf(...POSITION)),
    colorType: req(oneOf(...COLOR)),
    desktopImage: DESKTOP,
    mobileImage: MOBILE,
    subheadline: text(40),
    headline: text(60),
    description: paragraph(300, [1, 2]),
  }),
  PREMIUM_FULL_BACKGROUND_IMAGE: premium('A full-width image with an optional headline above and text below.', {
    desktopImage: DESKTOP,
    mobileImage: MOBILE,
    headline: text(80),
    footer: paragraph(300, [1, 4]),
  }),
  PREMIUM_FOUR_COLUMN_IMAGES: premium('Three or four images in a row under one headline, each with its own heading and text.', {
    headline: text(80),
    columns: req(list(object({
      position: req(whole(1, 4)),
      image: req(image(300, 225)),
      headline: text(30),
      description: paragraph(150, [1, 5]),
    }), [3, 4], 'imageColumn')),
  }),
  PREMIUM_DUAL_IMAGE_TEXT: premium('Two images side by side under one headline, each with its own heading and text.', {
    headline: text(50),
    columns: req(list(object({
      position: req(whole(1, 2)),
      image: req(image(650, 350)),
      headline: text(50),
      description: paragraph(300, [1, 5]),
    }), [2, 2], 'imageColumn')),
  }),
  PREMIUM_IMAGE_CAROUSEL: premium('A carousel of 2 to 6 full-width image panels, each with its own text and an optional button to an ASIN.', {
    headline: text(80),
    footer: paragraph(300, [1, 4]),
    carouselCards: req(list(object({
      position: req(whole(1, 6)),
      title: text(50),
      buttonText: text(12, 'shown only with asin'),
      asin: asin(),
      description: paragraph(200, [1, 4]),
      desktopImage: DESKTOP,
      mobileImage: MOBILE,
    }), [2, 6], 'imagePanel')),
  }, [buttonNeedsAsin]),
  PREMIUM_NAVIGATION_CAROUSEL: premium('A carousel of 2 to 5 full-width image panels with navigation tabs.', {
    carouselCards: req(list(object({
      position: req(whole(1, 5)),
      navText: req(text(25)),
      desktopImage: DESKTOP,
      mobileImage: MOBILE,
      title: text(50),
      subtitle: text(25),
      description: paragraph(100, [1, 4]),
    }), [2, 5], 'navigationPanel')),
  }),
  PREMIUM_REGIMEN_CAROUSEL: premium('A carousel of 2 to 5 steps (a regimen) under a headline, with navigation tabs.', {
    headline: text(100),
    carouselCards: req(list(object({
      position: req(whole(1, 5)),
      navText: req(text(20)),
      desktopImage: DESKTOP,
      mobileImage: MOBILE,
      title: text(20),
      description: paragraph(100, [1, 4]),
    }), [2, 5], 'regimenPanel')),
  }),
  PREMIUM_THREE_COLUMN_COMPARISON: premium('Three products side by side with 2 to 5 compared metrics.', {
    headline: req(text(80)),
    comparisonProducts: req(list(object({
      position: req(whole(1, 3)),
      productTitle: req(text(30)),
      productAsin: req(asin()),
      image: req(image(300, 225)),
    }), [3, 3])),
    comparisonRows: req(list(object({
      position: req(whole(1, 5)),
      metricValues: req(noted(list(object({
        metricName: req(text(30)),
        metricValue: req(paragraph(80, [1, 1])),
      }), [3, 3]), 'one per product, in the order of comparisonProducts')),
    }), [2, 5])),
  }),
  PREMIUM_COMPARISON_CAROUSEL: premium('A comparison of 3 to 5 products with portrait images and 3 to 7 metric rows.', {
    headline: req(text(25)),
    comparisonProducts: req(list(object({
      position: req(whole(1, 5)),
      productTitle: req(text(25)),
      productAsin: req(asin()),
      desktopImage: req(image(488, 700)),
      mobileImage: MOBILE,
    }), [3, 5], 'comparisonProduct')),
    comparisonMetrics: req(list(object({
      position: req(whole(1, 7)),
      metricName: text(20),
      comparisonType: req(choice(...COMPARISON)),
      comparisonFields: req(noted(list(item(20, [1, 5]), [3, 5], 'comparisonField'),
        'one per product, its position the product\'s; "true" or "false" in a checkbox row')),
    }), [3, 7], 'comparisonRow')),
  }, [comparisonFieldsMatch('comparisonMetrics')]),
  PREMIUM_COMPARISON_SCROLLER: premium('A scrolling comparison of 4 to 7 products with 5 to 12 metric rows; optional cart buttons, prices and reviews.', {
    headline: req(text(80)),
    showATC: flag(),
    showPrices: flag(),
    showReviews: flag(),
    comparisonProducts: req(list(object({
      position: req(whole(1, 7)),
      productTitle: req(text(25)),
      productAsin: req(asin()),
      desktopImage: req(image(200, 225)),
    }), [4, 7], 'comparisonProduct')),
    comparisonRows: req(list(object({
      position: req(whole(1, 12)),
      metricName: text(30),
      comparisonType: req(choice(...COMPARISON)),
      additionalInfo: text(150),
      comparisonFields: req(noted(list(item(30, [1, 7]), [4, 7], 'comparisonField'),
        'one per product, its position the product\'s; "true" or "false" in a checkbox row')),
    }), [5, 12], 'comparisonRow')),
  }, [comparisonFieldsMatch('comparisonRows')]),
  PREMIUM_HOTSPOT_IMAGE: premium('A full-width image with 2 to 6 markers; each opens a title, text and a mobile picture.', {
    desktopImage: DESKTOP,
    hotSpots: req(noted(list(object({
      title: req(text(50)),
      xCoordinate: HOTSPOT_X,
      yCoordinate: HOTSPOT_Y,
      mobileImage: MOBILE,
      description: text(200),
    }), [2, 6], 'imageHotSpot'), `markers at least ${HOTSPOT_SPACING} px apart; no position`)),
  }, [hotspotsApart('imageHotSpot')]),
  PREMIUM_HOTSPOT_IMAGE_TEXT: premium('A headline and text above a full-width image with 2 to 6 markers.', {
    headline: req(text(80)),
    mainDescription: paragraph(300, [1, 2]),
    desktopImage: DESKTOP,
    hotSpots: req(noted(list(object({
      title: req(text(50)),
      xCoordinate: HOTSPOT_X,
      yCoordinate: HOTSPOT_Y,
      mobileImage: MOBILE,
    }), [2, 6], 'imageTextHotSpot'), `markers at least ${HOTSPOT_SPACING} px apart; no position, no description`)),
  }, [hotspotsApart('imageTextHotSpot')]),
  PREMIUM_FAQ: premium('2 to 5 questions and answers on a dark or light background.', {
    colorType: req(oneOf(...COLOR)),
    faqs: req(list(object({
      question: req(paragraph(120, [1, 1])),
      answer: req(paragraph(250, [1, 5])),
    }), [2, 5], 'faq')),
  }),
  PREMIUM_TECH_SPECS: premium('A headline over 4 to 16 specifications, in one or two columns.', {
    headline: req(text(80)),
    columnCount: req(whole(1, 2)),
    techSpecs: req(list(object({
      specKey: req(text(30)),
      specValue: req(text(500)),
    }), [4, 16], 'techSpec')),
  }),
  PREMIUM_VIDEO_TEXT: premium('A video beside text; positionType LEFT puts the video on the left.', {
    positionType: req(oneOf(...POSITION)),
    headline: req(text(80)),
    video: req(video('preview image at least 800×600')),
    title: text(40),
    description: paragraph(500, [1, 5]),
  }),
  PREMIUM_HERO_VIDEO: premium('A full-width video with an optional headline and text below.', {
    heroVideo: req(video('preview image at least 1464×600, video at least 960×540')),
    headline: text(80),
    footer: paragraph(300, [1, 4]),
  }),
  PREMIUM_VIDEO_IMAGE_CAROUSEL: premium('A carousel of 2 to 6 panels, each a video or a picture, with its own text.', {
    headline: text(80),
    carouselCards: req(list(object({
      position: req(whole(1, 6)),
      positionType: req(oneOf(...POSITION)),
      subheadline: req(text(80)),
      title: text(50),
      description: paragraph(500, [1, 4]),
      video: video('a video, or else both images'),
      desktopImage: noted(image(800, 600), 'with mobileImage, when the panel has no video'),
      mobileImage: noted(image(600, 450), 'with desktopImage, when the panel has no video'),
    }), [2, 6], 'videoCarouselPanel')),
  }, [videoOrImages]),

  BRAND_STORY_IMAGE_WITH_LOGO: brandStory('The background card every Brand Story needs, exactly once: a full-width image with a title and text.', {
    desktopImage: req(image(1464, 625)),
    mobileImage: req(image(463, 625)),
    title: text(30),
    description: paragraph(135, [1, 3]),
  }),
  BRAND_STORY_FOUR_ASIN: brandStory('A card with four of the brand\'s products (ASINs) and their pictures.', {
    title: req(text(30)),
    brandStoreId: text(100),
    asinImages: req(list(object({
      productAsin: req(asin()),
      productImage: req(image(166, 182)),
    }), [4, 4], 'asinImage')),
  }),
  BRAND_STORY_MEDIA_ASSET: brandStory('A card with one portrait picture, a title and text.', {
    image: req(image(362, 453)),
    title: text(30),
    description: paragraph(135, [1, 3]),
  }),
  BRAND_STORY_ABOUT: brandStory('A card about the brand: its logo, a title and a slogan or story.', {
    logoImage: req(image(315, 145)),
    title: text(30),
    slogan: paragraph(450, [1, 10]),
  }),
  BRAND_STORY_QUESTIONS: brandStory('A card with three questions and answers about the brand.', {
    questionAnswerPairs: req(list(object({
      question: req(text(70)),
      answer: req(paragraph(200, [1, 3])),
    }), [3, 3], 'questionAnswerPair')),
  }),
}

// ── Names ────────────────────────────────────────────────────────────────────────────────────────────

const MODULE_TYPE_SET: ReadonlySet<string> = new Set(APLUS_MODULE_TYPES)
export function isAplusModuleType(value: unknown): value is AplusModuleType {
  return typeof value === 'string' && MODULE_TYPE_SET.has(value)
}

export function tierOf(type: AplusModuleType): AplusTier {
  return MODULES[type].tier
}

/** The key of the module's content in Amazon's module object: the type in camelCase (PREMIUM_IMAGE_TEXT → premiumImageText). */
export function payloadKeyOf(type: AplusModuleType): string {
  return type.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

const TIER_NAME: Record<AplusTier, string> = { STANDARD: 'Standard A+', PREMIUM: 'Premium A+', BRAND_STORY: 'Brand Story' }

// ── Zod schemas, generated from the table ────────────────────────────────────────────────────────────

/** Marks the fields allowed where an unknown key was found; `issueSentences` names the key and lists them. */
const FIELDS_HERE = 'the fields here: '
const strict = <Shape extends z.ZodRawShape>(shape: Shape) =>
  z.strictObject(shape, { error: (issue) => issue.code === 'unrecognized_keys' ? `${FIELDS_HERE}${Object.keys(shape).join(', ')}` : undefined })

const range = (min: number, max: number) => (min === max ? `${min}` : `${min}–${max}`)
const said = (input: unknown) => (input === undefined ? '' : ` (it is ${JSON.stringify(input)})`)
const count = (n: number, noun: string) => `${n} ${n === 1 ? noun.replace(/s$/, '') : noun}`

/** A whole number from min to max, said as one sentence whichever bound it misses. */
function wholeSchema(min: number, max: number) {
  const say = (issue: { input?: unknown }) => `must be a whole number ${range(min, max)}${said(issue.input)}`
  return z.number({ error: (issue) => (issue.input === undefined ? undefined : say(issue)) }).int({ error: say }).min(min, { error: say }).max(max, { error: say })
}

/** A list of min to max items, said as one sentence whichever bound it misses. */
function sizedList<Item extends z.ZodType>(item: Item, [min, max]: readonly [number, number], noun: string) {
  const say = (issue: { input?: unknown }) =>
    `${min === max ? `exactly ${count(min, noun)}` : min === 0 ? `at most ${count(max, noun)}` : `${min} to ${count(max, noun)}`}${Array.isArray(issue.input) ? ` (it has ${issue.input.length})` : ''}`
  return z.array(item).min(min, { error: say }).max(max, { error: say })
}

const textLength = (value: string, max: number): string | null =>
  value.trim() === '' ? 'is empty' : value.length > max ? `at most ${max} characters (it has ${value.length})` : null

const SIZE_PX = strict({ value: z.number().int().min(1), units: z.literal('pixels') })
const OFFSET_PX = strict({ value: z.number().int().min(0), units: z.literal('pixels') })
const CROP = strict({ size: strict({ width: SIZE_PX, height: SIZE_PX }), offset: strict({ x: OFFSET_PX, y: OFFSET_PX }).optional() })
const DECORATOR = strict({
  type: z.enum(DECORATOR_TYPES).optional(),
  offset: z.number().int().min(0).max(10000).optional(),
  length: z.number().int().min(0).max(10000).optional(),
  depth: z.number().int().min(0).max(100).optional(),
})

/** TextComponent { value, decoratorSet? }; `check` says what is wrong with its value, or null. */
function textComponent(check: (value: string) => string | null) {
  return strict({ value: z.string(), decoratorSet: z.array(DECORATOR).optional() }).superRefine((component, ctx) => {
    const wrong = check(component.value)
    if (wrong) ctx.addIssue({ code: 'custom', message: wrong, path: [] })
  })
}

const IMAGE_SOURCES = ['uploadDestinationId', 'assetId', 'url'] as const

/** An image position as Nexus takes it: Amazon's ImageComponent, or a new photo by assetId or url. */
function imageSchema(slot: ImageSlot) {
  return strict({
    altText: z.string().superRefine((value, ctx) => {
      const wrong = textLength(value, 100)
      if (wrong) ctx.addIssue({ code: 'custom', message: wrong, path: [] })
    }),
    uploadDestinationId: z.string().min(1, { error: 'is empty' }).optional(),
    assetId: z.string().regex(ASSET_ID, { error: (issue) => `must be a photo id from image-library, da_… or pi_…${said(issue.input)}` }).optional(),
    url: z.string().optional(),
    imageCropSpecification: CROP.optional(),
  }).superRefine((position, ctx) => {
    const sources = IMAGE_SOURCES.filter((key) => position[key] !== undefined)
    if (sources.length === 0) {
      ctx.addIssue({ code: 'custom', path: [], message: 'needs one source: uploadDestinationId (an image already at Amazon, with its imageCropSpecification), assetId (a photo from image-library) or url (an https link to a JPEG or PNG)' })
    } else if (sources.length > 1) {
      ctx.addIssue({ code: 'custom', path: [], message: `takes one source, not ${sources.join(' and ')}` })
    }
    if (position.url !== undefined && !isHttpsLink(position.url)) ctx.addIssue({ code: 'custom', path: ['url'], message: 'must be an https:// link' })
    const crop = position.imageCropSpecification
    if (position.uploadDestinationId !== undefined && !crop) {
      ctx.addIssue({ code: 'custom', path: ['imageCropSpecification'], message: 'is required with uploadDestinationId (keep the one aplus-content view document shows)' })
    }
    if (crop && position.uploadDestinationId !== undefined) {
      const { width, height } = crop.size
      if (width.value < slot.minWidth || height.value < slot.minHeight) {
        ctx.addIssue({ code: 'custom', path: ['imageCropSpecification'], message: `the crop is ${width.value}×${height.value}; Amazon needs at least ${slot.minWidth}×${slot.minHeight}` })
      }
    }
  })
}

function isHttpsLink(value: string): boolean {
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

const VIDEO = strict({ videoMediaId: z.string().min(1, { error: 'is empty' }), imageMediaId: z.string().min(1, { error: 'is empty' }), imageCropSpecification: CROP })

/** The field's own item, unwrapped: a list's items carry `position` when Amazon orders them. */
const positionedObject = (field: Field): boolean => field.kind === 'object' && 'position' in field.fields

function schemaOf(field: Field): z.ZodType {
  const schema = baseSchemaOf(field)
  return field.required ? schema : schema.optional()
}

function baseSchemaOf(field: Field): z.ZodType {
  switch (field.kind) {
    case 'text': return textComponent((value) => textLength(value, field.max))
    case 'paragraph': {
      const line = textComponent((value) => (value === '' ? 'is empty' : null))
      return strict({ textList: sizedList(line, field.lines, 'lines') }).check((ctx) => {
        const total = ctx.value.textList.reduce((sum, entry) => sum + entry.value.length, 0)
        if (total > field.max) ctx.issues.push({ code: 'custom', input: ctx.value, path: [], message: `at most ${field.max} characters in all (it has ${total})` })
        // A paragraph of blank lines is empty (an empty line is already said by itself).
        else if (!ctx.issues.length && ctx.value.textList.every((entry) => entry.value.trim() === '')) ctx.issues.push({ code: 'custom', input: ctx.value, path: [], message: 'is empty' })
      })
    }
    case 'image': return imageSchema(field.slot)
    case 'video': return VIDEO
    case 'enum': return z.enum(field.values as [string, ...string[]])
    case 'choice': return textComponent((value) => (field.values.includes(value) ? null : `value must be ${field.values.map((v) => `"${v}"`).join(' or ')} (it is "${value}")`))
    case 'coordinate': return textComponent((value) => {
      const n = /^\d+$/.test(value) ? Number(value) : NaN
      return n >= field.min && n <= field.max ? null : `value must be a whole number of pixels as text, ${field.min}–${field.max} (it is "${value}")`
    })
    case 'number': return wholeSchema(field.min, field.max)
    case 'boolean': return z.boolean()
    case 'asin': {
      const wrong = (value: string) => (ASIN.test(value) ? null : `must be an ASIN, 10 capital letters and digits (it is "${value}")`)
      return field.form === 'string'
        ? z.string().superRefine((value, ctx) => { const w = wrong(value); if (w) ctx.addIssue({ code: 'custom', path: [], message: w }) })
        : textComponent((value) => (wrong(value) ? `value ${wrong(value)}` : null))
    }
    case 'string': return z.string().superRefine((value, ctx) => {
      const wrong = textLength(value, field.max)
      if (wrong) ctx.addIssue({ code: 'custom', path: [], message: wrong })
    })
    case 'item': return strict({ position: wholeSchema(field.positions[0], field.positions[1]), value: baseSchemaOf(string(field.max)) })
    case 'object': return strict(Object.fromEntries(Object.entries(field.fields).map(([name, f]) => [name, schemaOf(f)])))
    case 'list': {
      const inner = schemaOf({ ...field.of, required: true })
      const entry = field.wrapper ? strict({ [field.wrapper]: inner }) : inner
      const listed = sizedList(entry, field.size, 'items')
      if (!positionedObject(field.of)) return listed
      return listed.check((ctx) => {
        // Once its items pass (zod runs a check after its siblings' issues; it sees them in ctx.issues).
        if (ctx.issues.length) return
        const seen = new Map<number, number>()
        ctx.value.forEach((raw, i) => {
          const position = (field.wrapper ? (raw as Payload)[field.wrapper] : raw)?.position as number
          if (seen.has(position)) ctx.issues.push({ code: 'custom', input: ctx.value, path: [], message: `items ${seen.get(position)! + 1} and ${i + 1} both have position ${position}; each position is used once` })
          else seen.set(position, i)
        })
      })
    }
  }
}

function payloadSchemaOf(spec: ModuleSpec): z.ZodType {
  const schema = baseSchemaOf(object(spec.fields))
  if (!spec.rules?.length) return schema
  return schema.check((ctx) => {
    // The rules across fields read the fields' shapes: they run once every field passes.
    if (ctx.issues.length) return
    for (const rule of spec.rules!) rule(ctx.value as Payload, (path, message) => ctx.issues.push({ code: 'custom', input: ctx.value, path: [...path], message }))
  })
}

/**
 * The strict schema of each module type's payload (the object under its payload key), as Nexus takes it: Amazon's
 * shape, where an image may also name a new photo by assetId or url. Parse with `{ error: aplusIssueMessage }` for the
 * plain words `checkAplusDocument` uses.
 */
export const APLUS_PAYLOAD_SCHEMAS: Readonly<Record<AplusModuleType, z.ZodType>> = Object.freeze(
  Object.fromEntries(APLUS_MODULE_TYPES.map((type) => [type, payloadSchemaOf(MODULES[type])])) as Record<AplusModuleType, z.ZodType>,
)

const EXPECTED: Record<string, string> = {
  object: 'an object', string: 'text', number: 'a number', int: 'a whole number', boolean: 'true or false', array: 'a list',
}

/** Plain words for the zod issues the table's schemas do not word themselves (missing fields, wrong types, enums). */
export function aplusIssueMessage(issue: { code: string; input?: unknown; expected?: string; values?: readonly unknown[]; minimum?: unknown; maximum?: unknown; origin?: string }): string | undefined {
  if (issue.input === undefined && (issue.code === 'invalid_type' || issue.code === 'invalid_value')) return 'is required'
  switch (issue.code) {
    case 'invalid_type': return `must be ${EXPECTED[issue.expected ?? ''] ?? issue.expected}${said(issue.input)}`
    case 'invalid_value': return `must be ${(issue.values ?? []).map(String).join(' or ')}${said(issue.input)}`
    case 'too_small': return issue.origin === 'string' ? `needs at least ${issue.minimum} characters` : `must be at least ${issue.minimum}${said(issue.input)}`
    case 'too_big': return issue.origin === 'string' ? `at most ${issue.maximum} characters` : `must be at most ${issue.maximum}${said(issue.input)}`
    case 'invalid_format': return 'is not in the form Amazon takes'
    default: return undefined
  }
}

/** A zod path as Amazon writes it: columns[1].imageColumn.image */
function pathText(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((out, part) => (typeof part === 'number' ? `${out}[${part}]` : out ? `${out}.${String(part)}` : String(part)), '')
}

const sentence = (prefix: string, path: string, message: string) => `${prefix}${path ? ` ${path}` : ''}: ${message.replace(/\.$/, '')}.`

function issueSentences(issues: readonly z.core.$ZodIssue[], prefix: string): string[] {
  return issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      const allowed = issue.message.startsWith(FIELDS_HERE) ? issue.message.slice(FIELDS_HERE.length) : ''
      return issue.keys.map((key) => sentence(prefix, pathText([...issue.path, key]), `not a field here${allowed ? ` (${FIELDS_HERE}${allowed})` : ''}`))
    }
    return [sentence(prefix, pathText(issue.path), issue.message)]
  })
}

// ── Walking a payload by the table ───────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Visit every field of the table that the payload holds, with its path. Tolerant: unknown keys and wrong shapes are skipped. */
function walk(fields: Fields, value: unknown, path: string, visit: (field: Field, value: unknown, path: string) => void): void {
  if (!isRecord(value)) return
  for (const [name, field] of Object.entries(fields)) {
    const inner = value[name]
    if (inner === undefined || inner === null) continue
    const at = path ? `${path}.${name}` : name
    visit(field, inner, at)
    if (field.kind === 'object') walk(field.fields, inner, at, visit)
    if (field.kind === 'list' && Array.isArray(inner)) {
      inner.forEach((entry, i) => {
        const itemPath = field.wrapper ? `${at}[${i}].${field.wrapper}` : `${at}[${i}]`
        const itemValue = field.wrapper ? (isRecord(entry) ? entry[field.wrapper] : undefined) : entry
        if (itemValue === undefined || itemValue === null) return
        if (field.of.kind === 'object') walk(field.of.fields, itemValue, itemPath, visit)
        else visit(field.of, itemValue, itemPath)
      })
    }
  }
}

/** The characters of a text field's value(s) as a shopper reads them; 0 for anything that is not text. */
function textCharsOf(field: Field, value: unknown): number {
  if (field.kind === 'text') return valueOf(value)?.length ?? 0
  if (field.kind === 'string') return typeof value === 'string' ? value.length : 0
  if (field.kind === 'item') return isRecord(value) && typeof value.value === 'string' ? value.value.length : 0
  if (field.kind === 'paragraph') {
    const lines = isRecord(value) && Array.isArray(value.textList) ? value.textList : []
    return lines.reduce((sum: number, line) => sum + (valueOf(line)?.length ?? 0), 0)
  }
  return 0
}

function cropOf(spec: unknown): CropSpec | null {
  if (!isRecord(spec) || !isRecord(spec.size)) return null
  const px = (v: unknown) => (isRecord(v) && typeof v.value === 'number' ? v.value : 0)
  const offset = isRecord(spec.offset) ? spec.offset : {}
  return { width: px(spec.size.width), height: px(spec.size.height), x: px(offset.x), y: px(offset.y) }
}

// ── Normalising and hashing ──────────────────────────────────────────────────────────────────────────

/** Drop null / undefined object values at every depth and every empty decoratorSet (Amazon treats both as absent). */
function dropEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropEmpty)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) {
    if (inner === null || inner === undefined) continue
    if (key === 'decoratorSet' && Array.isArray(inner) && inner.length === 0) continue
    out[key] = dropEmpty(inner)
  }
  return out
}

/** The document without null / undefined values and empty decoratorSets, so the same content always compares and hashes the same. */
export function normalizeAmazonDocument(doc: AplusDocument): AplusDocument {
  return dropEmpty(doc) as AplusDocument
}

/** A short hash of the document's content, whatever its key order and however Amazon wrote its empty values. */
export function documentHash(doc: AplusDocument): string {
  return factHash(normalizeAmazonDocument(doc))
}

// ── Checking a document ──────────────────────────────────────────────────────────────────────────────

const LOCALE = /^[a-z]{2,}-[A-Z0-9]{2,}$/
const MAX_PROBLEMS = 50

const listOf = (numbers: number[]) => (numbers.length === 1 ? `module ${numbers[0]}` : `modules ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`)

/**
 * Check a document as set-aplus-content would send it: the module objects (Amazon's exact shape, `{ contentModuleType,
 * <payloadKey>: {…} }`), every payload against its strict schema after nulls are dropped, then the document's rules:
 * EBC is all Standard or all Premium, BrandStory is all Brand Story with exactly one BRAND_STORY_IMAGE_WITH_LOGO, EMC
 * (vendor content) is refused, at most APLUS_MAX_MODULES of the tier. Returns every problem found as a sentence, or the
 * checked document with its image positions, videos and the ASINs its modules name.
 */
export function checkAplusDocument(input: { name: string; contentType: 'EBC' | 'BrandStory'; locale: string; modules: readonly unknown[] }):
  { ok: true; doc: CheckedAplusDocument } | { ok: false; problems: string[] } {
  const problems: string[] = []
  const name = typeof input.name === 'string' ? input.name : ''
  if (name.trim() === '') problems.push('The document needs a name (1–100 characters).')
  else if (name.length > 100) problems.push(`The document name has at most 100 characters (it has ${name.length}).`)
  const contentType = input.contentType as string
  if (contentType === 'EMC') problems.push('contentType EMC is vendor A+ content; Nexus makes seller content only: EBC (A+) or BrandStory (Brand Story).')
  else if (contentType !== 'EBC' && contentType !== 'BrandStory') problems.push(`contentType must be EBC (A+) or BrandStory (Brand Story)${said(contentType)}.`)
  const locale = typeof input.locale === 'string' ? input.locale : ''
  if (!LOCALE.test(locale)) problems.push(`The locale is the language and the country with a hyphen, e.g. it-IT${said(input.locale)}.`)

  const raw = Array.isArray(input.modules) ? input.modules : []
  if (raw.length === 0) problems.push('The document needs at least one module.')
  const modules: AplusModule[] = []
  const types: Array<{ n: number; type: AplusModuleType }> = []
  raw.forEach((entry, i) => {
    const n = i + 1
    const module = dropEmpty(entry)
    if (!isRecord(module)) { problems.push(`Module ${n}: must be an object { contentModuleType, <its content> }.`); return }
    const type = module.contentModuleType
    if (!isAplusModuleType(type)) {
      problems.push(`Module ${n}: contentModuleType ${JSON.stringify(type ?? null)} is not an A+ module type (aplus-content view modules lists them).`)
      return
    }
    types.push({ n, type })
    const key = payloadKeyOf(type)
    const prefix = `Module ${n} (${type})`
    for (const other of Object.keys(module)) {
      if (other !== 'contentModuleType' && other !== key) problems.push(sentence(prefix, other, `not a field of the module object; it holds contentModuleType and ${key} only`))
    }
    if (module[key] === undefined) { problems.push(sentence(prefix, '', `its content goes under ${key}`)); return }
    const parsed = APLUS_PAYLOAD_SCHEMAS[type].safeParse(module[key], { error: aplusIssueMessage })
    if (!parsed.success) { problems.push(...issueSentences(parsed.error.issues, prefix)); return }
    modules.push({ contentModuleType: type, [key]: module[key] })
  })

  // The document's rules, on every module whose type is known (a payload problem does not hide them).
  const tiers = new Map<AplusTier, number[]>()
  for (const { n, type } of types) tiers.set(tierOf(type), [...(tiers.get(tierOf(type)) ?? []), n])
  // Amazon's seven-module cap applies as soon as one Premium module is in the list (troubleshooting guide).
  const tier: AplusTier = contentType === 'BrandStory' ? 'BRAND_STORY' : tiers.has('PREMIUM') ? 'PREMIUM' : 'STANDARD'
  if (contentType === 'EBC') {
    const story = tiers.get('BRAND_STORY')
    if (story) problems.push(`Brand Story modules (${listOf(story)}) go in their own Brand Story document (kind brand-story).`)
    if (tiers.has('STANDARD') && tiers.has('PREMIUM')) {
      problems.push(`A document is all Standard or all Premium: ${listOf(tiers.get('STANDARD')!)} Standard, ${listOf(tiers.get('PREMIUM')!)} Premium.`)
    }
  }
  if (contentType === 'BrandStory') {
    const other = types.filter(({ type }) => tierOf(type) !== 'BRAND_STORY').map(({ n }) => n)
    if (other.length) problems.push(`A Brand Story document holds Brand Story modules only; ${listOf(other)} ${other.length === 1 ? 'is' : 'are'} not.`)
    const logos = types.filter(({ type }) => type === 'BRAND_STORY_IMAGE_WITH_LOGO').map(({ n }) => n)
    if (logos.length !== 1) {
      problems.push(`A Brand Story document has exactly one BRAND_STORY_IMAGE_WITH_LOGO, its background card; it has ${logos.length ? `${logos.length} (${listOf(logos)})` : 'none'}.`)
    }
  }
  if ((contentType === 'EBC' || contentType === 'BrandStory') && raw.length > APLUS_MAX_MODULES[tier]) {
    problems.push(`The document has ${raw.length} modules; a ${TIER_NAME[tier]} document holds at most ${APLUS_MAX_MODULES[tier]}.`)
  }
  if (problems.length) {
    return { ok: false, problems: problems.length > MAX_PROBLEMS ? [...problems.slice(0, MAX_PROBLEMS), `…and ${problems.length - MAX_PROBLEMS} more.`] : problems }
  }

  const images: ImageUse[] = []
  const asins = new Set<string>()
  let videos = 0
  modules.forEach((module, index) => {
    const key = payloadKeyOf(module.contentModuleType)
    walk(MODULES[module.contentModuleType].fields, module[key], '', (field, value, path) => {
      if (field.kind === 'video') videos++
      if (field.kind === 'asin') asins.add(field.form === 'string' ? (value as string) : valueOf(value)!)
      if (field.kind !== 'image') return
      const position = value as Record<string, any>
      const source: ImageSource = position.uploadDestinationId !== undefined
        ? { kind: 'amazon', uploadDestinationId: position.uploadDestinationId }
        : position.assetId !== undefined ? { kind: 'asset', assetId: position.assetId } : { kind: 'url', url: position.url }
      images.push({ key: `${index}:${path}`, module: index, path, slot: field.slot, source, altText: position.altText, crop: cropOf(position.imageCropSpecification) })
    })
  })
  return {
    ok: true,
    doc: { name, contentType: contentType as 'EBC' | 'BrandStory', tier, locale, modules, images, videos, asins: [...asins].sort() },
  }
}

// ── Summary and guide ────────────────────────────────────────────────────────────────────────────────

export interface ModuleSummary { position: number; type: AplusModuleType; headline: string | null; images: number; textChars: number }

/**
 * One line per module of a document as Amazon keeps it: its position (from 1), type, headline (its headline, else its
 * title, else its first text), how many images it shows and how many characters of text it holds.
 */
export function summarizeModules(modules: readonly AplusModule[]): ModuleSummary[] {
  return modules.map((module, i) => {
    const type = module.contentModuleType
    const spec = isAplusModuleType(type) ? MODULES[type] : null
    const payload = isAplusModuleType(type) ? module[payloadKeyOf(type)] : undefined
    let images = 0
    let textChars = 0
    let firstText: string | null = null
    if (spec) {
      walk(spec.fields, payload, '', (field, value) => {
        if (field.kind === 'image') images++
        textChars += textCharsOf(field, value)
        if (firstText === null && field.kind === 'text') firstText = valueOf(value)
        if (firstText === null && field.kind === 'paragraph') firstText = valueOf((value as { textList?: unknown[] })?.textList?.[0])
      })
    }
    const top = isRecord(payload) ? valueOf(payload.headline) ?? valueOf(payload.title) : null
    return { position: i + 1, type, headline: top ?? firstText, images, textChars }
  })
}

export interface AplusModuleGuide {
  type: AplusModuleType
  tier: AplusTier
  payloadKey: string
  about: string
  fields: Array<{ path: string; kind: 'text' | 'paragraph' | 'image' | 'video' | 'list' | 'enum' | 'number' | 'boolean' | 'asin' | 'plain' | 'object'; required: boolean; rule: string }>
}
type GuideField = AplusModuleGuide['fields'][number]

const GUIDE_KIND: Record<Field['kind'], GuideField['kind']> = {
  text: 'text', paragraph: 'paragraph', image: 'image', video: 'video', enum: 'enum', choice: 'enum', coordinate: 'text',
  number: 'number', boolean: 'boolean', asin: 'asin', string: 'plain', item: 'plain', object: 'object', list: 'list',
}

function ruleOf(field: Field): string {
  const rule = ((): string => {
    switch (field.kind) {
      case 'text': return `{ value }, at most ${field.max} characters`
      case 'paragraph': return `{ textList: [{ value }] }, ${field.lines[0] === field.lines[1] ? `${count(field.lines[0], 'lines')}` : `${field.lines[0]} to ${count(field.lines[1], 'lines')}`}, at most ${field.max} characters in all`
      case 'image': return `an image, at least ${field.slot.minWidth}×${field.slot.minHeight} px (cropped to that shape)`
      case 'video': return 'a video already at Amazon: { videoMediaId, imageMediaId, imageCropSpecification }'
      case 'enum': return field.values.join(' or ')
      case 'choice': return `{ value: ${field.values.map((v) => `"${v}"`).join(' or ')} }`
      case 'coordinate': return `{ value: a whole number of pixels as text, ${field.min}–${field.max} }`
      case 'number': return `a whole number ${range(field.min, field.max)}`
      case 'boolean': return 'true or false'
      case 'asin': return field.form === 'string' ? 'an ASIN: 10 capital letters and digits' : '{ value: an ASIN, 10 capital letters and digits }'
      case 'string': return `text of at most ${field.max} characters`
      case 'item': return `{ position ${range(field.positions[0], field.positions[1])}, value of at most ${field.max} characters }`
      case 'object': return 'an object'
      case 'list': {
        const [min, max] = field.size
        const size = min === max ? `exactly ${count(min, 'items')}` : min === 0 ? `at most ${count(max, 'items')}` : `${min} to ${count(max, 'items')}`
        return `${size}${field.wrapper ? `, each { ${field.wrapper}: {…} }` : ''}${positionedObject(field.of) ? '; each position used once' : ''}`
      }
    }
  })()
  return field.note ? `${rule}; ${field.note}` : rule
}

function guideFields(fields: Fields, prefix: string, out: GuideField[]): GuideField[] {
  for (const [name, field] of Object.entries(fields)) {
    const path = `${prefix}${name}`
    out.push({ path, kind: GUIDE_KIND[field.kind], required: field.required, rule: ruleOf(field) })
    if (field.kind === 'object') guideFields(field.fields, `${path}.`, out)
    if (field.kind === 'list') {
      const itemPath = field.wrapper ? `${path}[].${field.wrapper}` : `${path}[]`
      if (field.of.kind === 'object') guideFields(field.of.fields, `${itemPath}.`, out)
      else out.push({ path: itemPath, kind: GUIDE_KIND[field.of.kind], required: true, rule: ruleOf(field.of) })
    }
  }
  return out
}

/** What Claude reads before writing modules: for one type or all 39, its tier, payload key, what it shows and every field's rule. */
export function aplusModuleGuide(type?: AplusModuleType): AplusModuleGuide[] {
  return (type ? [type] : [...APLUS_MODULE_TYPES]).map((t) => ({
    type: t,
    tier: MODULES[t].tier,
    payloadKey: payloadKeyOf(t),
    about: MODULES[t].about,
    fields: guideFields(MODULES[t].fields, '', []),
  }))
}

/** The rules of a whole document, said once (aplus-content view modules shows them above the module guide). */
export const APLUS_DOCUMENT_RULES = [
  `An A+ document (kind a-plus, contentType EBC) holds 1 to ${APLUS_MAX_MODULES.PREMIUM} modules, all Standard (STANDARD_…) or all Premium (PREMIUM_…); Premium needs the brand's Premium A+ in that market.`,
  `A Brand Story document (kind brand-story, contentType BrandStory) holds Brand Story modules only, exactly one of them BRAND_STORY_IMAGE_WITH_LOGO (its background card), and needs Amazon Brand Registry.`,
  'Each module is Amazon\'s own object, { contentModuleType: "PREMIUM_IMAGE_TEXT", premiumImageText: {…} }: the content key is the type in camelCase, and the object holds nothing else; an unknown field anywhere is refused by name.',
  'Text is { value } (decoratorSet optional: bold, italic, lists); a paragraph is { textList: [{ value }, …] }, and its limit counts all its lines together.',
  'List items are wrapped where Amazon wraps them (columns[].imageColumn, carouselCards[].imagePanel, faqs[].faq, techSpecs[].techSpec, …); positions count from 1 and each is used once in its list.',
  'An image is { altText (1–100 characters) and one source }: uploadDestinationId with its imageCropSpecification (an image already at Amazon, as aplus-content view document shows it), assetId (a photo from image-library, da_… or pi_…) or url (an https link to a JPEG or PNG).',
  'Nexus crops a new photo to the slot\'s shape (the largest centred crop) unless imageCropSpecification { size: { width, height }, offset: { x, y } } in pixels is given; it refuses a photo smaller than the slot, over 5 MB, or not JPEG or PNG, and uploads it to Amazon only when the approved request runs.',
  'A video goes in only as already at Amazon: { videoMediaId, imageMediaId, imageCropSpecification }.',
  'The locale is the market\'s language and country with a hyphen (it-IT).',
].join(' ')
