'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { MoreHorizontal, PanelLeftOpen, Redo2, Undo2 } from 'lucide-react'
import type { MediaOp } from '@nexus/shared/media-plan'
import type { AmazonArchiveKind } from '@nexus/shared/media-plan-archive'

import { Banner, Drawer, Field, Listbox, MediaPreview, Menu, Modal, useToast, type MenuItemDef } from '@/design-system/components'
import { Button, SegmentedControl, Select, ToolbarButton } from '@/design-system/primitives'
import { usePathname, useRouter, useSearchParams } from '@/lib/workspaces/navigation'

import { MASTER_SCOPE } from '../../types'
import { useStudioScope } from '../../contracts'
import { languageLabel } from '../../scopes'
import { LibraryPanel } from './LibraryPanel'
import { LibraryManager } from './LibraryManager'
import { PhotoGrid, type AddTarget } from './PhotoGrid'
import { SidePanel } from './SidePanel'
import { ListingChips } from './ListingChips'
import { DestinationName } from './destinationName'
import { CompareDialog } from './CompareDialog'
import { UploadDialog } from './UploadDialog'
import { PublishPhotosDialog } from './PublishPhotosDialog'
import { SamePhotoDialog } from './SamePhotoDialog'
import { AmazonZipDialog } from './AmazonZipDialog'
import { setPhotoPublish } from './photoPublish'
import { joinVersions, leaveVersions, markDistinct, markSame, separate, undoSame, undoVersions, type SamePhotoUndo, type VersionsUndo } from './lookalikeApi'
import {
  CHANNEL_LABEL, amazonMarketLayout, amazonOwnMarkets, assetMap, cardOf, computeLayouts, copyFromOps, destinationLabel, destinationNameParts, followAllOps, libraryUsage, listingName,
  ownedSkuSets, scopeDestinationKey, setRows, siblingListings, swatchRows, viewAxis, viewStack, withReadableNames, wordList, languageName, versionLanguages, versionsOf,
  type LayerView, type LibraryAsset, type MediaChannel, type MediaDestinationRow, type MediaRead,
} from './model'
import { apiSend } from '../api'
import type { ActionEntry, MediaPlanState } from './useMediaPlan'
import styles from './planPage.module.css'

const WIDE = 1180
const LIBRARY_KEY = 'nexus:media:library-beside'

/** The page's width decides where the library and the side panel live: beside the grid, or in a drawer and below it. */
function useWide() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(WIDE)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.getBoundingClientRect().width)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width >= WIDE] as const
}

function readLibraryPref(): boolean {
  try { return window.localStorage.getItem(LIBRARY_KEY) !== 'off' } catch { return true }
}
function writeLibraryPref(on: boolean) {
  try { window.localStorage.setItem(LIBRARY_KEY, on ? 'on' : 'off') } catch { /* a browser that blocks storage keeps the default */ }
}

/**
 * The Media page of a family on the photo plan — redesign 2026-09-29 (Owner: "simple and fast to use").
 *
 * The studio's scope selector (Editing: Shared product, or a channel · market · account · listing — the same selector as
 * the Information page) chooses what the page edits: the Shared photos, or one destination's own photos. One photo grid
 * (rows = sets, columns = slots) shows it; a row a destination changed is marked there with "Reset to shared". The
 * library folds away on the left; the side panel shows the destination's buyer preview and checks, or every destination
 * on the Shared product. The header's Publish opens "Publish photos" for what the page shows.
 *
 * Amazon (2026-09-29, the Owner's option 3): "All Amazon markets" edits the account's photos, the one set its API sends;
 * "Only DE" edits Amazon DE's own photos, below them — they reach Amazon only through the DE ZIP.
 */
export function MediaPlanPage({ read: raw, plan }: { read: MediaRead; plan: MediaPlanState }) {
  const { scope, market, destination: studioDestination, marketplaces, setListing } = useStudioScope()
  const router = useRouter()
  const pathname = usePathname()
  const search = useSearchParams()
  const { toast } = useToast()
  const [box, wide] = useWide()
  // Readable names for photos named by a storage code: every part of the page shows them (not saved anywhere).
  const read = useMemo(() => withReadableNames(raw), [raw])
  const [showSkus, setShowSkus] = useState(false)
  const [pending, setPending] = useState<{ view: LayerView; target: AddTarget } | null>(null)
  const [libraryBeside, setLibraryBeside] = useState(readLibraryPref)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [managing, setManaging] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  // The ZIP window: closed, or open on a market and a kind ("Only DE" opens on the DE ZIP).
  const [zip, setZip] = useState<{ market: string | null; kind: AmazonArchiveKind } | null>(null)
  // Amazon: the switch "All Amazon markets | Only <market>" (default All; kept while the page is open).
  const [amazonOnly, setAmazonOnly] = useState(false)
  // P4b — the upload dialog, with the files dropped on the page (if any).
  const [uploading, setUploading] = useState<File[] | null>(null)
  const [dropping, setDropping] = useState(false)
  // Publish photos: false = closed, 'all' = every destination, else what the page shows (one destination, or every
  // listing of one eBay account and market).
  const [publishing, setPublishing] = useState<false | 'all' | string | string[]>(false)
  // W4a — two library photos that look the same ("Same photo?").
  const [lookalike, setLookalike] = useState<{ a: string; b: string; kind?: 'same' | 'versions' } | null>(null)

  const assets = useMemo(() => assetMap(read), [read])
  const usage = useMemo(() => libraryUsage(read), [read])
  const layouts = useMemo(() => computeLayouts(read), [read])
  const shared: LayerView = { layer: 'SHARED' }

  // What the scope selector points at: the Shared product, or one destination (null while it resolves or has none).
  const channelScope = scope !== MASTER_SCOPE
  const scopeKey = channelScope && studioDestination.status === 'ready' ? scopeDestinationKey(studioDestination.data) : null
  const d = scopeKey ? read.destinations.find(x => x.key === scopeKey) ?? null : null
  // "Only DE": an Amazon market the account lists the product on; the page then edits that market's own layer.
  const amazonMarket = d?.channel === 'AMAZON' && market && d.markets.includes(market) ? market : null
  const onlyMarket = amazonOnly ? amazonMarket : null
  const view: LayerView = d ? { layer: 'LISTING', destination: d.key, ...(onlyMarket ? { market: onlyMarket } : {}) } : shared
  // A market sees its own language versions (eBay IT the Italian size chart, Amazon DE the German one in its ZIP). All
  // Amazon markets shows the versions Publish photos sends to every market (the account's first market's language).
  const marketLanguages = d ? marketplaces.find(m => m.channel === d.channel && m.code === market)?.languages ?? [] : []
  const languages = d ? (marketLanguages.length && (d.channel !== 'AMAZON' || onlyMarket) ? marketLanguages : d.languages) : null
  const ownMarkets = d ? amazonOwnMarkets(read, d) : []
  const marketView = d && onlyMarket ? { code: onlyMarket, layout: amazonMarketLayout(read, d, onlyMarket, languages ?? d.languages) } : null

  // The one Publish button: the studio header's, while this page is open. On an eBay account and market with aliases it
  // offers every listing there, the one shown and its aliases (each is its own line and its own revision).
  const siblings = d && d.channel !== 'AMAZON' ? siblingListings(read, d) : []
  const publishKeys = d ? (siblings.length > 1 ? siblings.filter(x => x.targetable).map(x => x.key) : [d.key]) : null
  const publishKey = publishKeys?.join('|') ?? null
  useEffect(() => {
    setPhotoPublish({ open: () => setPublishing(publishKey ? publishKey.split('|') : 'all') })
    return () => setPhotoPublish(null)
  }, [publishKey])

  const edit = useCallback((target: LayerView, ops: MediaOp[], label: string) => {
    void plan.edit(target, ops, label).then(outcome => {
      if (!outcome.ok) return
      toast(<span className={styles.toast}>{label}. <Button size="xs" variant="secondary" onClick={() => plan.undo()}>Undo</Button></span>, 'success', { duration: 6000 })
    })
  }, [plan, toast])

  /** Point the studio's scope selector at a destination (one URL write, as the Editing menu does). */
  const openDestination = (x: MediaDestinationRow) => {
    const next = new URLSearchParams(search.toString())
    const patch: Record<string, string | undefined> = {
      scope: x.channel, market: x.marketplace === 'GLOBAL' ? (market && x.markets.includes(market) ? market : x.markets[0]) : x.marketplace,
      account: x.accountId, listing: x.alias?.id, tab: 'images', locale: undefined, locales: undefined, rec: undefined, cell: undefined, chip: undefined,
    }
    for (const [key, value] of Object.entries(patch)) { if (value === undefined) next.delete(key); else next.set(key, value) }
    router.push(`${pathname}?${next.toString()}`)
  }

  const openAsset = (id: string) => { setDrawerOpen(false); setViewing(id) }
  // W4a/W4b — library answers go into the page's Undo/Redo (⌘Z, ⌘⇧Z), like plan edits; the message's Undo is the same entry.
  const sameEntry = (keep: LibraryAsset, drop: LibraryAsset, undo: SamePhotoUndo): ActionEntry => ({ label: `Same photo: ${drop.label} and ${keep.label}`,
    run: async () => {
      await undoSame(read.rootId, undo)
      toast(`${drop.label} is its own photo again.`, 'success')
      return { label: `Same photo: ${drop.label} and ${keep.label}`, run: async () => sameEntry(keep, drop, (await markSame(read.rootId, keep.id, drop.id)).undo) }
    } })
  const versionsEntry = (a: LibraryAsset, b: LibraryAsset, versionLangs: Record<string, string>, undo: VersionsUndo): ActionEntry => ({ label: `Language versions: ${a.label} and ${b.label}`,
    run: async () => {
      await undoVersions(read.rootId, undo)
      toast(`${a.label} and ${b.label} are two photos again.`, 'success')
      return { label: `Language versions: ${a.label} and ${b.label}`, run: async () => versionsEntry(a, b, versionLangs, (await joinVersions(read.rootId, [a.id, b.id], versionLangs)).undo) }
    } })
  const distinctEntry = (a: LibraryAsset, b: LibraryAsset): ActionEntry => ({ label: `Not the same: ${a.label} and ${b.label}`,
    run: async () => {
      await markDistinct(read.rootId, a.id, b.id, true)
      return { label: `Not the same: ${a.label} and ${b.label}`, run: async () => { await markDistinct(read.rootId, a.id, b.id); return distinctEntry(a, b) } }
    } })
  const done = (entry: ActionEntry, text: string) => {
    plan.record(entry)
    void plan.reload()
    toast(<span className={styles.toast}>{text}{' '}<Button size="xs" variant="secondary" onClick={() => void plan.undoAction(entry)}>Undo</Button></span>, 'success', { duration: 10000 })
  }
  const layersText = (n: number) => n ? ` (${n} photo layer${n === 1 ? '' : 's'} changed)` : ''
  const markSamePhoto = async (keep: LibraryAsset, drop: LibraryAsset) => {
    const answer = await markSame(read.rootId, keep.id, drop.id)
    done(sameEntry(keep, drop, answer.undo), `${drop.label} is now a copy of ${keep.label}${layersText(answer.layersChanged)}. Undo is also in the toolbar (⌘Z).`)
  }
  const markNotSame = async (a: LibraryAsset, b: LibraryAsset) => {
    await markDistinct(read.rootId, a.id, b.id)
    done(distinctEntry(a, b), `${a.label} and ${b.label} are marked as different photos.`)
  }
  const makeVersions = async (a: LibraryAsset, b: LibraryAsset, versionLangs: Record<string, string>) => {
    const answer = await joinVersions(read.rootId, [a.id, b.id], versionLangs)
    done(versionsEntry(a, b, versionLangs, answer.undo), `${a.label} and ${b.label} are language versions of one photo${layersText(answer.layersChanged)}. Undo is also in the toolbar (⌘Z).`)
  }
  const setPhotoLanguage = async (asset: LibraryAsset, languageTag: string) => {
    const res = await apiSend<unknown>(`/api/products/${encodeURIComponent(read.rootId)}/media/library`, 'PATCH', { languages: [{ id: asset.id, languageTag }], groups: [] })
    if (!res.ok) { toast(res.message, 'danger'); return }
    void plan.reload()
    toast(`${asset.label}: ${languageName(languageTag)}.`, 'success')
  }

  const showLibrary = () => {
    if (wide) { setLibraryBeside(true); writeLibraryPref(true) } else setDrawerOpen(true)
  }
  const hideLibrary = () => { setLibraryBeside(false); writeLibraryPref(false) }
  // An empty slot (or a row's add) asks for photos: the library opens on "Adding to …".
  const requestAdd = (target: AddTarget) => {
    setPending({ view, target })
    if (!wide || !libraryBeside) showLibrary()
  }
  // "Add to" goes to the layer the page edits: the destination's own, or Shared.
  const addView = pending?.view ?? view
  const targets: AddTarget[] = [
    ...setRows(read, addView, { skus: showSkus }).filter(r => r.kind !== 'safety' || !d || d.channel === 'AMAZON').map(r => ({ id: r.ref, label: r.label, group: 'Sets' as const })),
    ...(!d || d.channel === 'AMAZON' ? swatchRows(read, addView).map(s => ({ id: `swatch:${s.value}`, label: `${s.label} swatch`, group: 'Swatches' as const, one: true })) : []),
  ]
  const addTo = (target: AddTarget, ids: string[]) => {
    const into = pending?.view ?? view
    if (target.group === 'Swatches') edit(into, [{ op: 'swatch', value: target.id.slice('swatch:'.length), assetId: ids[0] }], `Set the ${target.label}`)
    else edit(into, [{ op: 'insert', set: target.id as `value:${string}`, assetIds: ids }], `Add ${ids.length} photo${ids.length > 1 ? 's' : ''} to ${target.label}`)
    if (!wide) setDrawerOpen(false)
  }

  const axis = viewAxis(read, viewStack(read, shared))
  const skuCount = ownedSkuSets(read, shared)
  const comparable = read.destinations.filter(x => x.targetable)
  const compareStart = d?.targetable
    ? [d.key, ...comparable.filter(x => x.key !== d.key && x.channel === d.channel).map(x => x.key)].slice(0, 3)
    : comparable.slice(0, 3).map(x => x.key)

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable="true"]')) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) plan.redo(); else plan.undo()
    }
    // U opens "Upload photos" (PLAN.md §5.2) — never from inside a control that owns the key.
    if (event.key.toLowerCase() === 'u' && !event.metaKey && !event.ctrlKey && !event.altKey && !target.closest('select, [role="listbox"], [role="menu"], [role="dialog"]')) {
      event.preventDefault()
      setUploading([])
    }
  }
  // Files dropped anywhere on the page open the upload dialog with them (a library photo dragged onto a slot is not a file).
  const hasFiles = (event: DragEvent<HTMLDivElement>) => [...event.dataTransfer.types].includes('Files')
  // The outline goes when the files stop moving over the page: a drag that ends elsewhere (Escape, another window)
  // sends no dragleave to the page, and the outline stayed (2026-09-29).
  const dropTimer = useRef<number | null>(null)
  useEffect(() => () => { if (dropTimer.current) window.clearTimeout(dropTimer.current) }, [])
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    if (!dropping) setDropping(true)
    if (dropTimer.current) window.clearTimeout(dropTimer.current)
    dropTimer.current = window.setTimeout(() => setDropping(false), 300)
  }
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => { if (event.currentTarget === event.target) setDropping(false) }
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return
    event.preventDefault(); setDropping(false)
    setUploading([...event.dataTransfer.files])
  }

  const beside = wide && libraryBeside
  const library = <LibraryPanel read={read} usage={usage} targets={targets} pendingTarget={pending?.target ?? null} onClearPending={() => setPending(null)}
    onAdd={addTo} onOpen={asset => openAsset(asset.id)} onManage={() => { setDrawerOpen(false); setManaging(true) }} onUpload={() => setUploading([])}
    onCollapse={beside ? hideLibrary : undefined} onDragging={plan.hold} draggable={beside}
    onSkip={() => { setDrawerOpen(false); const grid = box.current; (grid?.querySelector<HTMLElement>('.nds-media-board-thumb[tabindex="0"]') ?? grid?.querySelector<HTMLElement>('.nds-media-board-add'))?.focus() }}
    onLookalike={(a, b, kind) => { setDrawerOpen(false); setViewing(null); setLookalike({ a, b, kind }) }} />
  // A plan may point at another SKU's copy of a picture: the preview opens its library card.
  const viewingAsset = viewing ? read.library.find(a => a.id === cardOf(read)(viewing)) ?? null : null
  // Copies of the same picture on other SKUs; the photos marked the same (W4a) are listed apart, each with "Separate it".
  const skuCopies = (viewingAsset?.copies ?? []).filter(id => !viewingAsset?.merged?.some(m => m.id === id)).length

  if (managing) return <div ref={box} className={styles.page}><LibraryManager productId={read.productId} onClose={() => { setManaging(false); void plan.reload(true) }} /></div>

  // "Copy photos from": this account and market's other listings first (its aliases), then the channel, then the rest.
  const closeness = (x: MediaDestinationRow) => !d ? 0 : siblings.some(y => y.key === x.key) ? 2 : x.channel === d.channel ? 1 : 0
  const others = d ? read.destinations.filter(x => x.key !== d.key && x.targetable).sort((a, b) => closeness(b) - closeness(a)) : []
  const followAll = d ? followAllOps(read, view) : []
  // What the page edits, in words: "Amazon DE · Test Amazon" on "Only DE", else the destination.
  const editing = d ? onlyMarket ? `Amazon ${onlyMarket} · ${d.accountLabel ?? 'Unknown account'}` : destinationLabel(d) : 'Shared photos'
  const resetAll = onlyMarket ? 'Reset all to All Amazon markets' : 'Reset all to shared'
  const destinationMenu: MenuItemDef[] = d ? [
    { id: 'reset-all', label: resetAll, disabled: !followAll.length, onSelect: () => edit(view, followAll, `${resetAll}: ${editing}`) },
    ...(others.length ? [{ id: 'copy-heading', heading: true, label: 'Copy photos from' }, ...others.map(o => ({ id: `copy:${o.key}`, label: destinationLabel(o), onSelect: () => {
      const ops = copyFromOps(read, o, { layer: 'LISTING', destination: d.key, ...(onlyMarket ? { market: onlyMarket } : {}) })
      if (ops.length) edit(view, ops, `Copy photos from ${destinationLabel(o)}`)
      else toast(`${editing} already shows the photos of ${destinationLabel(o)}.`, 'info')
    } }))] : []),
  ] : []
  const marketLanguage = marketLanguages[0] ?? d?.languages.find(l => l !== 'mul') ?? null
  const apiLanguage = d?.languages.find(l => l !== 'mul') ?? null

  // Focusable (not a Tab stop): a click on the page keeps its shortcuts (U, ⌘Z) and lets PageDown scroll it.
  return <div ref={box} className={styles.page} tabIndex={-1} onKeyDown={onKeyDown} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} data-dropping={dropping || undefined}>
    <header className={styles.toolbar}>
      <h2 className={styles.pageTitle}>Media · {read.sku} · {read.family.variants.length} variant{read.family.variants.length === 1 ? '' : 's'}</h2>
      <label className={styles.control}><span>Photos vary by</span>
        <Listbox size="sm" ariaLabel="Photos vary by" value={axis.axis ?? ''}
          onChange={value => edit(shared, [{ op: 'axis', axis: value || null }], value ? `Photos vary by ${read.family.axes.find(a => a.code === value)?.label ?? value}` : 'One gallery for every variant')}
          options={[...read.family.axes.map(a => ({ value: a.code, label: a.label })), { value: '', label: 'Nothing — one gallery' }]} />
      </label>
      <span className={styles.spacer} />
      <ToolbarButton icon={<Undo2 size={16} />} label={plan.undoLabel ? `Undo: ${plan.undoLabel}` : 'Undo'} shortcut="⌘Z" disabled={!plan.canUndo} onClick={() => plan.undo()} />
      <ToolbarButton icon={<Redo2 size={16} />} label={plan.redoLabel ? `Redo: ${plan.redoLabel}` : 'Redo'} shortcut="⌘⇧Z" disabled={!plan.canRedo} onClick={() => plan.redo()} />
      <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" triggerProps={{ className: 'nds-btn sm', 'aria-label': 'More actions', title: 'More actions' }} items={[
        { id: 'upload', label: 'Upload photos… (U)', onSelect: () => setUploading([]) },
        { id: 'compare', label: 'Compare destinations…', disabled: comparable.length < 2, description: comparable.length < 2 ? 'Compare needs two or more destinations.' : undefined, onSelect: () => setComparing(true) },
      ]} />
      {!beside && <Button size="sm" variant="secondary" onClick={showLibrary}><PanelLeftOpen size={14} aria-hidden />Library · {read.library.length}</Button>}
    </header>

    {plan.writeError && <Banner tone="danger" title="Not saved" onDismiss={plan.clearWriteError}
      action={plan.writeError.retry ? <Button size="sm" variant="secondary" onClick={plan.writeError.retry}>Try again</Button> : undefined}>{plan.writeError.message}</Banner>}
    {plan.notice && <Banner tone="warning" onDismiss={plan.clearNotice}>{plan.notice}</Banner>}
    {read.family.unmapped.length > 0 && <Banner tone="warning" title="Some option values are not in the attribute dictionary">
      {read.family.unmapped.map(k => read.family.valueLabels[k] ?? k).join(', ')} — their photos cannot reach eBay until they are mapped in the variation theme.
    </Banner>}

    <div className={styles.layout} data-wide={wide || undefined} data-library={beside || undefined}>
      {beside && <aside className={styles.libraryColumn}>{library}</aside>}
      <section className={styles.main} aria-labelledby="media-grid-title">
        <header className={styles.gridHead}>
          {d ? <>
            <h3 id="media-grid-title" className={styles.sectionTitle}>{d.channel === 'AMAZON' ? destinationNameParts(d).head : <DestinationName d={d} />}</h3>
            {amazonMarket && <SegmentedControl ariaLabel="Which Amazon photos to edit" size="sm" wrap value={onlyMarket ? 'market' : 'all'}
              onChange={value => setAmazonOnly(value === 'market')}
              options={[{ value: 'all', label: 'All Amazon markets' }, { value: 'market', label: `Only ${amazonMarket}` }]} />}
            <span className={styles.spacer} />
            {d.channel === 'AMAZON' && <Button size="sm" variant="secondary" disabled={!layouts[d.key] || !d.markets.length}
              onClick={() => setZip({ market, kind: onlyMarket ? 'country' : 'slots' })}>Export ZIP per marketplace</Button>}
            {destinationMenu.length > 0 && <Menu label={<MoreHorizontal size={16} aria-hidden />} align="right" items={destinationMenu}
              triggerProps={{ className: 'nds-btn sm', 'aria-label': `More actions for ${destinationLabel(d)}`, title: 'More actions' }} />}
          </> : <h3 id="media-grid-title" className={styles.sectionTitle}>{channelScope ? `${CHANNEL_LABEL[scope as MediaChannel] ?? scope}${market ? ` ${market}` : ''}` : 'Shared photos'}</h3>}
        </header>
        {d && <ListingChips read={read} destination={d} layouts={layouts} onPick={x => setListing(x.alias?.id)} />}
        {(!channelScope || d) && <p className={styles.muted}>{!channelScope
          ? 'Every channel shows these photos unless a row is changed for it. To change a channel\'s or a market\'s photos, choose it in Editing above. Nothing is sent until you publish.'
          : d?.channel === 'AMAZON' && onlyMarket
            ? `What Amazon ${onlyMarket} shows${marketLanguage ? `, in its ${languageLabel(marketLanguage)} versions` : ''}. Rows without a mark show the All Amazon markets photos. A change here is for Amazon ${onlyMarket} only: it reaches Amazon only through the ${onlyMarket} ZIP. Safety images are one set for all markets.`
          : d?.channel === 'AMAZON'
            ? `What Publish photos sends to ${wordList(d.markets)}${apiLanguage ? `, in the ${languageLabel(apiLanguage)} versions` : ''}: Amazon keeps one photo set per ASIN. Rows without a mark show the Shared photos.${amazonMarket ? ` To change Amazon ${amazonMarket} alone, choose Only ${amazonMarket}.` : ''}`
            : d ? `Rows without a mark show the Shared photos. A change here gives ${d.alias || siblings.length > 1 ? listingName(d) : `${CHANNEL_LABEL[d.channel]}${d.marketplace === 'GLOBAL' ? '' : ` ${d.marketplace}`}`} its own photos for that row.` : ''}</p>}
        {ownMarkets.map(m => <Banner key={m} tone="info" title={`Amazon ${m} has own photos`}
          action={<Button size="sm" variant="secondary" onClick={() => setZip({ market: m, kind: 'country' })}>Export the {m} ZIP</Button>}>
          They reach Amazon only through the {m} ZIP (Seller Central → Image Manager → Country-Specific Upload). Publish photos sends the All Amazon markets photos.
        </Banner>)}

        {channelScope && !d ? <ScopeState status={studioDestination.status} message={studioDestination.status === 'error' ? studioDestination.message : null}
          retry={studioDestination.status === 'error' ? studioDestination.retry : undefined} channel={scope} market={market} />
          : <PhotoGrid read={read} view={view} destination={d} assets={assets} languages={languages} showSkus={!d && showSkus}
            edit={edit} onAddRequest={requestAdd} onOpen={openAsset} />}

        {!d && !channelScope && (read.family.variants.length > 0 ? <span className={styles.skuToggle}>
          <Button size="sm" variant="ghost" aria-expanded={showSkus} onClick={() => setShowSkus(v => !v)}>
            {showSkus ? '▾' : '▸'} Photos for one SKU only ({skuCount})
          </Button>
          {showSkus && <span className={styles.muted}>Amazon and Shopify use a SKU's own photos; eBay shows photos per {axis.info?.label ?? 'value'}.</span>}
        </span> : <span className={styles.muted}>This product has no options — one gallery for every channel.</span>)}
      </section>
      <SidePanel read={read} destination={d} layouts={layouts} market={marketView} assets={assets} onOpenDestination={openDestination} />
    </div>

    <Drawer open={!beside && drawerOpen} onClose={() => { setDrawerOpen(false); setPending(null) }} title="Photo library" width="min(520px, 100vw)">
      {library}
    </Drawer>
    <UploadDialog read={read} plan={plan} open={uploading !== null} files={uploading ?? []} onClose={() => setUploading(null)} onReview={() => setPublishing(publishKeys ?? 'all')} />
    <PublishPhotosDialog read={read} open={publishing !== false} only={publishing === 'all' || publishing === false ? null : publishing} onClose={() => setPublishing(false)} />
    <CompareDialog read={read} assets={assets} open={comparing} initial={compareStart} onClose={() => setComparing(false)}
      onOpenDestination={key => { const x = read.destinations.find(y => y.key === key); if (x) openDestination(x) }} />
    <SamePhotoDialog read={read} pair={lookalike} onClose={() => setLookalike(null)} onSame={markSamePhoto} onVersions={makeVersions} onDistinct={markNotSame} />
    {d?.channel === 'AMAZON' && <AmazonZipDialog key={d.key} read={read} destination={d} assets={assets} open={!!zip} initialMarket={zip?.market ?? market} initialKind={zip?.kind}
      onClose={() => setZip(null)} />}
    <Modal open={!!viewingAsset} onClose={() => setViewing(null)} title={viewingAsset?.label} size="lg">
      {viewingAsset && <MediaPreview type={viewingAsset.mediaType} url={viewingAsset.url} label={viewingAsset.label} />}
      {viewingAsset && <p className={styles.muted}>{viewingAsset.width && viewingAsset.height ? `${viewingAsset.width} × ${viewingAsset.height} px · ` : ''}{usage.get(viewingAsset.id)?.join(' · ') || 'Not in any set'}</p>}
      {skuCopies ? <p className={styles.muted}>The same picture is stored {skuCopies} more time{skuCopies === 1 ? '' : 's'} (copies on other SKUs). The library shows it once.</p> : null}
      {viewingAsset?.merged?.map(copy => <p key={copy.id} className={styles.muted}>{copy.label} was marked the same photo as this one, so the library shows it here.{' '}
        <Button size="xs" variant="link" onClick={() => void separate(read.rootId, copy.id).then(() => { void plan.reload(); toast(`${copy.label} is its own photo again. Photo sets did not change.`, 'success') },
          (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'danger'))}>Separate it</Button></p>)}
      {viewingAsset?.lookalikes?.map(other => <p key={other.id} className={styles.muted}>
        {other.kind === 'versions' ? 'Similar to' : 'Looks like'} {read.library.find(x => x.id === other.id)?.label ?? 'another photo'}{other.kind === 'versions' ? ' — maybe another language of this photo.' : ', at another address.'}{' '}
        <Button size="xs" variant="link" onClick={() => { setViewing(null); setLookalike({ a: viewingAsset.id, b: other.id, kind: other.kind }) }}>Compare them</Button></p>)}
      {viewingAsset && viewingAsset.mediaType === 'IMAGE' && <div className={styles.photoLanguage}>
        <Field label="Language of the text in this photo">
          <Select size="sm" value={viewingAsset.languageTag} onChange={e => void setPhotoLanguage(viewingAsset, e.target.value)}>
            <option value="zxx">No text</option>
            <option value="mul">Several languages</option>
            {[...new Set([...versionLanguages(read), viewingAsset.languageTag])].filter(t => t !== 'zxx' && t !== 'mul').map(tag => <option key={tag} value={tag}>{languageName(tag)}</option>)}
          </Select>
        </Field>
        {versionsOf(read, viewingAsset.id).length > 1 && <p className={styles.muted}>
          Versions: {versionsOf(read, viewingAsset.id).map(v => `${v.label} (${languageName(v.languageTag)})`).join('; ')}.{' '}
          <Button size="xs" variant="link" onClick={() => void leaveVersions(read.rootId, viewingAsset.id).then(() => { void plan.reload(); toast(`${viewingAsset.label} is its own photo again. Photo sets did not change.`, 'success') },
            (e: unknown) => toast(e instanceof Error ? e.message : String(e), 'danger'))}>Leave its versions</Button></p>}
        <Field label="Add a language version of this photo">
          <Select size="sm" value="" onChange={e => { const other = e.target.value; if (other) { setViewing(null); setLookalike({ a: viewingAsset.id, b: other, kind: 'versions' }) } }}>
            <option value="">Choose a photo</option>
            {read.library.filter(x => x.mediaType === 'IMAGE' && x.id !== viewingAsset.id && !versionsOf(read, viewingAsset.id).some(v => v.id === x.id)).map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
          </Select>
        </Field>
      </div>}
    </Modal>
  </div>
}

/** A channel scope with no destination on the page: still resolving, failed, or this product has no listing there. */
function ScopeState({ status, message, retry, channel, market }: { status: string; message: string | null; retry?: () => void; channel: string; market: string | null }) {
  const where = `${CHANNEL_LABEL[channel as MediaChannel] ?? channel}${market ? ` ${market}` : ''}`
  if (status === 'loading') return <p className={styles.muted} aria-busy="true">Finding the {where} listing…</p>
  if (status === 'error') return <Banner tone="danger" title={`The ${where} listing could not be read`} action={retry ? <Button size="sm" variant="secondary" onClick={retry}>Try again</Button> : undefined}>{message}</Banner>
  if (status === 'idle') return <Banner tone="neutral">Choose a market in Editing above to see its photos.</Banner>
  return <Banner tone="neutral" title={`No ${where} listing for this product on this account`}>
    Photos are set per listing, so there is nothing to change here yet. When a listing exists, it starts with the Shared photos.
  </Banner>
}
