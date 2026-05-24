'use client'

// AC.11 — Smart Auto-Fill ("One-Click Listing").
//
// One card with three fill sources for title / description / bullets:
//
//   1. Pull from Master — copies product.name / description / brand
//      straight into the draft bus. No AI call; instant. Good for
//      "this listing should mirror the master on this market".
//
//   2. AI generate copy — POST /api/products/ai/bulk-generate with
//      dryRun=true, fields=['title','bullets','description'] for the
//      active marketplace. The endpoint already respects the
//      TerminologyPreference glossary (Italian Giacca-vs-Giubbotto,
//      per-brand preferred / avoid lists) so the output lands in
//      market-native language.
//
//   3. Pull from sibling market — pick another marketplace's listing
//      and copy its title / description / bulletPointsOverride.
//      Surfaced as 'sibling' source in FieldSource (AC.5/AC.7 wiring).
//
// All three open a DIFF MODAL showing CURRENT → PROPOSED per field,
// with per-field "Apply" checkboxes so the operator can accept a
// subset. Apply pushes into the draft bus; the cockpit preview +
// health panel + bullet list re-render immediately. Save still
// requires the header Save All (DSP discipline).

import { useMemo, useState } from 'react'
import {
  Wand2,
  ArrowDownToLine,
  Copy,
  Sparkles,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { setDraftField } from '../../../_shared/draft-bus/useProductDraftBus'
import { announce } from '../../../_shared/announce/useAnnounce'
import { postCockpitEvent } from '../../../_shared/telemetry/cockpit-telemetry'

interface ListingLite {
  marketplace: string
  title?: string | null
  description?: string | null
  bulletPointsOverride?: string[] | null
}

interface Props {
  productId: string
  productName: string | null
  productDescription: string | null
  productBrand: string | null
  marketplace: string
  language: string
  /** Current values seen by the cockpit (with draft overlays applied).
   *  Used to compute the diff against the proposed values. */
  currentTitle: string
  currentDescription: string
  currentBullets: string[]
  /** Other marketplaces' listings on the same channel — feeds the
   *  sibling-pull dropdown. */
  siblingListings?: ListingLite[]
  onJumpToClassic?: () => void
}

type FieldKey = 'name' | 'description' | 'bullets'

interface DiffEntry {
  field: FieldKey
  label: string
  current: string
  proposed: string
  selected: boolean
}

interface GeneratedField {
  content?: string | string[]
}
interface GenerationResultLite {
  title?: GeneratedField
  description?: GeneratedField
  bullets?: GeneratedField
  keywords?: GeneratedField
}
interface BulkGenerateResp {
  results?: Array<{ productId: string; ok: boolean; generated?: GenerationResultLite; error?: string }>
}

export default function AutoFillCard({
  productId,
  productName,
  productDescription,
  productBrand,
  marketplace,
  language,
  currentTitle,
  currentDescription,
  currentBullets,
  siblingListings = [],
  onJumpToClassic,
}: Props) {
  const [busy, setBusy] = useState<'master' | 'ai' | 'sibling' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<DiffEntry[]>([])
  const [source, setSource] = useState<'master' | 'ai' | 'sibling'>('master')
  const [siblingChoice, setSiblingChoice] = useState<string>(
    siblingListings[0]?.marketplace ?? '',
  )
  const [appliedFlash, setAppliedFlash] = useState<string | null>(null)

  const eligibleSiblings = useMemo(
    () => siblingListings.filter((l) => l.title || l.description || (l.bulletPointsOverride?.length ?? 0) > 0),
    [siblingListings],
  )

  // ── Compute diff helpers ─────────────────────────────────────────────
  function diffFor(
    proposed: { name?: string; description?: string; bullets?: string[] },
  ): DiffEntry[] {
    const out: DiffEntry[] = []
    if (proposed.name != null && proposed.name !== currentTitle) {
      out.push({
        field: 'name',
        label: 'Title',
        current: currentTitle,
        proposed: proposed.name,
        selected: true,
      })
    }
    if (
      proposed.description != null &&
      proposed.description !== currentDescription
    ) {
      out.push({
        field: 'description',
        label: 'Description',
        current: currentDescription,
        proposed: proposed.description,
        selected: true,
      })
    }
    if (proposed.bullets != null) {
      const before = (currentBullets ?? []).join('\n')
      const after = proposed.bullets.join('\n')
      if (before !== after) {
        out.push({
          field: 'bullets',
          label: 'Bullet points (5)',
          current: before,
          proposed: after,
          selected: true,
        })
      }
    }
    return out
  }

  // ── Pull from Master ─────────────────────────────────────────────────
  function handlePullMaster() {
    setError(null)
    const proposed = {
      name: productName ?? undefined,
      description: productDescription ?? undefined,
    }
    const d = diffFor(proposed)
    if (d.length === 0) {
      setAppliedFlash('Master already matches the cockpit — nothing to copy.')
      window.setTimeout(() => setAppliedFlash(null), 2200)
      return
    }
    setDiffs(d)
    setSource('master')
  }

  // ── AI generate ──────────────────────────────────────────────────────
  async function handleAiGenerate() {
    setBusy('ai')
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/ai/bulk-generate`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productIds: [productId],
            fields: ['title', 'description', 'bullets'],
            marketplace,
            dryRun: true,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as BulkGenerateResp
      const r = json.results?.[0]
      if (!r) throw new Error('No result returned')
      if (!r.ok) throw new Error(r.error ?? 'AI generation failed')
      const g = r.generated ?? {}
      const proposed = {
        name:
          typeof g.title?.content === 'string'
            ? (g.title.content as string)
            : undefined,
        description:
          typeof g.description?.content === 'string'
            ? (g.description.content as string)
            : undefined,
        bullets: Array.isArray(g.bullets?.content)
          ? ((g.bullets.content as string[]).filter(
              (b) => typeof b === 'string',
            ) as string[])
          : undefined,
      }
      const d = diffFor(proposed)
      if (d.length === 0) {
        setAppliedFlash('AI output identical to current — no change.')
        window.setTimeout(() => setAppliedFlash(null), 2200)
        return
      }
      setDiffs(d)
      setSource('ai')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // ── Pull from sibling ────────────────────────────────────────────────
  function handlePullSibling() {
    setError(null)
    if (!siblingChoice) {
      setError('Pick a sibling market first.')
      return
    }
    const sib = siblingListings.find((s) => s.marketplace === siblingChoice)
    if (!sib) {
      setError('Sibling market not found.')
      return
    }
    const proposed = {
      name: sib.title ?? undefined,
      description: sib.description ?? undefined,
      bullets:
        Array.isArray(sib.bulletPointsOverride) &&
        sib.bulletPointsOverride.length > 0
          ? sib.bulletPointsOverride.filter((b): b is string => typeof b === 'string')
          : undefined,
    }
    const d = diffFor(proposed)
    if (d.length === 0) {
      setAppliedFlash(`${siblingChoice} already matches — no change.`)
      window.setTimeout(() => setAppliedFlash(null), 2200)
      return
    }
    setDiffs(d)
    setSource('sibling')
  }

  // ── Apply diff (push to bus) ─────────────────────────────────────────
  function handleApplyDiff() {
    const accepted = diffs.filter((d) => d.selected)
    if (accepted.length === 0) {
      setDiffs([])
      return
    }
    for (const d of accepted) {
      if (d.field === 'name') {
        setDraftField(productId, 'name', d.proposed)
      } else if (d.field === 'description') {
        setDraftField(productId, 'description', d.proposed)
      } else if (d.field === 'bullets') {
        setDraftField(
          productId,
          'bullets',
          d.proposed.split('\n').filter(Boolean),
        )
      }
    }
    const msg = `Applied ${accepted.length} field${accepted.length === 1 ? '' : 's'} from ${source}. Save via header to persist.`
    setAppliedFlash(msg)
    announce(msg)
    postCockpitEvent({
      type: 'autofill_applied',
      productId,
      marketplace,
      payload: {
        source,
        fieldCount: accepted.length,
        fields: accepted.map((d) => d.field),
      },
    })
    window.setTimeout(() => setAppliedFlash(null), 2500)
    setDiffs([])
  }

  return (
    <div
      data-jump-target="autofill"
      className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/40 dark:bg-blue-950/20 p-3 space-y-2"
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Smart auto-fill
          </span>
          <span className="text-[10.5px] text-slate-500 dark:text-slate-400">
            One-click title + bullets + description from Master, AI, or a sibling market
          </span>
        </div>
        {onJumpToClassic && (
          <button
            type="button"
            onClick={onJumpToClassic}
            className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
          >
            Classic editor →
          </button>
        )}
      </div>

      {/* Action row */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          variant="secondary"
          icon={
            busy === 'master' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <ArrowDownToLine className="w-3.5 h-3.5" />
            )
          }
          onClick={handlePullMaster}
          disabled={busy !== null || !productName}
          title="Copy Master title + description into the cockpit"
        >
          Pull from Master
        </Button>
        <Button
          size="sm"
          icon={
            busy === 'ai' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Wand2 className="w-3.5 h-3.5" />
            )
          }
          onClick={handleAiGenerate}
          disabled={busy !== null}
          title={`AI generate title + bullets + description in ${language.toUpperCase()} (glossary-aware)`}
        >
          {busy === 'ai' ? 'Generating…' : `AI fill (${language.toUpperCase()})`}
        </Button>

        {eligibleSiblings.length > 0 && (
          <>
            <select
              value={siblingChoice}
              onChange={(e) => setSiblingChoice(e.target.value)}
              className="h-7 px-2 rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-[11.5px] text-slate-800 dark:text-slate-200"
              disabled={busy !== null}
            >
              {eligibleSiblings.map((s) => (
                <option key={s.marketplace} value={s.marketplace}>
                  {s.marketplace}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="secondary"
              icon={<Copy className="w-3.5 h-3.5" />}
              onClick={handlePullSibling}
              disabled={busy !== null || !siblingChoice}
              title="Copy this sibling market's listing copy into the cockpit"
            >
              Pull from {siblingChoice || 'sibling'}
            </Button>
          </>
        )}
      </div>

      {/* Brand pull mini-action — only when master has a brand and the
          cockpit doesn't already see it. */}
      {productBrand && productBrand.trim().length > 0 && (
        <div className="text-[10.5px] text-slate-500 dark:text-slate-400">
          Master brand:{' '}
          <button
            type="button"
            className="font-mono text-blue-600 dark:text-blue-400 hover:underline"
            onClick={() => {
              setDraftField(productId, 'brand', productBrand)
              setAppliedFlash(`Brand "${productBrand}" copied to cockpit.`)
              window.setTimeout(() => setAppliedFlash(null), 2200)
            }}
          >
            {productBrand}
          </button>{' '}
          (click to copy)
        </div>
      )}

      {/* Error / flash */}
      {error && (
        <div className="inline-flex items-start gap-1.5 text-[11px] text-rose-700 dark:text-rose-400">
          <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {appliedFlash && (
        <div className="inline-flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded px-2 py-1">
          <CheckCircle2 className="w-3 h-3" />
          {appliedFlash}
        </div>
      )}

      <div className="text-[10.5px] text-slate-500 dark:text-slate-400 italic">
        AC.11 — pushes to draft bus (AC.5); cockpit preview + health
        re-render live, save still owns persistence via the header.
      </div>

      {/* Diff modal */}
      {diffs.length > 0 && (
        <DiffModal
          source={source}
          marketplace={marketplace}
          siblingChoice={source === 'sibling' ? siblingChoice : null}
          diffs={diffs}
          onToggle={(field) =>
            setDiffs((arr) =>
              arr.map((d) =>
                d.field === field ? { ...d, selected: !d.selected } : d,
              ),
            )
          }
          onApply={handleApplyDiff}
          onCancel={() => setDiffs([])}
        />
      )}
    </div>
  )
}

// ── Diff modal ─────────────────────────────────────────────────────────
function DiffModal({
  source,
  marketplace,
  siblingChoice,
  diffs,
  onToggle,
  onApply,
  onCancel,
}: {
  source: 'master' | 'ai' | 'sibling'
  marketplace: string
  siblingChoice: string | null
  diffs: DiffEntry[]
  onToggle: (field: FieldKey) => void
  onApply: () => void
  onCancel: () => void
}) {
  const title =
    source === 'master'
      ? `Pull from Master → ${marketplace}`
      : source === 'sibling'
      ? `Pull from ${siblingChoice} → ${marketplace}`
      : `AI suggestions → ${marketplace}`

  const acceptedCount = diffs.filter((d) => d.selected).length

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
    >
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl border border-slate-200 dark:border-slate-700 w-full max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {title}
            </div>
            <div className="text-[10.5px] text-slate-500 dark:text-slate-400">
              Review and uncheck any field you don&apos;t want to apply.
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          {diffs.map((d) => (
            <div
              key={d.field}
              className={cn(
                'rounded border p-2',
                d.selected
                  ? 'border-blue-200 dark:border-blue-700 bg-blue-50/30 dark:bg-blue-950/20'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-900/40 opacity-60',
              )}
            >
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={d.selected}
                  onChange={() => onToggle(d.field)}
                  className="w-4 h-4"
                />
                <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {d.label}
                </span>
              </label>
              <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-[12px] leading-snug">
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-rose-600 dark:text-rose-400 mb-0.5">
                    Current
                  </div>
                  <div className="rounded bg-rose-50/60 dark:bg-rose-950/20 border border-rose-100 dark:border-rose-900 p-1.5 text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                    {d.current || (
                      <em className="text-slate-400">empty</em>
                    )}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide font-semibold text-emerald-600 dark:text-emerald-400 mb-0.5">
                    Proposed
                  </div>
                  <div className="rounded bg-emerald-50/60 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-900 p-1.5 text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                    {d.proposed || (
                      <em className="text-slate-400">empty</em>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            {acceptedCount}/{diffs.length} field{diffs.length === 1 ? '' : 's'} selected
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={onApply}
              disabled={acceptedCount === 0}
            >
              Apply {acceptedCount > 0 && `(${acceptedCount})`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
