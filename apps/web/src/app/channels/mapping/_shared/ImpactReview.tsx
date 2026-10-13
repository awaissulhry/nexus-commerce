'use client'

import { useEffect, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { productWorkspaceHref } from '@/app/_shared/product-workspace-href'
import { Banner, KeyValue, Pagination, ProgressBar } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import { Button } from '@/design-system/primitives'
import { inlineValue, plainValue } from '@/design-system/lib/format'
import * as api from './api'
import styles from './impactReview.module.css'

// A value in plain words, whole — never raw JSON (grid audit wave 3, D10).
const value = (v: unknown) => v == null ? 'Missing' : plainValue(v)

/** Review of a durable mapping operation, also reachable directly by its job URL. */
export function ImpactReview({ jobId, onApplied }: { jobId: string; onApplied?: () => void | Promise<void> }) {
  const [impact, setImpact] = useState<api.MappingImpact | null>(null)
  const [page, setPage] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [assignmentHref, setAssignmentHref] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    setImpact(null)
    const poll = async () => {
      try {
        const result = await api.readImpact(jobId, page, controller.signal)
        if (controller.signal.aborted) return
        setImpact(result); setError(null)
        if (result.state === 'MAPPING_SCANNING') timer = setTimeout(poll, 1500)
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [jobId, page])
  const activate = async () => {
    setBusy(true); setError(null)
    try { await api.activateImpact(jobId); setImpact(old => old ? { ...old, state: 'MAPPING_APPLIED' } : old); await onApplied?.() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <div style={{ display: 'grid', gap: 'var(--nds-space-12)', minWidth: 0 }}>
    {error && <Banner tone="danger" title="Review could not complete">{error}</Banner>}
    {!impact ? <ProgressBar indeterminate ariaLabel="Loading mapping impact" /> : <>
      <Banner tone="info" title={impact.categoryChange ? 'Apply this category assignment' : 'Keep applying this rule to matching records'}>
        {impact.channel} · {impact.market} · {impact.categoryChange ? 'Selected internal category and its inheriting products' : impact.category ? `Marketplace category ${impact.category}` : 'All marketplace categories'} · {impact.presentationChange?.rule?.scope.accountId ? 'One account only' : 'All accounts'}.
        {impact.presentationChange?.rule && ` Matching criteria: ${inlineValue(impact.presentationChange.rule.scope)}. Priority ${impact.presentationChange.rule.priority}.`}
        Applies to current and future matching products. Changes derived listing data; shared facts and explicit overrides are preserved. Publication is a separate step.
      </Banner>
      {impact.state === 'MAPPING_SCANNING' && <>
        <ProgressBar value={impact.total ? impact.processed / impact.total * 100 : 0} ariaLabel="Scanning catalog impact" />
        <p role="status">Scanned {impact.processed} of {impact.total} products. Counts below are still being calculated.</p>
      </>}
      {impact.state === 'MAPPING_STALE' && <Banner tone="warning" title="Rules or resolution inputs changed during review">Close this review, reload the current rules and preview again.</Banner>}
      {impact.state === 'MAPPING_FAILED' && <Banner tone="danger" title="Impact calculation failed">Three attempts failed. No mapping was changed. Reopen the rule and start a new preview.</Banner>}
      {impact.counts.introducedInvalid > 0 && <Banner tone="danger" title="Draft introduces invalid outputs">Correct the draft and preview again before activation.</Banner>}
      <KeyValue columns={2} items={[
        { label: 'Matched products', value: impact.counts.matchedProducts },
        { label: 'Matched existing listings', value: impact.counts.matchedListings ?? 0 },
        { label: 'Listings with changed values', value: impact.counts.affectedListings },
        { label: 'Changed effective values', value: impact.counts.changed },
        { label: 'Preserved overrides', value: impact.counts.preservedOverrides },
        { label: 'Invalid outputs', value: impact.counts.invalid },
        { label: 'Missing outputs (including optional fields)', value: impact.counts.missing ?? 0 },
        { label: 'Outputs with conflicts', value: impact.counts.conflicts ?? 0 },
        { label: 'Products outside the matching scope', value: impact.counts.excluded },
      ]} />
      {impact.restoreRevision && <Banner tone="info">Restores saved revision {impact.restoreRevision.version} across this marketplace. The complete current catalog is checked before activation.</Banner>}
      {impact.expression && <p>Business rule: {impact.expression.name}. All fields that depend on this formula are included.</p>}
      {impact.categoryChange && <p>Shared category: {impact.categoryChange.categoryId}. Existing listing categories remain explicit exceptions.</p>}
      {impact.cloneSource && <p>Clone source: {impact.cloneSource.channel} · {impact.cloneSource.market}. {impact.cloneSource.cloned} fields copied. Excluded fields absent from the target schema: {impact.cloneSource.skippedFields?.join(', ') || 'None'}.</p>}
      <p>{impact.inputPolicy}</p>
      <p>Rule version {impact.version}. Review started {new Date(impact.createdAt).toLocaleString()}. The table shows one batch; use the page controls to inspect the complete scanned set.</p>
      {/* Now → New, whole and wrapping, in columns that fit the window (grid audit wave 3, D10): the listing in words, not its
          raw id or the account's. */}
      <DataGrid ariaLabel="Mapping impact by destination" size="md" headerMenus={false} rows={impact.rows} rowKey={r => JSON.stringify([r.productId, r.listingId, r.field])} columns={[
        { key: 'product', label: 'Product / destination', width: 200, render: r => <span className={styles.lines}><Button asChild inline variant="link"><Link href={productWorkspaceHref({ productId: r.productId, id: r.listingId ?? undefined, channel: impact.channel, marketplace: impact.market, channelConnectionId: r.accountId, aliasKey: r.aliasKey }, r.field)}>{r.sku}</Link></Button><span>{r.listingId ? 'Existing listing' : 'No listing yet'} · {r.market ?? impact.market} · {r.language ?? 'Market language'}</span></span> },
        { key: 'field', label: 'Field', width: 140, render: r => <span className={styles.lines}>{r.field}</span> },
        { key: 'before', label: 'Before', width: 200, render: r => <span className={styles.value}>{value(r.before)}</span> },
        { key: 'after', label: 'After', width: 200, render: r => <span className={styles.value}>{value(r.after)}</span> },
        { key: 'result', label: 'Result', width: 120, render: r => <span className={styles.lines}>{r.errors.join(' · ') || (r.preserved ? 'Override preserved' : r.changed ? 'Will change' : 'Unchanged')}</span> },
      ]} />
      {impact.pages > 1 && <Pagination page={page + 1} pageCount={impact.pages} onPage={p => setPage(p - 1)} />}
      {impact.state === 'MAPPING_APPLIED' ? <Banner tone="success" title={impact.categoryChange ? 'Category assignment activated' : 'Rule activated'}>Matching products use this rule on their next resolution. No listings were published.</Banner>
        : <Button variant="primary" disabled={busy || !!impact.presentationChange?.rule?.order || impact.state !== 'MAPPING_REVIEW' || impact.counts.introducedInvalid > 0} onClick={() => void activate()}>{busy ? 'Activating…' : impact.categoryChange ? 'Activate category assignment' : 'Activate standing rule'}</Button>}
      {impact.presentationChange?.rule?.themeId && !impact.presentationChange.rule.order && impact.state === 'MAPPING_REVIEW' && <>
        <p>Apply once customizes the existing changed listings in this review. Current overrides are preserved; future matching listings keep their existing defaults. Stored shared-data corrections belong in Information.</p>
        <Button disabled={busy} onClick={() => {
          setBusy(true); setError(null)
          void api.reviewOneTimeAssignment(jobId).then(result => setAssignmentHref(result.href)).catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false))
        }}>Review one-time theme assignments</Button>
        {assignmentHref && <Button asChild variant="link"><Link href={assignmentHref}>Open exact assignments and apply</Link></Button>}
      </>}
      {impact.presentationChange?.rule?.order && <Banner tone="warning">Variation-order activation is waiting for publisher integration. This saved preview can be inspected; activation is blocked until all consumers use the same order.</Banner>}
      <Button asChild inline variant="link"><Link href={`/channels/mapping/impact/${jobId}`}>Open this resumable review</Link></Button>
    </>}
  </div>
}
