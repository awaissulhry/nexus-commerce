import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, Select, TooltipPortalProvider } from '@/design-system/primitives'
import { NexusGrid, GridSheet, SHEET_GRID_OPTIONS, formulaTransfer } from '@/design-system/grid'
import { ProductMediaDialog } from '@/app/products/[id]/edit/_studio/media/ProductMediaDialog'
import { mediaGridTransfer } from '@/app/products/[id]/edit/_studio/media/mediaGridTransfer'
import { useMediaCellActions, type MediaRow } from '@/app/products/[id]/edit/_studio/media/useMediaCellActions'
import { mediaSummary } from '@/app/products/[id]/edit/_studio/media/mediaCellTransfer'
import { productMediaEndpoint } from '@/app/products/[id]/edit/_studio/media/ProductMediaDialog'
import { ToastProvider } from '@/design-system/components'
import { productMediaColumn } from '@/app/products/[id]/edit/_studio/media/productMediaColumn'
import { InformationMediaDialog } from '@/app/products/[id]/edit/_studio/shopify/InformationMediaDialog'
import '@/design-system/styles/tokens-global.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/design-system/styles/a11y.css'
import './style.css'
const media = [
  { id: 'front', type: 'IMAGE', preview: '/image.svg', url: '/image.svg', alt: 'Front view', status: 'READY' },
  { id: 'video', type: 'VIDEO', preview: null, url: '/video.mp4', alt: 'Fit demonstration', status: 'READY', sources: [{ url: '/video.mp4', mimeType: 'video/mp4' }] },
  { id: 'rear', type: 'IMAGE', preview: '/image.svg', url: '/image.svg', alt: 'Rear view', status: 'READY' },
  { id: 'external', type: 'EXTERNAL_VIDEO', preview: null, url: 'https://example.com/video', alt: 'External demonstration', status: 'READY' },
  { id: 'broken', type: 'VIDEO', preview: null, url: '/missing.mp4', alt: 'Unavailable video', status: 'READY' },
  { id: 'model', type: 'MODEL_3D', preview: null, url: 'https://example.com/model.glb', alt: '3D product model', status: 'READY' },
]
function App() {
  const [scope, setScope] = useState('MASTER'), [locale, setLocale] = useState('it'), [account, setAccount] = useState('a'), [market, setMarket] = useState('GLOBAL')
  const [anchor, setAnchor] = useState<HTMLElement | null>(null), [open, setOpen] = useState(false), [linked, setLinked] = useState(false), [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<MediaRow | null>(null), [rows, setRows] = useState<MediaRow[]>([]), [refresh, setRefresh] = useState(0), [readOnly, setReadOnly] = useState(false)
  const contextFor = (row?: MediaRow) => ({ scope, locale, market: scope === 'MASTER' ? 'GLOBAL' : market, ...(scope === 'MASTER' ? {} : { accountId: account, listingId: `listing-${account}-${row?.id ?? 'product-1'}` }) })
  const context = contextFor(selected ?? undefined)
  const actions = useMediaCellActions({ contextFor, canEdit: !readOnly, onSettled: () => setRefresh(v => v + 1) })
  const clipboard = useMemo(() => mediaGridTransfer(formulaTransfer<MediaRow>({ exprFor: () => null }), actions), [actions])
  const cols = useMemo(() => [{ field: 'name', headerName: 'Product', width: 220, editable: true }, productMediaColumn<MediaRow>((row, anchor) => { setSelected(row); setAnchor(anchor); setOpen(true) }, actions), {field: 'sku', headerName: 'SKU', width: 180, editable: true}], [actions])
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all(['product-1','product-2','product-3'].map(async (id, i) => {
      const value = await fetch(productMediaEndpoint(id, contextFor({id})), {signal:controller.signal}).then(r => r.json())
      return {id, name: ['Touring jacket','Black jacket','Blue jacket'][i], sku: ['TOURING','BLACK','BLUE'][i], productMedia: mediaSummary(value)}
    })).then(rows => { if (!controller.signal.aborted) setRows(rows) }).catch(() => {})
    return () => controller.abort()
  }, [scope, locale, market, account, refresh])
  return <TooltipPortalProvider><main><div className="qa-toolbar"><h1>Product media</h1>
    <Select aria-label="Scope" value={scope} onChange={e => setScope(e.target.value)}>{['MASTER','SHOPIFY','AMAZON','EBAY','ETSY','FUTURE_STORE'].map(s => <option key={s}>{s}</option>)}</Select>
    <Select aria-label="Language" value={locale} onChange={e => setLocale(e.target.value)}>{['und','it','en','de','fr-CA'].map(s => <option key={s}>{s}</option>)}</Select>
    <Select aria-label="Store" value={account} onChange={e => setAccount(e.target.value)}><option value="a">Store A</option><option value="b">Store B</option></Select>
    <Select aria-label="Marketplace" value={market} onChange={e => setMarket(e.target.value)}>{['GLOBAL','IT','DE'].map(s => <option key={s}>{s}</option>)}</Select>
    <Button size="sm" onClick={() => document.documentElement.classList.toggle('dark')}>Toggle theme</Button>
    <Button size="sm" onClick={() => { void fetch('/conflict', { method: 'POST' }); setNotice('Conflict armed for next save') }}>Conflict on next save</Button>
    <Button size="sm" onClick={() => setLinked(true)}>Shopify linked media</Button><Button size="sm" onClick={() => setReadOnly(v => !v)}>Read only: {readOnly ? "on" : "off"}</Button></div>
    <p role="status">{notice}</p>
    <GridSheet toolbar={<span>{scope} · Store {account} · {market} · {locale}</span>}><NexusGrid loading={rows.length === 0} {...SHEET_GRID_OPTIONS} {...clipboard} rowData={rows} columnDefs={cols} getRowId={p => p.data.id} rows="media-line" /></GridSheet>
    {open && <ProductMediaDialog productId={selected?.id ?? "product-1"} title={selected?.name ?? "Touring jacket"} context={context} contextLabel={`${scope} · Store ${account.toUpperCase()} · ${market} · ${locale}`} anchor={anchor} onClose={() => setOpen(false)} onSaved={() => { setNotice('Saved or refreshed media'); setRefresh(v => v + 1) }} />}
    {linked && <InformationMediaDialog title="Touring jacket" items={media} anchor={null} disabled={false} onClose={() => setLinked(false)} onApply={ids => setNotice(`Applied order: ${ids.join(', ')}`)} />}
  </main></TooltipPortalProvider>
}
createRoot(document.getElementById('root')!).render(<ToastProvider><App /></ToastProvider>)
