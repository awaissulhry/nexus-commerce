'use client'

import { useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  RotateCw,
  Sparkles,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

interface TitleResult {
  content: string
  charCount: number
  insights: string[]
}
interface BulletsResult {
  content: string[]
  charCounts: number[]
  insights: string[]
}
interface DescriptionResult {
  content: string
  preview: string
  insights: string[]
}
interface KeywordsResult {
  content: string
  charCount: number
  insights: string[]
}

interface ContentSlice {
  title?: TitleResult
  bullets?: BulletsResult
  description?: DescriptionResult
  keywords?: KeywordsResult
  aiGenerated?: boolean
  generatedAt?: string
}

type Field = 'title' | 'bullets' | 'description' | 'keywords'
const ALL_FIELDS: Field[] = ['title', 'bullets', 'description', 'keywords']

const TITLE_MAX = 200
const BULLET_MAX = 500
const KEYWORD_MAX = 250
const MAX_VARIANTS = 5

export default function Step6Content({
  wizardState,
  updateWizardState,
  product,
  marketplace,
}: StepProps) {
  const slice = (wizardState.content ?? {}) as ContentSlice

  const [results, setResults] = useState<ContentSlice>(slice)
  const [busy, setBusy] = useState<Set<Field>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // Variant counter per field — bumped on each Regenerate so the
  // server applies a different temperature.
  const variantsRef = useRef<Record<Field, number>>({
    title: 0,
    bullets: 0,
    description: 0,
    keywords: 0,
  })

  const generate = async (fields: Field[], regenerateField?: Field) => {
    if (fields.length === 0) return
    setError(null)
    setBusy((prev) => {
      const next = new Set(prev)
      for (const f of fields) next.add(f)
      return next
    })
    if (regenerateField) {
      variantsRef.current[regenerateField] = Math.min(
        variantsRef.current[regenerateField] + 1,
        MAX_VARIANTS - 1,
      )
    }
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-content/generate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productId: product.id,
            marketplace,
            fields,
            variant: regenerateField
              ? variantsRef.current[regenerateField]
              : 0,
          }),
        },
      )
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json?.error ?? `HTTP ${res.status}`)
      }
      setResults((prev) => {
        const next: ContentSlice = {
          ...prev,
          ...json,
          aiGenerated: true,
          generatedAt:
            json?.metadata?.generatedAt ?? new Date().toISOString(),
        }
        // Persist to wizard state in the background.
        void updateWizardState({ content: next })
        return next
      })
    } catch (err: any) {
      setError(err?.message ?? String(err))
    } finally {
      setBusy((prev) => {
        const next = new Set(prev)
        for (const f of fields) next.delete(f)
        return next
      })
    }
  }

  const editField = (field: Field, patch: Partial<ContentSlice[Field]>) => {
    setResults((prev) => {
      const next: ContentSlice = {
        ...prev,
        [field]: {
          ...((prev[field] ?? {}) as object),
          ...(patch as object),
        } as any,
      }
      void updateWizardState({ content: next })
      return next
    })
  }

  const editTitleContent = (val: string) => {
    editField('title', {
      content: val,
      charCount: val.length,
    } as Partial<TitleResult>)
  }
  const editBullet = (idx: number, val: string) => {
    setResults((prev) => {
      const current = prev.bullets ?? {
        content: [],
        charCounts: [],
        insights: [],
      }
      const nextContent = current.content.slice()
      nextContent[idx] = val
      const next: ContentSlice = {
        ...prev,
        bullets: {
          ...current,
          content: nextContent,
          charCounts: nextContent.map((s) => s.length),
        },
      }
      void updateWizardState({ content: next })
      return next
    })
  }
  const editDescription = (val: string) => {
    editField('description', {
      content: val,
      preview: val.replace(/<[^>]+>/g, '').slice(0, 240),
    } as Partial<DescriptionResult>)
  }
  const editKeywords = (val: string) => {
    editField('keywords', {
      content: val,
      charCount: val.length,
    } as Partial<KeywordsResult>)
  }

  const anyContent = useMemo(
    () =>
      !!(
        results.title ||
        results.bullets ||
        results.description ||
        results.keywords
      ),
    [results],
  )

  return (
    <div className="max-w-3xl mx-auto py-8 px-6 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[20px] font-semibold text-slate-900">
            AI Content Generation
          </h2>
          <p className="text-[13px] text-slate-600 mt-1 max-w-2xl">
            Generate Amazon-optimised title, bullets, description, and
            backend keywords for{' '}
            <span className="font-mono text-[12px] bg-slate-100 px-1.5 py-0.5 rounded">
              {marketplace}
            </span>
            . You can regenerate or edit each field afterwards.
          </p>
        </div>
        <button
          type="button"
          onClick={() => generate(ALL_FIELDS)}
          disabled={busy.size > 0}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-medium',
            busy.size > 0
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          {busy.size > 0 ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              {anyContent ? 'Regenerate all' : 'Generate all content'}
            </>
          )}
        </button>
      </header>

      {error && (
        <div className="px-4 py-2 rounded-md bg-red-50 border border-red-200 text-[12px] text-red-900 flex items-start gap-2">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {/* ── Title ─────────────────────────────────────────────── */}
      <FieldShell
        label="Title"
        max={TITLE_MAX}
        current={results.title?.content?.length ?? 0}
        busy={busy.has('title')}
        hasResult={!!results.title}
        onGenerate={() => generate(['title'])}
        onRegenerate={() => generate(['title'], 'title')}
        insights={results.title?.insights}
      >
        {results.title ? (
          <textarea
            value={results.title.content}
            onChange={(e) => editTitleContent(e.target.value)}
            rows={3}
            maxLength={TITLE_MAX + 50}
            className="w-full px-3 py-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 leading-snug"
          />
        ) : (
          <FieldHint>Click Generate to draft an Amazon-optimised title.</FieldHint>
        )}
      </FieldShell>

      {/* ── Bullets ───────────────────────────────────────────── */}
      <FieldShell
        label="Bullet points"
        sublabel="5 bullets, 200–500 chars each"
        busy={busy.has('bullets')}
        hasResult={!!results.bullets}
        onGenerate={() => generate(['bullets'])}
        onRegenerate={() => generate(['bullets'], 'bullets')}
        insights={results.bullets?.insights}
      >
        {results.bullets ? (
          <ul className="space-y-2">
            {results.bullets.content.map((b, i) => {
              const len = results.bullets!.charCounts[i] ?? b.length
              const tone =
                len < 200 || len > BULLET_MAX
                  ? 'text-amber-700'
                  : 'text-slate-500'
              return (
                <li key={i} className="space-y-0.5">
                  <textarea
                    value={b}
                    onChange={(e) => editBullet(i, e.target.value)}
                    rows={3}
                    className="w-full px-3 py-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 leading-snug"
                  />
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="font-mono text-slate-400">
                      bullet {i + 1}
                    </span>
                    <span className={cn('tabular-nums', tone)}>
                      {len} / {BULLET_MAX}
                    </span>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : (
          <FieldHint>
            Click Generate for 5 themed bullets (protection, comfort,
            versatility, materials, brand).
          </FieldHint>
        )}
      </FieldShell>

      {/* ── Description ───────────────────────────────────────── */}
      <FieldShell
        label="Description (HTML)"
        sublabel="1000–2500 characters · Amazon-safe tags only"
        busy={busy.has('description')}
        hasResult={!!results.description}
        onGenerate={() => generate(['description'])}
        onRegenerate={() => generate(['description'], 'description')}
        insights={results.description?.insights}
      >
        {results.description ? (
          <div className="space-y-2">
            <textarea
              value={results.description.content}
              onChange={(e) => editDescription(e.target.value)}
              rows={10}
              className="w-full px-3 py-2 text-[12px] font-mono border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 leading-snug"
            />
            <div className="text-[10px] tabular-nums text-slate-500">
              {results.description.content.length} characters · plain-text
              preview: <span className="italic">{results.description.preview}</span>
            </div>
          </div>
        ) : (
          <FieldHint>
            Click Generate for HTML with brand story, features,
            specifications, use cases, and care instructions.
          </FieldHint>
        )}
      </FieldShell>

      {/* ── Keywords ──────────────────────────────────────────── */}
      <FieldShell
        label="Backend search keywords"
        max={KEYWORD_MAX}
        current={results.keywords?.content?.length ?? 0}
        busy={busy.has('keywords')}
        hasResult={!!results.keywords}
        onGenerate={() => generate(['keywords'])}
        onRegenerate={() => generate(['keywords'], 'keywords')}
        insights={results.keywords?.insights}
      >
        {results.keywords ? (
          <textarea
            value={results.keywords.content}
            onChange={(e) => editKeywords(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 leading-snug"
          />
        ) : (
          <FieldHint>
            Click Generate for synonyms, common misspellings, use-case
            phrases, and compatible-item terms.
          </FieldHint>
        )}
      </FieldShell>

      {results.generatedAt && (
        <div className="text-[11px] text-slate-400 text-right">
          Last generated{' '}
          {new Date(results.generatedAt).toLocaleString()} · auto-saved
        </div>
      )}
    </div>
  )
}

function FieldShell({
  label,
  sublabel,
  max,
  current,
  busy,
  hasResult,
  onGenerate,
  onRegenerate,
  insights,
  children,
}: {
  label: string
  sublabel?: string
  max?: number
  current?: number
  busy: boolean
  hasResult: boolean
  onGenerate: () => void
  onRegenerate: () => void
  insights?: string[]
  children: React.ReactNode
}) {
  const overLimit = max != null && current != null && current > max
  return (
    <section className="border border-slate-200 rounded-lg bg-white px-5 py-4">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-[14px] font-semibold text-slate-900">
            {label}
          </div>
          {sublabel && (
            <div className="text-[11px] text-slate-500 mt-0.5">
              {sublabel}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {max != null && (
            <span
              className={cn(
                'text-[11px] tabular-nums',
                overLimit
                  ? 'text-red-700 font-semibold'
                  : 'text-slate-500',
              )}
            >
              {current ?? 0} / {max}
            </span>
          )}
          {hasResult ? (
            <button
              type="button"
              onClick={onRegenerate}
              disabled={busy}
              className="inline-flex items-center gap-1 h-7 px-2 text-[11px] rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RotateCw className="w-3 h-3" />
              )}
              Regenerate
            </button>
          ) : (
            <button
              type="button"
              onClick={onGenerate}
              disabled={busy}
              className="inline-flex items-center gap-1 h-7 px-2 text-[11px] rounded-md bg-blue-50 border border-blue-200 text-blue-800 hover:bg-blue-100 disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              Generate
            </button>
          )}
        </div>
      </header>
      {children}
      {insights && insights.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {insights.map((i, idx) => (
            <span
              key={idx}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-900 text-[10px] rounded"
            >
              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
              {i}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-4 rounded-md border border-dashed border-slate-200 bg-slate-50 text-[12px] text-slate-500 text-center">
      {children}
    </div>
  )
}
