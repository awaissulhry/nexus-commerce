'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Copy, Eye, Image as ImageIcon, RefreshCw, Search, Trash2 } from 'lucide-react'
import { amazonImageSlots, amazonSlotsForSection, effectiveImageSlots, groupAmazonItems, imageCatalogMatches, imageContributionMatches, imageDraftFingerprint,
  type AmazonImageSection, type AmazonMediaDraft, type AmazonMediaRun, type AmazonMediaWorkspace as Workspace, type ImageAssignment } from '@nexus/shared/amazon-media'
import { Banner, Disclosure, EmptyState, Field, MediaCard, Modal, PressableRow, Thumbnail } from '@/design-system/components'
import { Button, Input, Select, Tag, ToolbarButton } from '@/design-system/primitives'
import { PageHeader } from '@/design-system/patterns'
import { GridDensityProvider } from '@/design-system/lib/density'
import { usePermission } from '@/lib/auth/AuthProvider'
import { usePresentationNavigationGuard } from '@/app/products/ebay-flat-file/Presentation/usePresentationNavigationGuard'
import { useSaveReporter } from '../../contracts'
import { SourceLibrary, dimensions } from '../ebay/SourceLibrary'
import { amazonMediaPath, requestAmazonRun, requestAmazonWorkspace, requestAmazonDestinations } from './transport'
import { CopyMarketGallery } from './CopyMarketGallery'
import { BulkImageAssignment } from './BulkImageAssignment'
import { SkuSelection } from './SkuSelection'
import { SafetyImageExport } from './SafetyImageExport'
import styles from './media.module.css'

const working = (run: AmazonMediaRun | null) => !!run && ['REVIEW_QUEUED', 'REVIEWING', 'QUEUED', 'READY', 'SUBMITTING'].includes(run.status)
const sending = (run: AmazonMediaRun | null) => !!run && ['QUEUED', 'READY', 'SUBMITTING'].includes(run.status)
const axisLabel = (axis: string) => axis.replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase())
const languageLabel = (code: string) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code } catch { return code } }
const desiredUrls = (w: Workspace, d: AmazonMediaDraft, id: string) => Object.fromEntries(Object.entries(effectiveImageSlots(d, id)).flatMap(([code, assignment]) => {
  const asset = assignment && w.assets.find(a => a.id === assignment.assetId)
  return asset ? [[code, asset.url]] : []
}))

export function AmazonMediaWorkspace({ path, productId, accountLabel, onListingChange }: { path: string; productId: string; accountLabel: string; onListingChange(id: string): void }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [listingChoices, setListingChoices] = useState<Array<{ id: string; label: string }>>([])
  const [draft, setDraft] = useState<AmazonMediaDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [needsReload, setNeedsReload] = useState(false)
  const [active, setActive] = useState('common')
  const [axis, setAxis] = useState('')
  const [query, setQuery] = useState('')
  const [pickerSlot, setPickerSlot] = useState<string | null>(null)
  const [inspectId, setInspectId] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [targetIds, setTargetIds] = useState<string[]>([])
  const [run, setRun] = useState<AmazonMediaRun | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [section, setSection] = useState<AmazonImageSection>('gallery')
  const [exportOpen, setExportOpen] = useState(false)
  const [bulkUndo, setBulkUndo] = useState<{ before: AmazonMediaDraft; fingerprint: string } | null>(null)
  const [marketCopyOpen, setMarketCopyOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [compact, setCompact] = useState(false)
  const [groupsOpen, setGroupsOpen] = useState(true)
  const root = useRef<HTMLDivElement>(null)
  const [confirmation, setConfirmation] = useState<{ proceed(): void; cancel(): void } | null>(null)
  const reporter = useSaveReporter()
  const canEdit = usePermission('products.images.edit')
  const alive = useRef(true)
  const operation = useRef(false)
  const editVersion = useRef(0)
  const subject = `amazon-media:${path}`
  const dirty = !!workspace && !!draft && imageDraftFingerprint(workspace.draft) !== imageDraftFingerprint(draft)
  const locked = busy || uploading || sending(run)
  const disabled = locked || !canEdit || needsReload
  operation.current = locked
  const adopt = useCallback((next: Workspace) => {
    setWorkspace(next); setDraft(next.draft); setBulkUndo(null); setError(null); setNeedsReload(false); reporter.cleared([subject])
  }, [reporter, subject])
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    void requestAmazonWorkspace(path, 'GET', undefined, controller.signal).then(next => {
      if (controller.signal.aborted) return
      adopt(next)
      setTargetIds(next.items.filter(i => !i.parent).map(i => i.id))
      if (next.activeRunId) void requestAmazonRun(path, `/runs/${next.activeRunId}`, undefined, controller.signal).then(value => { if (!controller.signal.aborted) setRun(value) }).catch(e => { if (!controller.signal.aborted) { setNeedsReload(true); setError(e.message) } })
    }).catch(async e => { if (!controller.signal.aborted) {
      setError(e.message)
      try { const choices = await requestAmazonDestinations(path, controller.signal); if (!controller.signal.aborted) setListingChoices(choices) } catch { /* Retain the original scope error. */ }
    } })
    return () => { alive.current = false; controller.abort() }
  }, [path, adopt])

  useEffect(() => {
    if (!root.current) return
    const element = root.current
    const observer = new ResizeObserver(() => { const small = element.clientWidth < 800; setCompact(small); setGroupsOpen(!small) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [workspace?.productId])

  useEffect(() => {
    if (!workspace || dirty || locked || working(run) || marketCopyOpen || copyOpen || exportOpen) return
    const controller = new AbortController()
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return
      const generation = editVersion.current
      try {
        const next = await requestAmazonWorkspace(path, 'GET', undefined, controller.signal)
        if (!controller.signal.aborted && generation === editVersion.current && !operation.current) { setWorkspace(next); setDraft(next.draft) }
      } catch { /* Preserve the timestamp and observed state on read failure. */ }
    }
    const timer = setInterval(() => void refresh(), 30_000)
    window.addEventListener('focus', refresh)
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [path, !!workspace, dirty, locked, run?.status, marketCopyOpen, copyOpen, exportOpen])

  useEffect(() => {
    if (!working(run)) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const next = await requestAmazonRun(path, `/runs/${run!.id}`, undefined, controller.signal)
        if (controller.signal.aborted) return
        setRun(next)
        if (!working(next) && sending(run)) adopt(await requestAmazonWorkspace(path, 'GET', undefined, controller.signal))
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'The publication receipt could not be refreshed.') }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1500)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [run?.id, run?.status, path, adopt])

  usePresentationNavigationGuard(dirty || locked, async () => {
    if (operation.current) { setError('Wait for this request to finish before leaving.'); return false }
    if (!dirty) return true
    return new Promise<boolean>(resolve => setConfirmation({ proceed: () => { setConfirmation(null); resolve(true) }, cancel: () => { setConfirmation(null); resolve(false) } }))
  })
  const items = useMemo(() => workspace?.items.map(item => {
    const observed = workspace.observations[item.id]
    return observed && !observed.error ? { ...item, theme: observed.theme, attributes: observed.attributes, productType: observed.productType, asin: observed.asin } : item
  }) ?? [], [workspace])
  const axes = [...new Set(items.flatMap(i => Object.keys(i.attributes)))]
  const groups = groupAmazonItems(items.filter(i => `${i.sku} ${i.label} ${Object.values(i.attributes).join(' ')}`.toLowerCase().includes(query.toLowerCase())), axes.includes(axis) ? axis : '')
  const item = items.find(i => i.id === active)
  const slots = draft ? active === 'common' ? draft.common : effectiveImageSlots(draft, active) : {}
  const visibleSlots = amazonSlotsForSection(section)
  const emptyCodes = visibleSlots.filter(s => s.code !== 'SWCH' && !slots[s.code]).map(s => s.code)
  const heading = active === 'common' ? 'Common images' : item?.sku || 'SKU images'
  const previewAsset = workspace?.assets.find(a => a.id === inspectId)
  const thumbnail = (id: string) => {
    const assignment = draft && effectiveImageSlots(draft, id).MAIN
    return assignment ? workspace?.assets.find(a => a.id === assignment.assetId)?.url : undefined
  }
  function editSlot(code: string, assignment: ImageAssignment | null | undefined) {
    if (disabled) return
    setBulkUndo(null)
    editVersion.current++
    setDraft(current => {
      if (!current) return current
      const next = { ...(active === 'common' ? current.common : current.items[active] ?? {}) }
      if (assignment === undefined) delete next[code]; else next[code] = assignment
      return active === 'common' ? { ...current, common: next } : { ...current, items: { ...current.items, [active]: next } }
    })
    setMessage(''); setRun(current => current?.status === 'REVIEW' ? null : current)
  }
  async function save() {
    if (!workspace || !draft || disabled || !dirty) return
    editVersion.current++
    setBusy(true); setError(null)
    const write = crypto.randomUUID(); reporter.pending(write, subject)
    try {
      const next = await requestAmazonWorkspace(path, 'PUT', { expectedRevision: workspace.revision, draft })
      if (alive.current) { adopt(next); setMessage('Draft saved for this Amazon market.'); setRun(null) }
      reporter.resolved(write, true, undefined, subject)
    } catch (e) {
      const text = e instanceof Error ? e.message : 'Save outcome unknown. Reload before retrying.'
      if (alive.current) { setError(text); setNeedsReload(true) }
      reporter.resolved(write, false, text, subject)
    } finally { if (alive.current) setBusy(false) }
  }
  async function reload() {
    if (locked) return
    if (dirty) {
      const discard = await new Promise<boolean>(resolve => setConfirmation({ proceed: () => { setConfirmation(null); resolve(true) }, cancel: () => { setConfirmation(null); resolve(false) } }))
      if (!discard) return
    }
    setBusy(true)
    try {
      const next = await requestAmazonWorkspace(path); adopt(next)
      setRun(next.activeRunId ? await requestAmazonRun(path, `/runs/${next.activeRunId}`) : null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Reload failed.') }
    finally { setBusy(false) }
  }
  async function checkAmazon() {
    if (!workspace || dirty || locked) return
    setBusy(true); setError(null); setMessage('Checking seller contributions, variation themes and Amazon catalog images…')
    try { adopt(await requestAmazonWorkspace(amazonMediaPath(path, '/refresh'), 'POST', { expectedRevision: workspace.revision })); setMessage('Amazon read completed. Each SKU shows its own result and check time.') }
    catch (e) { setError(e instanceof Error ? e.message : 'Amazon could not be checked.'); setMessage('') }
    finally { setBusy(false) }
  }
  async function review() {
    if (!workspace || dirty || locked || !targetIds.length) return
    setBusy(true); setError(null)
    try { setRun(await requestAmazonRun(path, '/review', { expectedRevision: workspace.revision, listingIds: targetIds })) }
    catch (e) { setError(e instanceof Error ? e.message : 'The review could not be started.') }
    finally { setBusy(false) }
  }
  async function publish() {
    if (!workspace || !run || dirty || locked || run.status !== 'REVIEW') return
    setBusy(true); setError(null)
    try { setRun(await requestAmazonRun(path, `/runs/${run.id}/publish`, { expectedRevision: workspace.revision })) }
    catch (e) { setError(e instanceof Error ? e.message : 'The submission outcome is unknown. Reload its receipt.'); setNeedsReload(true) }
    finally { setBusy(false) }
  }
  function swap(code: string, direction: number) {
    const index = visibleSlots.findIndex(s => s.code === code); const next = visibleSlots[index + direction]
    if (!next || next.code === 'SWCH' || disabled) return
    editSlot(code, slots[next.code] ?? null); editSlot(next.code, slots[code] ?? null)
  }

  if (!workspace || !draft) return <div className={styles.loading}>{error ? <><EmptyState title="Amazon images unavailable" description={error} action={<Button onClick={() => void reload()}>Retry</Button>} />
    {listingChoices.length > 0 && <Field label="Choose an Amazon listing"><Select value="" onChange={event => onListingChange(event.target.value)}><option value="">Choose listing</option>{listingChoices.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</Select></Field>}</> : <p role="status">Loading Amazon images…</p>}</div>
  const themes = [...new Set(items.flatMap(i => i.theme ? [i.theme] : []))]
  const activeObservation = item && workspace.observations[item.id]
  const activeDesired = item ? desiredUrls(workspace, draft, item.id) : {}
  const matchesContribution = !!activeObservation && imageContributionMatches(activeDesired, activeObservation)
  const matchesCatalog = !!activeObservation && imageCatalogMatches(activeDesired, activeObservation)
  const runBlocked = !!run?.items.some(i => i.issues.length)
  const languageOptions = <><option value="und">Language needs review</option><option value="zxx">No language-specific text</option>{workspace.languages.map(code => <option key={code} value={code}>{languageLabel(code)} content</option>)}</>

  return <div ref={root} className={styles.workspace}>
    <header className={styles.header}>
      <PageHeader title="Images" subtitle={`${accountLabel} · Amazon ${workspace.destination.marketplace} · ${workspace.destination.label}`}
        actions={<><ToolbarButton icon={<RefreshCw size={16} />} label="Reload saved Amazon gallery" disabled={locked} onClick={() => void reload()} />
          <ToolbarButton icon={<Eye size={16} />} label="Preview Amazon image gallery" onClick={() => setPreviewOpen(true)} />
          <Button disabled={disabled || !dirty} onClick={() => void save()}>Save draft</Button>
          {section === 'safety' ? <Button variant="primary" disabled={disabled || dirty} onClick={() => setExportOpen(true)}>Export PS images</Button>
            : <Button variant="primary" aria-label="Review & publish" disabled={disabled || dirty} onClick={() => setReviewOpen(true)}>{compact ? 'Review' : 'Review & publish'}</Button>}</>} />
      <div className={styles.context}>
        <Tag>{workspace.destination.marketplace} images only</Tag>
        <span>{dirty ? 'Unsaved changes' : 'No unsaved changes'}</span>
        <span>{items.length} {items.length === 1 ? 'listing' : 'listings'}</span>
        {themes.length > 0 && <span>Variation theme: {themes.join(' · ')}</span>}
      </div>
    </header>
    <div className={styles.body}>
      <aside className={styles.navigation} aria-label="Amazon image galleries">
        <Field label="Listing"><Select size="sm" value={workspace.destination.listingId} disabled={locked} onChange={event => onListingChange(event.target.value)}>
          {workspace.destination.listings.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
        </Select></Field>
        <PressableRow label="Common images" current={active === 'common'} onClick={() => setActive('common')} description="Images shared by SKUs in this market; SKU overrides take precedence."><Tag>{Object.values(draft.common).filter(Boolean).length}</Tag></PressableRow>
        <Disclosure summary={`SKU galleries · ${items.length}`} open={groupsOpen} onToggle={event => setGroupsOpen(event.currentTarget.open)}>
          <div className={styles.navControls}>
            {axes.length > 0 && <Field label="Group variations by"><Select size="sm" value={axes.includes(axis) ? axis : ''} onChange={event => setAxis(event.target.value)}><option value="">All SKUs</option>{axes.map(a => <option key={a} value={a}>{axisLabel(a)}</option>)}</Select></Field>}
            <Input size="sm" aria-label="Search Amazon SKUs and variations" placeholder="Search SKU or variation" leadingIcon={<Search size={16} />} value={query} onChange={event => setQuery(event.target.value)} />
          </div>
          <GridDensityProvider value="compact"><div className={styles.groupList}>
            {groups.map(group => <section key={group.label} className={styles.group} aria-label={group.label}>
              <div className={styles.groupHeading}><span>{group.label}</span><Tag>{group.items.length}</Tag></div>
              {group.items.map(i => <PressableRow key={i.id} label={i.sku || i.label} leading={<Thumbnail src={thumbnail(i.id) ?? null} alt="" />} current={active === i.id} onClick={() => { setActive(i.id); if (compact) setGroupsOpen(false) }} description={Object.entries(i.attributes).map(([k, v]) => `${axisLabel(k)}: ${v}`).join(', ')} />)}
            </section>)}
            {!groups.length && <p>No matching SKUs.</p>}
          </div></GridDensityProvider>
        </Disclosure>
      </aside>
      <section className={styles.canvas} aria-label="Amazon gallery editor">
        {error && <Banner tone="danger" title="Action needs attention" children={error} />}
        {message && <p role="status" className={styles.note}>{message}</p>}
        {workspace.warnings.map(warning => <Banner key={warning} tone="warning" children={warning} />)}
        <div className={styles.galleryHeading}>
          <div><h2>{heading}</h2><p>{active === 'common' ? 'Shared defaults for this market. Each SKU can replace or clear any image slot.' : `${item?.label ?? ''}${item?.asin ? ` · ${item.asin}` : ''}`}</p></div>
          <div className={styles.actions}>
            <Button disabled={disabled || !emptyCodes.length} onClick={() => setPickerSlot('batch')}>Add images</Button>
            <Button disabled={disabled || dirty} onClick={() => setMarketCopyOpen(true)}>Copy from market</Button>
            <Button size="sm" disabled={disabled} onClick={() => setCopyOpen(true)}><Copy size={16} />Apply to SKUs</Button>
            {section === 'gallery' && <Button disabled={locked || dirty || !canEdit} onClick={() => void checkAmazon()}>Check Amazon</Button>}
          </div>
        </div>
        <div className={styles.actions} role="group" aria-label="Amazon image type">
          <Button size="sm" active={section === 'gallery'} aria-pressed={section === 'gallery'} onClick={() => setSection('gallery')}>Product gallery</Button>
          <Button size="sm" active={section === 'safety'} aria-pressed={section === 'safety'} onClick={() => setSection('safety')}>Safety images (PS)</Button>
        </div>
        {bulkUndo && bulkUndo.fingerprint === imageDraftFingerprint(draft) && <Banner tone="info" title="Bulk changes applied to the draft"
          action={<Button size="sm" disabled={disabled} onClick={() => { editVersion.current++; setDraft(bulkUndo.before); setBulkUndo(null); setRun(null); setMessage('Bulk changes undone.') }}>Undo bulk changes</Button>}>Save the draft when you have finished reviewing.</Banner>}
        {section === 'safety' && <Banner tone="info" title="PS01–PS06 · Seller Central upload required">Save and assign safety images here, then export them for Image Manager. The Listings API cannot publish these slots. PS publication and display on Amazon are not verified here.</Banner>}
        {active === 'common' && <p className={styles.note}>{section === 'safety' ? 'Use common safety images when they apply to every SKU. Override them for variations with different warnings or instructions.' : `Place shared product photos or the ${workspace.languages.map(languageLabel).join(' / ')} size chart here.`} These images are not inherited by other markets.</p>}
        {item && section === 'gallery' && <div className={styles.truth}>
          <Tag tone={matchesCatalog ? 'success' : 'neutral'}>{matchesCatalog ? 'Catalog URLs matched at last check' : 'Catalog match not verified'}</Tag>
          <Tag tone={matchesContribution ? 'success' : 'neutral'}>{matchesContribution ? 'Contribution URLs matched at last check' : 'Seller contribution not matched'}</Tag>
          <span>{activeObservation ? `Checked ${new Date(activeObservation.checkedAt).toLocaleString()}` : 'Amazon has not been checked'}</span>
          {activeObservation?.error && <Banner tone="warning" children={activeObservation.error} />}
          {activeObservation && !activeObservation.error && <Button size="sm" disabled={disabled} onClick={() => setAdoptOpen(true)}>Use Amazon contribution</Button>}
        </div>}
        <div className={styles.slotGrid}>
          {visibleSlots.map((slot, index) => {
            const assignment = slots[slot.code]
            const asset = assignment && workspace.assets.find(a => a.id === assignment.assetId)
            const inherited = active !== 'common' && !(slot.code in (draft.items[active] ?? {}))
            const controls = <>
              <Button size="sm" disabled={disabled} onClick={() => setPickerSlot(slot.code)}>{asset ? 'Replace' : 'Choose image'}</Button>
              {asset && <ToolbarButton icon={<Trash2 size={16} />} label={`Clear ${slot.label}`} disabled={disabled} onClick={() => editSlot(slot.code, null)} />}
              {active !== 'common' && !inherited && <Button size="sm" variant="quiet" disabled={disabled} onClick={() => editSlot(slot.code, undefined)}>Use common</Button>}
            </>
            return <div key={slot.code} className={styles.slot}>
              {asset ? <MediaCard src={asset.url} label={slot.label} marker={slot.code} onPreview={() => setInspectId(asset.id)}
                detail={<><span>{dimensions(asset)}</span><Field label={`${slot.code} image language`}><Select value={assignment!.language} disabled={disabled} onChange={event => editSlot(slot.code, { ...assignment!, language: event.target.value })}>{languageOptions}</Select></Field></>}
                actions={<>{controls}{slot.code !== 'SWCH' && <>
                  <ToolbarButton icon={<ArrowLeft size={16} />} label={`Move ${slot.label} earlier`} disabled={disabled || index === 0} onClick={() => swap(slot.code, -1)} />
                  <ToolbarButton icon={<ArrowRight size={16} />} label={`Move ${slot.label} later`} disabled={disabled || !visibleSlots[index + 1] || visibleSlots[index + 1].code === 'SWCH'} onClick={() => swap(slot.code, 1)} />
                </>}</>} />
                : <div className={styles.emptySlot}><div className={styles.emptySlotHeading}><span>{slot.label}</span><Tag>{slot.code}</Tag></div>
                  <div className={styles.emptyPhoto}><ImageIcon size={28} aria-hidden /><span>{slot.code === 'MAIN' ? active === 'common' ? 'Optional common main image' : 'Main image required' : slot.code === 'SWCH' ? 'Optional variation swatch' : 'Empty image slot'}</span></div>
                  <div className={styles.actions}>{controls}</div></div>}
              <p className={styles.slotOrigin}>{active === 'common' ? 'Market common image' : inherited ? 'Uses market common image' : assignment === null ? 'Explicitly empty for this SKU' : 'SKU override'}</p>
            </div>
          })}
        </div>
        <p className={styles.note}>{section === 'safety' ? 'Confirm that safety text is readable, in the intended language and applies to every selected product or variation.' : 'The main photo must meet Amazon’s product image rules.'} Text language is your confirmation; Nexus does not infer it from filenames or certify image content.</p>
        {item && activeObservation && <Disclosure summary="Images and issues returned by Amazon">
          <p className={styles.note}>Catalog images can include other sellers’ contributions. Amazon can resize, select and display images differently. Matching your seller contribution does not prove the storefront has changed.</p>
          {activeObservation.catalogError && <Banner tone="warning" children={activeObservation.catalogError} />}
          <div className={styles.remoteGrid}>{activeObservation.catalog.map(photo => <MediaCard key={photo.slot} src={photo.url} label={photo.slot} onPreview={() => window.open(photo.url, '_blank', 'noopener,noreferrer')} detail={`${photo.width} × ${photo.height} px`} />)}</div>
          {activeObservation.issues.map((issue, index) => <Banner key={index} tone={issue.severity === 'ERROR' ? 'danger' : 'warning'} title={`${issue.severity} · ${issue.code}`} children={issue.message} />)}
        </Disclosure>}
        {run && !working(run) && run.status !== 'REVIEW' && <Banner tone={run.status === 'UNKNOWN' || run.status === 'REVIEW_FAILED' ? 'warning' : 'info'} title="Amazon publication receipt"
          children={`${run.receipts.filter(r => r.status === 'ACCEPTED').length} accepted for processing · ${run.receipts.filter(r => r.status === 'REJECTED').length} rejected · ${run.receipts.filter(r => r.status === 'UNKNOWN').length} unknown · ${run.receipts.filter(r => r.status === 'NOT_SENT').length} not sent. Check Amazon to verify the result.`}
          action={<Button onClick={() => setReviewOpen(true)}>View receipt</Button>} />}
      </section>
    </div>
    {marketCopyOpen && <CopyMarketGallery path={path} workspace={workspace} targetGalleryId={active} section={section} onClose={() => setMarketCopyOpen(false)} onBusyChange={setBusy}
      onCopied={next => { adopt(next); setRun(null); setMessage('Market gallery copied and saved. Review the language of images containing text before publishing.') }} />}
    {pickerSlot && <SourceLibrary assets={workspace.assets} productId={productId} assignedUrls={new Set()} disabled={disabled} galleryLabel={`${heading} · ${pickerSlot === 'batch' ? `assign in selection order to ${emptyCodes.join(', ')}` : pickerSlot}`} galleryCount={0} galleryLimit={pickerSlot === 'batch' ? emptyCodes.length : 1}
      pinned={false} canPin={false} onPinChange={() => {}} onClose={() => setPickerSlot(null)} onBusyChange={setUploading}
      onAdd={ids => { if (!ids.length || ids.length > (pickerSlot === 'batch' ? emptyCodes.length : 1) || disabled) return false;
        ids.forEach((id, index) => editSlot(pickerSlot === 'batch' ? emptyCodes[index] : pickerSlot, { assetId: id, language: 'und' })); setPickerSlot(null); return true }}
      onPreview={setInspectId} onRefresh={async () => {
        const next = await requestAmazonWorkspace(path)
        const changed = imageDraftFingerprint(next.draft) !== imageDraftFingerprint(workspace.draft)
          || JSON.stringify(next.items) !== JSON.stringify(workspace.items)
          || workspace.assets.some(a => next.assets.find(b => b.id === a.id)?.url !== a.url)
        if (changed) { setNeedsReload(true); setError('The saved gallery, listing or an existing source image changed during upload. Your edits and uploads are retained. Reload before saving.'); return }
        setWorkspace(next)
      }} />}
    <Modal open={!!previewAsset} onClose={() => setInspectId(null)} title={previewAsset?.label ?? 'Inspect image'} size="xl">
      {previewAsset && <><img className={styles.inspection} src={previewAsset.url} alt={previewAsset.label} /><p>{dimensions(previewAsset)}</p></>}
    </Modal>
    <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title={`${heading} · ${section === 'safety' ? 'safety ' : ''}draft preview`} subtitle={`Amazon ${workspace.destination.marketplace}. This preview shows the selected draft, not a live storefront.`} size="xl">
      <div className={styles.previewGrid}>{visibleSlots.filter(s => s.code !== 'SWCH').flatMap(slot => {
        const value = slots[slot.code]; const asset = value && workspace.assets.find(a => a.id === value.assetId)
        return asset ? [<MediaCard key={slot.code} src={asset.url} label={slot.label} onPreview={() => setInspectId(asset.id)} />] : []
      })}</div>
      {!visibleSlots.some(s => slots[s.code]) && <EmptyState title="No images in this section yet" description="Choose images to preview this section." />}
    </Modal>
    {copyOpen && <BulkImageAssignment workspace={{ ...workspace, items }} draft={draft} active={active} section={section} axis={axis} disabled={disabled} onClose={() => setCopyOpen(false)} onApply={(next, count) => {
      editVersion.current++; setBulkUndo({ before: draft, fingerprint: imageDraftFingerprint(next) }); setDraft(next); setRun(null); setCopyOpen(false); setMessage(`Applied to ${count} SKUs in this draft. Save to keep these changes.`)
    }} />}
    {exportOpen && <SafetyImageExport path={path} workspace={workspace} axis={axis} onClose={() => setExportOpen(false)} onBusyChange={setBusy} />}
    <Modal open={reviewOpen} onClose={() => setReviewOpen(false)} title="Review Amazon publication" subtitle={`${accountLabel} · Amazon ${workspace.destination.marketplace} · ${workspace.destination.label}`} size="xl"
      footer={<><Button onClick={() => setReviewOpen(false)}>Close</Button>
        {run?.status === 'REVIEW' ? <Button variant="primary" disabled={disabled || dirty || runBlocked || !run.items.some(i => i.patches.length)} onClick={() => void publish()}>Publish reviewed changes</Button>
          : <Button variant="primary" disabled={disabled || dirty || working(run) || !targetIds.length} onClick={() => void review()}>Check {targetIds.length} SKUs for publication</Button>}</>}>
      <p>Saving keeps a Nexus draft. Publishing sends the reviewed image changes to Amazon. An accepted submission still needs processing and a read from Amazon to confirm its result.</p>
      <Banner tone="info">This review covers MAIN, PT01–PT08 and SWCH only. Safety images (PS) use the separate Seller Central export.</Banner>
      {error && <Banner tone="danger" children={error} />}
      {!working(run) && run?.status !== 'REVIEW' && <Disclosure summary={`Choose SKUs · ${targetIds.length} selected`} open={!run}>
        <SkuSelection items={items} selected={targetIds} onChange={setTargetIds} defaultAxis={axis} disabled={disabled} />
      </Disclosure>}
      {working(run) && <p role="status">{sending(run) ? 'Submitting the reviewed snapshot to Amazon…' : `Checking the selected SKUs with Amazon… ${run?.items.length ?? 0} reviewed.`} The job is recorded in Nexus.</p>}
      {run?.status === 'REVIEW' && <Button disabled={locked} onClick={() => setRun(null)}>Change selected SKUs</Button>}
      {run?.items.map(entry => <section key={entry.listingId} className={styles.reviewItem}>
        <h3>{entry.sku || 'SKU unavailable'} <span className={styles.note}>{entry.asin} · {entry.productType}</span></h3>
        {entry.issues.map((issue, index) => <Banner key={index} tone="danger" children={issue} />)}
        {entry.changes.map(change => <div key={change.slot} className={styles.change}>
          <strong>{change.slot}</strong><span>{change.before && change.after ? 'Replace' : change.after ? 'Add' : 'Remove'}</span>
          <Thumbnail src={change.before} alt={`Current ${change.slot}`} /><ArrowRight size={16} aria-hidden /><Thumbnail src={change.after} alt={`Desired ${change.slot}`} />
        </div>)}
        {!entry.changes.length && !entry.issues.length && <p>No image changes.</p>}
        {run.status !== 'REVIEW' && <p>{run.receipts.find(r => r.listingId === entry.listingId)?.status.replace(/_/g, ' ')} · {run.receipts.find(r => r.listingId === entry.listingId)?.message || 'See Amazon check for current contribution and catalog images.'}</p>}
      </section>)}
      {run?.receipts.filter(r => !run.items.some(i => i.listingId === r.listingId)).map(r => <Banner key={r.listingId} tone="warning" children={r.message || 'Waiting for review.'} />)}
    </Modal>
    <Modal open={!!confirmation} onClose={() => confirmation?.cancel()} title="Discard unsaved Amazon image changes?" subtitle="Your saved market gallery and uploaded source images will be retained."
      footer={<><Button onClick={() => confirmation?.cancel()}>Keep editing</Button><Button variant="danger" onClick={() => confirmation?.proceed()}>Discard changes</Button></>} />
    <Modal open={adoptOpen} onClose={() => setAdoptOpen(false)} title="Use Amazon’s seller contribution?" subtitle="Replaces this SKU’s draft with the image URLs returned by Amazon. Review their language before saving and publishing."
      footer={<><Button onClick={() => setAdoptOpen(false)}>Cancel</Button><Button variant="primary" disabled={disabled || !activeObservation || !!activeObservation.error} onClick={() => {
        if (!activeObservation) return
        for (const slot of amazonImageSlots) {
          const url = activeObservation.slots[slot.code]; const asset = url && workspace.assets.find(a => a.url === url)
          editSlot(slot.code, asset ? { assetId: asset.id, language: 'und' } : null)
        }
        setAdoptOpen(false); setMessage('Amazon contribution applied to this SKU’s draft. Review its image languages and save.')
      }}>Use in draft</Button></>} />
  </div>
}
