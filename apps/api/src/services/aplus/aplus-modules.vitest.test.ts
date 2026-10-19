/**
 * Amazon A+ content (2026-10-19) — the module table against Amazon's model and documents: the 39 types and their payload
 * keys exactly as aplusContent_2020-11-01.json has them, Amazon's own documentation examples accepted, a smallest valid
 * payload of every type accepted, and each rule refused with a sentence that names the module, its type and the field.
 * Pure: no database, no network.
 */
import { describe, expect, it } from 'vitest'
import {
  APLUS_DOCUMENT_RULES, APLUS_MAX_MODULES, APLUS_MODULE_TYPES, APLUS_PAYLOAD_SCHEMAS, aplusModuleGuide, checkAplusDocument,
  documentHash, normalizeAmazonDocument, payloadKeyOf, summarizeModules, tierOf, type AplusModuleType,
} from './aplus-modules.js'
import type { AplusDocument, AplusModule } from './aplus-client.js'

/** ContentModuleType in aplusContent_2020-11-01.json, and each type's property of ContentModule. */
const AMAZON_MODEL: Array<[string, string]> = [
  ['STANDARD_COMPANY_LOGO', 'standardCompanyLogo'], ['STANDARD_COMPARISON_TABLE', 'standardComparisonTable'],
  ['STANDARD_FOUR_IMAGE_TEXT', 'standardFourImageText'], ['STANDARD_FOUR_IMAGE_TEXT_QUADRANT', 'standardFourImageTextQuadrant'],
  ['STANDARD_HEADER_IMAGE_TEXT', 'standardHeaderImageText'], ['STANDARD_IMAGE_SIDEBAR', 'standardImageSidebar'],
  ['STANDARD_IMAGE_TEXT_OVERLAY', 'standardImageTextOverlay'], ['STANDARD_MULTIPLE_IMAGE_TEXT', 'standardMultipleImageText'],
  ['STANDARD_PRODUCT_DESCRIPTION', 'standardProductDescription'], ['STANDARD_SINGLE_IMAGE_HIGHLIGHTS', 'standardSingleImageHighlights'],
  ['STANDARD_SINGLE_IMAGE_SPECS_DETAIL', 'standardSingleImageSpecsDetail'], ['STANDARD_SINGLE_SIDE_IMAGE', 'standardSingleSideImage'],
  ['STANDARD_TECH_SPECS', 'standardTechSpecs'], ['STANDARD_TEXT', 'standardText'], ['STANDARD_THREE_IMAGE_TEXT', 'standardThreeImageText'],
  ['PREMIUM_IMAGE_TEXT', 'premiumImageText'], ['PREMIUM_TEXT', 'premiumText'], ['PREMIUM_FULL_BACKGROUND_TEXT', 'premiumFullBackgroundText'],
  ['PREMIUM_FULL_BACKGROUND_IMAGE', 'premiumFullBackgroundImage'], ['PREMIUM_FOUR_COLUMN_IMAGES', 'premiumFourColumnImages'],
  ['PREMIUM_DUAL_IMAGE_TEXT', 'premiumDualImageText'], ['PREMIUM_IMAGE_CAROUSEL', 'premiumImageCarousel'],
  ['PREMIUM_NAVIGATION_CAROUSEL', 'premiumNavigationCarousel'], ['PREMIUM_REGIMEN_CAROUSEL', 'premiumRegimenCarousel'],
  ['PREMIUM_THREE_COLUMN_COMPARISON', 'premiumThreeColumnComparison'], ['PREMIUM_COMPARISON_CAROUSEL', 'premiumComparisonCarousel'],
  ['PREMIUM_COMPARISON_SCROLLER', 'premiumComparisonScroller'], ['PREMIUM_HOTSPOT_IMAGE', 'premiumHotspotImage'],
  ['PREMIUM_HOTSPOT_IMAGE_TEXT', 'premiumHotspotImageText'], ['PREMIUM_FAQ', 'premiumFaq'], ['PREMIUM_TECH_SPECS', 'premiumTechSpecs'],
  ['PREMIUM_VIDEO_TEXT', 'premiumVideoText'], ['PREMIUM_HERO_VIDEO', 'premiumHeroVideo'], ['PREMIUM_VIDEO_IMAGE_CAROUSEL', 'premiumVideoImageCarousel'],
  ['BRAND_STORY_IMAGE_WITH_LOGO', 'brandStoryImageWithLogo'], ['BRAND_STORY_FOUR_ASIN', 'brandStoryFourAsin'],
  ['BRAND_STORY_MEDIA_ASSET', 'brandStoryMediaAsset'], ['BRAND_STORY_ABOUT', 'brandStoryAbout'], ['BRAND_STORY_QUESTIONS', 'brandStoryQuestions'],
]

const T = (value: string) => ({ value })
const P = (...lines: string[]) => ({ textList: lines.map((value) => ({ value })) })
const px = (value: number) => ({ value, units: 'pixels' })
const crop = (width: number, height: number, x = 0, y = 0) => ({ size: { width: px(width), height: px(height) }, offset: { x: px(x), y: px(y) } })
const AT_AMAZON = (width: number, height: number) => ({ uploadDestinationId: 'aplus-media/test.png', imageCropSpecification: crop(width, height), altText: 'A photo at Amazon' })
const NEW = { assetId: 'da_photo1', altText: 'A new photo' }
const LINK = { url: 'https://photos.example.test/jacket.jpg', altText: 'A linked photo' }
const VIDEO = { videoMediaId: 'video-1', imageMediaId: 'thumb-1', imageCropSpecification: crop(1464, 600) }
const times = <V>(n: number, make: (i: number) => V): V[] => Array.from({ length: n }, (_, i) => make(i))
const asinNo = (i: number) => `B00000000${i + 1}`
const mod = (type: AplusModuleType, payload: unknown): AplusModule => ({ contentModuleType: type, [payloadKeyOf(type)]: payload })
const ebc = (...modules: unknown[]) => checkAplusDocument({ name: 'Test A+', contentType: 'EBC', locale: 'it-IT', modules })
const story = (...modules: unknown[]) => checkAplusDocument({ name: 'Test story', contentType: 'BrandStory', locale: 'it-IT', modules })
const problemsOf = (result: ReturnType<typeof checkAplusDocument>): string[] => (result.ok ? [] : (result as { problems: string[] }).problems)
const docOf = (result: ReturnType<typeof checkAplusDocument>) => {
  expect(problemsOf(result)).toEqual([])
  return (result as Extract<typeof result, { ok: true }>).doc
}

/** A smallest valid payload of every type (required fields, the fewest list items, the rules across fields kept). */
const MINIMAL: Record<AplusModuleType, unknown> = {
  STANDARD_COMPANY_LOGO: { companyLogo: NEW },
  STANDARD_COMPARISON_TABLE: {
    productColumns: [{ position: 1, title: 'Jacket', asin: 'B000000001', highlight: true, metrics: [{ position: 1, value: 'Waterproof' }] }, { position: 2, title: 'Pants' }],
    metricRowLabels: [{ position: 1, value: 'Rain' }],
  },
  STANDARD_FOUR_IMAGE_TEXT: { headline: T('Four'), block1: { image: NEW, headline: T('One'), body: P('Body') } },
  STANDARD_FOUR_IMAGE_TEXT_QUADRANT: { block1: { headline: T('1') }, block2: { headline: T('2') }, block3: { headline: T('3') }, block4: { headline: T('4') } },
  STANDARD_HEADER_IMAGE_TEXT: { headline: T('Header'), block: { image: NEW, body: P('Text') } },
  STANDARD_IMAGE_SIDEBAR: { headline: T('Side'), descriptionListBlock: { textList: [{ position: 1, text: T('Point') }] } },
  STANDARD_IMAGE_TEXT_OVERLAY: { overlayColorType: 'DARK', block: { image: NEW, headline: T('Over') } },
  STANDARD_MULTIPLE_IMAGE_TEXT: { blocks: [{ block: { image: NEW, headline: T('One') }, caption: T('Caption') }] },
  STANDARD_PRODUCT_DESCRIPTION: { body: P('Description') },
  STANDARD_SINGLE_IMAGE_HIGHLIGHTS: { image: NEW, bulletedListBlock: { headline: T('Specs'), block: { textList: [{ position: 1, text: T('Light') }] } } },
  STANDARD_SINGLE_IMAGE_SPECS_DETAIL: { headline: T('Specs'), specificationListBlock: { block: { textList: [] } } },
  STANDARD_SINGLE_SIDE_IMAGE: { imagePositionType: 'LEFT', block: { body: P('Side') } },
  STANDARD_TECH_SPECS: { specificationList: times(4, (i) => ({ label: T(`Spec ${i}`), description: T('Value') })), tableCount: 1 },
  STANDARD_TEXT: { body: P('Text') },
  STANDARD_THREE_IMAGE_TEXT: { block1: { headline: T('One') } },
  PREMIUM_IMAGE_TEXT: { positionType: 'RIGHT', headline: T('Headline'), image: NEW },
  PREMIUM_TEXT: { description: P('Description') },
  PREMIUM_FULL_BACKGROUND_TEXT: { positionType: 'LEFT', colorType: 'LIGHT', desktopImage: NEW, mobileImage: LINK },
  PREMIUM_FULL_BACKGROUND_IMAGE: { desktopImage: NEW, mobileImage: NEW },
  PREMIUM_FOUR_COLUMN_IMAGES: { columns: times(3, (i) => ({ imageColumn: { position: i + 1, image: NEW } })) },
  PREMIUM_DUAL_IMAGE_TEXT: { columns: times(2, (i) => ({ imageColumn: { position: i + 1, image: NEW } })) },
  PREMIUM_IMAGE_CAROUSEL: {
    carouselCards: [
      { imagePanel: { position: 1, desktopImage: NEW, mobileImage: NEW } },
      { imagePanel: { position: 2, desktopImage: NEW, mobileImage: NEW, buttonText: T('Shop now'), asin: T('B000000001') } },
    ],
  },
  PREMIUM_NAVIGATION_CAROUSEL: { carouselCards: times(2, (i) => ({ navigationPanel: { position: i + 1, navText: T(`Tab ${i}`), desktopImage: NEW, mobileImage: NEW } })) },
  PREMIUM_REGIMEN_CAROUSEL: { carouselCards: times(2, (i) => ({ regimenPanel: { position: i + 1, navText: T(`Step ${i}`), desktopImage: NEW, mobileImage: NEW } })) },
  PREMIUM_THREE_COLUMN_COMPARISON: {
    headline: T('Compare'),
    comparisonProducts: times(3, (i) => ({ position: i + 1, productTitle: T(`Jacket ${i}`), productAsin: T(asinNo(i)), image: NEW })),
    comparisonRows: times(2, (i) => ({ position: i + 1, metricValues: times(3, () => ({ metricName: T('Rain'), metricValue: P('Yes') })) })),
  },
  PREMIUM_COMPARISON_CAROUSEL: {
    headline: T('Compare'),
    comparisonProducts: times(3, (i) => ({ comparisonProduct: { position: i + 1, productTitle: T(`Jacket ${i}`), productAsin: T(asinNo(i)), desktopImage: NEW, mobileImage: NEW } })),
    comparisonMetrics: times(3, (i) => ({ comparisonRow: { position: i + 1, comparisonType: T('checkbox'), comparisonFields: times(3, (k) => ({ comparisonField: { position: k + 1, value: 'true' } })) } })),
  },
  PREMIUM_COMPARISON_SCROLLER: {
    headline: T('Compare'),
    comparisonProducts: times(4, (i) => ({ comparisonProduct: { position: i + 1, productTitle: T(`Jacket ${i}`), productAsin: T(asinNo(i)), desktopImage: NEW } })),
    comparisonRows: times(5, (i) => ({ comparisonRow: { position: i + 1, comparisonType: T('input-field'), comparisonFields: times(4, (k) => ({ comparisonField: { position: k + 1, value: '3 layers' } })) } })),
  },
  PREMIUM_HOTSPOT_IMAGE: { desktopImage: NEW, hotSpots: times(2, (i) => ({ imageHotSpot: { title: T(`Spot ${i}`), xCoordinate: T(String(100 + 200 * i)), yCoordinate: T('100'), mobileImage: NEW } })) },
  PREMIUM_HOTSPOT_IMAGE_TEXT: { headline: T('Spots'), desktopImage: NEW, hotSpots: times(2, (i) => ({ imageTextHotSpot: { title: T(`Spot ${i}`), xCoordinate: T('300'), yCoordinate: T(String(100 + 200 * i)), mobileImage: NEW } })) },
  PREMIUM_FAQ: { colorType: 'DARK', faqs: times(2, (i) => ({ faq: { question: P(`Question ${i}?`), answer: P('Answer.') } })) },
  PREMIUM_TECH_SPECS: { headline: T('Specs'), columnCount: 2, techSpecs: times(4, (i) => ({ techSpec: { specKey: T(`Key ${i}`), specValue: T('Value') } })) },
  PREMIUM_VIDEO_TEXT: { positionType: 'LEFT', headline: T('Video'), video: VIDEO },
  PREMIUM_HERO_VIDEO: { heroVideo: VIDEO },
  PREMIUM_VIDEO_IMAGE_CAROUSEL: {
    carouselCards: [
      { videoCarouselPanel: { position: 1, positionType: 'LEFT', subheadline: T('A video'), video: VIDEO } },
      { videoCarouselPanel: { position: 2, positionType: 'RIGHT', subheadline: T('Two images'), desktopImage: NEW, mobileImage: NEW } },
    ],
  },
  BRAND_STORY_IMAGE_WITH_LOGO: { desktopImage: NEW, mobileImage: NEW },
  BRAND_STORY_FOUR_ASIN: { title: T('Our range'), asinImages: times(4, (i) => ({ asinImage: { productAsin: T(asinNo(i)), productImage: NEW } })) },
  BRAND_STORY_MEDIA_ASSET: { image: NEW },
  BRAND_STORY_ABOUT: { logoImage: NEW },
  BRAND_STORY_QUESTIONS: { questionAnswerPairs: times(3, (i) => ({ questionAnswerPair: { question: T(`Question ${i}?`), answer: P('Answer.') } })) },
}

/** A document holding one module of `type`, in the kind of document that type belongs to. */
const oneModule = (type: AplusModuleType, payload: unknown = MINIMAL[type]) =>
  tierOf(type) === 'BRAND_STORY'
    ? story(...(type === 'BRAND_STORY_IMAGE_WITH_LOGO' ? [] : [mod('BRAND_STORY_IMAGE_WITH_LOGO', MINIMAL.BRAND_STORY_IMAGE_WITH_LOGO)]), mod(type, payload))
    : ebc(mod(type, payload))
/** The module's number in `oneModule`'s document. */
const numberIn = (type: AplusModuleType) => (tierOf(type) === 'BRAND_STORY' && type !== 'BRAND_STORY_IMAGE_WITH_LOGO' ? 2 : 1)

// Amazon's own examples (A+ Premium Modules; create-edit-publish-aplus-content, Step 3a).
const AMAZON_PREMIUM_IMAGE_TEXT = { contentModuleType: 'PREMIUM_IMAGE_TEXT', premiumImageText: { subheadline: { decoratorSet: [], value: 'WHY DOGS BOND WITH HUMANS' }, bodyText: { textList: [{ decoratorSet: [], value: 'Dogs are uniquely wired to form deep emotional bonds with humans. Research shows dogs release oxytocin—the "love hormone"—when interacting with their owners, the same chemical that bonds human parents to their children. Studies reveal dogs can recognize human emotions through facial expressions and tone of voice, responding with empathy when their owners are distressed. This loyalty makes dogs the only non-primate species that naturally seeks eye contact with humans for emotional connection.' }] }, positionType: 'LEFT', image: { imageCropSpecification: { offset: { y: { value: 0, units: 'pixels' }, x: { value: 240, units: 'pixels' } }, size: { width: { value: 1440, units: 'pixels' }, height: { value: 1080, units: 'pixels' } } }, uploadDestinationId: 'aplus-media/9eb22e6f-e704-43e6-86cd-ff5c30125273.png', altText: 'Descriptive alt text about image' }, headline: { decoratorSet: [], value: "Dogs' Loyalty: The Science Behind Our Most Devoted Companions" } } }
const AMAZON_FOUR_COLUMN_IMAGES = { contentModuleType: 'PREMIUM_FOUR_COLUMN_IMAGES', premiumFourColumnImages: { columns: [
  { imageColumn: { position: 1, description: { textList: [{ decoratorSet: [], value: 'That "guilty look" isn\'t guilt—it\'s learned behavior! Dogs read your body language and give puppy eyes as a peace offering, even when innocent.' }] }, headline: { decoratorSet: [], value: 'Master of the Guilty Face Act' }, image: { imageCropSpecification: { offset: { y: { value: 0, units: 'pixels' }, x: { value: 258, units: 'pixels' } }, size: { width: { value: 1440, units: 'pixels' }, height: { value: 1080, units: 'pixels' } } }, uploadDestinationId: 'aplus-media/9eb22e6f-e704-43e6-86cd-ff5c30125273.png', altText: 'Descriptive alt text about image' } } },
  { imageColumn: { position: 2, description: { textList: [{ decoratorSet: [], value: 'Dogs sleep 12-14 hours daily, perfecting the art of power naps. They can fall asleep in seconds and wake instantly for treats or walks.' }] }, headline: { decoratorSet: [], value: 'Professional Nap Champion' }, image: { imageCropSpecification: { offset: { y: { value: 0, units: 'pixels' }, x: { value: 308, units: 'pixels' } }, size: { width: { value: 1440, units: 'pixels' }, height: { value: 1080, units: 'pixels' } } }, uploadDestinationId: 'aplus-media/812ca5bb-16f3-466d-891c-464fbd7bd8ad.png', altText: 'Descriptive alt text about image' } } },
  { imageColumn: { position: 3, description: { textList: [{ decoratorSet: [], value: "A wagging tail doesn't always mean happy! Some wags show positive feelings, while other wags indicate nervousness, it's their emotional mood ring." }] }, headline: { decoratorSet: [], value: 'The Tail-Wagging Translator' }, image: { imageCropSpecification: { offset: { y: { value: 0, units: 'pixels' }, x: { value: 294, units: 'pixels' } }, size: { width: { value: 1440, units: 'pixels' }, height: { value: 1080, units: 'pixels' } } }, uploadDestinationId: 'aplus-media/adf0687c-4f5b-4cfb-b660-fdc2e3311b45.png', altText: 'Descriptive alt text about image' } } },
  { imageColumn: { position: 4, description: { textList: [{ decoratorSet: [], value: 'Dogs can hear a treat bag opening from three rooms away and detect snack time before you even think about it. Their food radar is unmatched!' }] }, headline: { decoratorSet: [], value: 'Champion Treat Detector Expert' }, image: { imageCropSpecification: { offset: { y: { value: 0, units: 'pixels' }, x: { value: 280, units: 'pixels' } }, size: { width: { value: 1440, units: 'pixels' }, height: { value: 1080, units: 'pixels' } } }, uploadDestinationId: 'aplus-media/0eda7aa0-8d41-496b-9937-486ea495cb9a.png', altText: 'Descriptive alt text about image' } } },
], headline: { decoratorSet: [], value: 'Collect all the dogs, gift them to your friends and neighbors!' } } }
const AMAZON_HEADER_IMAGE_TEXT = { contentModuleType: 'STANDARD_HEADER_IMAGE_TEXT', standardHeaderImageText: { headline: { value: 'Lorem ipsum', decoratorSet: [] }, block: { image: { uploadDestinationId: 'SampleID', imageCropSpecification: { size: { width: { value: 970, units: 'pixels' }, height: { value: 600, units: 'pixels' } }, offset: { x: { value: 7, units: 'pixels' }, y: { value: 0, units: 'pixels' } } }, altText: 'Lorem ipsum' }, headline: { value: 'Nunc faucibus neque auctor faucibus pretium.', decoratorSet: [] }, body: { textList: [{ value: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nunc faucibus neque auctor faucibus pretium. Quisque sed blandit nunc. Pellentesque malesuada lorem vitae justo efficitur viverra.', decoratorSet: [] }] } } } }

describe('the 39 module types', () => {
  it('are exactly Amazon\'s ContentModuleType enum, each with its ContentModule property as payload key', () => {
    expect([...APLUS_MODULE_TYPES]).toEqual(AMAZON_MODEL.map(([type]) => type))
    for (const [type, key] of AMAZON_MODEL) expect(payloadKeyOf(type as AplusModuleType)).toBe(key)
  })

  it('every type has its tier from its name, a schema, a guide entry and a smallest valid payload', () => {
    expect(Object.keys(MINIMAL).sort()).toEqual([...APLUS_MODULE_TYPES].sort())
    const guide = aplusModuleGuide()
    expect(guide.map((g) => g.type)).toEqual([...APLUS_MODULE_TYPES])
    for (const type of APLUS_MODULE_TYPES) {
      expect(tierOf(type)).toBe(type.startsWith('STANDARD_') ? 'STANDARD' : type.startsWith('PREMIUM_') ? 'PREMIUM' : 'BRAND_STORY')
      expect(APLUS_PAYLOAD_SCHEMAS[type]).toBeDefined()
      const entry = aplusModuleGuide(type)
      expect(entry).toHaveLength(1)
      expect(entry[0]).toMatchObject({ type, tier: tierOf(type), payloadKey: payloadKeyOf(type) })
      expect(entry[0].about.length).toBeGreaterThan(10)
      expect(entry[0].fields.length).toBeGreaterThan(0)
    }
    expect(APLUS_MAX_MODULES).toEqual({ STANDARD: 7, PREMIUM: 7, BRAND_STORY: 20 })
    expect(APLUS_DOCUMENT_RULES).toMatch(/all Standard \(STANDARD_…\) or all Premium/)
  })

  it.each([...APLUS_MODULE_TYPES])('%s: its smallest valid payload passes', (type) => {
    const doc = docOf(oneModule(type))
    expect(doc.modules[numberIn(type) - 1]).toEqual(mod(type, MINIMAL[type]))
    expect(doc.tier).toBe(tierOf(type))
  })

  it.each([...APLUS_MODULE_TYPES])('%s: each required top-level field the guide names is required', (type) => {
    const required = aplusModuleGuide(type)[0].fields.filter((f) => f.required && !/[.[]/.test(f.path))
    for (const field of required) {
      const payload = { ...(MINIMAL[type] as Record<string, unknown>) }
      delete payload[field.path]
      expect(problemsOf(oneModule(type, payload))).toContain(`Module ${numberIn(type)} (${type}) ${field.path}: is required.`)
    }
  })

  it.each([...APLUS_MODULE_TYPES])('%s: each top-level text limit the guide names is the one checked', (type) => {
    for (const field of aplusModuleGuide(type)[0].fields.filter((f) => f.kind === 'text' && !/[.[]/.test(f.path))) {
      const max = Number(/at most (\d+) characters/.exec(field.rule)?.[1])
      if (!max) continue
      const payload = { ...(MINIMAL[type] as Record<string, unknown>), [field.path]: T('x'.repeat(max + 1)) }
      expect(problemsOf(oneModule(type, payload))).toEqual([`Module ${numberIn(type)} (${type}) ${field.path}: at most ${max} characters (it has ${max + 1}).`])
    }
  })
})

describe('Amazon\'s documentation examples', () => {
  it('PREMIUM_IMAGE_TEXT and PREMIUM_FOUR_COLUMN_IMAGES pass as one Premium document', () => {
    const doc = docOf(ebc(AMAZON_PREMIUM_IMAGE_TEXT, AMAZON_FOUR_COLUMN_IMAGES))
    expect(doc.tier).toBe('PREMIUM')
    expect(doc.images.map((i) => i.key)).toEqual(['0:image', '1:columns[0].imageColumn.image', '1:columns[1].imageColumn.image', '1:columns[2].imageColumn.image', '1:columns[3].imageColumn.image'])
    expect(doc.images[0]).toEqual({
      key: '0:image', module: 0, path: 'image', slot: { minWidth: 800, minHeight: 600 },
      source: { kind: 'amazon', uploadDestinationId: 'aplus-media/9eb22e6f-e704-43e6-86cd-ff5c30125273.png' },
      altText: 'Descriptive alt text about image', crop: { width: 1440, height: 1080, x: 240, y: 0 },
    })
    // Empty decoratorSets are dropped from the checked modules (Amazon treats them as absent).
    expect(JSON.stringify(doc.modules)).not.toContain('decoratorSet')
  })

  it('the create-edit-publish header example passes (a seller document; the guide\'s own is vendor EMC)', () => {
    const doc = docOf(checkAplusDocument({ name: 'Example content document', contentType: 'EBC', locale: 'en-US', modules: [AMAZON_HEADER_IMAGE_TEXT] }))
    expect(doc.tier).toBe('STANDARD')
    expect(doc.images).toEqual([expect.objectContaining({ key: '0:block.image', slot: { minWidth: 970, minHeight: 600 }, crop: { width: 970, height: 600, x: 7, y: 0 } })])
  })
})

describe('the document\'s rules', () => {
  const text = mod('STANDARD_TEXT', MINIMAL.STANDARD_TEXT)
  const premiumText = mod('PREMIUM_TEXT', MINIMAL.PREMIUM_TEXT)
  const logo = mod('BRAND_STORY_IMAGE_WITH_LOGO', MINIMAL.BRAND_STORY_IMAGE_WITH_LOGO)

  it('refuses Standard and Premium in one document', () => {
    expect(problemsOf(ebc(text, premiumText, text))).toEqual(['A document is all Standard or all Premium: modules 1 and 3 Standard, module 2 Premium.'])
  })

  it('refuses an eighth module, and a Brand Story module in an A+ document', () => {
    expect(problemsOf(ebc(...times(8, () => premiumText)))).toEqual(['The document has 8 modules; a Premium A+ document holds at most 7.'])
    expect(problemsOf(ebc(...times(8, () => text)))).toEqual(['The document has 8 modules; a Standard A+ document holds at most 7.'])
    expect(docOf(ebc(...times(7, () => premiumText))).modules).toHaveLength(7)
    expect(problemsOf(ebc(text, logo))).toEqual(['Brand Story modules (module 2) go in their own Brand Story document (kind brand-story).'])
  })

  it('a Brand Story document has exactly one BRAND_STORY_IMAGE_WITH_LOGO and nothing but Brand Story modules', () => {
    const about = mod('BRAND_STORY_ABOUT', MINIMAL.BRAND_STORY_ABOUT)
    expect(problemsOf(story(about))).toEqual(['A Brand Story document has exactly one BRAND_STORY_IMAGE_WITH_LOGO, its background card; it has none.'])
    expect(problemsOf(story(logo, about, logo))).toEqual(['A Brand Story document has exactly one BRAND_STORY_IMAGE_WITH_LOGO, its background card; it has 2 (modules 1 and 3).'])
    expect(problemsOf(story(logo, text))).toEqual(['A Brand Story document holds Brand Story modules only; module 2 is not.'])
    expect(docOf(story(about, logo)).tier).toBe('BRAND_STORY')
  })

  it('refuses EMC (vendor content), an underscore locale, a missing name and an empty module list', () => {
    expect(problemsOf(checkAplusDocument({ name: 'Vendor', contentType: 'EMC' as 'EBC', locale: 'it-IT', modules: [text] })))
      .toEqual(['contentType EMC is vendor A+ content; Nexus makes seller content only: EBC (A+) or BrandStory (Brand Story).'])
    expect(problemsOf(checkAplusDocument({ name: 'Locale', contentType: 'EBC', locale: 'it_IT', modules: [text] })))
      .toEqual(['The locale is the language and the country with a hyphen, e.g. it-IT (it is "it_IT").'])
    expect(problemsOf(checkAplusDocument({ name: ' ', contentType: 'EBC', locale: 'it-IT', modules: [] })))
      .toEqual(['The document needs a name (1–100 characters).', 'The document needs at least one module.'])
  })

  it('refuses a module object that is not Amazon\'s exact shape', () => {
    expect(problemsOf(ebc({ contentModuleType: 'PREMIUM_DYNAMIC_CAROUSEL', premiumDynamicCarousel: {} })))
      .toEqual(['Module 1: contentModuleType "PREMIUM_DYNAMIC_CAROUSEL" is not an A+ module type (aplus-content view modules lists them).'])
    expect(problemsOf(ebc({ contentModuleType: 'STANDARD_TEXT', body: P('x') }))).toEqual([
      'Module 1 (STANDARD_TEXT) body: not a field of the module object; it holds contentModuleType and standardText only.',
      'Module 1 (STANDARD_TEXT): its content goes under standardText.',
    ])
    expect(problemsOf(ebc('text'))).toEqual(['Module 1: must be an object { contentModuleType, <its content> }.'])
  })
})

describe('module payloads', () => {
  it('an 81-character headline is refused with its module, type, path and length', () => {
    const payload = { ...(MINIMAL.PREMIUM_IMAGE_TEXT as object), headline: T('x'.repeat(81)) }
    expect(problemsOf(ebc(mod('PREMIUM_TEXT', MINIMAL.PREMIUM_TEXT), mod('PREMIUM_IMAGE_TEXT', payload))))
      .toEqual(['Module 2 (PREMIUM_IMAGE_TEXT) headline: at most 80 characters (it has 81).'])
  })

  it('a paragraph\'s limit counts all its lines together, and its line count is checked', () => {
    const bodyText = P('x'.repeat(300), 'y'.repeat(201))
    expect(problemsOf(ebc(mod('PREMIUM_IMAGE_TEXT', { ...(MINIMAL.PREMIUM_IMAGE_TEXT as object), bodyText }))))
      .toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) bodyText: at most 500 characters in all (it has 501).'])
    expect(problemsOf(ebc(mod('PREMIUM_IMAGE_TEXT', { ...(MINIMAL.PREMIUM_IMAGE_TEXT as object), bodyText: P('a', 'b', 'c', 'd', 'e', 'f') }))))
      .toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) bodyText.textList: 1 to 5 lines (it has 6).'])
    // An empty line is said once, by itself; a paragraph of blank lines is empty.
    expect(problemsOf(ebc(mod('STANDARD_TEXT', { body: P('', ' ') })))).toEqual(['Module 1 (STANDARD_TEXT) body.textList[0]: is empty.'])
    expect(problemsOf(ebc(mod('STANDARD_TEXT', { body: P(' ', '  ') })))).toEqual(['Module 1 (STANDARD_TEXT) body: is empty.'])
    expect(problemsOf(ebc(mod('PREMIUM_FAQ', { colorType: 'DARK', faqs: times(2, () => ({ faq: { question: P('One?', 'Two?'), answer: P('A.') } })) }))))
      .toEqual(['Module 1 (PREMIUM_FAQ) faqs[0].faq.question.textList: exactly 1 line (it has 2).', 'Module 1 (PREMIUM_FAQ) faqs[1].faq.question.textList: exactly 1 line (it has 2).'])
  })

  it('list sizes are Amazon\'s (the stricter of the model and the documents)', () => {
    expect(problemsOf(ebc(mod('PREMIUM_FOUR_COLUMN_IMAGES', { columns: times(5, (i) => ({ imageColumn: { position: (i % 4) + 1, image: NEW } })) }))))
      .toEqual(['Module 1 (PREMIUM_FOUR_COLUMN_IMAGES) columns: 3 to 4 items (it has 5).'])
    expect(problemsOf(ebc(mod('PREMIUM_DUAL_IMAGE_TEXT', { columns: [{ imageColumn: { position: 1, image: NEW } }] }))))
      .toEqual(['Module 1 (PREMIUM_DUAL_IMAGE_TEXT) columns: exactly 2 items (it has 1).'])
    // The model allows 3 products in the scroller; Amazon's module documents say 4–7.
    const scroller = MINIMAL.PREMIUM_COMPARISON_SCROLLER as Record<string, any>
    expect(problemsOf(ebc(mod('PREMIUM_COMPARISON_SCROLLER', { ...scroller, comparisonProducts: scroller.comparisonProducts.slice(0, 3) }))))
      .toContain('Module 1 (PREMIUM_COMPARISON_SCROLLER) comparisonProducts: 4 to 7 items (it has 3).')
    expect(problemsOf(ebc(mod('STANDARD_TECH_SPECS', { specificationList: times(3, () => ({ label: T('k'), description: T('v') })) }))))
      .toEqual(['Module 1 (STANDARD_TECH_SPECS) specificationList: 4 to 16 items (it has 3).'])
  })

  it('positions are unique within a list and inside their range', () => {
    const columns = [1, 2, 2].map((position) => ({ imageColumn: { position, image: NEW } }))
    expect(problemsOf(ebc(mod('PREMIUM_FOUR_COLUMN_IMAGES', { columns }))))
      .toEqual(['Module 1 (PREMIUM_FOUR_COLUMN_IMAGES) columns: items 2 and 3 both have position 2; each position is used once.'])
    expect(problemsOf(ebc(mod('PREMIUM_FOUR_COLUMN_IMAGES', { columns: [1, 2, 5].map((position) => ({ imageColumn: { position, image: NEW } })) }))))
      .toEqual(['Module 1 (PREMIUM_FOUR_COLUMN_IMAGES) columns[2].imageColumn.position: must be a whole number 1–4 (it is 5).'])
  })

  it('an unknown key is named by its path, with the fields allowed there', () => {
    expect(problemsOf(ebc(mod('PREMIUM_TEXT', { body: P('x'), description: P('y') }))))
      .toEqual(['Module 1 (PREMIUM_TEXT) body: not a field here (the fields here: description, headline).'])
    const columns = times(3, (i) => ({ imageColumn: { position: i + 1, image: NEW, ...(i === 1 ? { subtitle: T('?') } : {}) } }))
    expect(problemsOf(ebc(mod('PREMIUM_FOUR_COLUMN_IMAGES', { columns }))))
      .toEqual(['Module 1 (PREMIUM_FOUR_COLUMN_IMAGES) columns[1].imageColumn.subtitle: not a field here (the fields here: position, image, headline, description).'])
    // A list item sent without its wrapper.
    expect(problemsOf(ebc(mod('PREMIUM_TECH_SPECS', { headline: T('Specs'), columnCount: 1, techSpecs: times(4, () => ({ specKey: T('k'), specValue: T('v') })) }))))
      .toContain('Module 1 (PREMIUM_TECH_SPECS) techSpecs[0].specKey: not a field here (the fields here: techSpec).')
  })

  it('nulls are dropped before the strict check (Amazon writes absent fields as null)', () => {
    const payload = { ...(MINIMAL.PREMIUM_IMAGE_TEXT as object), subheadline: null, bodyText: null, extra: null }
    const doc = docOf(ebc({ contentModuleType: 'PREMIUM_IMAGE_TEXT', premiumImageText: payload, premiumText: null }))
    expect(doc.modules).toEqual([mod('PREMIUM_IMAGE_TEXT', MINIMAL.PREMIUM_IMAGE_TEXT)])
  })

  it('wrong types, enums and empty texts are said plainly', () => {
    expect(problemsOf(ebc(mod('PREMIUM_IMAGE_TEXT', { ...(MINIMAL.PREMIUM_IMAGE_TEXT as object), positionType: 'TOP', headline: T('  ') })))).toEqual([
      'Module 1 (PREMIUM_IMAGE_TEXT) positionType: must be LEFT or RIGHT (it is "TOP").',
      'Module 1 (PREMIUM_IMAGE_TEXT) headline: is empty.',
    ])
    expect(problemsOf(ebc(mod('PREMIUM_TEXT', { description: 'plain text' }))))
      .toEqual(['Module 1 (PREMIUM_TEXT) description: must be an object (it is "plain text").'])
  })
})

describe('images and videos', () => {
  const image = (position: unknown) => ebc(mod('PREMIUM_IMAGE_TEXT', { ...(MINIMAL.PREMIUM_IMAGE_TEXT as object), image: position }))

  it('an image takes exactly one source', () => {
    expect(problemsOf(image({ altText: 'No source' })))
      .toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) image: needs one source: uploadDestinationId (an image already at Amazon, with its imageCropSpecification), assetId (a photo from image-library) or url (an https link to a JPEG or PNG).'])
    expect(problemsOf(image({ ...NEW, url: LINK.url }))).toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) image: takes one source, not assetId and url.'])
    expect(problemsOf(image({ url: 'http://photos.example.test/a.jpg', altText: 'x' }))).toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) image.url: must be an https:// link.'])
    expect(problemsOf(image({ assetId: 'photo1', altText: 'x' }))).toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) image.assetId: must be a photo id from image-library, da_… or pi_… (it is "photo1").'])
    expect(problemsOf(image({ assetId: 'pi_1' }))).toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) image.altText: is required.'])
  })

  it('an image already at Amazon needs its crop, at least the slot', () => {
    expect(problemsOf(image({ uploadDestinationId: 'aplus-media/a.png', altText: 'x' })))
      .toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) image.imageCropSpecification: is required with uploadDestinationId (keep the one aplus-content view document shows).'])
    expect(problemsOf(image(AT_AMAZON(640, 480))))
      .toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) image.imageCropSpecification: the crop is 640×480; Amazon needs at least 800×600.'])
    expect(problemsOf(image({ ...AT_AMAZON(800, 600), imageCropSpecification: { size: { width: { value: 800, units: 'px' }, height: px(600) } } })))
      .toEqual(['Module 1 (PREMIUM_IMAGE_TEXT) image.imageCropSpecification.size.width.units: must be pixels (it is "px").'])
  })

  it('lists every image position with its slot, source and given crop; counts videos; collects named ASINs', () => {
    const doc = docOf(ebc(
      mod('PREMIUM_FULL_BACKGROUND_TEXT', { ...(MINIMAL.PREMIUM_FULL_BACKGROUND_TEXT as object), desktopImage: { ...NEW, imageCropSpecification: crop(1464, 600, 10, 20) } }),
      mod('PREMIUM_VIDEO_IMAGE_CAROUSEL', MINIMAL.PREMIUM_VIDEO_IMAGE_CAROUSEL),
      mod('PREMIUM_THREE_COLUMN_COMPARISON', MINIMAL.PREMIUM_THREE_COLUMN_COMPARISON),
    ))
    expect(doc.images.slice(0, 2)).toEqual([
      { key: '0:desktopImage', module: 0, path: 'desktopImage', slot: { minWidth: 1464, minHeight: 600 }, source: { kind: 'asset', assetId: 'da_photo1' }, altText: 'A new photo', crop: { width: 1464, height: 600, x: 10, y: 20 } },
      { key: '0:mobileImage', module: 0, path: 'mobileImage', slot: { minWidth: 600, minHeight: 450 }, source: { kind: 'url', url: LINK.url }, altText: 'A linked photo', crop: null },
    ])
    expect(doc.images.map((i) => i.key)).toContain('1:carouselCards[1].videoCarouselPanel.desktopImage')
    expect(doc.images.map((i) => i.key)).toContain('2:comparisonProducts[2].image')
    expect(doc.videos).toBe(1)
    expect(doc.asins).toEqual(['B000000001', 'B000000002', 'B000000003'])
  })

  it('a video goes in only as already at Amazon', () => {
    expect(problemsOf(ebc(mod('PREMIUM_HERO_VIDEO', { heroVideo: { url: 'https://videos.example.test/a.mp4' } })))).toEqual([
      'Module 1 (PREMIUM_HERO_VIDEO) heroVideo.videoMediaId: is required.',
      'Module 1 (PREMIUM_HERO_VIDEO) heroVideo.imageMediaId: is required.',
      'Module 1 (PREMIUM_HERO_VIDEO) heroVideo.imageCropSpecification: is required.',
      'Module 1 (PREMIUM_HERO_VIDEO) heroVideo.url: not a field here (the fields here: videoMediaId, imageMediaId, imageCropSpecification).',
    ])
  })
})

describe('rules across fields', () => {
  it('hotspot markers sit inside the image and at least 95 px apart', () => {
    const spots = (points: Array<[string, string]>) => ({ desktopImage: NEW, hotSpots: points.map(([x, y], i) => ({ imageHotSpot: { title: T(`Spot ${i}`), xCoordinate: T(x), yCoordinate: T(y), mobileImage: NEW } })) })
    expect(problemsOf(ebc(mod('PREMIUM_HOTSPOT_IMAGE', spots([['100', '100'], ['160', '150']])))))
      .toEqual(['Module 1 (PREMIUM_HOTSPOT_IMAGE) hotSpots[1]: the marker is 78 px from hotSpots[0]; markers sit at least 95 px apart.'])
    expect(problemsOf(ebc(mod('PREMIUM_HOTSPOT_IMAGE', spots([['10', '100'], ['400', '25.5']]))))).toEqual([
      'Module 1 (PREMIUM_HOTSPOT_IMAGE) hotSpots[0].imageHotSpot.xCoordinate: value must be a whole number of pixels as text, 23–1441 (it is "10").',
      'Module 1 (PREMIUM_HOTSPOT_IMAGE) hotSpots[1].imageHotSpot.yCoordinate: value must be a whole number of pixels as text, 23–577 (it is "25.5").',
    ])
  })

  it('a comparison row has one field per product, at the products\' positions; a checkbox says true or false', () => {
    const carousel = structuredClone(MINIMAL.PREMIUM_COMPARISON_CAROUSEL) as Record<string, any>
    carousel.comparisonMetrics[0].comparisonRow.comparisonFields.pop()
    carousel.comparisonMetrics[1].comparisonRow.comparisonFields[2].comparisonField.position = 4
    carousel.comparisonMetrics[2].comparisonRow.comparisonFields[0].comparisonField.value = 'yes'
    expect(problemsOf(ebc(mod('PREMIUM_COMPARISON_CAROUSEL', carousel)))).toEqual([
      'Module 1 (PREMIUM_COMPARISON_CAROUSEL) comparisonMetrics[0].comparisonRow.comparisonFields: 3 to 5 items (it has 2).',
    ])
    carousel.comparisonMetrics[0].comparisonRow.comparisonFields.push({ comparisonField: { position: 3, value: 'false' } })
    expect(problemsOf(ebc(mod('PREMIUM_COMPARISON_CAROUSEL', carousel)))).toEqual([
      'Module 1 (PREMIUM_COMPARISON_CAROUSEL) comparisonMetrics[1].comparisonRow.comparisonFields: the field positions are the products\' positions (1, 2, 3); they are 1, 2, 4.',
      'Module 1 (PREMIUM_COMPARISON_CAROUSEL) comparisonMetrics[2].comparisonRow.comparisonFields[0].comparisonField.value: a checkbox row says "true" or "false" (it is "yes").',
    ])
    // The carousel's rows take no additionalInfo (the scroller's do).
    const withInfo = structuredClone(MINIMAL.PREMIUM_COMPARISON_CAROUSEL) as Record<string, any>
    withInfo.comparisonMetrics[0].comparisonRow.additionalInfo = T('Note')
    expect(problemsOf(ebc(mod('PREMIUM_COMPARISON_CAROUSEL', withInfo)))[0]).toMatch(/comparisonMetrics\[0\]\.comparisonRow\.additionalInfo: not a field here/)
  })

  it('a carousel button needs its ASIN; a video panel shows a video or two images', () => {
    const cards = structuredClone(MINIMAL.PREMIUM_IMAGE_CAROUSEL) as Record<string, any>
    delete cards.carouselCards[1].imagePanel.asin
    expect(problemsOf(ebc(mod('PREMIUM_IMAGE_CAROUSEL', cards))))
      .toEqual(['Module 1 (PREMIUM_IMAGE_CAROUSEL) carouselCards[1].imagePanel.buttonText: is shown only with asin; give the asin it links to or leave buttonText out.'])
    const panels = structuredClone(MINIMAL.PREMIUM_VIDEO_IMAGE_CAROUSEL) as Record<string, any>
    panels.carouselCards[0].videoCarouselPanel.desktopImage = NEW
    delete panels.carouselCards[1].videoCarouselPanel.mobileImage
    expect(problemsOf(ebc(mod('PREMIUM_VIDEO_IMAGE_CAROUSEL', panels)))).toEqual([
      'Module 1 (PREMIUM_VIDEO_IMAGE_CAROUSEL) carouselCards[0].videoCarouselPanel: a panel shows a video or its two images, not both.',
      'Module 1 (PREMIUM_VIDEO_IMAGE_CAROUSEL) carouselCards[1].videoCarouselPanel: a panel needs a video (already at Amazon) or both desktopImage and mobileImage.',
    ])
  })

  it('an ASIN is 10 capital letters and digits', () => {
    const table = { productColumns: [{ position: 1, asin: 'b0001' }] }
    expect(problemsOf(ebc(mod('STANDARD_COMPARISON_TABLE', table))))
      .toEqual(['Module 1 (STANDARD_COMPARISON_TABLE) productColumns[0].asin: must be an ASIN, 10 capital letters and digits (it is "b0001").'])
  })
})

describe('normalising, hashing and summarising', () => {
  const document = (modules: AplusModule[]): AplusDocument => ({ name: 'Doc', contentType: 'EBC', locale: 'it-IT', contentModuleList: modules })

  it('drops nulls at every depth and empty decoratorSets, nothing else', () => {
    const doc = document([{ contentModuleType: 'STANDARD_TEXT', standardText: { headline: null, body: { textList: [{ value: 'A', decoratorSet: [] }, { value: 'B', decoratorSet: [{ type: 'STYLE_BOLD', offset: 0, length: 1 }] }] } }, standardCompanyLogo: null }])
    expect(normalizeAmazonDocument(doc)).toEqual(document([{ contentModuleType: 'STANDARD_TEXT', standardText: { body: { textList: [{ value: 'A' }, { value: 'B', decoratorSet: [{ type: 'STYLE_BOLD', offset: 0, length: 1 }] }] } } }]))
  })

  it('documentHash is stable across key order, nulls and decoratorSet [] versus absent; it changes with the text', () => {
    const a = document([{ contentModuleType: 'STANDARD_TEXT', standardText: { headline: { value: 'H', decoratorSet: [] }, body: { textList: [{ value: 'Text' }] } } }])
    const b: AplusDocument = { contentModuleList: [{ standardText: { body: { textList: [{ value: 'Text', decoratorSet: [] }] }, headline: { value: 'H' } }, contentModuleType: 'STANDARD_TEXT', standardCompanyLogo: null }], locale: 'it-IT', contentType: 'EBC', name: 'Doc' }
    expect(documentHash(a)).toBe(documentHash(b))
    expect(documentHash(a)).toMatch(/^[0-9a-f]{16}$/)
    expect(documentHash(document([{ contentModuleType: 'STANDARD_TEXT', standardText: { body: { textList: [{ value: 'Other' }] } } }]))).not.toBe(documentHash(a))
  })

  it('summarizes each module: headline (else title, else its first text), images, characters', () => {
    const modules = [AMAZON_PREMIUM_IMAGE_TEXT, AMAZON_FOUR_COLUMN_IMAGES, mod('BRAND_STORY_ABOUT', { logoImage: NEW, title: T('Our story') }), mod('PREMIUM_FAQ', MINIMAL.PREMIUM_FAQ)] as AplusModule[]
    const summary = summarizeModules(modules)
    expect(summary.map(({ position, type, headline, images }) => ({ position, type, headline, images }))).toEqual([
      { position: 1, type: 'PREMIUM_IMAGE_TEXT', headline: "Dogs' Loyalty: The Science Behind Our Most Devoted Companions", images: 1 },
      { position: 2, type: 'PREMIUM_FOUR_COLUMN_IMAGES', headline: 'Collect all the dogs, gift them to your friends and neighbors!', images: 4 },
      { position: 3, type: 'BRAND_STORY_ABOUT', headline: 'Our story', images: 1 },
      { position: 4, type: 'PREMIUM_FAQ', headline: 'Question 0?', images: 0 },
    ])
    expect(summary[0].textChars).toBe(25 + 61 + 496)
  })

  it('the guide gives each field its path, kind, whether it is required and its rule', () => {
    const [guide] = aplusModuleGuide('PREMIUM_FOUR_COLUMN_IMAGES')
    expect(guide.fields).toEqual([
      { path: 'headline', kind: 'text', required: false, rule: '{ value }, at most 80 characters' },
      { path: 'columns', kind: 'list', required: true, rule: '3 to 4 items, each { imageColumn: {…} }; each position used once' },
      { path: 'columns[].imageColumn.position', kind: 'number', required: true, rule: 'a whole number 1–4' },
      { path: 'columns[].imageColumn.image', kind: 'image', required: true, rule: 'an image, at least 300×225 px (cropped to that shape)' },
      { path: 'columns[].imageColumn.headline', kind: 'text', required: false, rule: '{ value }, at most 30 characters' },
      { path: 'columns[].imageColumn.description', kind: 'paragraph', required: false, rule: '{ textList: [{ value }] }, 1 to 5 lines, at most 150 characters in all' },
    ])
    expect(aplusModuleGuide('STANDARD_COMPARISON_TABLE')[0].fields).toContainEqual({ path: 'metricRowLabels[]', kind: 'plain', required: true, rule: '{ position 1–100, value of at most 100 characters }' })
  })
})
