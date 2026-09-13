'use client'
import { useEffect, useState } from 'react'
import Link from '@/lib/workspaces/Link'
import { PageHeader } from '@/design-system/patterns/PageHeader'
import { Button, Input, Textarea } from '@/design-system/primitives'
import { Banner, Card, Disclosure, Field, FileDropzone, Listbox, Tabs, tabPanelProps } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'
import { SourceMappingEditor } from './SourceMappingEditor'
import { TransferReview } from './TransferReview'
import { SourcesPanel } from './SourcesPanel'
import { WorkbookTemplate, type WorkbookSetup } from './WorkbookTemplate'
import { defaultSourceMapping, type SourceInspection, type SourceMapping, type TransferJob, type TransferOptions } from './sourceMapping'
import { transferApi } from './transferApi'
import { destinationMarkets } from './workbookSelection'
import type { TransferMode } from '@nexus/shared/catalog-transfer'
import styles from './transfer.module.css'

async function download(path: string, payload: unknown, filename: string) {
  const response = await fetch(`${getBackendUrl()}/api/catalog-transfer/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), credentials: 'include' })
  if (!response.ok) throw new Error((await response.json()).error ?? 'Download failed')
  const blob = await response.blob(), url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = blob.type.split(';')[0] === 'application/zip' ? filename.replace(/\.xlsx$/i, '.zip') : filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export default function CatalogTransferPage() {
  const [options, setOptions] = useState<TransferOptions | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [tab, setTab] = useState('template'), [market, setMarket] = useState('IT'), [familyId, setFamilyId] = useState(''), [mode, setMode] = useState<TransferMode>('update')
  const [loadAttempt, setLoadAttempt] = useState(0), [downloaded, setDownloaded] = useState('')
  const [workbookSetup, setWorkbookSetup] = useState<WorkbookSetup>({ destinations: [], extras: [], regionalLanguages: '' })
  const [format, setFormat] = useState('catalog'), [file, setFile] = useState<File | null>(null), [url, setUrl] = useState('')
  const [source, setSource] = useState<SourceInspection | null>(null), [mapping, setMapping] = useState<SourceMapping | null>(null), [jobId, setJobId] = useState('')
  const [blankPolicy, setBlankPolicy] = useState<'ignore' | 'clear'>('ignore')
  const [accountId, setAccountId] = useState(''), [skus, setSkus] = useState(''), [purpose, setPurpose] = useState('editing'), [exportMarkets, setExportMarkets] = useState('all')
  useEffect(() => {
    const abort = new AbortController()
    void transferApi<TransferOptions>('catalog-transfer/options', undefined, abort.signal).then(o => { if (!abort.signal.aborted) setOptions(o) }).catch(e => { if (!abort.signal.aborted) setError(e.message) })
    return () => abort.abort()
  }, [loadAttempt])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('job')) { setJobId(params.get('job')!); setTab('import') }
    else if (params.get('tab') === 'sources' || params.get('tab') === 'scheduled') setTab('sources')
    else if (['import', 'export'].includes(params.get('tab') ?? '')) setTab(params.get('tab')!)
  }, [])
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); setDownloaded(''); try { await fn() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) } }
  const showJob = (id: string) => { setJobId(id); setTab('import'); window.history.replaceState(null, '', `${window.location.pathname}?job=${encodeURIComponent(id)}`) }
  const reset = () => { setJobId(''); setSource(null); setMapping(null); setFile(null); window.history.replaceState(null, '', window.location.pathname) }
  const inspect = () => run(async () => {
    let result: SourceInspection
    if (file) { const body = new FormData(); body.append('file', file); result = await transferApi('catalog-transfer/source/inspect', body) }
    else result = await transferApi('catalog-transfer/source/fetch', { url })
    setSource(result); setMapping(defaultSourceMapping(result.headers, market, mode))
  })
  const preview = () => run(async () => {
    let result: TransferJob
    if (source && mapping) result = await transferApi('catalog-transfer/source/preview', { sourceId: source.sourceId, inputHash: source.hash, mapping: { ...mapping, market, mode } })
    else { if (!file) return; const body = new FormData(); body.append('file', file); body.append('market', market); body.append('mode', mode); body.append('format', format); body.append('blankPolicy', blankPolicy); if (format === 'amazon') { body.append('accountId', accountId); body.append('familyId', familyId) } result = await transferApi('catalog-transfer/preview', body) }
    showJob(result.jobId)
  })
  return <div className={styles.workspace}>
    <PageHeader eyebrow="Products" title="Catalog import & export" subtitle="Prepare products for Amazon and eBay across marketplaces, using one file." actions={<Button asChild><Link href="/products">Back to products</Link></Button>} />
    <Tabs idBase="catalog-transfer" ariaLabel="Catalog transfer workflow" tabs={[{ id: 'template', label: 'Create workbook', disabled: busy }, { id: 'import', label: 'Import & review', disabled: busy }, { id: 'export', label: 'Export existing products', disabled: busy }, { id: 'sources', label: 'Sources & history', disabled: busy }]} active={tab} onChange={setTab} />
    {error && <Banner tone="danger" title="Unable to complete this step">{error}</Banner>}
    {downloaded && <Banner tone="success" title="Workbook downloaded" action={tab !== 'import' ? <Button onClick={() => { reset(); setTab('import'); setFormat('catalog') }}>Import filled workbook</Button> : undefined}>{downloaded}</Banner>}
    {!options ? error ? <div><Button onClick={() => { setError(''); setLoadAttempt(n => n + 1) }}>Try loading options again</Button></div> : <p role="status">Loading catalog options…</p> : <div {...tabPanelProps('catalog-transfer', tab)} className={styles.stack}>
      {tab === 'sources' ? <SourcesPanel onJob={showJob} /> : tab === 'import' && jobId ? <TransferReview key={jobId} jobId={jobId} options={options} onReset={reset} onJob={showJob} /> : <>
        <div className={styles.fields}>
          <Field label="Product family" required={tab === 'template'} hint={tab === 'template' ? 'For example, Jackets. Determines which shared product details your file contains.' : 'Choose for exports, source mapping or new products from an Amazon file. Nexus workbooks already contain their family codes.'}><Listbox options={options.families.map(f => ({ value: f.id, label: f.label }))} value={familyId} onChange={id => { setFamilyId(id); setDownloaded('') }} emptyLabel="Choose a family" disabled={busy} width="100%" /></Field>
        </div>
        {!(tab === 'import' && format === 'amazon') && <Disclosure summary="Reference marketplace"><Field label="Reference marketplace" hint="Used for shared field guidance. Listing destinations are selected separately and saved in the file."><Listbox options={[...new Set(options.markets.map(m => m.code))].map(value => ({ value, label: value }))} value={market} onChange={setMarket} disabled={busy} width="100%" /></Field></Disclosure>}
        {tab === 'template' ? <Card header={<h2>One workbook for your listing destinations</h2>} description="Choose destinations → Fill one file → Import and review. Saved listings then go through channel validation and publication."><div className={styles.stack}>
          <WorkbookTemplate options={options} market={market} familyId={familyId} busy={busy} value={workbookSetup} onChange={next => { setWorkbookSetup(next); setDownloaded('') }} onDownload={payload => run(async () => { await download('template', payload, 'nexus-catalog-template.xlsx'); setMode('upsert'); setDownloaded('Fill shared product details once, add translations and any channel-specific values, then return here to import the file.') })} />
          <Disclosure summary="How to fill the workbook"><ol className={styles.guide}>
            <li>Start with the Instructions sheet. Enter each product and variant using its own SKU.</li>
            <li>Fill shared facts in Products and translated copy in the named language sheets.</li>
            <li>Use listing sheets for destination-specific values. Keep the same SKU across sheets.</li>
            <li>Leave unknown facts blank. Review formula results and paste them as values before uploading.</li>
          </ol><p>The file contains field instructions and valid values for AI-assisted filling. Creating a file does not translate content or verify product facts.</p></Disclosure>
        </div></Card> : tab === 'import' ? <Card header={<h2>{source ? 'Map incoming columns' : 'Upload your completed file'}</h2>} description="Review exactly what will change before saving. Importing prepares your catalog; publication is a separate step."><div className={styles.stack}>
          <Field label="What should this file do?" hint="This applies to both products and listing destinations. You will review new records and changes before saving."><Listbox options={[{ value: 'update', label: 'Update existing products and listings only' }, { value: 'create', label: 'Create new products and listings only' }, { value: 'upsert', label: 'Create new records and update existing ones' }]} value={mode} onChange={v => setMode(v as TransferMode)} disabled={busy} width="100%" /></Field>
          {!source ? <>
            <Field label="File type"><Listbox value={format} options={[{ value: 'catalog', label: 'Nexus workbook — columns map automatically' }, { value: 'amazon', label: 'Amazon template — columns map automatically' }, { value: 'source', label: 'Supplier or other file — choose column mappings' }]} onChange={v => { setFormat(v); setFile(null); setUrl(''); if (!market && v !== 'amazon') setMarket(options.markets.some(m => m.code === 'IT') ? 'IT' : options.markets[0]?.code ?? '') }} disabled={busy} width="100%" /></Field>
            {format === 'catalog' && <Field label="Blank cells" hint="Applies independently to each language sheet in a Nexus workbook. Omitted columns preserve their values; explicit SET, CLEAR and INHERIT actions take precedence."><Listbox value={blankPolicy} onChange={value => setBlankPolicy(value as 'ignore' | 'clear')} options={[{ value: 'ignore', label: 'Ignore — preserve existing values' }, { value: 'clear', label: 'Clear — remove values in present columns' }]} disabled={busy} /></Field>}
            {format === 'amazon' && <>
              <Field label="Destination Amazon account" hint="Choose the seller account this file belongs to."><Listbox options={options.accounts.filter(a => a.channelType === 'AMAZON').map(a => ({ value: a.id, label: a.displayName ?? a.id }))} value={accountId} onChange={id => { setAccountId(id); if (!destinationMarkets(options, id).some(m => m.code === market)) setMarket('') }} disabled={busy} width="100%" /></Field>
              <Field label="Amazon marketplace" hint="The file’s marketplace and language must match this destination."><Listbox options={destinationMarkets(options, accountId).map(m => ({ value: m.code, label: m.name }))} value={market} onChange={setMarket} disabled={busy || !accountId} width="100%" /></Field>
              <p>Amazon values stay scoped to this account and marketplace. Existing shared facts and other translations are preserved. Review managed or unsupported columns in the import outcomes.</p>
            </>}
            <FileDropzone accept={format === 'source' ? '.csv,.xlsx,.json' : format === 'amazon' ? '.xlsx,.xlsm' : '.csv,.xlsx'} maxBytes={10 * 1024 * 1024} disabled={busy} onFiles={files => { setFile(files[0] ?? null); setUrl('') }} hint="Up to 10 MB · 50,000 mapped attribute outcomes" />
            {file && <div className={styles.file}><strong>{file.name}</strong><Button size="sm" disabled={busy} onClick={() => setFile(null)}>Remove selected file</Button></div>}
            {format === 'source' && <Field label="Or fetch a source URL" hint="Fetches one immutable copy for mapping and preview."><Input type="url" value={url} onChange={e => { setUrl(e.target.value); setFile(null) }} disabled={busy} placeholder="https://supplier.example/catalog.csv" /></Field>}
            <div><Button variant="primary" disabled={busy || !market || !file && !url.trim() || format === 'amazon' && !accountId} onClick={format === 'source' ? inspect : preview}>{busy ? 'Checking your file…' : format === 'source' ? 'Continue to column mapping' : 'Review file before saving'}</Button></div>
          </> : mapping && <>
            <SourceMappingEditor source={source} mapping={{ ...mapping, market, mode }} onChange={setMapping} options={options} familyId={familyId} disabled={busy} />
            <div className={styles.actions}><Button disabled={busy} onClick={() => { setSource(null); setMapping(null) }}>Choose another source</Button><Button variant="primary" disabled={busy || !mapping.skuColumn || !mapping.bindings.length || mapping.bindings.some(b => !b.field)} onClick={preview}>{busy ? 'Preparing review…' : 'Preview mapped import'}</Button></div>
          </>}
          <p className={styles.secondary}>Omitted columns preserve data. Nexus workbook blanks follow the selected policy per language; explicit SET, CLEAR or INHERIT actions take precedence. Pricing, inventory and marketplace publication have separate workflows.</p>
        </div></Card> : <Card header={<h2>Choose what your export contains</h2>}><div className={styles.stack}>
          <Field label="Export purpose"><Listbox options={[{ value: 'editing', label: 'Edit and re-import — exact accounts and overrides' }, { value: 'effective', label: 'Review effective listings — table data only' }]} value={purpose} onChange={setPurpose} disabled={busy} width="100%" /></Field>
          <Field label="Listing marketplaces" hint="Shared translations are included in every editing export. Each listing keeps its own account, marketplace, category and version."><Listbox options={[{ value: 'all', label: 'All marketplaces for the selected products' }, { value: 'current', label: `Only ${market}` }]} value={exportMarkets} onChange={setExportMarkets} disabled={busy} width="100%" /></Field>
          <Field label="Or select SKUs" hint="One SKU per line, overriding the family selection. Large editing exports are a ZIP of numbered workbooks; extract before importing."><Textarea value={skus} onChange={e => setSkus(e.target.value)} rows={5} disabled={busy} /></Field>
          <p>{purpose === 'editing' ? 'Includes stable SKUs, explicit account/market/listing coordinates, actual overrides, inheritance actions and record versions.' : 'Resolved values are for review. Table exports cannot safely round-trip listing ownership.'}</p>
          <div><Button variant="primary" disabled={busy || !familyId && !skus.trim()} onClick={() => run(async () => { await download('export', { purpose, market, marketplaces: exportMarkets === 'all' ? [] : [market], layout: 'wide', familyId: familyId || undefined, skus: skus.trim() ? [...new Set(skus.split(/\r?\n/).map(s => s.trim()).filter(Boolean))] : undefined }, `nexus-catalog-${purpose}.xlsx`); if (purpose === 'editing') { setMode('update'); setDownloaded('Edit the downloaded workbook and reimport it to review your changes. Keep its record versions intact.') } })}>{busy ? 'Preparing export…' : 'Download export'}</Button></div>
        </div></Card>}
      </>}
    </div>}
  </div>
}
