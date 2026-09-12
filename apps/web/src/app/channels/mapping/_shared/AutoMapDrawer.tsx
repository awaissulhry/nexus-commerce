'use client'

/**
 * PES.6 — 6.24 auto-map (Owner-approved, hub ruling #105).
 *
 * Proposes a source for every UNMAPPED field and writes nothing until the operator says so.
 * Two passes, deliberately separate:
 *   1. the free HEURISTIC (`/suggest`) — alias matching, deterministic, covers the name-matchable
 *      majority. Runs on open.
 *   2. an opt-in AI pass (`/suggest-ai`) for the long tail the heuristic could not name. It is a
 *      button, never automatic, and it stays inside the existing budget + kill-switch plumbing.
 *
 * REVIEW-GATED means exactly one thing here: no rule exists until **Apply** is pressed, and Apply
 * writes only the rows still ticked. The AI half proposes into the same list as the heuristic and
 * is marked as such, so an operator can see which suggestions a model produced before accepting.
 *
 * Honesty rules this panel holds:
 *  - When the AI does not run, its own sentence is printed (kill-switch off, no provider, nothing
 *    left to scan, or the call failed). An empty list is never dressed up as "AI found nothing".
 *  - Confidence is the service's, not a re-derivation: `high` = an exact alias match, `medium` =
 *    substring containment. Only `high` is pre-ticked.
 *  - Applying goes through the bulk endpoint, which records ONE `MappingRevision` — so an
 *    auto-map is a single rollback point rather than N separate ones.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Sparkles } from 'lucide-react'

import { Button, Checkbox, Pill } from '@/design-system/primitives'
import { Banner, Drawer, EmptyState } from '@/design-system/components'
import styles from '../mapping.module.css'
import * as api from './api'
import { ImpactReview } from './ImpactReview'
import type { FieldMappingRule, MappingSuggestion } from './contracts'

interface Props {
  open: boolean
  channel: string
  code: string
  productType: string | null
  previewProductId?: string | null
  mappingToken: string
  onClose: () => void
  onApplied: () => void | Promise<void>
}

export function AutoMapDrawer({ open, channel, code, productType, previewProductId, mappingToken, onClose, onApplied }: Props) {
  const [impactId, setImpactId] = useState<string | null>(null)

  const [suggestions, setSuggestions] = useState<MappingSuggestion[]>([])
  const [unmappedTotal, setUnmappedTotal] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [aiRunning, setAiRunning] = useState(false)
  const [aiNote, setAiNote] = useState<string | null>(null)
  const [aiRan, setAiRan] = useState(false)

  const [addTranslate, setAddTranslate] = useState(false)
  const [applying, setApplying] = useState(false)

  /* ── heuristic pass on open ──────────────────────────────────── */
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await api.fetchSuggestions(channel, code, productType, previewProductId)
      setSuggestions(r.suggestions)
      setUnmappedTotal(r.unmappedTotal)
      // Pre-tick only what the service called `high`. A medium match is a guess worth showing
      // and not worth accepting on the operator's behalf.
      setPicked(new Set(r.suggestions.filter((s) => s.confidence === 'high').map((s) => s.fieldKey)))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [channel, code, productType, previewProductId])

  useEffect(() => { void load() }, [load])

  /* ── opt-in AI pass ──────────────────────────────────────────── */
  const runAi = async () => {
    setAiRunning(true)
    setAiNote(null)
    try {
      const r = await api.fetchAiSuggestions(channel, code, productType, previewProductId)
      setAiRan(true)
      if (!r.aiUsed) {
        // Print the service's own sentence. This is the whole point of the honesty rule.
        setAiNote(r.reason ?? 'The AI pass did not run, and gave no reason.')
        return
      }
      const marked = r.suggestions.map((s) => ({ ...s, fromAI: true }))
      setSuggestions((cur) => {
        const have = new Set(cur.map((s) => s.fieldKey))
        return [...cur, ...marked.filter((s) => !have.has(s.fieldKey))]
      })
      setAiNote(
        marked.length > 0
          ? `The AI proposed ${marked.length} of the ${r.scanned} fields the heuristic could not name. Review them before applying — none are ticked.`
          : `The AI scanned ${r.scanned} long-tail fields and proposed nothing.`,
      )
    } catch (e: any) {
      setAiNote(`The AI pass failed: ${e.message}`)
    } finally {
      setAiRunning(false)
    }
  }

  /* ── selection ───────────────────────────────────────────────── */
  const toggle = (fieldKey: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      next.has(fieldKey) ? next.delete(fieldKey) : next.add(fieldKey)
      return next
    })

  const highKeys = useMemo(
    () => suggestions.filter((s) => s.confidence === 'high').map((s) => s.fieldKey),
    [suggestions],
  )

  /* ── apply ───────────────────────────────────────────────────── */
  const apply = async () => {
    const chosen = suggestions.filter((s) => picked.has(s.fieldKey))
    if (chosen.length === 0) return
    setApplying(true)
    setError(null)
    try {
      const rules = chosen.map((s) => {
        const rule: FieldMappingRule = { source: s.suggestedSource }
        // The old modal's "optional translate": mark text fields for the FM.5 translation pass.
        // A marker only — it never mutates the value inline.
        if (addTranslate && /title|description|bullet|keyword|name/i.test(s.fieldKey)) {
          rule.transforms = [{ type: 'translate' }]
        }
        return { fieldKey: s.fieldKey, rule }
      })
      const r = await api.createImpact(channel, code, productType, rules, mappingToken)
      setImpactId(r.jobId)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setApplying(false)
    }
  }

  const aiCandidates = suggestions.filter((s) => s.fromAI).length

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={impactId ? 1100 : 620}
      title="Auto-map unmapped fields"
      subtitle={`${channel} · ${code}${productType ? ` · ${productType}` : ''} — proposals only; nothing is written until you apply`}
      footer={impactId ? <Button onClick={() => setImpactId(null)}>Back to suggestions</Button> :
        <>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(highKeys))} disabled={loading || highKeys.length === 0}>
            Select all high confidence ({highKeys.length})
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())} disabled={picked.size === 0}>
            Clear
          </Button>
          <span className="grow" />
          <Button size="sm" variant="ghost" onClick={onClose} disabled={applying}>Cancel</Button>
          <Button size="sm" variant="primary" onClick={apply} disabled={picked.size === 0 || applying}>
            {applying ? <Loader2 size={14} className="spin" /> : <Check size={14} />} Review impact of {picked.size} field{picked.size === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {impactId ? <ImpactReview jobId={impactId} onApplied={async () => { await onApplied(); onClose() }} /> : <div className={styles.drawerBody}>
        {error && <Banner tone="danger" title="That did not work">{error}</Banner>}

        {!loading && (
          <p className={styles.hint}>
            {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'} for {unmappedTotal} unmapped
            field{unmappedTotal === 1 ? '' : 's'}. High-confidence matches are ticked; medium ones are
            shown but left for you to judge.
          </p>
        )}

        {/* ── AI pass ── */}
        <div className={styles.section}>
          <span className={styles.sectionTitle}>The long tail</span>
          <div>
            <Button size="sm" variant="ghost" onClick={runAi} disabled={aiRunning || loading}>
              {aiRunning ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {aiRan ? ' Run the AI pass again' : ' Enhance with AI'}
            </Button>
          </div>
          <p className={styles.hint}>
            The heuristic maps what it can match by name. This asks a model for the fields it
            could not, constrained to known master attributes so it cannot invent a path. Its
            proposals arrive unticked.
          </p>
          {aiNote && <Banner tone={aiCandidates > 0 ? 'info' : 'neutral'} title="AI pass">{aiNote}</Banner>}
        </div>

        {/* ── translate option ── */}
        <label className={styles.hint} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <Checkbox checked={addTranslate} onChange={() => setAddTranslate((v) => !v)} />
          Mark text fields (title, description, bullets, keywords) for translation to this market's language
        </label>

        {/* ── the list ── */}
        {loading ? (
          <p className={styles.hint}>Looking for matches…</p>
        ) : suggestions.length === 0 ? (
          <EmptyState
            title="Nothing left to suggest"
            description={
              unmappedTotal === 0
                ? 'Every field on this category already carries a rule.'
                : `${unmappedTotal} field${unmappedTotal === 1 ? ' is' : 's are'} unmapped, but none matched a known master attribute by name. Try the AI pass, or map them by hand.`
            }
          />
        ) : (
          <div className={styles.section}>
            {suggestions.map((s) => (
              <label key={s.fieldKey} className={styles.ruleRow} style={{ cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 }}>
                  <Checkbox checked={picked.has(s.fieldKey)} onChange={() => toggle(s.fieldKey)} />
                  <div style={{ minWidth: 0 }}>
                    <div className={styles.ruleName}>
                      {s.label ?? s.fieldKey}
                      {s.required && <> <Pill tone="danger" size="sm">Required</Pill></>}
                      {s.fromAI && <> <Pill tone="info" size="sm">AI</Pill></>}
                    </div>
                    <div className={styles.ruleBody}>
                      {s.fieldKey} ← {s.suggestedSource}
                    </div>
                    <div className={styles.usageList}>{s.reason}</div>
                  </div>
                </div>
                <Pill tone={s.confidence === 'high' ? 'success' : 'neutral'} size="sm">
                  {s.confidence}
                </Pill>
              </label>
            ))}
          </div>
        )}
      </div>}
    </Drawer>
  )
}
