'use client'

import { useEffect, useMemo, useState } from 'react'
import { Field, Modal } from '@/design-system/components'
import { Button, Input, Tag, TokenChip } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import type { AxisSummary } from './coverage'
import { deriveSkuPattern, defaultCode, type PlanFamily } from './generatePlan'
import styles from './family.module.css'

interface Preview {
  dryRun: true
  previewToken: string
  counts: { combinations: number; existing: number; willCreate: number }
  plan: Array<{ sku: string; axisValues: Record<string, string>; copiesFrom: { id: string; sku: string } | null }>
  skipped: Array<{ reason: string; sku?: string }>
  codes: Record<string, Record<string, string>>
  skuConventionWarnings: Array<{ axisKey: string; value: string; code: string; exampleSku: string }>
}

export interface GenerateCombinationsDialogProps {
  open: boolean
  productId: string
  version: number
  parentSku: string
  axes: readonly AxisSummary[]
  family: PlanFamily
  onClose(): void
  onCreated(): void
}

/** The same request is previewed and committed; only the explicit dryRun flag changes. */
export function GenerateCombinationsDialog({ open, productId, version, parentSku, axes, family, onClose, onCreated }: GenerateCombinationsDialogProps) {
  const derived = useMemo(() => deriveSkuPattern(parentSku, family.children, axes), [parentSku, family.children, axes])
  const [added, setAdded] = useState<Record<string, string[]>>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [patternEdit, setPatternEdit] = useState<string | null>(null)
  const [codeEdit, setCodeEdit] = useState<Record<string, Record<string, string>>>({})
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const pattern = patternEdit ?? derived.pattern
  const request = useMemo(() => ({ version, skuPattern: pattern,
    axisValues: Object.fromEntries(axes.map(a => [a.key, [...a.values.map(v => v.code), ...(added[a.key] ?? [])]])),
    valueCodes: Object.fromEntries(axes.map(a => [a.key, { ...derived.codes[a.key], ...codeEdit[a.key] }])),
  }), [version, pattern, axes, added, derived.codes, codeEdit])
  const key = JSON.stringify(request)
  const [reviewedKey, setReviewedKey] = useState('')
  const endpoint = `${getBackendUrl()}/api/products/${encodeURIComponent(productId)}/studio/family/generate`
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setPreviewing(true); setError(null)
    const timer = setTimeout(() => {
      void fetch(endpoint, { method: 'POST', credentials: 'include', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...JSON.parse(key), dryRun: true }) })
        .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); return body as Preview })
        .then(body => { setPreview(body); setReviewedKey(key) })
        .catch(err => { if (!controller.signal.aborted) { setError(err.message); setPreview(null) } })
        .finally(() => { if (!controller.signal.aborted) setPreviewing(false) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [open, endpoint, key])
  const add = (axis: string) => {
    const value = (drafts[axis] ?? '').trim()
    if (value && !request.axisValues[axis].includes(value)) {
      setAdded(current => ({ ...current, [axis]: [...(current[axis] ?? []), value] }))
      setCodeEdit(current => ({ ...current, [axis]: { ...current[axis], [value]: defaultCode(value) } }))
    }
    setDrafts(current => ({ ...current, [axis]: '' }))
  }
  const create = async () => {
    if (reviewedKey !== key || !preview?.counts.willCreate) return
    setBusy(true); setError(null)
    try {
      const response = await fetch(endpoint, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, dryRun: false, previewToken: preview?.previewToken }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.message ?? body.error ?? 'The variants could not be created.')
      onCreated(); onClose()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const count = preview?.counts.willCreate ?? 0
  return <Modal open={open} size="md" title="Generate combinations"
    subtitle={`${parentSku} · ${axes.map(a => a.label).join(' × ')} · every combination that does not exist yet becomes a variant`}
    onClose={() => { if (!busy) onClose() }} footer={<>
      <Button size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button size="sm" variant="primary" disabled={busy || previewing || reviewedKey !== key || !count || !!preview?.skipped.some(row => row.reason === 'sku_collision')}
        title={!count ? 'Every combination already exists — add a value to create variants' : undefined}
        onClick={() => void create()}>{busy ? 'Creating…' : `Create ${count} variants`}</Button>
    </>}>
    <div className={styles.dialog}>
      {axes.map(axis => <div key={axis.key} className={styles.axisSection}>
        <Field label={axis.label} hint={`${axis.values.length} existing values${added[axis.key]?.length ? ` · ${added[axis.key].length} new` : ''}`}>
          <div className={styles.valueRow}>
            {axis.values.map(value => <Tag key={value.code} tone="neutral">{value.label}</Tag>)}
            {(added[axis.key] ?? []).map(value => <TokenChip key={value} removeLabel={`Remove ${value}`} onRemove={() => setAdded(current => ({ ...current, [axis.key]: current[axis.key].filter(v => v !== value) }))}>+ {value}</TokenChip>)}
            <Input size="xs" fieldClassName={styles.addValue} aria-label={`Add a ${axis.label} value`} placeholder="Add a value…" value={drafts[axis.key] ?? ''} disabled={busy}
              onChange={e => setDrafts(current => ({ ...current, [axis.key]: e.target.value }))} onBlur={() => add(axis.key)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(axis.key) } }} />
          </div>
        </Field>
      </div>)}
      <div className={styles.axisSection}>
        <Field label="SKU pattern" hint={derived.derived ? undefined : derived.reason}>
          <Input size="xs" fieldClassName={styles.patternField} aria-label="SKU pattern" value={pattern} disabled={busy} onChange={e => setPatternEdit(e.target.value)} />
        </Field>
        <span className={styles.preview}>
          {Object.entries(preview?.codes ?? {}).map(([axis, codes]) => <span key={axis}>Codes: {Object.entries(codes).map(([value, code]) => `${value} → ${code}`).join(', ')} · </span>)}
          {preview?.plan[0] && <>first new SKU <code>{preview.plan[0].sku}</code> · title, price and stock copy from the nearest sibling</>}
        </span>
        {axes.flatMap(axis => (added[axis.key] ?? []).map(value => <Field key={`${axis.key}:${value}`} label={`Code for ${value}`}>
          <Input size="xs" aria-label={`Code for ${value}`} value={codeEdit[axis.key]?.[value] ?? defaultCode(value)} disabled={busy}
            onChange={e => setCodeEdit(current => ({ ...current, [axis.key]: { ...current[axis.key], [value]: e.target.value } }))} />
        </Field>))}
        {!!preview?.skuConventionWarnings.length && <span className={styles.preview}>Check the SKU convention: {preview.skuConventionWarnings.map(w => `${w.value} → ${w.code}; existing ${w.exampleSku}`).join(' · ')}</span>}
      </div>
      <div className={styles.summary} role="status">{previewing ? 'Checking combinations…' : preview && <span>
        <b>{Object.values(request.axisValues).map(v => v.length).join(' × ')} = {preview.counts.combinations}</b> combinations · {preview.counts.existing} exist · <b>{count} will be created</b> as drafts, excluded from every channel until you include them
      </span>}</div>
      {!!preview?.skipped.filter(row => row.reason === 'sku_collision').length && <p role="alert">SKUs already in use: {preview.skipped.filter(row => row.reason === 'sku_collision').map(row => row.sku).join(', ')}. Edit the pattern before creating.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  </Modal>
}
export { codeFor } from './generatePlan'
