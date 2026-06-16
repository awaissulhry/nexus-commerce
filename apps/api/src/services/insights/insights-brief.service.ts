/**
 * IH.11 — AI executive brief.
 *
 * Assembles a compact snapshot of the operator's last window
 * (summary + breakdown + ads + anomalies + product highlights),
 * feeds it to Claude via the existing AnthropicProvider, and
 * returns a structured narrative the hub renders as the operator's
 * morning briefing.
 *
 * Output shape is JSON so the UI can render distinct sections
 * (TL;DR, what went well, what's broken, top 3 actions, anomalies)
 * with consistent layout. The prompt asks for Italian output by
 * default since Xavia's primary operator reads in Italian; the
 * route accepts ?language=en for English.
 *
 * The brief is NOT cached longer than 5 minutes since it's an
 * explicit "what changed lately" surface — staleness here defeats
 * the purpose.
 */

import { AnthropicProvider } from '../ai/providers/anthropic.provider.js'
import { resolveModelForFeature } from '../ai/model-resolver.service.js'
import type { InsightsFilters } from './index.js'
import { computeInsightsSummary } from './insights-summary.service.js'
import { computeInsightsBreakdown } from './insights-breakdown.service.js'
import { computeWhatChanged } from './insights-what-changed.service.js'
import { computeAnomalies } from './insights-anomalies.service.js'
import { computeAdvertisingReport } from './insights-advertising.service.js'

export interface BriefAction {
  title: string
  rationale: string
  area: 'pricing' | 'advertising' | 'inventory' | 'product' | 'customer' | 'fiscal' | 'other'
  urgency: 'today' | 'this_week' | 'this_month'
}

export interface BriefSection {
  heading: string
  bullets: string[]
}

export interface ExecutiveBrief {
  language: 'it' | 'en'
  generatedAt: string
  window: { from: string; to: string }
  tldr: string
  sections: BriefSection[]
  topActions: BriefAction[]
  watchlist: string[]
  modelUsed: string
  costUsd: number
}

interface PromptContext {
  summary: Awaited<ReturnType<typeof computeInsightsSummary>>
  breakdown: Awaited<ReturnType<typeof computeInsightsBreakdown>>
  whatChanged: Awaited<ReturnType<typeof computeWhatChanged>>
  anomalies: Awaited<ReturnType<typeof computeAnomalies>>
  advertising: Awaited<ReturnType<typeof computeAdvertisingReport>>
}

function buildPrompt(
  ctx: PromptContext,
  language: 'it' | 'en',
): string {
  const langInstruction =
    language === 'it'
      ? "Rispondi SEMPRE in italiano. L'operatore è italiano e legge il brief al mattino con il caffè."
      : 'Respond ALWAYS in English. Be concise and direct.'

  const data = {
    window: ctx.summary.window,
    currency: ctx.summary.currency,
    totals: {
      revenue: ctx.summary.totals.revenue,
      orders: ctx.summary.totals.orders,
      units: ctx.summary.totals.units,
      aov: ctx.summary.totals.aov,
    },
    revenueByChannel: ctx.breakdown.byChannel.slice(0, 5),
    revenueByMarket: ctx.breakdown.byMarket.slice(0, 8),
    advertising: {
      spend: ctx.advertising.totals.spend,
      sales: ctx.advertising.totals.sales,
      acos: ctx.advertising.totals.acos,
      roas: ctx.advertising.totals.roas,
      tacos: ctx.advertising.totals.tacos,
    },
    whatChanged: ctx.whatChanged.items.slice(0, 10),
    anomalies: ctx.anomalies.items.slice(0, 8).map((a) => ({
      date: a.date,
      kind: a.kind,
      severity: a.severity,
      headline: a.headline,
    })),
  }

  return `You are the analytics co-pilot for Xavia, an Italian motorcycle gear e-commerce business (primary market: Amazon IT). The operator is reviewing their performance for the window below.

${langInstruction}

DATA:
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`

Write an executive brief as STRICT JSON matching this TypeScript type:

\`\`\`ts
{
  tldr: string,                                  // 1–2 sentence summary
  sections: Array<{ heading: string, bullets: string[] }>, // 2–4 sections
  topActions: Array<{
    title: string,                                // imperative, ≤ 8 words
    rationale: string,                            // ≤ 30 words
    area: "pricing"|"advertising"|"inventory"|"product"|"customer"|"fiscal"|"other",
    urgency: "today"|"this_week"|"this_month"
  }>,                                              // exactly 3 actions
  watchlist: string[]                              // 2–4 items to monitor
}
\`\`\`

Rules:
- Be specific. Reference channel/market/SKU/campaign names where useful.
- Sections should cover: what went well, what's broken, and 1–2 themed observations.
- topActions must be concrete decisions the operator can take this week, not platitudes.
- watchlist is metrics or events to keep an eye on, not advice.
- NO markdown fences. NO commentary outside the JSON. Output ONLY valid JSON.`
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const raw = fenced ? fenced[1]! : trimmed
  return JSON.parse(raw)
}

interface ClaudeBriefShape {
  tldr?: string
  sections?: Array<{ heading?: string; bullets?: string[] }>
  topActions?: BriefAction[]
  watchlist?: string[]
}

export async function computeExecutiveBrief(
  filters: InsightsFilters,
  options: { language?: 'it' | 'en' } = {},
): Promise<ExecutiveBrief> {
  const language: 'it' | 'en' = options.language ?? 'it'

  const [summary, breakdown, whatChanged, anomalies, advertising] =
    await Promise.all([
      computeInsightsSummary(filters),
      computeInsightsBreakdown(filters),
      computeWhatChanged(filters),
      computeAnomalies(filters),
      computeAdvertisingReport(filters),
    ])

  const prompt = buildPrompt(
    { summary, breakdown, whatChanged, anomalies, advertising },
    language,
  )

  const provider = new AnthropicProvider()
  if (!provider.isConfigured()) {
    return {
      language,
      generatedAt: new Date().toISOString(),
      window: summary.window,
      tldr:
        language === 'it'
          ? 'Brief AI non disponibile — ANTHROPIC_API_KEY non configurata.'
          : 'AI brief unavailable — ANTHROPIC_API_KEY is not configured.',
      sections: [],
      topActions: [],
      watchlist: [],
      modelUsed: 'unavailable',
      costUsd: 0,
    }
  }

  const model = await resolveModelForFeature('insights-brief', provider)
  const result = await provider.generate({
    prompt,
    model,
    jsonMode: true,
    maxOutputTokens: 2048,
    temperature: 0.5,
  })

  let parsed: ClaudeBriefShape
  try {
    parsed = extractJson(result.text) as ClaudeBriefShape
  } catch {
    parsed = { tldr: result.text, sections: [], topActions: [], watchlist: [] }
  }

  return {
    language,
    generatedAt: new Date().toISOString(),
    window: summary.window,
    tldr: parsed.tldr ?? '',
    sections: (parsed.sections ?? [])
      .filter((s) => s.heading && Array.isArray(s.bullets))
      .map((s) => ({ heading: s.heading!, bullets: s.bullets ?? [] })),
    topActions: (parsed.topActions ?? []).slice(0, 3),
    watchlist: parsed.watchlist ?? [],
    modelUsed: result.usage.model,
    costUsd: result.usage.costUSD,
  }
}
