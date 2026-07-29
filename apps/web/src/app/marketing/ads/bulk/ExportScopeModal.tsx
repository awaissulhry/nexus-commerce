'use client'

/**
 * AX-IE.10 — choose what to export.
 *
 * The export used to be one button and a performance-window dropdown: whole
 * account or nothing. The server grew six scope filters before there was any way
 * to reach them, so this is the surface that makes them real.
 *
 * The design decision that matters is the ESTIMATE. Every change re-asks the
 * server what this scope would produce, and the primary button *is* the answer —
 * "Download 3,625 rows · 76 campaigns". Without it, narrowing a scope is done
 * blind: you find out whether you got everything, nothing, or the wrong thing by
 * opening the file. The two ways a scope can be unusable — it matches nothing,
 * or it selects only Sponsored Brands / Display, which have no sheet layout —
 * arrive here as a disabled button and a plain-English reason, instead of as a
 * failed download after the fact.
 *
 * The estimate is computed by the same parser as the download (see
 * `export-scope.ts`), so the number beside the button and the file behind it
 * cannot disagree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Bookmark, Trash2 } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Banner } from '@/design-system/components/Banner'
import { MultiSelect } from '@/design-system/components/MultiSelect'
import { Button } from '@/design-system/primitives/Button'
import { Select } from '@/design-system/primitives/Select'
import { Input } from '@/design-system/primitives/Input'
import { RadioCard } from '@/design-system/primitives/RadioCard'
import { Spinner } from '@/design-system/primitives/Spinner'

export type ScopeMode = 'all' | 'portfolio' | 'product' | 'view' | 'selected'

export interface ScopeOptions {
  totalCampaigns: number
  portfolios: Array<{ id: string; name: string; campaigns: number }>
  marketplaces: Array<{ value: string; campaigns: number }>
  adProducts: Array<{ value: string; campaigns: number; exportable: boolean; note: string | null }>
  entities: string[]
}

export interface Estimate {
  scoped: boolean
  scope: string[]
  campaigns: number
  rows: number
  byEntity: Record<string, number>
  withheld: Array<{ product: string; campaigns: number }>
  blocked: string | null
  message: string | null
}

/**
 * Campaign ids the caller already resolved. The campaigns grid keeps its filters
 * in React state with nothing in the URL, so rather than re-implement its filter
 * semantics on the server, it hands over the ids its own view resolved to. The
 * grid stays the single definition of "what I'm looking at".
 */
export interface GridContext {
  /** External campaign ids currently passing the grid's filters. */
  viewIds: string[]
  /** External campaign ids the operator has ticked. */
  selectedIds: string[]
  /** Short description of the grid's active filters, for the summary line. */
  viewLabel?: string
}

interface SavedScope {
  name: string
  mode: ScopeMode
  portfolio: string
  product: string
  state: string
  marketplace: string
  entities: string[]
}

const SAVED_KEY = 'nexus-ads-export-scopes-v1'
/** An Amazon ASIN is 10 chars starting B0; anything else in the box is a SKU. */
const ASIN_RE = /^B0[A-Z0-9]{8}$/i

const readSaved = (): SavedScope[] => {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) ?? '[]') as SavedScope[] } catch { return [] }
}

export interface ExportScopeModalProps {
  open: boolean
  onClose: () => void
  /** `${getBackendUrl()}/api/advertising` — passed in so this file owns no URL policy. */
  api: (path: string) => string
  grid?: GridContext
  onDownloaded?: (summary: { rows: number; campaigns: number; filename: string }) => void
  onError?: (message: string) => void
}

export function ExportScopeModal({ open, onClose, api, grid, onDownloaded, onError }: ExportScopeModalProps) {
  const [mode, setMode] = useState<ScopeMode>('all')
  const [portfolio, setPortfolio] = useState('')
  const [product, setProduct] = useState('')
  const [state, setState] = useState('')
  const [marketplace, setMarketplace] = useState('')
  const [entities, setEntities] = useState<string[]>([])
  const [perfDays, setPerfDays] = useState('30')

  const [opts, setOpts] = useState<ScopeOptions | null>(null)
  const [est, setEst] = useState<Estimate | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [saved, setSaved] = useState<SavedScope[]>([])

  // Reset on every open, so a modal never reopens holding a scope from a
  // previous, forgotten session — the house convention, and here it also
  // prevents downloading something narrower than the operator now believes.
  useEffect(() => {
    if (!open) return
    setMode(grid?.selectedIds.length ? 'selected' : 'all')
    setPortfolio(''); setProduct(''); setState(''); setMarketplace('')
    setEntities([]); setPerfDays('30'); setEst(null)
    setSaved(readSaved())
  }, [open, grid])

  useEffect(() => {
    if (!open) return
    void fetch(api('/bulk/export/scope-options'), { cache: 'no-store' })
      .then((r) => r.json()).then(setOpts)
      .catch(() => { /* the picker still works; it just loses the counts */ })
  }, [open, api])

  /** The scope as query params — the ONE place it is built, for both estimate and download. */
  const query = useCallback((withDays: boolean): string => {
    const p = new URLSearchParams()
    if (withDays) p.set('days', perfDays)
    if (mode === 'portfolio' && portfolio) p.set('portfolioId', portfolio)
    if (mode === 'product' && product.trim()) {
      const terms = product.split(',').map((t) => t.trim()).filter(Boolean)
      const asins = terms.filter((t) => ASIN_RE.test(t))
      const skus = terms.filter((t) => !ASIN_RE.test(t))
      if (asins.length) p.set('asin', asins.join(','))
      if (skus.length) p.set('sku', skus.join(','))
    }
    if (mode === 'view' && grid?.viewIds.length) p.set('campaignIds', grid.viewIds.join(','))
    if (mode === 'selected' && grid?.selectedIds.length) p.set('campaignIds', grid.selectedIds.join(','))
    if (state) p.set('state', state)
    if (marketplace) p.set('marketplace', marketplace)
    if (entities.length) p.set('entities', entities.join(','))
    return p.toString()
  }, [mode, portfolio, product, state, marketplace, entities, perfDays, grid])

  /** True once the chosen mode has the input it needs. */
  const ready = useMemo(() => {
    if (mode === 'portfolio') return !!portfolio
    if (mode === 'product') return !!product.trim()
    if (mode === 'view') return !!grid?.viewIds.length
    if (mode === 'selected') return !!grid?.selectedIds.length
    return true
  }, [mode, portfolio, product, grid])

  // Re-estimate on every change, debounced — the product box is typed into, and
  // a request per keystroke would both hammer the API and race its own replies.
  // `seq` guarantees a slow early reply cannot overwrite a fast later one.
  const seq = useRef(0)
  useEffect(() => {
    if (!open || !ready) { setEst(null); return }
    const mine = ++seq.current
    setEstimating(true)
    const t = setTimeout(() => {
      void fetch(api(`/bulk/export/estimate?${query(false)}`), { cache: 'no-store' })
        .then(async (r) => {
          const body = await r.json()
          if (mine !== seq.current) return
          setEst(r.ok ? body : { scoped: true, scope: [], campaigns: 0, rows: 0, byEntity: {}, withheld: [], blocked: body.error ?? 'bad_scope', message: body.hint ?? `${body.field ?? 'That filter'} is not one we recognise.` })
        })
        .catch(() => { if (mine === seq.current) setEst(null) })
        .finally(() => { if (mine === seq.current) setEstimating(false) })
    }, 300)
    return () => clearTimeout(t)
  }, [open, ready, query, api])

  /**
   * Scope-encoded filename. Every export used to be `nexus-bulksheet.xlsx`, so
   * three scoped downloads landed in Downloads as three identical names.
   */
  const filename = useMemo(() => {
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
    const bits = ['nexus-bulksheet']
    if (mode === 'portfolio' && portfolio) bits.push(slug(opts?.portfolios.find((p) => p.id === portfolio)?.name ?? 'portfolio'))
    if (mode === 'product' && product.trim()) bits.push(slug(product.split(',')[0]))
    if (mode === 'view') bits.push('current-view')
    if (mode === 'selected') bits.push(`${grid?.selectedIds.length ?? 0}-selected`)
    if (state) bits.push(slug(state))
    if (marketplace) bits.push(slug(marketplace))
    return `${bits.join('_')}_${new Date().toISOString().slice(0, 10)}.xlsx`
  }, [mode, portfolio, product, state, marketplace, opts, grid])

  const download = useCallback(async () => {
    setDownloading(true)
    try {
      const res = await fetch(api(`/bulk/export?${query(true)}`), { cache: 'no-store' })
      if (!res.ok) {
        const why = await res.json().catch(() => null)
        onError?.(why?.hint ?? why?.message ?? `Export failed — HTTP ${res.status}`)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
      onDownloaded?.({ rows: est?.rows ?? 0, campaigns: est?.campaigns ?? 0, filename })
      onClose()
    } catch (e) {
      onError?.((e as Error).message)
    } finally { setDownloading(false) }
  }, [api, query, filename, est, onDownloaded, onError, onClose])

  const saveScope = useCallback(() => {
    const name = window.prompt('Name this scope', est?.scope.join(' · ') || 'My scope')
    if (!name) return
    const next = [...readSaved().filter((s) => s.name !== name), { name, mode, portfolio, product, state, marketplace, entities }]
    localStorage.setItem(SAVED_KEY, JSON.stringify(next))
    setSaved(next)
  }, [mode, portfolio, product, state, marketplace, entities, est])

  const applySaved = useCallback((s: SavedScope) => {
    setMode(s.mode); setPortfolio(s.portfolio); setProduct(s.product)
    setState(s.state); setMarketplace(s.marketplace); setEntities(s.entities)
  }, [])

  const removeSaved = useCallback((name: string) => {
    const next = readSaved().filter((s) => s.name !== name)
    localStorage.setItem(SAVED_KEY, JSON.stringify(next))
    setSaved(next)
  }, [])

  const blocked = !!est?.blocked
  // `!estimating` is load-bearing. While a re-estimate is in flight `est` still
  // holds the PREVIOUS scope's numbers, so without it the button stayed enabled
  // showing a count that no longer described what would be downloaded — and a
  // fast click could commit to a scope that was about to come back blocked.
  const canDownload = ready && !!est && !estimating && est.rows > 0 && !blocked && !downloading

  const cta = downloading ? 'Preparing…'
    : estimating || !est ? 'Download bulksheet'
      : est.rows > 0 ? `Download ${est.rows.toLocaleString()} rows · ${est.campaigns} campaign${est.campaigns === 1 ? '' : 's'}`
        : 'Nothing to export'

  return (
    <Modal
      open={open}
      // Refusing to close mid-download matches the house rule and avoids
      // orphaning a request whose blob nothing is left to receive.
      onClose={() => { if (!downloading) onClose() }}
      size="lg"
      title="Export a bulksheet"
      subtitle="Pick what goes in the file. The count updates as you choose."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={downloading}>Cancel</Button>
          <Button variant="primary" onClick={() => void download()} disabled={!canDownload}>
            {downloading ? <Spinner size={14} /> : <Download size={14} />}{cta}
          </Button>
        </>
      }
    >
      <div className="esm">
        {saved.length > 0 && (
          <div className="esm-saved">
            {saved.map((s) => (
              <span key={s.name} className="esm-chip">
                <button type="button" onClick={() => applySaved(s)}>{s.name}</button>
                <button type="button" aria-label={`Delete ${s.name}`} onClick={() => removeSaved(s.name)}><Trash2 size={11} /></button>
              </span>
            ))}
          </div>
        )}

        <div className="esm-cards">
          <RadioCard
            name="esm-mode" value="all" checked={mode === 'all'} selected={mode === 'all'}
            onChange={() => setMode('all')}
            title="Everything"
            description={opts ? `All ${opts.totalCampaigns} campaigns` : 'The whole account'}
          />
          <RadioCard
            name="esm-mode" value="portfolio" checked={mode === 'portfolio'} selected={mode === 'portfolio'}
            onChange={() => setMode('portfolio')}
            title="One portfolio"
            description={opts ? `${opts.portfolios.length} to choose from` : 'Pick a portfolio'}
          />
          <RadioCard
            name="esm-mode" value="product" checked={mode === 'product'} selected={mode === 'product'}
            onChange={() => setMode('product')}
            title="A product"
            description="Every campaign advertising a SKU or ASIN"
          />
          {grid && (
            <RadioCard
              name="esm-mode" value="view" checked={mode === 'view'} selected={mode === 'view'}
              onChange={() => setMode('view')}
              title="What I'm looking at"
              description={grid.viewIds.length ? `${grid.viewIds.length} campaigns${grid.viewLabel ? ` · ${grid.viewLabel}` : ''}` : 'The grid has no rows'}
              disabled={!grid.viewIds.length}
            />
          )}
          {grid && (
            <RadioCard
              name="esm-mode" value="selected" checked={mode === 'selected'} selected={mode === 'selected'}
              onChange={() => setMode('selected')}
              title="Selected rows"
              description={grid.selectedIds.length ? `${grid.selectedIds.length} selected` : 'Nothing selected'}
              disabled={!grid.selectedIds.length}
            />
          )}
        </div>

        {mode === 'portfolio' && (
          <div className="esm-row">
            <label className="esm-label" htmlFor="esm-pf">Portfolio</label>
            <Select id="esm-pf" value={portfolio} onChange={(e) => setPortfolio(e.target.value)}>
              <option value="">Choose a portfolio…</option>
              {(opts?.portfolios ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.campaigns})</option>
              ))}
            </Select>
          </div>
        )}

        {mode === 'product' && (
          <div className="esm-row">
            <label className="esm-label" htmlFor="esm-prod">SKU or ASIN</label>
            <Input
              id="esm-prod" fieldClassName="esm-field" value={product}
              onChange={(e) => setProduct(e.target.value)}
              placeholder="XV-GALE-BLACK-M, or B0BMSC91YK — comma-separated"
            />
          </div>
        )}

        <div className="esm-grid">
          <div className="esm-row">
            <label className="esm-label" htmlFor="esm-state">Campaign state</label>
            <Select id="esm-state" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">Any</option>
              <option value="ENABLED">Enabled</option>
              <option value="PAUSED">Paused</option>
              <option value="ARCHIVED">Archived</option>
            </Select>
          </div>
          <div className="esm-row">
            <label className="esm-label" htmlFor="esm-mk">Marketplace</label>
            <Select id="esm-mk" value={marketplace} onChange={(e) => setMarketplace(e.target.value)}>
              <option value="">All</option>
              {(opts?.marketplaces ?? []).map((m) => (
                <option key={m.value} value={m.value}>{m.value} ({m.campaigns})</option>
              ))}
            </Select>
          </div>
          <div className="esm-row">
            <span className="esm-label">Row types</span>
            <MultiSelect
              placeholder="All"
              options={(opts?.entities ?? []).map((e) => ({
                value: e,
                label: est?.byEntity[e] != null ? `${e} (${est.byEntity[e].toLocaleString()})` : e,
              }))}
              value={entities} onChange={setEntities}
            />
          </div>
          <div className="esm-row">
            <label className="esm-label" htmlFor="esm-days">Performance window</label>
            <Select id="esm-days" value={perfDays} onChange={(e) => setPerfDays(e.target.value)}>
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="60">Last 60 days</option>
              <option value="90">Last 90 days</option>
            </Select>
          </div>
        </div>

        {/* AX-ZD.5 — the window is chosen HERE, so its settledness belongs here
            too. Amazon restates for up to 60 days; a 7-day window will not match
            a copy taken next week, and that is worth knowing before the file
            becomes someone's source of truth in a spreadsheet. */}
        {Number(perfDays) <= 14 && (
          <Banner tone="warning" className="esm-banner">
            The last {perfDays} days are still settling. Amazon restates figures for up to 60 days,
            so these metrics will not match a copy taken later — fine for a sanity check, not for a
            number you are going to quote.
          </Banner>
        )}

        {blocked && est?.message && (
          <Banner tone="danger" title="This scope cannot be exported" className="esm-banner">
            {est.message}
            {est.withheld.length > 0 && (
              <> {est.withheld.map((w) => `${w.product}: ${w.campaigns} campaigns`).join(', ')}.</>
            )}
          </Banner>
        )}

        {!blocked && est && est.withheld.length > 0 && (
          <Banner tone="warning" className="esm-banner">
            {est.withheld.map((w) => `${w.campaigns} ${w.product}`).join(' and ')} campaign
            {est.withheld.reduce((n, w) => n + w.campaigns, 0) === 1 ? '' : 's'} in this scope are
            not in the file — those ad products have no confirmed sheet layout yet.
          </Banner>
        )}

        <div className="esm-foot">
          <span className="esm-est">
            {!ready ? 'Choose what to include.'
              : estimating ? <><Spinner size={12} /> Working out what that covers…</>
                : est && est.rows > 0 ? <>Downloads as <code>{filename}</code></>
                  : est ? '' : ' '}
          </span>
          <Button variant="ghost" onClick={saveScope} disabled={!ready || !est || est.rows === 0}>
            <Bookmark size={13} />Save this scope
          </Button>
        </div>
      </div>
    </Modal>
  )
}
