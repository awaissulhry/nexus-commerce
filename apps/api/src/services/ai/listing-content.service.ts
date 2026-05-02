/**
 * Phase 5.5: Amazon-listing content generation via Gemini Flash.
 *
 * Single entry point — `generate({ product, marketplace, fields, variant })`.
 * Each requested field has its own prompt builder + JSON-shape contract;
 * we run the requested generators in parallel and return a partial
 * response keyed by field name. Temperature is bumped per `variant`
 * so repeated regenerations produce noticeably different output.
 */

import type { GenerativeModel } from '@google/generative-ai'
import { GeminiService } from './gemini.service.js'

const FLASH_MODEL = 'gemini-1.5-flash'

const LANGUAGE_FOR_MARKETPLACE: Record<string, string> = {
  IT: 'Italian',
  DE: 'German',
  FR: 'French',
  ES: 'Spanish',
  UK: 'British English (use UK spellings — colour, organise, …)',
  US: 'American English',
  NL: 'Dutch',
  SE: 'Swedish',
  PL: 'Polish',
  CA: 'Canadian English',
  MX: 'Mexican Spanish',
}

export type ContentField = 'title' | 'bullets' | 'description' | 'keywords'

export interface ProductContext {
  id: string
  sku: string
  name: string
  brand: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
  weightValue: number | null
  weightUnit: string | null
  dimLength: number | null
  dimWidth: number | null
  dimHeight: number | null
  dimUnit: string | null
  productType: string | null
  variantAttributes: unknown
  categoryAttributes: unknown
}

export interface TerminologyEntry {
  preferred: string
  avoid: string[]
  context: string | null
}

export interface GenerationParams {
  product: ProductContext
  marketplace: string
  fields: ContentField[]
  /** 0–4. Higher values nudge temperature so regenerations yield
   *  visibly different copy. */
  variant?: number
  /** Per-brand / per-marketplace terminology to inject into every
   *  prompt. Fetched by the route from TerminologyPreference. */
  terminology?: TerminologyEntry[]
}

export interface TitleResult {
  content: string
  charCount: number
  insights: string[]
}

export interface BulletsResult {
  content: string[]
  charCounts: number[]
  insights: string[]
}

export interface DescriptionResult {
  content: string
  preview: string
  insights: string[]
}

export interface KeywordsResult {
  content: string
  charCount: number
  insights: string[]
}

export interface GenerationResult {
  title?: TitleResult
  bullets?: BulletsResult
  description?: DescriptionResult
  keywords?: KeywordsResult
  metadata: {
    productSku: string
    marketplace: string
    language: string
    model: string
    elapsedMs: number
    generatedAt: string
  }
}

export class ListingContentService {
  constructor(private gemini: GeminiService) {}

  isConfigured(): boolean {
    return this.gemini.isConfigured()
  }

  async generate(params: GenerationParams): Promise<GenerationResult> {
    const language =
      LANGUAGE_FOR_MARKETPLACE[params.marketplace.toUpperCase()] ?? 'English'

    const start = Date.now()
    const model = (this.gemini as any)
      .getClient()
      .getGenerativeModel({ model: FLASH_MODEL })

    const tasks: Array<Promise<[ContentField, unknown]>> = []
    for (const f of params.fields) {
      if (f === 'title') {
        tasks.push(
          this.runOne(model, this.titlePrompt(params, language), params.variant).then(
            (raw) => ['title', this.parseTitle(raw)] as [ContentField, TitleResult],
          ),
        )
      } else if (f === 'bullets') {
        tasks.push(
          this.runOne(model, this.bulletsPrompt(params, language), params.variant, 0.05).then(
            (raw) =>
              ['bullets', this.parseBullets(raw)] as [ContentField, BulletsResult],
          ),
        )
      } else if (f === 'description') {
        tasks.push(
          this.runOne(model, this.descriptionPrompt(params, language), params.variant).then(
            (raw) =>
              ['description', this.parseDescription(raw)] as [ContentField, DescriptionResult],
          ),
        )
      } else if (f === 'keywords') {
        tasks.push(
          this.runOne(model, this.keywordsPrompt(params, language), params.variant).then(
            (raw) =>
              ['keywords', this.parseKeywords(raw)] as [ContentField, KeywordsResult],
          ),
        )
      }
    }

    const settled = await Promise.all(tasks)
    const result: GenerationResult = {
      metadata: {
        productSku: params.product.sku,
        marketplace: params.marketplace,
        language,
        model: FLASH_MODEL,
        elapsedMs: Date.now() - start,
        generatedAt: new Date().toISOString(),
      },
    }
    for (const [field, value] of settled) {
      ;(result as any)[field] = value
    }
    return result
  }

  // ── Prompt builders ────────────────────────────────────────────

  /**
   * P0 #27: brand terminology block. Returns a "STRICTLY FOLLOW"
   * preferences section if any preferences are configured, or an
   * empty string if none. Goes into every prompt before the JSON
   * return contract.
   */
  private terminologyBlock(entries: TerminologyEntry[] | undefined): string {
    if (!entries || entries.length === 0) return ''
    const lines = entries.map((e) => {
      const ctx = e.context ? ` (${e.context})` : ''
      if (!e.avoid || e.avoid.length === 0) {
        return `- Use "${e.preferred}"${ctx}.`
      }
      return `- Use "${e.preferred}" instead of: ${e.avoid
        .map((a) => `"${a}"`)
        .join(', ')}${ctx}.`
    })
    return `\n\nTerminology preferences (STRICTLY FOLLOW — do not substitute synonyms):\n${lines.join('\n')}`
  }

  private contextBlock(product: ProductContext): string {
    const lines: string[] = []
    lines.push(`- Name: ${product.name}`)
    if (product.brand) lines.push(`- Brand: ${product.brand}`)
    if (product.description) {
      lines.push(`- Existing description: ${truncate(product.description, 600)}`)
    }
    if (product.bulletPoints.length > 0) {
      lines.push(
        `- Existing bullets: ${product.bulletPoints
          .map((b, i) => `(${i + 1}) ${truncate(b, 200)}`)
          .join(' ')}`,
      )
    }
    if (product.keywords.length > 0) {
      lines.push(`- Existing keywords: ${product.keywords.join(', ')}`)
    }
    if (product.productType) {
      lines.push(`- Amazon product type: ${product.productType}`)
    }
    if (product.weightValue != null) {
      lines.push(
        `- Weight: ${product.weightValue} ${product.weightUnit ?? ''}`.trim(),
      )
    }
    if (
      product.dimLength != null ||
      product.dimWidth != null ||
      product.dimHeight != null
    ) {
      const dims = [product.dimLength, product.dimWidth, product.dimHeight]
        .map((v) => (v == null ? '?' : String(v)))
        .join('×')
      lines.push(`- Dimensions (L×W×H): ${dims} ${product.dimUnit ?? ''}`.trim())
    }
    if (product.categoryAttributes && typeof product.categoryAttributes === 'object') {
      const flat = flattenAttrs(product.categoryAttributes as Record<string, unknown>)
      if (flat) lines.push(`- Category attributes: ${flat}`)
    }
    if (product.variantAttributes && typeof product.variantAttributes === 'object') {
      const flat = flattenAttrs(product.variantAttributes as Record<string, unknown>)
      if (flat) lines.push(`- Variation: ${flat}`)
    }
    return lines.join('\n')
  }

  private titlePrompt(params: GenerationParams, language: string): string {
    return `You are an Amazon SEO expert. Generate ONE optimised product title for Amazon ${params.marketplace}.

Product:
${this.contextBlock(params.product)}

Requirements:
- HARD MAX 200 characters
- Brand name at the start
- Include product type, the primary benefit, and one or two key features
- Add variation details (size, colour, material) at the end if applicable
- Natural language — no keyword stuffing, no SHOUTING CAPS, no emojis
- Optimised for ${params.marketplace} customer search behaviour
- Write in ${language}${this.terminologyBlock(params.terminology)}

Return JSON only — no markdown, no commentary, no surrounding text:
{
  "content": "the title",
  "charCount": <number — count UTF-16 code units, must match content.length>,
  "insights": [
    "Short bullet noting why this title works",
    "Another short bullet",
    "..."
  ]
}`
  }

  private bulletsPrompt(params: GenerationParams, language: string): string {
    return `You are an Amazon SEO expert. Generate exactly 5 bullet points for Amazon ${params.marketplace}.

Product:
${this.contextBlock(params.product)}

Per-bullet requirements:
- Length: 200–500 characters
- Start with [BENEFIT_HEADER] in ALL CAPS inside square brackets
- Then explain the benefit in natural language
- Active voice, customer-benefit focus (not feature dumps)
- Naturally include searchable keywords; no keyword stuffing
- No emojis, no excessive punctuation, no SHOUTING outside the header
- Write in ${language}${this.terminologyBlock(params.terminology)}

Bullet themes (one per bullet, in this order):
1. Premium quality, protection, or safety
2. Comfort, fit, or wearability
3. Versatility or use cases
4. Materials or construction quality
5. Brand confidence, warranty, or buyer reassurance

Return JSON only:
{
  "content": ["bullet 1", "bullet 2", "bullet 3", "bullet 4", "bullet 5"],
  "charCounts": [n1, n2, n3, n4, n5],
  "insights": ["why these bullets work, 2–4 short notes"]
}`
  }

  private descriptionPrompt(params: GenerationParams, language: string): string {
    return `You are an Amazon listing copywriter. Generate the long product description as Amazon-safe HTML for marketplace ${params.marketplace}.

Product:
${this.contextBlock(params.product)}

Format:
- Sections in this order, each with its own <h3>:
  1. Brand story (2–3 sentences)
  2. Key features (use <ul><li>, 4–6 items)
  3. Specifications (a simple <ul><li> list of label: value pairs)
  4. Use cases (one paragraph)
  5. Care instructions (one short paragraph; omit if not applicable)

HTML constraints (Amazon's Listing API restrictions):
- ONLY these tags: <h3>, <p>, <ul>, <li>, <strong>, <em>, <br>
- No inline styles, no class attributes, no other tags
- No <html>, <head>, <body>, <div>
- Total length 1000–2500 characters of HTML
- Write in ${language}${this.terminologyBlock(params.terminology)}

Return JSON only:
{
  "content": "<h3>...</h3><p>...</p>...",
  "preview": "first ~200 plain-text characters with all HTML stripped",
  "insights": ["why this description works, 2–4 short notes"]
}`
  }

  private keywordsPrompt(params: GenerationParams, language: string): string {
    return `Generate Amazon backend search terms for marketplace ${params.marketplace}.

Product:
${this.contextBlock(params.product)}

Hard requirements:
- HARD MAX 250 characters total
- Space-separated keywords
- NO commas, NO punctuation between terms, NO duplicate words
- Do NOT repeat words already in the product title (Amazon ignores those)
- Mix ${language} + English where it makes sense (catches both audiences)
- Include synonyms, common misspellings, and use-case phrases (e.g. "summer riding")
- Include compatible items where relevant (e.g. for jackets: "helmet pants gloves")${this.terminologyBlock(params.terminology)}

Return JSON only:
{
  "content": "keyword1 keyword2 keyword3 ...",
  "charCount": <number — must equal content.length>,
  "insights": ["why these keywords work, 2–4 short notes"]
}`
  }

  // ── Run + parse ────────────────────────────────────────────────

  private async runOne(
    model: GenerativeModel,
    prompt: string,
    variant: number = 0,
    extraTemperatureBump: number = 0,
  ): Promise<string> {
    // Base 0.6 + variant bump; bullets get a slightly higher base so
    // repeats feel meaningfully different.
    const temperature = Math.min(
      1.0,
      0.6 + variant * 0.07 + extraTemperatureBump,
    )
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        responseMimeType: 'application/json',
      },
    })
    return response.response.text()
  }

  private parseJson<T>(raw: string, field: string): T {
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()
    try {
      return JSON.parse(cleaned) as T
    } catch (e: any) {
      throw new Error(
        `Gemini returned invalid JSON for ${field}: ${e?.message ?? String(e)}`,
      )
    }
  }

  private parseTitle(raw: string): TitleResult {
    const j = this.parseJson<{ content?: string; insights?: string[] }>(
      raw,
      'title',
    )
    const content = (j.content ?? '').trim()
    return {
      content,
      charCount: content.length,
      insights: Array.isArray(j.insights) ? j.insights.slice(0, 6) : [],
    }
  }

  private parseBullets(raw: string): BulletsResult {
    const j = this.parseJson<{ content?: string[]; insights?: string[] }>(
      raw,
      'bullets',
    )
    const content = Array.isArray(j.content)
      ? j.content.slice(0, 5).map((s) => String(s).trim())
      : []
    return {
      content,
      charCounts: content.map((s) => s.length),
      insights: Array.isArray(j.insights) ? j.insights.slice(0, 6) : [],
    }
  }

  private parseDescription(raw: string): DescriptionResult {
    const j = this.parseJson<{
      content?: string
      preview?: string
      insights?: string[]
    }>(raw, 'description')
    const content = (j.content ?? '').trim()
    const preview =
      j.preview ?? content.replace(/<[^>]+>/g, '').slice(0, 240).trim()
    return {
      content,
      preview,
      insights: Array.isArray(j.insights) ? j.insights.slice(0, 6) : [],
    }
  }

  private parseKeywords(raw: string): KeywordsResult {
    const j = this.parseJson<{ content?: string; insights?: string[] }>(
      raw,
      'keywords',
    )
    const content = (j.content ?? '').trim()
    return {
      content,
      charCount: content.length,
      insights: Array.isArray(j.insights) ? j.insights.slice(0, 6) : [],
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '…'
}

function flattenAttrs(obj: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue
    if (typeof v === 'object') {
      const inner = flattenAttrs(v as Record<string, unknown>)
      if (inner) parts.push(`${k}{${inner}}`)
    } else {
      parts.push(`${k}=${String(v)}`)
    }
  }
  return parts.join(', ')
}
