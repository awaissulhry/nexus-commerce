/**
 * MB.1 — Brand Brain status dashboard.
 *
 * Shows:
 *   - pgvector health + total embeddings by entity type
 *   - Ingest trigger (re-indexes BrandKit + BrandVoice + APlusContent)
 *   - Live query test (nearest-neighbour retrieval)
 *   - Env/config requirements
 *
 * The Brand Brain augments listing-wizard generation: when
 * NEXUS_ENABLE_BRAND_BRAIN=1, renderBrandVoiceBlock() fetches the 2
 * nearest A+ examples from the vector store and injects them into the
 * listing prompt so the model has real brand-specific examples to follow.
 *
 * Status loads client-side in BrandBrainStatusClient — the cross-site API
 * session cookie means server fetches can never authenticate. The page
 * stays a server component so router.refresh() (fired by
 * BrandBrainActionsClient after ingest / from its Refresh button) mints a
 * new refreshToken and re-triggers the status fetch.
 */

import { Brain } from 'lucide-react'
import { BrandBrainActionsClient } from './BrandBrainActionsClient'
import { BrandBrainStatusClient } from './BrandBrainStatusClient'

export const dynamic = 'force-dynamic'

export default function BrandBrainPage() {
  return (
    <div className="px-4 py-4 max-w-3xl">
      <div className="flex items-start gap-3 mb-4">
        <Brain className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Brand Brain
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            RAG (retrieval-augmented generation) layer for listing content. Embeds BrandKit
            voice notes, Brand Voice rules, and published A+ Content into pgvector. During
            listing generation, the 2 nearest past A+ examples are injected into the brand-voice
            block so the model has brand-specific reference material.
          </p>
        </div>
      </div>

      <BrandBrainStatusClient refreshToken={Date.now()} />

      <BrandBrainActionsClient />

      {/* How it works */}
      <section className="mt-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          How retrieval works
        </h2>
        <div className="bg-white dark:bg-slate-900 border border-default dark:border-slate-800 rounded-md px-4 py-3 text-sm text-slate-600 dark:text-slate-400 space-y-2">
          <div className="flex items-start gap-2">
            <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">1</span>
            <span>
              <strong className="text-slate-900 dark:text-slate-100">Index</strong> — The embedding
              ingester (every 6h, or manual trigger) embeds BrandKit voice notes, Brand Voice
              rule bodies, and published A+ content snapshots using{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                text-embedding-3-small
              </code>{' '}
              (1536 dims) and stores them in the{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                ContentEmbedding
              </code>{' '}
              table (pgvector, HNSW index).
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">2</span>
            <span>
              <strong className="text-slate-900 dark:text-slate-100">Retrieve</strong> — At listing
              generation time,{' '}
              <code className="text-[11px] px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800">
                renderBrandVoiceBlock()
              </code>{' '}
              embeds the brand + product query, runs a cosine nearest-neighbour search, and
              prepends the 2 most-similar A+ snippets to the brand-voice prompt block.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <span className="font-mono text-violet-600 dark:text-violet-400 text-xs mt-0.5">3</span>
            <span>
              <strong className="text-slate-900 dark:text-slate-100">Generate</strong> — Claude sees
              the brand voice rules <em>and</em> real brand-specific examples of past A+ content
              in the same prompt — producing listings that are demonstrably on-brand.
            </span>
          </div>
        </div>
      </section>

      {/* Env config */}
      <section className="mt-6">
        <h2 className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
          Configuration
        </h2>
        <div className="bg-slate-50 dark:bg-slate-950/40 border border-default dark:border-slate-800 rounded-md px-4 py-3 text-xs text-slate-600 dark:text-slate-400 space-y-1.5">
          <ConfigRow
            env="NEXUS_ENABLE_BRAND_BRAIN"
            value="1"
            desc="Enable retrieval in listing generation + start embedding ingester cron"
          />
          <ConfigRow
            env="OPENAI_API_KEY"
            value="sk-..."
            desc="OpenAI embeddings API key (text-embedding-3-small). Falls back to deterministic mock when absent — useful for dev."
          />
          <ConfigRow
            env="NEXUS_EMBEDDING_INGESTER_SCHEDULE"
            value="0 */6 * * *"
            desc="Override the ingester cron schedule (default: every 6h)"
          />
        </div>
      </section>
    </div>
  )
}

function ConfigRow({
  env,
  value,
  desc,
}: {
  env: string
  value: string
  desc: string
}) {
  return (
    <div className="flex items-start gap-2 flex-wrap">
      <code className="shrink-0 px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-300">
        {env}={value}
      </code>
      <span className="text-slate-500 dark:text-slate-400">{desc}</span>
    </div>
  )
}
