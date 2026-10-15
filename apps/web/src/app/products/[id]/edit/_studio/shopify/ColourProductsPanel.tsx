'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link2, RefreshCw, Search } from 'lucide-react'
import { AsyncListboxPanel, Banner, Card, Disclosure, Field, KeyValue, Modal, Thumbnail, type ListboxPanelOption } from '@/design-system/components'
import { Button, Checkbox, Input, Pill, Select, Toggle } from '@/design-system/primitives'
import { linkedEndpoint, linkedRequest } from './api'
import { colourNameClash, colourNameToSend, colourRows, confirmBlockers, confirmWrites, defaultColourName, fullSyncEffects, sizeMapAxes, sizeMapOf, swatchGroupWords, syncWords,
  type ColourRowModel, type ColourView, type SizeMapAxis, type StoreProduct } from './colourProducts'
import styles from './colourProducts.module.css'

/**
 * Colour products (one Shopify product per colour of this family) in the Product family tab: the store switch, then one
 * row per Nexus colour — its Shopify product (Find's proposal, or the one the operator chooses), the sizes it pairs, the
 * SKUs Nexus will write — and Confirm with a review of exactly what is written to Shopify, and the colour's name on
 * Shopify (by default the one its product shows). Sizes that Nexus and Shopify name differently (EU 44 / XS) are paired
 * in "Pair sizes…" (the family's size map on this store). Linking is adopt only: after it, "Start full sync" (with its
 * own review) is the operator's explicit step to stock, sizes and colour swatches.
 */
export function ColourProductsPanel({ linkedPath, canEdit, canPublish }: { linkedPath: string; canEdit: boolean; canPublish: boolean }) {
  const path = linkedPath.replace('/shopify-linked?', '/shopify-colour-products?')
  const [view, setView] = useState<ColourView | null>(null), [locations, setLocations] = useState<ColourView['locations']>(undefined)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [replace, setReplace] = useState<Record<string, boolean>>({})
  const [picking, setPicking] = useState<ColourRowModel | null>(null), [reviewing, setReviewing] = useState<ColourRowModel | null>(null), [fullSyncOpen, setFullSyncOpen] = useState(false)
  const [pairing, setPairing] = useState<ColourRowModel | null>(null)
  const alive = useRef(true)
  const accept = useCallback((data: ColourView) => { setView(data); if (data.locations) setLocations(data.locations) }, [])
  const load = useCallback(async () => {
    setBusy(true); setError('')
    try { const data = await linkedRequest<ColourView>(path); if (alive.current) accept(data) }
    catch (e) { if (alive.current) setError((e as Error).message) } finally { if (alive.current) setBusy(false) }
  }, [path, accept])
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [load])
  async function run<T extends ColourView>(work: () => Promise<T>, done: (data: T) => string) {
    if (busy) return false
    setBusy(true); setError(''); setNotice('')
    try { const data = await work(); if (alive.current) { accept(data); setNotice(done(data)) }; return true }
    catch (e) { if (alive.current) setError((e as Error).message); return false } finally { if (alive.current) setBusy(false) }
  }
  const find = (choices?: Array<{ valueKey: string; shopifyProductId: string | null }>) => run(() => linkedRequest<ColourView>(linkedEndpoint(path, '/find'), 'POST', choices ? { choices } : {}),
    () => choices ? 'Find matched the sizes of the chosen product. Nothing was written to Shopify.' : 'Find read the store and stored a proposal for each colour. Nothing was written to Shopify.')
  const saveSwitch = (enabled: boolean) => view && run(async () => {
    const { revision, ...settings } = view.settings
    await linkedRequest(linkedEndpoint(path, '/settings'), 'PUT', { settings: { ...settings, enabled }, expectedRevision: revision })
    return linkedRequest<ColourView>(path)
  }, () => enabled ? 'Colour products are on for this store. Nothing was written to Shopify.' : 'Colour products are off for this store: the colour sync stops for every family of it.')

  if (!view) return <Card header="Colour products" headingLevel={3}>{error ? <Banner tone="danger" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>{error}</Banner> : <p role="status">Loading colour products…</p>}</Card>
  if (view.plan.mode !== 'colour-products') return null
  const rows = colourRows(view), state = syncWords(view)
  const planErrors = view.plan.issues.filter(i => i.severity === 'error')
  return <Card header="Colour products" headingLevel={3} description="Each colour of this family is its own Shopify product, as on the store's colour swatches."
    headerAction={<Pill tone={state.tone}>{state.label}</Pill>}>
    <div className={styles.panel} aria-busy={busy}>
      <div className={styles.toolbar}>
        <span className={styles.switch}><Toggle checked={view.settings.enabled} disabled={busy || !canPublish} aria-label="Colour products for this Shopify store" onChange={next => { void saveSwitch(next) }} />
          <span>Colour products for this store: <strong>{view.settings.enabled ? 'On' : 'Off'}</strong>{!canPublish && ' (you may not change it)'}</span></span>
        <span className={styles.actions}>
          <Button size="sm" disabled={busy} onClick={() => void load()}><RefreshCw size={14} aria-hidden />Reload</Button>
          <Button size="sm" disabled={busy || !canEdit} onClick={() => void find()}><Search size={14} aria-hidden />Find products</Button>
          {view.sync?.linked && view.sync.adoptOnly && <Button size="sm" variant="secondary" disabled={busy || !canPublish || !view.settings.enabled} onClick={() => setFullSyncOpen(true)}>Start full sync…</Button>}
        </span>
      </div>
      <p className={styles.hint}>{state.text}</p>
      {!view.settings.enabled && <Banner tone="warning">Colour products are off for this store. Find works; Confirm needs them on.</Banner>}
      {error && <Banner tone="danger" title="Nothing more was done">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}
      {planErrors.length > 0 && <Banner tone="warning" title="This family needs a fix before linking"><ul className={styles.list}>{planErrors.map(i => <li key={i.message}>{i.message}</li>)}</ul></Banner>}
      <ul className={styles.rows} aria-label="Colours of this family">
        {rows.map(model => <ColourRow key={model.key} model={model} group={swatchGroupWords(view, model)} busy={busy} canEdit={canEdit} canPublish={canPublish && view.settings.enabled}
          replace={!!replace[model.key]} onReplace={value => setReplace(r => ({ ...r, [model.key]: value }))}
          onPick={() => setPicking(model)} onClear={() => { setReplace(r => ({ ...r, [model.key]: false })); void find([{ valueKey: model.key, shopifyProductId: null }]) }}
          onPairSizes={() => setPairing(model)} onConfirm={() => setReviewing(model)} />)}
      </ul>
    </div>
    {picking && <StoreProductPicker path={path} model={picking} onClose={() => setPicking(null)} onChoose={product => { const key = picking.key; setPicking(null); setReplace(r => ({ ...r, [key]: false })); void find([{ valueKey: key, shopifyProductId: product.id }]) }} />}
    {reviewing && <ConfirmReview model={reviewing} view={view} locations={locations} replace={!!replace[reviewing.key]} busy={busy} onClose={() => { if (!busy) setReviewing(null) }}
      onConfirm={async (locationId, colourName) => {
        const model = reviewing
        const ok = await run(() => linkedRequest<ColourView & { confirmed: Array<{ name: string; adoptOnly: boolean }> }>(linkedEndpoint(path, '/confirm'), 'POST',
          { colours: [{ valueKey: model.key, shopifyProductId: model.product!.id, colourName: colourNameToSend(model, colourName), ...(locationId ? { locationId } : {}), ...(replace[model.key] ? { replaceSkus: true } : {}) }] }),
          data => `"${model.name}" is linked to "${model.product!.title}"${data.confirmed[0]?.adoptOnly ? ' (adopt only): stock, prices, sizes and colour swatches were not changed' : ''}.`)
        if (ok) setReviewing(null)
      }} />}
    {pairing && <SizeMapReview model={pairing} axes={sizeMapAxes(view, pairing)} busy={busy} onClose={() => { if (!busy) setPairing(null) }}
      onSave={async sizeMap => {
        // Saved in Nexus only, then Find pairs the sizes again with it (nothing is written to Shopify).
        const ok = await run(async () => {
          await linkedRequest<ColourView>(linkedEndpoint(path, '/size-map'), 'PUT', { sizeMap })
          return linkedRequest<ColourView>(linkedEndpoint(path, '/find'), 'POST', {})
        }, () => 'The size pairing is saved and Find paired the sizes with it. Nothing was written to Shopify.')
        if (ok) setPairing(null)
      }} />}
    <Modal open={fullSyncOpen} onClose={() => { if (!busy) setFullSyncOpen(false) }} title="Start full sync for this family?" size="lg" readable
      footer={<FullSyncFooter busy={busy} onCancel={() => setFullSyncOpen(false)} onStart={async () => {
        const ok = await run(() => linkedRequest<ColourView & { started: { resumed: number; stockQueued: number; alreadyRunning: boolean } }>(linkedEndpoint(path, '/full-sync'), 'POST', { confirm: true }),
          data => data.started.alreadyRunning ? 'The full sync was already on.' : `Full sync is on: ${data.started.stockQueued} size${data.started.stockQueued === 1 ? '' : 's'} will receive their stock on the next colour sync.`)
        if (ok) setFullSyncOpen(false)
      }} />}>
      <p>Until now Nexus only linked these colours. Starting the full sync turns on, for every linked colour of this family on this store:</p>
      <ul className={styles.list}>{fullSyncEffects(view).map((effect, i) => <li key={i}>{i === 0 ? <strong>{effect}</strong> : effect}</li>)}</ul>
    </Modal>
  </Card>
}

function FullSyncFooter({ busy, onCancel, onStart }: { busy: boolean; onCancel(): void; onStart(): void }) {
  const [understood, setUnderstood] = useState(false)
  return <>
    <Checkbox className={styles.ack} checked={understood} disabled={busy} onChange={e => setUnderstood(e.target.checked)} label="I understand that Nexus then writes the colour swatch names and lists, one list per swatch group." />
    <span className="grow" />
    <Button disabled={busy} onClick={onCancel}>Cancel</Button>
    <Button variant="primary" disabled={busy || !understood} onClick={onStart}>{busy ? 'Starting…' : 'Start full sync'}</Button>
  </>
}

function ColourRow({ model, group, busy, canEdit, canPublish, replace, onReplace, onPick, onClear, onPairSizes, onConfirm }: {
  model: ColourRowModel; group: string | null; busy: boolean; canEdit: boolean; canPublish: boolean; replace: boolean
  onReplace(value: boolean): void; onPick(): void; onClear(): void; onPairSizes(): void; onConfirm(): void
}) {
  const p = model.proposal, sameProduct = !!model.product && p?.shopifyProductId === model.product.id
  const blockers = confirmBlockers(model, replace)
  const toWrite = sameProduct ? p!.skusToWrite : [], toReplace = sameProduct ? p!.skusToReplace ?? [] : [], toRecord = sameProduct ? p!.skusToRecord ?? [] : []
  const tone = model.status === 'linked' ? 'success' : model.status === 'deleted' ? 'danger' : model.status === 'proposed' ? 'info' : 'neutral'
  const label = model.status === 'linked' ? 'Linked' : model.status === 'deleted' ? 'Deleted on Shopify' : model.status === 'proposed' ? 'Proposed' : 'No product'
  return <li className={styles.row}>
    <div className={styles.rowHead}>
      <div className={styles.colour}><strong>{model.name}</strong><Pill tone={tone}>{label}</Pill></div>
      <span className={styles.actions}>
        {model.status !== 'linked' && <Button size="sm" disabled={busy || !canEdit} onClick={onPick}><Search size={14} aria-hidden />{model.product ? 'Choose another product…' : 'Choose product…'}</Button>}
        {model.chosenByOperator && <Button size="sm" variant="ghost" disabled={busy || !canEdit} onClick={onClear}>Clear choice</Button>}
        {model.canPairSizes && <Button size="sm" variant="secondary" disabled={busy || !canPublish} onClick={onPairSizes}>Pair sizes…</Button>}
        {model.status !== 'linked' && <Button size="sm" variant="primary" disabled={busy || !canPublish || blockers.length > 0} onClick={onConfirm}><Link2 size={14} aria-hidden />Confirm…</Button>}
      </span>
    </div>
    {model.product
      ? <KeyValue columns={3} dense labelCase="sentence" items={[
        { label: 'Shopify product', value: `${model.product.title} · ${model.product.id.split('/').pop()}` },
        { label: 'Status', value: model.product.status ?? 'Not read yet' },
        { label: 'Shows colour', value: model.product.showsColour ?? 'None' },
        { label: 'How', value: model.product.how },
        { label: 'Sizes', value: `${model.matched} of ${model.pairs.length} pair${model.shopifyOnly.length ? ` · ${model.shopifyOnly.length} on Shopify only` : ''}` },
        ...(group ? [{ label: 'Swatch group', value: group }] : []),
      ]} />
      : <p className={styles.hint}>{model.status === 'deleted' ? 'Its Shopify product was deleted. Choose its new product.' : 'No Shopify product yet. Choose it from the store, or run Find.'}</p>}
    {model.noSizeMatch && <Banner tone="danger" title="No size matches">{model.noSizeMatch}</Banner>}
    {sameProduct && model.pairs.length > 0 && <Disclosure summary={`Size pairing (${model.matched} of ${model.pairs.length})`}>
      <ul className={styles.list} aria-label={`Size pairing of ${model.name}`}>
        {model.pairs.map(pair => <li key={pair.productId}>{pair.size}{pair.shopifySize ? ` (${pair.shopifySize} on Shopify)` : ''} · {pair.sku} → {pair.shopify ? `Shopify ${pair.shopify.sku ? `SKU ${pair.shopify.sku}` : 'variant without SKU'} (by ${pair.shopify.by === 'sku' ? 'SKU' : 'size name'})` : 'not on this Shopify product'}</li>)}
        {model.shopifyOnly.map(size => <li key={`shopify-${size}`}>{size} · on Shopify only (left as it is)</li>)}
      </ul>
    </Disclosure>}
    {toWrite.length > 0 && <Disclosure summary={`SKUs Nexus will write (${toWrite.length})`}>
      <ul className={styles.list}>{toWrite.map(s => <li key={s.shopifyVariantId}>{s.sku}</li>)}</ul>
    </Disclosure>}
    {toRecord.length > 0 && <Disclosure summary={`SKUs recorded in Nexus as Shopify spells them (${toRecord.length})`}>
      <p className={styles.hint}>These differ from the Nexus SKU only in letter case. Nothing is written to Shopify for them.</p>
      <ul className={styles.list}>{toRecord.map(s => <li key={s.shopifyVariantId}>{s.sku}</li>)}</ul>
    </Disclosure>}
    {toReplace.length > 0 && <Banner tone="warning" title={`${toReplace.length} size${toReplace.length === 1 ? ' carries' : 's carry'} another SKU on Shopify`}>
      <ul className={styles.list}>{toReplace.map(r => <li key={r.shopifyVariantId}>{r.from} → {r.to}</li>)}</ul>
      <Checkbox checked={replace} disabled={busy || !canPublish} onChange={e => onReplace(e.target.checked)} label="Replace these SKUs on Shopify with the Nexus SKUs" />
    </Banner>}
    {sameProduct && model.status !== 'linked' && p!.issues.length > 0 && <Banner tone="warning" title="Problems"><ul className={styles.list}>{p!.issues.map(i => <li key={i.message}>{i.message}</li>)}</ul></Banner>}
  </li>
}

function StoreProductPicker({ path, model, onChoose, onClose }: { path: string; model: ColourRowModel; onChoose(product: StoreProduct): void; onClose(): void }) {
  const [query, setQuery] = useState(model.product?.title ?? ''), [items, setItems] = useState<StoreProduct[]>([]), [cursor, setCursor] = useState<string | null>(null)
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  const fetchPage = useCallback(async (after?: string) => {
    const request = ++generation.current; setBusy(true); setError('')
    try {
      const page = await linkedRequest<{ items: StoreProduct[]; cursor: string | null }>(linkedEndpoint(path, '/store-products', { query: query.trim() || undefined, cursor: after }))
      if (generation.current === request) { setItems(old => after ? [...old, ...page.items.filter(i => !old.some(o => o.id === i.id))] : page.items); setCursor(page.cursor) }
    } catch (e) { if (generation.current === request) setError((e as Error).message) } finally { if (generation.current === request) setBusy(false) }
  }, [path, query])
  useEffect(() => { const timer = setTimeout(() => { void fetchPage() }, 250); return () => { clearTimeout(timer); generation.current++ } }, [fetchPage, refresh])
  const other = (i: StoreProduct) => !!i.linkedTo && !(i.linkedTo.thisFamily && i.linkedTo.valueKey === model.key)
  const options: ListboxPanelOption[] = items.map(i => ({
    value: i.id, label: i.title, disabled: other(i), leading: <Thumbnail src={i.image} hoverPreview={false} alt="" />,
    note: [i.status, `shows colour: ${i.colourName ?? 'none'}`, i.variants == null ? null : `${i.variants} size${i.variants === 1 ? '' : 's'}`, i.sampleSku ? `SKU e.g. ${i.sampleSku}` : 'no SKU',
      i.linkedTo ? (i.linkedTo.thisFamily ? `linked to ${i.linkedTo.valueKey} of this family` : `linked to ${i.linkedTo.familySku}`) : null].filter(Boolean).join(' · '),
  }))
  return <Modal open onClose={onClose} title={`Choose the Shopify product of "${model.name}"`} size="lg" readable>
    <p>Search the store by title. Find then pairs this colour's sizes with the product's sizes (by SKU, then by size name) and lists the SKUs Nexus would write. Nothing is written to Shopify until you confirm.</p>
    <AsyncListboxPanel label="Search this Shopify store" query={query} onQueryChange={setQuery} options={options} loading={busy} error={error} onRetry={() => setRefresh(v => v + 1)}
      onCancel={onClose} onCommit={id => { const item = items.find(i => i.id === id); if (item && !other(item)) onChoose(item) }} placeholder="Product title"
      emptyMessage="No product of the store matches" message={cursor ? 'More products are available below.' : undefined} />
    {cursor && <Button size="sm" disabled={busy} onClick={() => { void fetchPage(cursor) }}>Load more</Button>}
  </Modal>
}

function ConfirmReview({ model, view, locations, replace, busy, onClose, onConfirm }: {
  model: ColourRowModel; view: ColourView; locations: ColourView['locations']; replace: boolean; busy: boolean; onClose(): void; onConfirm(locationId: string | null, colourName: string): void
}) {
  const writes = confirmWrites(model, replace)
  const choose = (locations?.length ?? 0) > 1
  const [locationId, setLocationId] = useState(choose ? '' : locations?.[0]?.id ?? '')
  const [colourName, setColourName] = useState(() => defaultColourName(model))
  const clash = colourNameClash(view, model, colourName), shows = model.proposal?.shopifyColourName ?? null
  const fullSync = !!view.sync?.linked && !view.sync.adoptOnly
  return <Modal open onClose={onClose} title={`Link "${model.name}" to "${writes.product}"?`} size="lg" readable
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || (choose && !locationId) || !colourName.trim() || !!clash} onClick={() => onConfirm(locationId || null, colourName.trim())}>{busy ? 'Linking…' : 'Confirm and link'}</Button></>}>
    <p><strong>Written to Shopify, on “{writes.product}”, then read back:</strong></p>
    <ul className={styles.list}>
      <li>{writes.identity}</li>
      {writes.skus.length > 0 && <li>The SKU of {writes.skus.length} size{writes.skus.length === 1 ? '' : 's'} without one:<ul className={styles.list}>{writes.skus.map(s => <li key={`${s.size}-${s.sku}`}>{s.size}: {s.sku}</li>)}</ul></li>}
      {writes.replaced.length > 0 && <li>The SKU of {writes.replaced.length} size{writes.replaced.length === 1 ? '' : 's'}, replaced:<ul className={styles.list}>{writes.replaced.map(r => <li key={`${r.size}-${r.to}`}>{r.size}: {r.from} → {r.to}</li>)}</ul></li>}
    </ul>
    {writes.recorded.length > 0 && <p>In Nexus only: {writes.recorded.length} size listing{writes.recorded.length === 1 ? '' : 's'} record{writes.recorded.length === 1 ? 's' : ''} the SKU as Shopify spells it ({writes.recorded.map(r => r.sku).join(', ')}).</p>}
    {fullSync
      ? <Banner tone="warning" title="This family runs the full sync">After linking, Nexus sends this colour's stock and keeps its sizes, size order and colour swatches in step with Nexus.</Banner>
      : <p><strong>Stock, prices, sizes and colour swatches are not changed.</strong> The size listings stay paused until you start the full sync.</p>}
    <Field label="Colour name on Shopify" required error={!colourName.trim() ? 'Name the colour.' : clash ?? undefined}
      hint={`${shows ? `The product shows "${shows}" today.` : 'The product shows no colour name today.'} Nexus writes this name to the swatch only after you start the full sync.`}>
      <Input value={colourName} disabled={busy} maxLength={255} onChange={e => setColourName(e.target.value)} />
    </Field>
    {choose && <Field label="Where this colour's stock is counted" hint="The store has more than one active location."><Select value={locationId} disabled={busy} onChange={e => setLocationId(e.target.value)}>
      <option value="">Choose a location</option>{locations!.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>}
  </Modal>
}

/** "Pair sizes…": each Nexus size of the family with the Shopify value it is on this store (the size map; Nexus only). */
function SizeMapReview({ model, axes, busy, onClose, onSave }: { model: ColourRowModel; axes: SizeMapAxis[]; busy: boolean; onClose(): void; onSave(sizeMap: ReturnType<typeof sizeMapOf>): void }) {
  const [edited, setEdited] = useState(axes)
  const pick = (axis: string, nexus: string, shopify: string) => setEdited(list => list.map(a => a.axis !== axis ? a : { ...a, values: a.values.map(v => v.nexus === nexus ? { ...v, shopify: shopify || null } : v) }))
  return <Modal open onClose={onClose} title={`Pair the sizes of "${model.name}" with "${model.product?.title ?? 'its Shopify product'}"`} size="lg" readable
    footer={<><Button disabled={busy} onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy} onClick={() => onSave(sizeMapOf(edited))}>{busy ? 'Saving…' : 'Save and find again'}</Button></>}>
    <p>Where Nexus and Shopify name a size differently (EU 44 is XS on the store), choose the Shopify size of each. The pairing is the family's on this store: Find, Confirm and the colour sync then pair, add and order the sizes by it. Saving writes nothing to Shopify.</p>
    {edited.map(axis => <section key={axis.axis} aria-label={axis.name}>
      <p><strong>{axis.name}</strong></p>
      <div className={styles.sizeMap}>
        {axis.values.map(v => <Field key={v.nexus} label={`${axis.name} ${v.nexus}`}>
          <Select size="sm" value={v.shopify ?? ''} disabled={busy} onChange={e => pick(axis.axis, v.nexus, e.target.value)}>
            <option value="">Same as Nexus ({v.nexus})</option>
            {axis.choices.filter(c => c !== v.nexus).map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
        </Field>)}
      </div>
    </section>)}
  </Modal>
}
