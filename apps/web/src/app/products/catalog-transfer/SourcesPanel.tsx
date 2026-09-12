'use client'
import { useEffect, useState } from 'react'
import { Button, Input } from '@/design-system/primitives'
import { Banner, Card, Disclosure, Field, Listbox, Pagination } from '@/design-system/components'
import { DataGrid } from '@/design-system/grid/datagrid'
import type { SourcePreset } from './sourceMapping'
import { transferApi } from './transferApi'
import styles from './transfer.module.css'

interface History { id: string; jobName: string; targetEntity: string; status: string; totalRows: number; createdAt: string }
export function SourcesPanel({ onJob }: { onJob: (id: string) => void }) {
  const [presets, setPresets] = useState<SourcePreset[]>([]), [history, setHistory] = useState<History[]>([]), [schedules, setSchedules] = useState<SourcePreset[]>([])
  const [page, setPage] = useState(1), [total, setTotal] = useState(0), [presetPage, setPresetPage] = useState(1), [presetTotal, setPresetTotal] = useState(0)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  const [presetId, setPresetId] = useState(''), [url, setUrl] = useState(''), [cron, setCron] = useState('0 6 * * *'), [execution, setExecution] = useState<'review' | 'automatic'>('review')
  useEffect(() => {
    const abort = new AbortController()
    void Promise.all([
      transferApi<{ presets: SourcePreset[]; total: number }>(`catalog-transfer/source/presets?page=${presetPage}`, undefined, abort.signal),
      transferApi<{ jobs: History[]; total: number }>(`catalog-transfer/source/history?page=${page}`, undefined, abort.signal),
      transferApi<{ schedules: SourcePreset[] }>('scheduled-imports', undefined, abort.signal),
    ]).then(([p, h, s]) => { if (!abort.signal.aborted) { setPresets(p.presets); setPresetTotal(p.total); setHistory(h.jobs); setTotal(h.total); setSchedules(s.schedules) } }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [page, presetPage, revision])
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); setRevision(r => r + 1) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  return <div className={styles.stack}>
    {error && <Banner tone="danger">{error}</Banner>}
    <Card header={<h2>Saved incoming mappings</h2>} description="Reuse the same source columns and explicit ownership policy for uploads or recurring URL imports."><div className={styles.stack}>
      <p>{presetTotal} saved source definitions · page {presetPage} of {Math.max(1, Math.ceil(presetTotal / 50))}</p>
      {presets.map(p => <Disclosure key={p.id} summary={p.name}><div className={styles.stack}>
        <p>SKU column: {p.columnMapping.skuColumn}. Shared data: {p.columnMapping.policy.shared}. Listing changes: {p.columnMapping.policy.overrides}.</p>
        <DataGrid ariaLabel={`Column destinations for ${p.name}`} columns={[
          { key: 'source', label: 'Source', render: b => b.source }, { key: 'field', label: 'Destination', render: b => `${b.entity} · ${b.field}` },
          { key: 'scope', label: 'Coordinates', render: b => [b.channel, b.accountId, b.marketplace, b.aliasKey, b.locale].filter(Boolean).map(v => v && 'column' in v ? `column: ${v.column}` : v && 'value' in v ? v.value : '').join(' · ') },
        ]} rows={p.columnMapping.bindings} rowKey={b => JSON.stringify(b)} size="sm" />
        {!p.enabled && <div><Button disabled={busy} onClick={() => run(async () => { await transferApi(`catalog-transfer/source/presets/${p.id}?version=${encodeURIComponent(p.updatedAt)}`, undefined, undefined, 'DELETE') })}>Delete mapping {p.name}</Button></div>}
      </div></Disclosure>)}
      <Pagination page={presetPage} pageCount={Math.max(1, Math.ceil(presetTotal / 50))} onPage={setPresetPage} />
      <Disclosure summary="Create a URL import schedule"><div className={styles.stack}>
        <div className={styles.fields}>
          <Field label="Source mapping for schedule"><Listbox options={presets.map(p => ({ value: p.id, label: p.name }))} value={presetId} onChange={setPresetId} disabled={busy} width="100%" /></Field>
          <Field label="Source URL"><Input type="url" value={url} onChange={e => setUrl(e.target.value)} disabled={busy} /></Field>
          <Field label="Schedule (cron)" hint="Europe/Rome time. For example, 0 6 * * * runs at 06:00 daily."><Input value={cron} onChange={e => setCron(e.target.value)} disabled={busy} /></Field>
          <Field label="After each source preview"><Listbox value={execution} options={[{ value: 'review', label: 'Wait for my review and apply' }, { value: 'automatic', label: 'Apply valid previews automatically' }]} onChange={v => setExecution(v as typeof execution)} disabled={busy} width="100%" /></Field>
        </div>
        <p className={styles.secondary}>Each run freezes the source and record versions. Validation failures block apply; concurrent changes become record refusals. Automatic runs use this saved ownership policy.</p>
        <div><Button disabled={busy || !presetId || !url.trim() || !cron.trim()} onClick={() => run(async () => {
          const preset = presets.find(p => p.id === presetId); if (!preset) return
          await transferApi('scheduled-imports', { name: preset.name, source: 'url', sourceUrl: url, targetEntity: 'catalog-source-v1', columnMapping: { ...preset.columnMapping, execution }, cronExpression: cron, timezone: 'Europe/Rome' })
          setUrl('')
        })}>Create schedule</Button></div>
      </div></Disclosure>
    </div></Card>
    <Card header={<h2>Scheduled sources</h2>}><div className={styles.stack}>
      {schedules.length ? schedules.map(s => <Disclosure key={s.id} summary={`${s.name} · ${s.enabled ? 'Enabled' : 'Paused'} · ${s.lastStatus ?? 'No runs yet'}`}><div className={styles.stack}>
        <p className={styles.wrap}>{s.sourceUrl} · {s.cronExpression} · Next run: {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : 'None'}</p>
        {s.lastError && <Banner tone="danger">{s.lastError}</Banner>}
        <div className={styles.actions}>
          <Button disabled={busy} onClick={() => run(async () => { await transferApi(`scheduled-imports/${s.id}/enabled`, { enabled: !s.enabled, version: s.updatedAt }, undefined, 'PATCH') })}>{s.enabled ? 'Pause' : 'Enable'} {s.name}</Button>
          {s.enabled && <Button disabled={busy} onClick={() => run(async () => { const r = await transferApi<{ jobId: string }>(`scheduled-imports/${s.id}/run`, { version: s.updatedAt }); onJob(r.jobId) })}>Fetch source now</Button>}
          {s.lastJobId && <Button onClick={() => onJob(s.lastJobId!)}>Open last import</Button>}
        </div>
      </div></Disclosure>) : <p>No URL schedules configured.</p>}
    </div></Card>
    <Card header={<h2>Import history</h2>}><div className={styles.stack}>
      <p>{total} imports · page {page} of {Math.max(1, Math.ceil(total / 50))}</p>
      <DataGrid ariaLabel="Import history" columns={[
        { key: 'name', label: 'Source', render: j => j.jobName }, { key: 'state', label: 'State', render: j => j.status },
        { key: 'records', label: 'Records', render: j => j.totalRows }, { key: 'date', label: 'Created', render: j => new Date(j.createdAt).toLocaleString() },
        { key: 'open', label: 'Review', render: j => j.targetEntity === 'catalog-transfer-v2' ? <Button size="sm" onClick={() => onJob(j.id)}>Open import</Button> : <span>Legacy history · upload again for a versioned review</span> },
      ]} rows={history} rowKey={j => j.id} size="sm" />
      <Pagination page={page} pageCount={Math.max(1, Math.ceil(total / 50))} onPage={setPage} />
    </div></Card>
  </div>
}
