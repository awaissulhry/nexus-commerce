'use client'

/**
 * MX.P — the verb PREVIEW dialog (design §3.8, Appendix A): COLLECT → PREFLIGHT → CONFIRM.
 *
 *   1. the parameter form the action DECLARES (`collect`: a number in the market currency, a
 *      percentage, a source coordinate, a fulfilment method) — the page renders it, the registry says
 *      what it is;
 *   2. the preview, re-run on every change: `old → new` per cell (`SummaryTable`: Variant · Coordinate
 *      · From → To · Note), the refusals by cause, the notices (`Amazon EU: this covers IT DE FR ES`,
 *      `Preview — nothing is sent`);
 *   3. the confirm level the PREVIEW chose — `none` · `confirm` · `type-to-confirm` (`Type <word> to
 *      confirm`) — and the footer `Cancel` / `Apply to N cells`.
 *
 * The dialog computes nothing: every number in it came back from `previewVerb` (preview mode) or the
 * verbs endpoint (live). A held Apply is `aria-disabled` with its reason, never a silent `disabled`.
 */
import { useEffect, useMemo, useState } from 'react'

import { Banner, Listbox, Modal, SummaryTable } from '@/design-system/components'
import { Button, Input } from '@/design-system/primitives'

import type { FulfilmentMethod, MatrixRead, MatrixVerbParams, MatrixVerbRequest, MatrixVerbTarget, VerbPreview, VerbRefusal } from '../contract'
import type { MatrixVerbSpec } from '@/design-system/grid'

export interface VerbDialogInitial { value?: number; percent?: number; fromCoordinateKey?: string; method?: FulfilmentMethod }

export interface VerbDialogProps {
  open: boolean
  spec: MatrixVerbSpec | null
  targets: readonly MatrixVerbTarget[]
  /** `3 rows on Amazon · IT` — what the selection spans, for the subtitle. */
  targetLabel: string
  read: MatrixRead | null
  initial?: VerbDialogInitial
  coordinateOptions: ReadonlyArray<{ value: string; label: string }>
  currency: string
  previewRun: (req: MatrixVerbRequest) => Promise<VerbPreview>
  busy: boolean
  onApply: (preview: VerbPreview) => Promise<unknown>
  onClose: () => void
}

const REFUSAL_WORD: Record<VerbRefusal['kind'], string> = {
  'amazon-managed': 'Amazon-managed', 'no-listing': 'No listing', formula: 'Formula', permission: 'Permission', 'not-applicable': 'Not applicable', guard: 'Guard', currency: 'Currency',
}

function paramsFor(spec: MatrixVerbSpec, form: { value: string; percent: string; from: string; method: string }): MatrixVerbParams | null {
  switch (spec.id) {
    case 'set-price': { const v = Number(form.value); return form.value !== '' && Number.isFinite(v) ? { verb: 'set-price', value: v } : null }
    case 'adjust-prices': { const v = Number(form.percent); return form.percent !== '' && Number.isFinite(v) ? { verb: 'adjust-prices', percent: v } : null }
    case 'copy-prices': return form.from ? { verb: 'copy-prices', fromCoordinateKey: form.from } : null
    case 'pin-quantity': { const v = Number(form.value); return form.value !== '' && Number.isFinite(v) ? { verb: 'pin-quantity', value: v } : null }
    case 'set-buffer': { const v = Number(form.value); return form.value !== '' && Number.isFinite(v) ? { verb: 'set-buffer', value: v } : null }
    case 'set-fulfilment': return form.method === 'FBA' || form.method === 'FBM' || form.method === 'MCF' ? { verb: 'set-fulfilment', method: form.method } : null
    case 'set-follow': return { verb: 'set-follow' }
    case 'pause-sync': return { verb: 'pause-sync' }
    case 'resume-sync': return { verb: 'resume-sync' }
    case 'push-now': return { verb: 'push-now' }
    case 'retry-sync': return { verb: 'retry-sync' }
  }
}

export function VerbDialog(p: VerbDialogProps) {
  const { open, spec, targets, read, initial, previewRun, onApply, onClose } = p
  const [form, setForm] = useState({ value: '', percent: '', from: '', method: '' })
  const [typed, setTyped] = useState('')
  const [preview, setPreview] = useState<VerbPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  /* A fresh form per opening — a value typed for one verb must not leak into the next. */
  useEffect(() => {
    if (!open) return
    setForm({
      value: initial?.value != null ? String(initial.value) : '',
      percent: initial?.percent != null ? String(initial.percent) : '',
      from: initial?.fromCoordinateKey ?? '',
      method: initial?.method ?? '',
    })
    setTyped('')
    setPreview(null)
    setProblem(null)
  }, [open, spec?.id, initial])

  const params = useMemo(() => (spec ? paramsFor(spec, form) : null), [spec, form])

  useEffect(() => {
    if (!open || !spec || !params) { setPreview(null); return }
    let alive = true
    previewRun({ params, targets: [...targets], commit: false })
      .then((pv) => { if (alive) { setPreview(pv); setProblem(null) } })
      .catch((e) => { if (alive) { setPreview(null); setProblem(e instanceof Error ? e.message : String(e)) } })
    return () => { alive = false }
  }, [open, spec, params, targets, previewRun])

  const coordLabel = (key: string) => read?.coordinates.find((c) => c.key === key)?.label ?? key
  /* The fulfilment vocabulary is the UNION of what the targets' coordinates offer — a select that
     listed `MCF` beside an Amazon row would offer a method the preview then refuses by name. */
  const methodOptions = useMemo(() => {
    const seen = new Set<FulfilmentMethod>()
    for (const t of targets) for (const m of read?.coordinates.find((c) => c.key === t.coordinateKey)?.vocabulary.fulfilment ?? []) seen.add(m)
    return [...seen].map((m) => ({ value: m, label: m }))
  }, [targets, read])

  const changes = preview?.changes.length ?? 0
  const skipped = preview?.refusals.filter((r) => r.kind === 'amazon-managed').length ?? 0
  const refused = (preview?.refusals.length ?? 0) - skipped
  const needsWord = preview?.confirm === 'type-to-confirm' && !!preview.confirmWord
  const wordOk = !needsWord || typed.trim().toUpperCase() === preview!.confirmWord!.toUpperCase()
  const applyHeld =
    !spec ? 'No verb' : !params ? 'Fill in the form first' : problem ? problem : !preview ? 'Previewing…' : changes === 0 ? 'Nothing would change' : !wordOk ? `Type ${preview.confirmWord} to confirm` : p.busy ? 'Applying…' : null

  const field = spec?.collect ?? null
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={spec?.label.replace(/…$/, '') ?? 'Verb'}
      subtitle={p.targetLabel}
      className="nds-matrix-verb-dialog"
      footer={
        <>
          <span className="nds-cell-muted nds-matrix-verb-summary" role="status">
            {preview ? `${changes} ${changes === 1 ? 'cell changes' : 'cells change'} · ${refused} refused · ${skipped} skipped (Amazon-managed)` : problem ? problem : params ? 'Previewing…' : ''}
          </span>
          <span className="grow" />
          <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            variant="primary"
            aria-disabled={!!applyHeld}
            className={applyHeld ? 'held' : undefined}
            title={applyHeld ?? `Apply to ${changes} ${changes === 1 ? 'cell' : 'cells'}`}
            onClick={() => { if (applyHeld || !preview) return; void onApply(preview) }}
          >
            {`Apply to ${changes} ${changes === 1 ? 'cell' : 'cells'}`}
          </Button>
        </>
      }
    >
      <div className="nds-matrix-verb-body">
        {field && (
          <div className="nds-matrix-verb-form">
            {field.kind === 'number' && (
              <label className="nds-matrix-verb-field">
                <span>{field.label}</span>
                <Input
                  size="sm" type="number" autoFocus
                  min={field.min ?? 0} step={field.step ?? (field.integer ? 1 : 0.01)}
                  prefix={field.currency ? field.currency : undefined}
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  aria-label={field.label}
                />
              </label>
            )}
            {field.kind === 'percent' && (
              <label className="nds-matrix-verb-field">
                <span>{field.label}</span>
                <Input size="sm" type="number" autoFocus step={0.5} suffix="%" value={form.percent} onChange={(e) => setForm((f) => ({ ...f, percent: e.target.value }))} aria-label={field.label} placeholder="−5" />
              </label>
            )}
            {field.kind === 'coordinate' && (
              <label className="nds-matrix-verb-field">
                <span>{field.label}</span>
                <Listbox size="sm" ariaLabel={field.label} options={[...p.coordinateOptions]} value={form.from} onChange={(v) => setForm((f) => ({ ...f, from: v }))} placeholder="Choose a coordinate…" width={260} />
              </label>
            )}
            {field.kind === 'fulfilment' && (
              <label className="nds-matrix-verb-field">
                <span>{field.label}</span>
                <Listbox size="sm" ariaLabel={field.label} options={methodOptions} value={form.method} onChange={(v) => setForm((f) => ({ ...f, method: v }))} placeholder="Choose a method…" width={200} />
              </label>
            )}
          </div>
        )}

        {preview?.notices.map((n) => (
          <Banner key={n} tone={n.startsWith('Preview') ? 'info' : 'warning'} className="nds-matrix-verb-notice">{n}</Banner>
        ))}
        {problem && <Banner tone="danger">{problem}</Banner>}

        {preview && changes > 0 && (
          <div className="nds-matrix-verb-table">
            <SummaryTable
              label="What would change"
              columns={['Variant', 'Coordinate', 'From → To', 'Note']}
              rows={preview.changes.map((c, i) => ({
                id: `${c.rowId}|${c.coordinateKey}|${c.cell}|${i}`,
                cells: [<code key="s" className="nds-matrix-mono">{c.sku}</code>, coordLabel(c.coordinateKey), <span key="ft">{c.fromLabel} → <b>{c.toLabel}</b></span>, c.note ?? ''],
              }))}
            />
          </div>
        )}
        {preview && changes === 0 && !problem && (
          <p className="nds-cell-muted nds-matrix-verb-empty">Nothing would change on this selection.</p>
        )}

        {preview && preview.refusals.length > 0 && (
          <div className="nds-matrix-verb-refusals">
            <p className="nds-matrix-verb-refusals-title">{preview.refusals.length} {preview.refusals.length === 1 ? 'refusal' : 'refusals'}</p>
            <ul>
              {preview.refusals.map((r, i) => (
                <li key={`${r.rowId}|${r.coordinateKey}|${i}`}>
                  <code className="nds-matrix-mono">{r.sku}</code> · {coordLabel(r.coordinateKey)} · <b>{REFUSAL_WORD[r.kind]}</b> — {r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {needsWord && (
          <label className="nds-matrix-verb-field nds-matrix-verb-confirm">
            <span>Type {preview!.confirmWord} to confirm</span>
            <Input size="sm" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={`Type ${preview!.confirmWord} to confirm`} autoComplete="off" />
          </label>
        )}
      </div>
    </Modal>
  )
}
