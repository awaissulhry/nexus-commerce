'use client'

/**
 * A first copy of shared products into this business (AE.3). Plan §16.2 and §19.3.
 *
 *   What arrives   Review 1: which products arrive, which SKUs this business already has (link or skip),
 *                  what is created, and what is not copied. Continue sends the review's fingerprint, so
 *                  nothing is created that the person did not see.
 *   Every field    Review 2: the shared catalog-transfer review, unchanged, in its `copy` purpose.
 *   Done           The run links the saved products and copies images. A partial run can run again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Banner, Disclosure, Drawer, Field, KeyValue, Listbox, MetricStrip, Stepper, SummaryTable } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button, Pill, SegmentedControl } from '@/design-system/primitives'
import { TransferReview } from '@/app/products/catalog-transfer/TransferReview'
import type { TransferJob, TransferOptions } from '@/app/products/catalog-transfer/sourceMapping'
import { transferApi } from '@/app/products/catalog-transfer/transferApi'
import { sharingApi, SharingError, type CopyPreview, type CopyRun, type ProductOutcome, type Share } from './sharingApi'
import { attributeTypeWords, bytesWords, count, excludedWords, heldPhotosWords, otherMediaWords, outcomeWords, plannedCopy, runStateWords } from './words'

type Step = 0 | 1 | 2
const STEPS = [{ key: 'arrives', label: 'What arrives' }, { key: 'fields', label: 'Every field' }, { key: 'done', label: 'Done' }]
const TERMINAL = ['done', 'partial', 'failed', 'abandoned']

export function CopyDrawer({ share, runId: initialRunId, onClose }: { share: Share; runId?: string; onClose: () => void }) {
  const [step, setStep] = useState<Step>(0)
  const [options, setOptions] = useState<TransferOptions | null>(null)
  const [run, setRun] = useState<CopyRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [reviewBusy, setReviewBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    transferApi<TransferOptions>('catalog-transfer/options').then((value) => { if (!cancelled) setOptions(value) })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'The review options could not be loaded.') })
    return () => { cancelled = true }
  }, [])

  // Reopening a run: go straight to the step it is on.
  useEffect(() => {
    if (!initialRunId) return
    let cancelled = false
    sharingApi<{ run: CopyRun }>(`assortment-copy-runs/${encodeURIComponent(initialRunId)}`).then(({ run: loaded }) => {
      if (cancelled) return
      setRun(loaded)
      const jobState = loaded.transferJob?.state
      setStep(loaded.state === 'reviewing' && !['COMPLETED', 'PARTIAL', 'FAILED', 'INVALID'].includes(jobState ?? '') ? 1 : 2)
    }).catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'This copy could not be loaded.') })
    return () => { cancelled = true }
  }, [initialRunId])

  const close = () => { if (!busy && !reviewBusy) onClose() }
  const title = `Copy products from ${share.ownerWorkspaceName}`
  return <Drawer open onClose={close} width={900} title={title} subtitle={share.assortmentName ?? undefined}>
    <div className="shared-products-drawer">
      <Stepper steps={STEPS} current={step} />
      {error && <Banner tone="danger">{error}</Banner>}
      {step === 0 && !initialRunId && <WhatArrives share={share} options={options} busy={busy} setBusy={setBusy} onClose={close}
        onConfirmed={(created) => { setRun(created); setStep(created.transferJobId ? 1 : 2) }} />}
      {step === 1 && run?.transferJobId && options && <TransferReview key={run.transferJobId} purpose="copy" jobId={run.transferJobId} options={options}
        onBusyChange={setReviewBusy} onReset={() => {}} onJob={() => {}}
        onSettled={(job: TransferJob) => { if (['COMPLETED', 'PARTIAL', 'FAILED'].includes(job.state)) setStep(2) }} />}
      {step === 1 && !options && !error && <p role="status">Loading the field review…</p>}
      {step === 2 && run && <Finish runId={run.id} onClose={close} />}
      {!run && initialRunId && !error && <p role="status">Loading this copy…</p>}
    </div>
  </Drawer>
}

function WhatArrives({ share, options, busy, setBusy, onClose, onConfirmed }: {
  share: Share
  options: TransferOptions | null
  busy: boolean
  setBusy: (busy: boolean) => void
  onClose: () => void
  onConfirmed: (run: CopyRun) => void
}) {
  // The import page's default is IT; with no marketplace set up, the list still offers it, so the
  // review never waits for a choice nobody can make.
  const markets = useMemo(() => { const codes = [...new Set((options?.markets ?? []).map((m) => m.code))]; return codes.length ? codes : ['IT'] }, [options])
  const [market, setMarket] = useState('')
  const [preview, setPreview] = useState<CopyPreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [choices, setChoices] = useState<Record<string, 'link' | 'skip'>>({})
  const [attempt, setAttempt] = useState(0)

  useEffect(() => { if (!market && markets.length) setMarket(markets.includes('IT') ? 'IT' : markets[0]) }, [market, markets])

  useEffect(() => {
    if (!market) return
    const abort = new AbortController()
    setPreview(null); setLoadError(null)
    sharingApi<{ preview: CopyPreview }>(`assortment-shares/${encodeURIComponent(share.id)}/copy/preview?market=${encodeURIComponent(market)}`, undefined, abort.signal)
      .then(({ preview: loaded }) => {
        setPreview(loaded)
        // Keep a choice the person already made for a SKU that is still a match; default Skip.
        setChoices((current) => Object.fromEntries(loaded.products.filter((p) => p.kind === 'match').map((p) => [p.sku, current[p.sku] ?? 'skip'])))
      })
      .catch((err) => { if (!abort.signal.aborted) setLoadError(err instanceof Error ? err.message : 'What arrives could not be loaded.') })
    return () => abort.abort()
  }, [share.id, market, attempt])

  const plan = useMemo(() => preview ? plannedCopy(preview.products, choices) : null, [preview, choices])

  async function confirm() {
    if (!preview || busy) return
    setBusy(true); setNotice(null)
    try {
      const { run } = await sharingApi<{ run: CopyRun }>(`assortment-shares/${encodeURIComponent(share.id)}/copy`, { market, fingerprint: preview.fingerprint, skuChoices: choices })
      onConfirmed(run)
    } catch (err) {
      if (err instanceof SharingError && err.code === 'copy_review_changed') {
        setNotice('What arrives changed since this review was loaded. It is reloaded below; check it again.')
        setAttempt((n) => n + 1)
      } else setNotice(err instanceof Error ? err.message : 'The copy could not be started.')
    } finally { setBusy(false) }
  }

  const columns: Array<Column<ProductOutcome>> = [
    { key: 'sku', label: 'SKU', render: (p) => p.sku },
    { key: 'variation', label: 'Variation of', render: (p) => p.parentSku ?? 'Not a variation' },
    { key: 'what', label: 'In this business', render: (p) => outcomeWords(p) },
    { key: 'result', label: 'Result', render: (p) => {
      if (p.kind === 'match' && !plan?.skippedByParent.has(p.sku)) {
        return <SegmentedControl ariaLabel={`Link or skip ${p.sku}`} size="sm" value={choices[p.sku] ?? 'skip'}
          onChange={(value) => setChoices((current) => ({ ...current, [p.sku]: value as 'link' | 'skip' }))}
          options={[{ value: 'link', label: 'Link' }, { value: 'skip', label: 'Skip' }]} />
      }
      const words = resultWords(p, plan)
      return <Pill tone={words.tone}>{words.label}</Pill>
    } },
  ]

  if (!options) return <p role="status">Loading marketplaces…</p>
  return <div className="shared-products-drawer">
    <Disclosure summary={`Reference marketplace: ${market || 'choose one'}`}>
      <Field label="Reference marketplace" hint="Decides which product details and attribute rules the review uses. A copy never creates channel listings.">
        <Listbox value={market} onChange={setMarket} options={markets.map((code) => ({ value: code, label: code }))} disabled={busy} width="100%" />
      </Field>
    </Disclosure>
    {loadError && <Banner tone="danger" action={<Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>}>{loadError}</Banner>}
    {notice && <Banner tone="warning">{notice}</Banner>}
    {!preview && !loadError && <p role="status">Reading what {share.ownerWorkspaceName} shares…</p>}
    {preview && plan && <>
      <MetricStrip metrics={[
        { label: 'New products', value: preview.counts.new, hint: 'created in this business' },
        { label: 'SKU already here', value: preview.counts.match, hint: 'link or skip each one' },
        { label: 'Already linked', value: preview.counts.linked },
        { label: 'Cannot copy', value: preview.counts.blocked },
        { label: 'Images', value: preview.counts.images, hint: bytesWords(preview.imageBytes) },
      ]} />
      {preview.counts.mediaNotCopied > 0 && <p className="shared-products-note">{otherMediaWords(preview.counts.mediaNotCopied)} not copied yet.</p>}
      {preview.counts.match > 0 && <p>This business already has {count(preview.counts.match, 'product')} with the same SKU. <strong>Link</strong> replaces its shared details with the ones from {share.ownerWorkspaceName}; you see every change in the next step. <strong>Skip</strong> leaves it as it is. A variation follows its main product.</p>}
      <DataGrid ariaLabel="Shared products and what happens to each" columns={columns} rows={preview.products} rowKey={(p) => p.sku}
        emptyState={<p>This assortment has no products right now.</p>} />
      <CreatedHere preview={preview} />
      {preview.conflicts.length > 0 && <Banner tone="warning" title={`${count(preview.conflicts.length, 'attribute')} cannot be copied`}>
        {preview.conflicts.map((c) => <p key={c.code}>{c.label}: {share.ownerWorkspaceName} stores {attributeTypeWords(c.source)}; this business stores {attributeTypeWords(c.follower)}. Its values are not copied.</p>)}
      </Banner>}
      {preview.excluded.length > 0 && <Disclosure summary={`${count(preview.excluded.length, 'kind of detail', 'kinds of detail')} not copied`}>
        <SummaryTable label="Details that are not copied" columns={['Detail', 'Why']} rows={preview.excluded.map((e) => ({ id: `${e.field}:${e.group ?? e.reason}`, cells: [e.label, excludedWords(e)] }))} />
      </Disclosure>}
      <div className="business-profile-actions">
        <Button disabled={busy} onClick={onClose}>Cancel</Button>
        {plan.included > 0
          ? <Button variant="primary" disabled={busy} onClick={() => { void confirm() }}>{busy ? 'Preparing the field review…' : `Continue with ${count(plan.included, 'product')}`}</Button>
          : <p className="shared-products-note">Nothing to copy: every product is already linked, skipped or cannot be copied.</p>}
      </div>
    </>}
  </div>
}

function resultWords(p: ProductOutcome, plan: ReturnType<typeof plannedCopy> | null): { label: string; tone: 'success' | 'neutral' | 'warning' | 'info' } {
  if (plan?.skippedByParent.has(p.sku)) return { label: 'Skipped with its main product', tone: 'neutral' }
  switch (p.kind) {
    case 'new': return { label: 'Copy', tone: 'success' }
    case 'linked': return { label: 'Nothing to do', tone: 'neutral' }
    case 'blocked': return { label: 'Not copied', tone: 'warning' }
    case 'match': return { label: 'Skipped', tone: 'neutral' }
  }
}

function CreatedHere({ preview }: { preview: CopyPreview }) {
  const c = preview.create
  const rows = [
    c.families.length ? { id: 'families', cells: ['Product families', c.families.map((f) => f.label).join(', ')] } : null,
    c.attributes.length ? { id: 'attributes', cells: ['Attributes', c.attributes.map((a) => a.label).join(', ')] } : null,
    c.options.length ? { id: 'options', cells: ['Choices for attributes', count(c.options.length, 'choice')] } : null,
    c.categories.length ? { id: 'categories', cells: ['Categories', c.categories.map((cat) => cat.names.join(' › ')).join(', ')] } : null,
  ].filter((row): row is { id: string; cells: string[] } => row !== null)
  if (rows.length === 0) return <p className="shared-products-note">Every product family, attribute and category these products use already exists in this business.</p>
  return <SummaryTable label="Created in this business when you continue" columns={['Created', 'Names']} rows={rows} />
}

/** Finishes the run as soon as its review is saved, and says what happened. */
function Finish({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [run, setRun] = useState<CopyRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const advance = useCallback(async () => {
    setBusy(true); setError(null)
    try {
      const { run: next } = await sharingApi<{ run: CopyRun }>(`assortment-copy-runs/${encodeURIComponent(runId)}/advance`, {})
      setRun(next)
      // Saving can still be running; the run finishes as soon as it is done.
      if (!TERMINAL.includes(next.state)) timer.current = setTimeout(() => { void advance() }, 2000)
    } catch (err) { setError(err instanceof Error ? err.message : 'This copy could not be finished.') }
    finally { setBusy(false) }
  }, [runId])
  // Opening a finished copy only shows it; only a copy still in progress is moved forward.
  useEffect(() => {
    let cancelled = false
    sharingApi<{ run: CopyRun }>(`assortment-copy-runs/${encodeURIComponent(runId)}`)
      .then(({ run: loaded }) => { if (cancelled) return; setRun(loaded); if (!TERMINAL.includes(loaded.state)) void advance() })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : 'This copy could not be loaded.') })
    return () => { cancelled = true; clearTimeout(timer.current) }
  }, [runId, advance])

  if (error) return <Banner tone="danger" action={<Button onClick={() => { void advance() }}>Retry</Button>}>{error}</Banner>
  if (!run) return <p role="status">Finishing the copy…</p>
  const words = runStateWords(run.state)
  const c = run.counts
  return <div className="shared-products-drawer">
    <p role="status"><Pill tone={words.tone}>{words.label}</Pill></p>
    {!TERMINAL.includes(run.state) && <p>Saving and linking continue in Nexus. You can close this; the copy finishes on its own.</p>}
    {c && <KeyValue columns={2} items={[
      { label: 'Linked products', value: count(c.linked + c.alreadyLinked, 'product') },
      { label: 'Images', value: `${count(c.imagesCopied, 'file')} copied · ${count(c.imagesAddressed, 'web address', 'web addresses')} kept`, hint: c.imagesReused ? `${count(c.imagesReused, 'image')} already here` : undefined },
      { label: 'Prices, status and type set', value: count(c.managedApplied, 'value') },
      { label: 'Not saved', value: count(c.notSaved, 'product'), hint: c.notSaved ? 'Refused in the field review' : undefined },
    ]} />}
    {run.state === 'abandoned' && <Banner tone="warning" title="This copy stopped">{run.error ?? 'The field review was not saved.'} Start a new copy to try again.</Banner>}
    {run.state === 'failed' && <Banner tone="danger" title="This copy could not start">{run.error}</Banner>}
    {run.state === 'partial' && <Banner tone="warning" title="Some steps did not finish" action={<Button disabled={busy} onClick={() => { void advance() }}>{busy ? 'Finishing…' : 'Finish again'}</Button>}>
      {(run.error ?? '').split('\n').filter(Boolean).map((line) => <p key={line}>{line}</p>)}
      <p>Finishing again only does what is missing.</p>
    </Banner>}
    {c && (c.imagesHeld ?? 0) > 0 && <p className="shared-products-note">{heldPhotosWords(c.imagesHeld ?? 0)}</p>}
    {c && c.mediaNotCopied > 0 && <p className="shared-products-note">{c.mediaNotCopied === 1 ? '1 video, 3D model or document was' : `${c.mediaNotCopied} videos, 3D models or documents were`} not copied.</p>}
    <div className="business-profile-actions"><Button variant="primary" onClick={onClose}>Close</Button></div>
  </div>
}
