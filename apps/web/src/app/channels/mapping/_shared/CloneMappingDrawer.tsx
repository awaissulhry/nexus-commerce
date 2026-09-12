'use client'

/** Clone into separately reviewed market drafts. Target schema exclusions are reported in
 * each review; activation checks both source and target revisions and resolution inputs. */

import { useMemo, useState } from 'react'
import { Copy, Loader2 } from 'lucide-react'

import { Button, Checkbox, Pill } from '@/design-system/primitives'
import { Banner, Drawer } from '@/design-system/components'
import styles from '../mapping.module.css'
import * as api from './api'
import { ImpactReview } from './ImpactReview'
import type { TemplateRow } from './contracts'

interface Props {
  open: boolean
  from: TemplateRow
  productType: string | null
  templates: TemplateRow[]
  /** How many rules the SOURCE carries for this category — what is about to be copied. */
  sourceRuleCount: number
  sourceToken: string
  onClose: () => void
  onCloned: () => void | Promise<void>
}

export function CloneMappingDrawer({
  open, from, productType, templates, sourceRuleCount, sourceToken, onClose, onCloned,
}: Props) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [addTranslate, setAddTranslate] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ results: Array<{ channel: string; code: string; jobId?: string; error?: string }> } | null>(null)

  const key = (t: { channel: string; code: string }) => `${t.channel}/${t.code}`

  // Same channel only: a rule keyed to Amazon's field names is meaningless on eBay's schema,
  // and `buildClonedRules` would skip every one of them.
  const candidates = useMemo(
    () => templates.filter((t) => t.channel === from.channel && key(t) !== key(from)),
    [templates, from],
  )

  const wouldOverwrite = useMemo(
    () => candidates.filter((t) => picked.has(key(t)) && t.mappedCount > 0),
    [candidates, picked],
  )

  const toggle = (k: string) =>
    setPicked((cur) => {
      const next = new Set(cur)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })

  const run = async () => {
    const targets = candidates.filter((t) => picked.has(key(t))).map((t) => ({ channel: t.channel, code: t.code }))
    if (targets.length === 0) return
    setRunning(true)
    setError(null)
    try {
      const results: Array<{ channel: string; code: string; jobId?: string; error?: string }> = []
      for (const target of targets) {
        try {
          const current = await api.fetchCatalogue(target.channel, target.code, productType)
          const review = await api.createConfigurationImpact(target.channel, target.code, current.mappingToken, { category: productType,
            clone: { channel: from.channel, market: from.code, token: sourceToken, addTranslate } })
          results.push({ ...target, jobId: review.jobId })
        } catch (e) { results.push({ ...target, error: e instanceof Error ? e.message : String(e) }) }
      }
      setResult({ results })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={() => { if (!running) onClose() }}
      width={560}
      title="Clone this mapping to other markets"
      subtitle={`From ${from.channel} · ${from.code}${productType ? ` · ${productType}` : ''} — ${sourceRuleCount} rule${sourceRuleCount === 1 ? '' : 's'}`}
      footer={
        result ? (
          <><span className="grow" /><Button size="sm" variant="ghost" onClick={onClose}>Done</Button></>
        ) : (
          <>
            <span className="grow" />
            <Button size="sm" variant="ghost" onClick={onClose} disabled={running}>Cancel</Button>
            <Button size="sm" variant="primary" onClick={run} disabled={picked.size === 0 || running}>
              {running ? <Loader2 size={14} className="spin" /> : <Copy size={14} />} Review {picked.size} market{picked.size === 1 ? '' : 's'}
            </Button>
          </>
        )
      }
    >
      <div className={styles.drawerBody}>
        {error && <Banner tone="danger" title="The clone failed">{error}</Banner>}

        {result ? (
          <div className={styles.section}>
            <span className={styles.sectionTitle}>Result</span>
            {result.results.map(r => <div key={`${r.channel}/${r.code}`} className={styles.section}>
              <h3>{r.channel} · {r.code}</h3>
              {r.error ? <Banner tone="danger">{r.error}</Banner> : r.jobId && <ImpactReview jobId={r.jobId} onApplied={onCloned} />}
            </div>)}
            <p className={styles.hint}>Each destination has an independent review and activation. Source fields absent from the target schema are excluded. Shared facts and listing overrides are preserved.</p>
          </div>
        ) : (
          <>
            {sourceRuleCount === 0 && (
              <Banner tone="warning" title="This market has nothing to clone">
                {from.channel} · {from.code} carries no rules for this category, so cloning would
                copy nothing.
              </Banner>
            )}

            <div className={styles.section}>
              <span className={styles.sectionTitle}>Copy to</span>
              {candidates.length === 0 ? (
                <p className={styles.hint}>No other {from.channel} market is configured.</p>
              ) : (
                candidates.map((t) => (
                  <label
                    key={key(t)}
                    className={styles.ruleRow}
                    style={{ cursor: t.fieldCount === 0 ? 'not-allowed' : 'pointer', opacity: t.fieldCount === 0 ? 0.6 : 1 }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <Checkbox
                        checked={picked.has(key(t))}
                        onChange={() => toggle(key(t))}
                        disabled={t.fieldCount === 0}
                      />
                      <div style={{ minWidth: 0 }}>
                        <div className={styles.ruleName}>{t.channel} · {t.code}</div>
                        <div className={styles.usageList}>
                          {t.name} — {t.fieldCount === 0
                            ? 'no schema synced, so nothing would land'
                            : t.mappedCount === 0
                              ? 'no rules yet'
                              : `${t.mappedCount} rule${t.mappedCount === 1 ? '' : 's'} already here`}
                        </div>
                      </div>
                    </div>
                    {t.fieldCount === 0
                      ? <Pill tone="neutral" size="sm">needs a schema sync</Pill>
                      : t.mappedCount > 0
                        ? <Pill tone="warning" size="sm">would overwrite</Pill>
                        : null}
                  </label>
                ))
              )}
            </div>

            {wouldOverwrite.length > 0 && (
              <Banner tone="warning" title={`${wouldOverwrite.length} market${wouldOverwrite.length === 1 ? ' already carries' : 's already carry'} rules`}>
                {wouldOverwrite.map((t) => `${t.code} (${t.mappedCount})`).join(', ')} — a field mapped
                there will be replaced by this market's rule. Each is snapshotted first, so it can be
                rolled back.
              </Banner>
            )}

            <label className={styles.hint} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <Checkbox checked={addTranslate} onChange={() => setAddTranslate((v) => !v)} />
              Mark cloned text fields for translation into each target market's language
            </label>

            <p className={styles.hint}>
              A rule only lands where the target market's schema defines the same field; anything
              else is skipped and counted, and you will see both numbers per market. Markets with
              no stored schema are greyed out — sync their schema first, or the clone reports a
              confident zero.
            </p>
          </>
        )}
      </div>
    </Drawer>
  )
}
