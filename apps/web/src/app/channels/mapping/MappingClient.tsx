'use client'

/**
 * PES.6 — the mapping engine's shell.
 *
 * Layout (the Rithum frame, rebuilt on the Nexus DS from scratch — decision §2.10):
 *
 *   ┌ PageHeader: Channel mapping · [channel × market ▾] · [Business rules] [Errors (N)] ┐
 *   ├──────────────┬──────────────────────────────────────────────────────────────────────┤
 *   │ Categories   │ <category> · Preview SKU [typeahead ×] · Go to product                │
 *   │  working set ├──────────────────────────────────────────────────────────────────────┤
 *   │  mapped/total│ Field ⌕ · Priority ▾ · Preview ▾ · Status ▾ · N of M · Clear filters  │
 *   │              ├──────────────────────────────────────────────────────────────────────┤
 *   │ Category     │ THE GRID: Channel Field · Priority · Mapping · Preview · Status       │
 *   │  mapping     │ grouped by the channel's own property groups                          │
 *   └──────────────┴──────────────────────────────────────────────────────────────────────┘
 *
 * The rail lists CHANNEL categories, not ours, because that is what the field set hangs off —
 * and because our `Category` taxonomy is empty on prod (0 rows, measured 2026-09-01), so a rail
 * built on it would be a blank panel pretending to be a feature. Our-category → channel-category
 * mapping is the separate pane at the rail's foot, which says so plainly.
 */

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Copy, ExternalLink, FunctionSquare, RefreshCw, Wand2, X } from 'lucide-react'

import { Button, Input, Pill } from '@/design-system/primitives'
import { Banner, Drawer, EmptyState, Listbox, ListboxPanel, MultiSelect, ToastProvider, useToast } from '@/design-system/components'
import { PageHeader } from '@/design-system/patterns'
import {
  GridDensityProvider, NexusGrid, GridSheet, GridToolbar, SHEET_GRID_OPTIONS,
  type ColDef, type GridApi, type GridReadyEvent,
} from '@/design-system/grid'

import styles from './mapping.module.css'
import {
  fieldWithPreviewRule, isCategoryField, PRIORITY_META, type FieldCatalogue, type FieldPriority,
  type PreviewSku, type ResolvedProduct, type TemplateRow,
} from './_shared/contracts'
import * as api from './_shared/api'
import { FieldNameCell, MappingCell, PreviewCell, PriorityCell, StatusCell, type MappingRow } from './_shared/cells'
import { rendererOwnsKeyboard } from '@/design-system/grid/rendererKeyboard'
import { RuleDrawer } from './_shared/RuleDrawer'
import { BusinessRulesDrawer } from './_shared/BusinessRulesDrawer'
import { CategoryMappingPane } from './_shared/CategoryMappingPane'
import { AutoMapDrawer } from './_shared/AutoMapDrawer'
import { productWorkspaceHref } from '@/app/_shared/product-workspace-href'
import { HistoryDrawer } from './_shared/HistoryDrawer'
import { CloneMappingDrawer } from './_shared/CloneMappingDrawer'
import { VariationsGroup } from './_shared/VariationsGroup'

type PreviewFilter = 'all' | 'errors' | 'empty' | 'hasValue'
type StatusFilter = 'all' | 'mapped' | 'unmapped' | 'owned'

const ALL_PRIORITIES: FieldPriority[] = ['required', 'requiredIfRelevant', 'bestPractice', 'optional']

function MappingWorkspace() {
  const { toast } = useToast()
  const search = useSearchParams()
  const requestedChannel = search.get('channel')?.toUpperCase() ?? null
  const requestedMarket = search.get('market')?.toUpperCase() ?? null
  const requestedCategory = search.get('category') ?? search.get('productType')
  const requestedField = search.get('field')
  const requestedProduct = search.get('product')
  const requestedAccount = search.get('account')
  const requestedAlias = search.get('alias') ?? ''


  // ── template (channel × market) ────────────────────────────────
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [templateKey, setTemplateKey] = useState<string>('')
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [templateReload, setTemplateReload] = useState(0)
  const [fatal, setFatal] = useState<string | null>(null)

  // ── catalogue ──────────────────────────────────────────────────
  const [catalogue, setCatalogue] = useState<FieldCatalogue | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [channelCategories, setChannelCategories] = useState<Array<{ id: string; label: string }>>([])
  const [categoryNote, setCategoryNote] = useState<string>('')
  const [categoryInput, setCategoryInput] = useState('')
  const [categoriesError, setCategoriesError] = useState<string | null>(null)
  const [loadingFields, setLoadingFields] = useState(false)
  const [catalogueError, setCatalogueError] = useState<string | null>(null)

  // ── preview SKU ────────────────────────────────────────────────
  const [previewListings, setPreviewListings] = useState<api.PreviewListing[]>([])
  const [previewListingId, setPreviewListingId] = useState('primary')
  const [listingError, setListingError] = useState<string | null>(null)
  const previewListing = previewListings.find(l => l.id === previewListingId)
  const [skuQuery, setSkuQuery] = useState('')
  const [skuOptions, setSkuOptions] = useState<PreviewSku[]>([])
  const [previewSku, setPreviewSku] = useState<PreviewSku | null>(null)
  const [resolved, setResolved] = useState<ResolvedProduct | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [skuOpen, setSkuOpen] = useState(false)
  const [skuActive, setSkuActive] = useState(0)
  const skuPickerId = useId()
  const [skuError, setSkuError] = useState<string | null>(null)
  const [skuLoading, setSkuLoading] = useState(false)

  // ── filters ────────────────────────────────────────────────────
  const [fieldQuery, setFieldQuery] = useState('')
  const [priorities, setPriorities] = useState<FieldPriority[]>(ALL_PRIORITIES)
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [railQuery, setRailQuery] = useState('')

  // ── panels ─────────────────────────────────────────────────────
  const [editingField, setEditingField] = useState<string | null>(null)
  const [categoryMappingOpen, setCategoryMappingOpen] = useState(false)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [errorsOpen, setErrorsOpen] = useState(false)
  const [autoMapOpen, setAutoMapOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  const gridApi = useRef<GridApi<MappingRow> | null>(null)
  // Monotonic request tokens: a response is applied only if it is still the newest one asked
  // for. Two catalogue loads are always in flight on mount (before and after the category is
  // known), and the first one resolves LAST because it loads no cached schema — so without this
  // the slower, emptier answer won and the page printed "0 of 111 mapped" over the real 19.
  const catalogueSeq = useRef(0)
  const resolveSeq = useRef(0)

  const template = useMemo(
    () => templates.find((t) => `${t.channel}/${t.code}` === templateKey) ?? null,
    [templates, templateKey],
  )

  /* ── load templates ──────────────────────────────────────────── */
  useEffect(() => {
    let alive = true
    setLoadingTemplates(true)
    setFatal(null)
    api.fetchTemplates()
      .then((rows) => {
        if (!alive) return
        setTemplates(rows)
        // Land on the market with the most rules already authored — the one being worked on.
        const best = [...rows].filter(t => (!requestedChannel || t.channel === requestedChannel) && (!requestedMarket || t.code === requestedMarket)).sort((a, b) => b.mappedCount - a.mappedCount)[0]
        if (best) setTemplateKey(`${best.channel}/${best.code}`)
        else if (requestedChannel) setFatal('This channel and market are not available. Check Channels & accounts.')
      })
      .catch((e) => alive && setFatal(e.message))
      .finally(() => alive && setLoadingTemplates(false))
    return () => { alive = false }
  }, [requestedChannel, requestedMarket, templateReload])

  useEffect(() => {
    if (!template || !requestedProduct) return
    let alive = true
    api.searchPreviewSkus(template.channel, template.code, '', requestedProduct).then(options => {
      if (!alive) return
      setPreviewSku(options[0] ?? null)
      if (!options.length) setResolveError('The linked preview product is no longer available.')
    }).catch(error => { if (alive) setResolveError(error.message) })
    return () => { alive = false }
  }, [template, requestedProduct])

  /* ── load the channel's categories for the rail ──────────────── */
  useEffect(() => {
    if (!template) return
    let alive = true
    setCategoriesError(null)
    api.fetchChannelCategories(template.channel, template.code)
      .then((r) => {
        if (!alive) return
        setChannelCategories(r.options)
        setCategoryNote(r.note)
        // Land where the work is: a category that already carries rules, not whichever sorts
        // first alphabetically (that was 3D_PRINTABLE_DESIGNS — 0 of 112 mapped).
        setCategory((cur) => {
          if (requestedCategory && (!requestedChannel || template.channel === requestedChannel) && (!requestedMarket || template.code === requestedMarket)) return requestedCategory
          if (cur && r.options.some((o) => o.id === cur)) return cur
          const withRules = template.overlayTypes.find((t) => r.options.some((o) => o.id === t))
          return withRules ?? r.options[0]?.id ?? null
        })
      })
      .catch(error => { if (alive) { setChannelCategories([]); setCategoriesError(error.message); if (requestedCategory) setCategory(requestedCategory) } })
    return () => { alive = false }
  }, [template, requestedCategory, requestedChannel, requestedMarket])

  /* ── load the field catalogue ────────────────────────────────── */
  const loadCatalogue = useCallback(async () => {
    if (!template) return
    const seq = ++catalogueSeq.current
    setLoadingFields(true)
    setCatalogue(null)
    setEditingField(null)
    setCatalogueError(null)
    try {
      const c = await api.fetchCatalogue(template.channel, template.code, category, template.channel === 'SHOPIFY' && previewListingId !== 'primary' ? previewListing?.channelConnectionId ?? requestedAccount : undefined)
      if (seq !== catalogueSeq.current) return
      setCatalogue(c)
      if (requestedField && c.fields.some(f => f.fieldKey === requestedField)) setFieldQuery(requestedField)
    } catch (e: any) {
      if (seq !== catalogueSeq.current) return
      setCatalogue(null)
      setCatalogueError(e.message)
    } finally {
      if (seq === catalogueSeq.current) setLoadingFields(false)
    }
  }, [template, category, requestedField, previewListingId, previewListing?.channelConnectionId, requestedAccount])

  useEffect(() => {
    void loadCatalogue()
    return () => { catalogueSeq.current++ }
  }, [loadCatalogue])


  useEffect(() => {
    let alive = true
    setPreviewListings([]); setPreviewListingId('loading'); setListingError(null)
    if (!previewSku || !template) return
    api.fetchPreviewListings(previewSku.productId).then(listings => {
      if (!alive) return
      const scoped = listings.filter(l => l.channel === template.channel && l.marketplace === template.code)
      setPreviewListings(scoped)
      if (requestedAccount && previewSku.productId === requestedProduct) {
        const exact = scoped.find(l => l.channelConnectionId === requestedAccount && l.aliasKey === requestedAlias)
        if (exact) setPreviewListingId(exact.id)
        else { setPreviewListingId('missing'); setListingError('The linked account or listing is no longer available. Choose a preview listing.') }
      } else setPreviewListingId('primary')
    }).catch(e => { if (alive) { setListingError(e.message); setPreviewListingId('missing') } })
    return () => { alive = false }
  }, [template, previewSku, requestedAccount, requestedAlias, requestedProduct])

  /* ── resolve the preview SKU ─────────────────────────────────── */
  const runResolve = useCallback(async () => {
    const seq = ++resolveSeq.current
    setResolved(null)
    if (!template || !previewSku || ['missing', 'loading'].includes(previewListingId)) { setResolving(false); setResolveError(null); setPreviewFilter('all'); return }
    setResolving(true)
    setResolveError(null)
    try {
      const r = await api.resolvePreview(template.channel, template.code, {
        channelConnectionId: previewListing?.channelConnectionId, aliasKey: previewListing?.aliasKey,
        productIds: [previewSku.productId],
        productType: category,
        includeCatalogue: false,
      })
      if (seq !== resolveSeq.current) return
      setResolved(r.products[0] ?? null)
      if (r.products.length === 0) setResolveError('That product could not be resolved on this channel.')
    } catch (e: any) {
      if (seq !== resolveSeq.current) return
      setResolved(null)
      setResolveError(e.message)
    } finally {
      if (seq === resolveSeq.current) setResolving(false)
    }
  }, [template, previewSku, category, previewListing, previewListingId])

  useEffect(() => {
    void runResolve()
    return () => { resolveSeq.current++ }
  }, [runResolve])

  /* ── SKU typeahead ───────────────────────────────────────────── */
  useEffect(() => {
    if (!template || !skuOpen) return
    let alive = true
    setSkuOptions([])
    setSkuError(null)
    setSkuLoading(true)
    const id = setTimeout(() => {
      api.searchPreviewSkus(template.channel, template.code, skuQuery)
        .then((options) => { if (alive) setSkuOptions(options) })
        .catch(error => { if (alive) { setSkuOptions([]); setSkuError(error.message) } })
        .finally(() => { if (alive) setSkuLoading(false) })
    }, 220)
    return () => { alive = false; clearTimeout(id) }
  }, [template, skuQuery, skuOpen])

  const pickSku = (id: string) => {
    const sku = skuOptions.find(option => option.productId === id)
    if (!sku) return
    setPreviewSku(sku); setSkuOpen(false); setSkuQuery('')
    if (sku.channelCategoryId && sku.channelCategoryId !== category && channelCategories.some(c => c.id === sku.channelCategoryId)) {
      setCategory(sku.channelCategoryId)
      toast(`Showing ${sku.channelCategoryId} for ${sku.sku}.`, 'info')
    }
  }

  /* ── rows ────────────────────────────────────────────────────── */
  const allRows: MappingRow[] = useMemo(() => {
    if (!catalogue) return []
    const groupLabel = new Map(catalogue.groups.map((g) => [g.key, g.label]))
    return catalogue.fields.map((field) => ({
      field: fieldWithPreviewRule(field, resolved?.cells[field.fieldKey]),
      cell: resolved?.cells[field.fieldKey],
      hasPreview: resolved != null,
      groupKey: field.group,
      groupLabel: groupLabel.get(field.group) ?? field.group,
    }))
  }, [catalogue, resolved])

  const rows = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase()
    const prioritySet = new Set(priorities)
    return allRows.filter((r) => {
      const f = r.field
      if (q && !f.label.toLowerCase().includes(q) && !f.shopifyField?.channelLabel?.toLowerCase().includes(q) && !f.fieldKey.toLowerCase().includes(q) && !f.sheetKey?.toLowerCase().includes(q)) return false
      if (!prioritySet.has(f.priority)) return false
      if (statusFilter !== 'all' && f.status !== statusFilter) return false
      if (previewFilter !== 'all') {
        const c = r.cell
        if (previewFilter === 'errors' && !(c && c.errors.length > 0)) return false
        if (previewFilter === 'empty' && !(c && c.errors.length === 0 && (c.value == null || c.value === '' || (Array.isArray(c.value) && c.value.length === 0)))) return false
        if (previewFilter === 'hasValue' && !(c && c.value != null && c.value !== '' && (!Array.isArray(c.value) || c.value.length > 0))) return false
      }
      return true
    })
  }, [allRows, fieldQuery, priorities, statusFilter, previewFilter])

  const errorRows = useMemo(
    () => allRows.filter((r) => (r.cell?.errors.length ?? 0) > 0),
    [allRows],
  )

  const filtersActive =
    fieldQuery.trim() !== '' || priorities.length !== ALL_PRIORITIES.length ||
    previewFilter !== 'all' || statusFilter !== 'all'

  const clearFilters = useCallback(() => {
    setFieldQuery('')
    setPriorities(ALL_PRIORITIES)
    setPreviewFilter('all')
    setStatusFilter('all')
  }, [])

  /* ── grid ────────────────────────────────────────────────────── */
  const context = useMemo(
    () => ({
      onEditField: (fieldKey: string) => isCategoryField(fieldKey, template?.channel) ? setCategoryMappingOpen(true) : setEditingField(fieldKey),
      channel: template?.channel,
      expressions: catalogue?.expressions ?? {},
    }),
    [catalogue?.expressions, template?.channel],
  )

  // AG keeps a reference to `context` and does not repaint on a new one. The business-rule
  // tooltip reads it, so the cells are refreshed explicitly when it changes.
  useEffect(() => { if (gridApi.current && !gridApi.current.isDestroyed()) gridApi.current.refreshCells({ force: true }) }, [context])

  // …and the same for the resolve result, for a subtler reason: with `getRowId` set, AG diffs
  // rows by the COLUMN VALUE. A field that resolves to nothing has an empty preview value both
  // before and after resolving, so AG saw no change and never re-invoked the renderer — the
  // column kept printing the "no preview SKU" dash while the row already carried its result
  // (and its errors). The state that changed lives in the renderer, not in the value, so the
  // repaint has to be asked for.
  useEffect(() => { if (gridApi.current && !gridApi.current.isDestroyed()) gridApi.current.refreshCells({ force: true }) }, [resolved])

  const columnDefs = useMemo<ColDef<MappingRow>[]>(() => [
    {
      // Grouping rides a hidden column with `groupDisplayType="groupRows"`, so the group is a
      // full-width band and the leaf rows keep all five real columns. Tree data put the field key
      // in an auto-group column beside the field NAME — the same identity printed twice.
      headerName: 'Group',
      colId: 'group',
      field: 'groupLabel',
      rowGroup: true,
      hide: true,
    },
    {
      headerName: 'Channel field',
      colId: 'field',
      flex: 2,
      minWidth: 240,
      cellRenderer: FieldNameCell,
      valueGetter: (p) => p.data?.field.label ?? '',
    },
    {
      headerName: 'Priority',
      colId: 'priority',
      width: 190,
      cellRenderer: PriorityCell,
      valueGetter: (p) => (p.data ? PRIORITY_META[p.data.field.priority].order : 99),
      comparator: (a, b) => Number(a) - Number(b),
    },
    {
      headerName: 'Mapping from your data',
      colId: 'mapping',
      flex: 2,
      minWidth: 220,
      cellRenderer: MappingCell,
      valueGetter: (p) => p.data?.field.ruleSummary ?? '',
    },
    {
      headerName: 'Preview value',
      colId: 'preview',
      flex: 3,
      minWidth: 240,
      cellRenderer: PreviewCell,
      valueGetter: (p) => {
        const v = p.data?.cell?.value
        return v === null || v === undefined ? '' : Array.isArray(v) ? v.join(' • ') : String(v)
      },
    },
    {
      headerName: 'Status',
      colId: 'status',
      width: 160,
      cellRenderer: StatusCell,
      valueGetter: (p) => p.data?.field.status ?? '',
    },
  ], [])

  const defaultColDef = useMemo<ColDef<MappingRow>>(
    () => ({ sortable: true, resizable: true, suppressHeaderMenuButton: true, suppressKeyboardEvent: rendererOwnsKeyboard }),
    [],
  )

  const getRowId = useCallback((p: { data: MappingRow }) => p.data.field.fieldKey, [])
  const onGridReady = useCallback((e: GridReadyEvent<MappingRow>) => { gridApi.current = e.api }, [])

  /* ── render ──────────────────────────────────────────────────── */

  if (fatal) {
    return (
      <div style={{ padding: 24 }}>
        <Banner tone="danger" title="The mapping engine could not load" action={<Button size="sm" onClick={() => setTemplateReload(value => value + 1)}>Retry</Button>}>{fatal}</Banner>
      </div>
    )
  }

  const templateOptions = templates.map((t) => ({
    value: `${t.channel}/${t.code}`,
    label: `${t.channel} · ${t.code}${t.mappedCount > 0 ? ` — ${t.mappedCount} saved fields` : ''}`,
  }))

  return (
    <div>
      <PageHeader
        title="Category & attribute mappings"
        subtitle="How your catalogue becomes each channel's fields — category mapping, per-field rules and a live preview."
        actions={
          <>
            <div style={{ width: 260 }}>
              <Listbox
                size="sm"
                options={templateOptions}
                value={templateKey}
                onChange={key => {
                  setTemplateKey(key); setCategory(null); setPreviewSku(null); setSkuOptions([])
                  setEditingField(null); setRulesOpen(false); setAutoMapOpen(false); setCloneOpen(false)
                  setCategoryMappingOpen(false)
                }}
                ariaLabel="Channel and market"
                placeholder={loadingTemplates ? 'Loading…' : 'Pick a channel'}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAutoMapOpen(true)}
              disabled={!catalogue || catalogue.counts.unmapped === 0}
              title={
                catalogue && catalogue.counts.unmapped === 0
                  ? 'Every field on this category has a shared mapping or a listing/system source.'
                  : 'Propose a source for every unmapped field — nothing is written until you apply.'
              }
            >
              <Wand2 size={14} /> Auto-map
              {catalogue && catalogue.counts.unmapped > 0 ? ` (${catalogue.counts.unmapped})` : ''}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCloneOpen(true)}
              disabled={!template}
              title="Copy this market's rules to other markets of the same channel."
            >
              <Copy size={14} /> Clone
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRulesOpen(true)}>
              <FunctionSquare size={14} /> Business rules
              {catalogue && Object.keys(catalogue.expressions).length > 0
                ? ` (${Object.keys(catalogue.expressions).length})` : ''}
            </Button>
            <Button
              variant={errorRows.length > 0 ? 'danger' : 'ghost'}
              size="sm"
              disabled={resolving || !!resolveError || errorRows.length === 0}
              onClick={() => setErrorsOpen(true)}
            >
              <AlertTriangle size={14} /> {resolving ? 'Checking preview…' : resolveError || listingError ? 'Preview unavailable' : !previewSku ? 'Select a preview SKU' : !resolved ? 'Preview not checked' : `${errorRows.length} preview error${errorRows.length === 1 ? '' : 's'}`}
            </Button>
            <Button variant="ghost" size="sm" disabled={!catalogue} onClick={() => setHistoryOpen(true)}>History</Button>
            <Button variant="ghost" size="sm" onClick={() => { void loadCatalogue(); void runResolve() }}>
              <RefreshCw size={14} /> Refresh
            </Button>
          </>
        }
      />

      <div className={styles.shell}>
        {/* ── rail ── */}
        <aside className={styles.rail}>
          <div className={styles.railHead}>
            <span className={styles.railTitle}>Marketplace categories</span>
            <span className={styles.railCount}>
              {channelCategories.length} available
            </span>
          </div>
          <div className={styles.railSearch}>
            <Input
              size="xs"
              value={railQuery}
              onChange={(e) => setRailQuery(e.target.value)}
              placeholder="Search categories…"
              aria-label="Search channel categories"
            />
          </div>
          {categoriesError && <Banner tone="danger" title="Categories could not load">{categoriesError}</Banner>}
          <div className={styles.railList}>
            <Button block variant={category === null ? 'tonal' : 'quiet'} size="sm" onClick={() => setCategory(null)}>Market defaults</Button>
            {channelCategories.length === 0 ? (
              <p className={styles.railEmpty}>{categoryNote || 'No channel categories on this market yet.'}</p>
            ) : (
              channelCategories
                .filter((c) => c.label.toLowerCase().includes(railQuery.trim().toLowerCase()))
                .map((c) => {
                  const active = c.id === category
                  return (
                    <Button
                      key={c.id}
                      variant={active ? 'tonal' : 'quiet'}
                      size="sm"
                      block className={styles.railItemBtn}
                      onClick={() => setCategory(c.id)}
                      aria-current={active ? 'true' : undefined}
                    >
                      <span className={styles.railItemLabel}>{c.label}</span>
                      {active && catalogue ? (
                        <span className={styles.railCount} title="Shared attribute mappings; listing and system sources are counted separately">
                          {catalogue.counts.mapped}/{catalogue.counts.total - (catalogue.counts.owned ?? 0)}
                        </span>
                      ) : null}
                    </Button>
                  )
                })
            )}
          </div>
          <form className={styles.categoryEntry} onSubmit={event => { event.preventDefault(); if (categoryInput.trim()) { setCategory(categoryInput.trim()); setCategoryInput('') } }}>
            <Input size="xs" value={categoryInput} onChange={event => setCategoryInput(event.target.value)} aria-label="Marketplace category ID" placeholder="Category ID…" />
            <Button size="xs" type="submit" disabled={!categoryInput.trim()}>Open</Button>
          </form>
          {template && (
            <CategoryMappingPane channel={template.channel} code={template.code} open={categoryMappingOpen} onOpenChange={setCategoryMappingOpen} onApplied={async () => { await loadCatalogue(); await runResolve() }} />
          )}
        </aside>

        {/* ── main ── */}
        <section className={styles.main}>
          <div className={styles.contextBar}>
            <div>
              <div className={styles.contextTitle}>{category ? `Marketplace category: ${category}` : 'Market defaults'}</div>
              <div className={styles.contextSub}>Standing rules · current and future matching products · {template?.language ? `Content language: ${template.language}` : 'Language unavailable'} · {template?.channel === 'SHOPIFY' ? 'Native rules shared across stores · metafield rules belong to the selected store' : 'all accounts on this channel and market'}</div>
              <div className={styles.contextSub}>
                {catalogue
                  ? `${catalogue.counts.mapped} shared mappings · ${catalogue.counts.owned ?? 0} listing or system sources · ${catalogue.counts.unmapped} without a source · ${catalogue.counts.requiredUnmapped} required mappings missing`
                  : loadingFields ? 'Loading the field set…' : '—'}
              </div>
              {resolved?.readiness && <div className={styles.contextSub}>{resolved.readiness.populated} / {resolved.readiness.total} values populated · {resolved.readiness.invalid} invalid fields · {resolved.readiness.translationPending} pending translations · {resolved.readiness.state === 'locally-valid' ? 'Ready for channel validation' : 'Needs attention'}</div>}
              {!!resolved?.readiness?.listingOwnerFields && <div className={styles.contextSub}>{resolved.readiness.listingOwnerFields} listing or system fields are checked by their owning workflows when the payload is built. Channel validation has not run.</div>}
              {resolved && <div className={styles.contextSub}>{resolved.sku} · {resolved.counts.requiredMissing} required value{resolved.counts.requiredMissing === 1 ? '' : 's'} missing · {previewListing ? `${previewListing.accountName ?? previewListing.channelConnectionId ?? 'Unassigned account'} · ${previewListing.aliasKey || 'Primary listing'}` : 'Primary account and listing'}</div>}
            </div>
            <span className={styles.spacer} />
            <div className={styles.previewPicker}>
              {previewSku && <Listbox size="xs" width="min(100%, 260px)" ariaLabel="Preview account and listing" value={previewListingId} disabled={previewListingId === 'loading'}
                options={[{ value: 'primary', label: 'Primary account · primary listing' }, ...previewListings.map(l => ({ value: l.id, label: `${l.accountName ?? l.channelConnectionId ?? 'Unassigned account'} · ${l.aliasKey || 'Primary listing'}` }))]}
                onChange={value => { setPreviewListingId(value); setListingError(null) }} />}
              {listingError && <Banner tone="warning">{listingError}</Banner>}
              <span className={styles.previewLabel}>Preview SKU</span>
              {previewSku ? (
                <>
                  <Pill tone="info" size="sm">{previewSku.sku}</Pill>
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label="Clear preview SKU"
                    onClick={() => { setPreviewSku(null); setResolved(null) }}
                  >
                    <X size={13} />
                  </Button>
                  <Button asChild variant="link" size="xs"><a
                    href={productWorkspaceHref({ productId: previewSku.productId, id: previewListing?.id, channel: template?.channel ?? 'master', marketplace: template?.code ?? '', channelConnectionId: previewListing?.channelConnectionId, aliasKey: previewListing?.aliasKey })}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Go to product <ExternalLink size={11} />
                  </a></Button>
                </>
              ) : (
                <div className={styles.skuSearch} onBlur={event => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setSkuOpen(false)
                }}>
                  <Input size="xs" value={skuQuery} placeholder="Search a SKU…" aria-label="Search a preview SKU"
                    role="combobox" aria-autocomplete="list" aria-expanded={skuOpen}
                    aria-controls={skuOpen && !skuLoading && !skuError ? `${skuPickerId}-listbox` : undefined}
                    aria-activedescendant={skuOpen && !skuLoading && skuOptions[skuActive] ? `${skuPickerId}-o${skuActive}` : undefined}
                    onFocus={() => setSkuOpen(true)}
                    onChange={event => { setSkuQuery(event.target.value); setSkuActive(0); setSkuOpen(true) }}
                    onKeyDown={event => {
                      if (event.key === 'Escape') { event.preventDefault(); setSkuOpen(false) }
                      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault(); setSkuOpen(true)
                        setSkuActive(index => Math.max(0, Math.min(skuOptions.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))))
                      } else if (event.key === 'Enter' && skuOpen && skuOptions[skuActive]) {
                        event.preventDefault(); pickSku(skuOptions[skuActive].productId)
                      }
                    }} />
                  {skuOpen && skuLoading && <span role="status" className={styles.contextSub}>Searching products…</span>}
                  {skuOpen && !skuLoading && !skuError && <ListboxPanel
                    options={skuOptions.map(option => ({ value: option.productId, label: `${option.sku} · ${option.name ?? ''}${option.listedHere ? '' : ' (not listed here)'}` }))}
                    query="" autoFocus={false} activeIndex={skuActive} onActiveIndexChange={setSkuActive}
                    idPrefix={skuPickerId} ariaLabel="Preview products" onCommit={pickSku} onCancel={() => setSkuOpen(false)}
                    style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 'var(--nds-z-popover)' }} />}
                  {skuError && <span role="alert" className={styles.errorText}>{skuError}</span>}
                </div>
              )}
            </div>
          </div>

          {catalogue?.schema.note && (
            <div className={styles.schemaNote}>{catalogue.schema.note}</div>
          )}
          {category && resolved && resolved.category.channelCategoryId !== category && (
            <Banner tone="info" title="Previewing a different category">
              These values use the selected mapping category {category}. {resolved.sku} currently uses {resolved.category.channelCategoryId ?? 'no assigned category'}. This preview does not change its category.
            </Banner>
          )}
          {resolveError && (
            <Banner tone="danger" title="Preview could not resolve">{resolveError}</Banner>
          )}

          <div className={styles.filterRow}>
            <Input
              size="xs"
              value={fieldQuery}
              onChange={(e) => setFieldQuery(e.target.value)}
              placeholder="Field contains…"
              aria-label="Filter fields by name"
              style={{ width: 220 }}
            />
            <div style={{ width: 200 }}>
              <MultiSelect
                options={ALL_PRIORITIES.map((p) => ({ value: p, label: PRIORITY_META[p].label }))}
                value={priorities}
                onChange={(v) => setPriorities(v as FieldPriority[])}
                placeholder="All priorities"
                ariaLabel="Filter by priority"
              />
            </div>
            <div style={{ width: 170 }}>
            <Listbox
              size="xs"
              options={[
                { value: 'all', label: 'Any preview' },
                { value: 'errors', label: 'Has an error' },
                { value: 'empty', label: 'Resolves empty' },
                { value: 'hasValue', label: 'Has a value' },
              ]}
              value={previewFilter}
              onChange={(v) => setPreviewFilter(v as PreviewFilter)}
              ariaLabel="Filter by preview value"
              disabled={!resolved}
            />
            </div>
            <div style={{ width: 150 }}>
            <Listbox
              size="xs"
              options={[
                { value: 'all', label: 'Any status' },
                { value: 'mapped', label: 'Mapped' },
                { value: 'owned', label: 'Listing / system source' },
                { value: 'unmapped', label: 'Unmapped' },
              ]}
              value={statusFilter}
              onChange={(v) => setStatusFilter(v as StatusFilter)}
              ariaLabel="Filter by status"
            />
            </div>
            <span className={styles.spacer} />
            {resolving && <span className={styles.contextSub}>Resolving…</span>}
          </div>

          {catalogue && filtersActive && (
            <div className={styles.matchBanner} role="status">
              Your filters match {rows.length} of {catalogue.counts.total} fields.
              <Button variant="link" size="xs" onClick={clearFilters}>Clear filters</Button>
            </div>
          )}

          <div className={styles.gridWrap}>
            {catalogueError ? (
              <Banner tone="danger" title="The field set could not load">{catalogueError}</Banner>
            ) : !catalogue && loadingFields ? (
              <div className={styles.emptyPane}><span className={styles.contextSub}>Loading the field set…</span></div>
            ) : rows.length === 0 ? (
              <EmptyState
                title={allRows.length === 0 ? 'No fields for this category yet' : 'No field matches those filters'}
                description={
                  allRows.length === 0
                    ? catalogue?.schema.note ?? 'Sync this channel’s schema to see its fields.'
                    : 'Widen the filters to see the rest of the field set.'
                }
                action={filtersActive ? <Button size="sm" variant="ghost" onClick={clearFilters}>Clear filters</Button> : undefined}
              />
            ) : (
              <GridDensityProvider value="compact">
                <GridSheet
                  toolbar={
                    <GridToolbar
                      count={<><b>{rows.length}</b> field{rows.length === 1 ? '' : 's'}{catalogue ? <> of <b>{catalogue.counts.total}</b></> : null}</>}
                      right={
                        catalogue?.schema.fetchedAt ? (
                          <span className={styles.contextSub}>
                            Schema cached {catalogue.schema.ageDays === 0 ? 'today' : `${catalogue.schema.ageDays}d ago`}
                          </span>
                        ) : null
                      }
                    />
                  }
                >
                  <NexusGrid<MappingRow>
                    {...SHEET_GRID_OPTIONS}
                    fill
                    rowData={rows}
                    columnDefs={columnDefs}
                    defaultColDef={defaultColDef}
                    groupDisplayType="groupRows"
                    groupDefaultExpanded={1}
                    getRowId={getRowId as any}
                    context={context}
                    onGridReady={onGridReady}
                  />
                </GridSheet>
              </GridDensityProvider>
            )}
          </div>

          {/* VT.3 — the Variations group: under the selected category, AFTER the field groups
              (design §3.7, VX §11.1). It reads its own wire shape and owns its own state, so a
              rule read cannot delay or fail the field set above it. */}
          {template && (
            <VariationsGroup
              key={`${templateKey}:${category ?? 'default'}`}
              channel={template.channel}
              market={template.code}
              category={category}
              fixtureKey={search.get('variationsFixture')}
            />
          )}
        </section>
      </div>

      {/* ── panels ── */}
      {template && editingField && catalogue && (
        <RuleDrawer
          key={`${templateKey}:${category}:${editingField}`}
          open
          channel={template.channel}
          code={template.code}
          productType={category}
          field={allRows.find(r => r.field.fieldKey === editingField)!.field}
          cell={resolved?.cells[editingField]}
          channelConnectionId={previewListing?.channelConnectionId} aliasKey={previewListing?.aliasKey}
          previewProductId={['missing', 'loading'].includes(previewListingId) ? null : previewSku?.productId ?? null}
          mappingToken={catalogue.mappingToken}
          expressions={catalogue.expressions}
          onClose={() => setEditingField(null)}
          onSaved={async () => {
            setEditingField(null)
            await loadCatalogue()
            await runResolve()
          }}
        />
      )}

      {template && rulesOpen && (
        <BusinessRulesDrawer
          open
          channel={template.channel}
          code={template.code}
          previewProductId={['missing', 'loading'].includes(previewListingId) ? null : previewSku?.productId ?? null}
          onClose={() => setRulesOpen(false)}
          onChanged={async () => { await loadCatalogue(); await runResolve() }}
        />
      )}

      {template && autoMapOpen && (
        <AutoMapDrawer
          key={`${template.channel}:${template.code}:${category}`}
          mappingToken={catalogue?.mappingToken ?? ''}
          open
          channel={template.channel}
          code={template.code}
          productType={category}
          previewProductId={previewSku?.productId}
          onClose={() => setAutoMapOpen(false)}
          onApplied={async () => { await loadCatalogue(); await runResolve() }}
        />
      )}

      {template && catalogue && historyOpen && <HistoryDrawer channel={template.channel} market={template.code} token={catalogue.mappingToken} onClose={() => setHistoryOpen(false)} onApplied={() => { setHistoryOpen(false); void loadCatalogue(); void runResolve() }} />}
      {template && cloneOpen && (
        <CloneMappingDrawer
          open
          from={template}
          productType={category}
          templates={templates}
          sourceToken={catalogue?.mappingToken ?? ''}
          sourceRuleCount={catalogue?.fields.filter(f => f.ruleOrigin === 'category' || f.ruleOrigin === 'default').length ?? 0}
          onClose={() => setCloneOpen(false)}
          onCloned={async () => {
            // The picker's per-market rule counts are now stale — refetch them too.
            try { setTemplates(await api.fetchTemplates()) } catch { /* the drawer already reported */ }
            await loadCatalogue()
          }}
        />
      )}

      {errorsOpen && (
        <ErrorsDrawer rows={errorRows} onClose={() => setErrorsOpen(false)} onPick={(k) => { setErrorsOpen(false); setEditingField(k) }} />
      )}
    </div>
  )
}

/** The `View N errors` panel — every cell that would block or misfire, with the reason. */
function ErrorsDrawer({
  rows, onClose, onPick,
}: { rows: MappingRow[]; onClose: () => void; onPick: (fieldKey: string) => void }) {
  return (
    <Drawer open onClose={onClose} title={`${rows.length} field${rows.length === 1 ? '' : 's'} would not ship cleanly`} width={520}>
      <div className={styles.errorList}>
        {rows.map((r) => (
          <div key={r.field.fieldKey} className={styles.errorItem}>
            <Button variant="link" size="xs" onClick={() => onPick(r.field.fieldKey)}>
              {r.field.label}
            </Button>
            {(r.cell?.errors ?? []).map((e, i) => (
              <span key={i} className={styles.errorText}>{e}</span>
            ))}
          </div>
        ))}
      </div>
    </Drawer>
  )
}

export function MappingClient() {
  return (
    <ToastProvider>
      <MappingWorkspace />
    </ToastProvider>
  )
}
