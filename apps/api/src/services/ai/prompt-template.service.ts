/**
 * AI-2.2 (list-wizard) — PromptTemplate service.
 *
 * Reads / writes the PromptTemplate table introduced in AI-2.1. v1
 * scope:
 *   findActive(feature, scope?)   — matcher used by AI-2.3 to swap
 *                                    inline prompts for DB-backed
 *                                    bodies. Returns null today
 *                                    because the seed lands every
 *                                    row as DRAFT (operator must
 *                                    promote via the admin UI in
 *                                    AI-2.5).
 *   listAll(feature?, status?)   — admin / route surface
 *   seedDefaults(prisma)         — idempotent upsert of the four
 *                                    Step 5 attribute prompts that
 *                                    listing-content.service.ts
 *                                    currently inlines. Captures the
 *                                    prompt frames with {placeholder}
 *                                    markers; the renderer in AI-2.3
 *                                    substitutes contextBlock /
 *                                    terminologyBlock / marketplace /
 *                                    language at call time.
 *
 * Why DRAFT-seed: shipping the rows as ACTIVE and re-routing the
 * existing inline prompt path through the renderer in one commit
 * would mean a regression risk on real Italian operator AI calls.
 * DRAFT keeps existing inline behaviour live; AI-2.5's admin UI
 * lets operators promote when they're ready to A/B.
 */

import type { PrismaClient } from '@nexus/database'
import { logger } from '../../utils/logger.js'

export type PromptTemplateStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED'

export interface PromptTemplateRow {
  id: string
  feature: string
  name: string
  description: string | null
  body: string
  status: string
  version: number
  language: string | null
  marketplace: string | null
  callCount: number
  lastUsedAt: Date | null
  createdAt: Date
  updatedAt: Date
  createdBy: string | null
}

export interface PromptScope {
  language?: string | null
  marketplace?: string | null
  /** AB.3 — stable seed for A/B variant assignment. When set and a
   *  tier has 2+ ACTIVE rows, the matcher hashes this seed and picks
   *  deterministically instead of Math.random. Same seed → same
   *  variant across calls. Pass productId or wizardId. Without a
   *  seed, the matcher falls back to even random split. */
  stableSeed?: string | null
}

/**
 * Resolve the most-specific ACTIVE PromptTemplate for a feature +
 * scope, WITHOUT side-effects. Used by both findActivePromptTemplate
 * (which adds PR.3 callCount telemetry on top) and the AET.1 record-
 * edit helper (which needs the same template the generation call
 * landed on, but must NOT double-count it as a fresh call).
 */
async function matchPromptTemplate(
  prisma: PrismaClient,
  feature: string,
  scope: PromptScope,
): Promise<PromptTemplateRow | null> {
  const language = scope.language?.toLowerCase() ?? null
  const marketplace = scope.marketplace?.toUpperCase() ?? null
  const rows = await prisma.promptTemplate.findMany({
    where: { feature, status: 'ACTIVE' },
    orderBy: [{ updatedAt: 'desc' }],
  })
  if (rows.length === 0) return null
  const exactRows = rows.filter(
    (r) =>
      r.language?.toLowerCase() === language &&
      r.marketplace?.toUpperCase() === marketplace,
  )
  const langOnlyRows = rows.filter(
    (r) => r.language?.toLowerCase() === language && r.marketplace == null,
  )
  const marketOnlyRows = rows.filter(
    (r) => r.language == null && r.marketplace?.toUpperCase() === marketplace,
  )
  const globalRows = rows.filter(
    (r) => r.language == null && r.marketplace == null,
  )
  const seed = scope.stableSeed?.trim() || null
  const pickFromTier = <T,>(tier: T[]): T | undefined => {
    if (tier.length === 0) return undefined
    if (tier.length === 1) return tier[0]
    if (seed) {
      let h = 5381
      for (let i = 0; i < seed.length; i += 1) {
        h = ((h << 5) + h + seed.charCodeAt(i)) | 0
      }
      return tier[Math.abs(h) % tier.length]
    }
    return tier[Math.floor(Math.random() * tier.length)]
  }
  const picked =
    pickFromTier(exactRows) ??
    pickFromTier(langOnlyRows) ??
    pickFromTier(marketOnlyRows) ??
    pickFromTier(globalRows) ??
    null
  return (picked as PromptTemplateRow | null) ?? null
}

/**
 * Resolve the most-specific ACTIVE PromptTemplate for a feature +
 * scope. Preference order:
 *   1. exact (language + marketplace) match
 *   2. language-only match
 *   3. marketplace-only match
 *   4. global (both null)
 * Returns null when nothing matches — caller falls back to inline.
 *
 * Side-effect: increments callCount + lastUsedAt on the matched row
 * (PR.3). Use matchPromptTemplate directly when you need the result
 * without the increment (AET.1 re-derivation).
 */
export async function findActivePromptTemplate(
  prisma: PrismaClient,
  feature: string,
  scope: PromptScope = {},
): Promise<PromptTemplateRow | null> {
  try {
    const picked = await matchPromptTemplate(prisma, feature, scope)
    if (picked === null) return null

    // PR.3 — increment usage telemetry on the picked row. Fire-and-
    // forget: the AI call is already running, the operator is
    // waiting on the response, so we don't make them wait on a DB
    // round-trip. Failures swallowed (the matcher's job is matching;
    // counter drift is a tolerable cost vs blocking generation).
    void prisma.promptTemplate
      .update({
        where: { id: picked.id },
        data: {
          callCount: { increment: 1 },
          lastUsedAt: new Date(),
        },
      })
      .catch((err) => {
        logger.warn(
          'prompt-template-service: usage telemetry update failed',
          { err: err instanceof Error ? err.message : String(err), id: picked.id },
        )
      })

    return picked
  } catch (err) {
    logger.warn('prompt-template-service: findActive failed (returning null)', {
      err: err instanceof Error ? err.message : String(err),
      feature,
    })
    return null
  }
}

/**
 * AET.1 — record an operator's accept-or-edit decision on AI-generated
 * content. Caller supplies the same scope they generated under
 * (feature + language + marketplace + stableSeed); the matcher re-
 * derives which template was used (deterministic via AB.3 stickiness)
 * and increments acceptedCount / editedCount + totalEditChars.
 *
 * Levenshtein distance via a dynamic-programming row swap. Capped at
 * MAX_LEN inputs (8 KB each) to keep wall time bounded — beyond that
 * the operator clearly did substantial rewriting and the actual
 * distance number stops being useful past O(thousands).
 *
 * Best-effort: failures swallow + return null. The save the operator
 * just did is already committed; counter drift is acceptable.
 */
const MAX_LEN_FOR_DISTANCE = 8 * 1024
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  // Hard cap inputs so an enormous description doesn't burn a CPU
  // tick. Operators editing >8KB strings get an upper-bound estimate
  // (counts the cap-truncated diff). Editing anywhere near this size
  // already classifies as "edited", which is the only outcome that
  // matters for the counter.
  const ax = a.length > MAX_LEN_FOR_DISTANCE ? a.slice(0, MAX_LEN_FOR_DISTANCE) : a
  const bx = b.length > MAX_LEN_FOR_DISTANCE ? b.slice(0, MAX_LEN_FOR_DISTANCE) : b
  const m = ax.length
  const n = bx.length
  let prev = new Array<number>(n + 1)
  let curr = new Array<number>(n + 1)
  for (let j = 0; j <= n; j += 1) prev[j] = j
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i
    for (let j = 1; j <= n; j += 1) {
      const cost = ax.charCodeAt(i - 1) === bx.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost,
      )
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[n]
}

export interface RecordEditInput {
  feature: string
  scope?: PromptScope
  aiText: string
  finalText: string
}
export interface RecordEditResult {
  templateId: string | null
  acceptedAsIs: boolean
  editDistance: number
}
export async function recordPromptTemplateEdit(
  prisma: PrismaClient,
  input: RecordEditInput,
): Promise<RecordEditResult | null> {
  try {
    // matchPromptTemplate (not findActivePromptTemplate) — recordEdit
    // must NOT increment callCount; the generation that produced
    // aiText already did (PR.3).
    const picked = await matchPromptTemplate(
      prisma,
      input.feature,
      input.scope ?? {},
    )
    const acceptedAsIs = input.aiText === input.finalText
    const editDistance = acceptedAsIs
      ? 0
      : levenshtein(input.aiText, input.finalText)
    if (!picked) {
      // No DB-backed template was used (caller fell through to the
      // inline static prompt). Don't increment anything; just report
      // the decision back so the caller can store it elsewhere if it
      // wants.
      return { templateId: null, acceptedAsIs, editDistance }
    }
    if (acceptedAsIs) {
      await prisma.promptTemplate.update({
        where: { id: picked.id },
        data: { acceptedCount: { increment: 1 } },
      })
    } else {
      await prisma.promptTemplate.update({
        where: { id: picked.id },
        data: {
          editedCount: { increment: 1 },
          totalEditChars: { increment: editDistance },
        },
      })
    }
    return { templateId: picked.id, acceptedAsIs, editDistance }
  } catch (err) {
    logger.warn('prompt-template-service: recordEdit failed', {
      err: err instanceof Error ? err.message : String(err),
      feature: input.feature,
    })
    return null
  }
}

/**
 * Enumerate templates for the admin surface. Optional filters keep
 * the read narrow when the table grows. Capped at 200 rows so a
 * runaway A/B-fork doesn't drown the UI.
 */
export async function listPromptTemplates(
  prisma: PrismaClient,
  filter: { feature?: string; status?: PromptTemplateStatus } = {},
): Promise<PromptTemplateRow[]> {
  const where: { feature?: string; status?: string } = {}
  if (filter.feature) where.feature = filter.feature
  if (filter.status) where.status = filter.status
  const rows = await prisma.promptTemplate.findMany({
    where,
    orderBy: [
      { feature: 'asc' },
      { name: 'asc' },
      { version: 'desc' },
    ],
    take: 200,
  })
  return rows as PromptTemplateRow[]
}

// ── Seed bodies ────────────────────────────────────────────────────
// These mirror the structural framing of the prompts in
// apps/api/src/services/ai/listing-content.service.ts but use
// {placeholder} markers in place of the dynamic method calls.
// The renderer in AI-2.3 will substitute:
//   {marketplace}      — params.marketplace
//   {language}         — LANGUAGE_FOR_MARKETPLACE[marketplace] resolution
//   {contextBlock}     — formatted product context (name / brand / desc / ...)
//   {terminologyBlock} — brand terminology preferences (P0 #27)
//
// Bodies stay static — operators editing them won't accidentally
// break interpolation as long as they don't rename the placeholder
// markers. The renderer ignores unknown markers so future fields
// can be added without breaking older prompts.

const TITLE_BODY = `You are an Amazon SEO expert. Generate ONE optimised product title for Amazon {marketplace}.

Product:
{contextBlock}

Requirements:
- HARD MAX 200 characters
- Brand name at the start
- Include product type, the primary benefit, and one or two key features
- Add variation details (size, colour, material) at the end if applicable
- Natural language — no keyword stuffing, no SHOUTING CAPS, no emojis
- Optimised for {marketplace} customer search behaviour
- Write in {language}{terminologyBlock}

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

const BULLETS_BODY = `You are an Amazon SEO expert. Generate exactly 5 bullet points for Amazon {marketplace}.

Product:
{contextBlock}

Per-bullet requirements:
- Length: 200–500 characters
- Start with [BENEFIT_HEADER] in ALL CAPS inside square brackets
- Then explain the benefit in natural language
- Active voice, customer-benefit focus (not feature dumps)
- Naturally include searchable keywords; no keyword stuffing
- No emojis, no excessive punctuation, no SHOUTING outside the header
- Write in {language}{terminologyBlock}

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

const DESCRIPTION_BODY = `You are an Amazon listing copywriter. Generate the long product description as Amazon-safe HTML for marketplace {marketplace}.

Product:
{contextBlock}

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
- Write in {language}{terminologyBlock}

Return JSON only:
{
  "content": "<h3>...</h3><p>...</p>...",
  "preview": "first ~200 plain-text characters with all HTML stripped",
  "insights": ["why this description works, 2–4 short notes"]
}`

const KEYWORDS_BODY = `Generate Amazon backend search terms for marketplace {marketplace}.

Product:
{contextBlock}

Hard requirements:
- HARD MAX 250 characters total
- Space-separated keywords
- NO commas, NO punctuation between terms, NO duplicate words
- Do NOT repeat words already in the product title (Amazon ignores those)
- Mix {language} + English where it makes sense (catches both audiences)
- Include synonyms, common misspellings, and use-case phrases (e.g. "summer riding")
- Include compatible items where relevant (e.g. for jackets: "helmet pants gloves"){terminologyBlock}

Return JSON only:
{
  "content": "keyword1 keyword2 keyword3 ...",
  "charCount": <number — must equal content.length>,
  "insights": ["why these keywords work, 2–4 short notes"]
}`

interface SeedDefinition {
  feature: string
  body: string
  description: string
}

const SEEDS: SeedDefinition[] = [
  {
    feature: 'listing-wizard.title',
    description:
      'Amazon SEO title — single line up to 200 chars. Brand-first, includes product type + primary benefit + one or two key features.',
    body: TITLE_BODY,
  },
  {
    feature: 'listing-wizard.bullets',
    description:
      'Amazon 5-bullet product attributes. Each starts with [BENEFIT_HEADER]; 200–500 chars per bullet; themed quality / comfort / versatility / materials / brand confidence.',
    body: BULLETS_BODY,
  },
  {
    feature: 'listing-wizard.description',
    description:
      'Amazon long description as restricted HTML. Brand story + key features + specs + use cases + care.',
    body: DESCRIPTION_BODY,
  },
  {
    feature: 'listing-wizard.keywords',
    description:
      'Amazon backend search terms — space-separated, ≤250 chars, no title duplication, mixed language where useful.',
    body: KEYWORDS_BODY,
  },
]

/**
 * AI-2.3 — render a PromptTemplate body by substituting
 * `{placeholder}` markers with caller-supplied values. Markers that
 * aren't in `vars` are left as-is (so an operator-edited prompt
 * with a stray `{foo}` doesn't crash; renders as literal text).
 *
 * Whitelist of supported placeholders matches what the seed bodies
 * use. Adding a new field is intentional — bodies referencing
 * unknown markers should preview as-is in the admin UI so operators
 * see what they typed rather than a silently dropped slot.
 */
export type PromptRenderVars = {
  marketplace?: string
  language?: string
  contextBlock?: string
  terminologyBlock?: string
}

export function renderPromptBody(body: string, vars: PromptRenderVars): string {
  if (!body) return ''
  return body.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const v = (vars as Record<string, unknown>)[key]
      return typeof v === 'string' ? v : match
    }
    return match
  })
}

/**
 * Idempotent upsert of the four Step 5 attribute prompts as DRAFT
 * rows. Runs on API startup; if a row already exists for
 * (feature, name='default', version=1) we leave it alone (operators
 * may have edited the body). Only fires when the row is missing.
 *
 * Returns the count of newly-inserted rows so the startup logger can
 * report visibility.
 */
export async function seedPromptTemplateDefaults(
  prisma: PrismaClient,
): Promise<{ inserted: number }> {
  let inserted = 0
  for (const seed of SEEDS) {
    try {
      const existing = await prisma.promptTemplate.findFirst({
        where: { feature: seed.feature, name: 'default', version: 1 },
        select: { id: true },
      })
      if (existing) continue
      await prisma.promptTemplate.create({
        data: {
          feature: seed.feature,
          name: 'default',
          description: seed.description,
          body: seed.body,
          status: 'DRAFT',
          version: 1,
          createdBy: 'system',
        },
      })
      inserted += 1
    } catch (err) {
      // Don't let one failure sink the rest. Logged for visibility.
      logger.warn('prompt-template-service: seed failed for feature', {
        feature: seed.feature,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (inserted > 0) {
    logger.info('prompt-template-service: seeded DRAFT prompts', {
      inserted,
      total: SEEDS.length,
    })
  }
  return { inserted }
}
