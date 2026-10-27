'use client'

/**
 * Reviews › Requests › "Package inserts" — a printed card for the box, with a QR code to the product's Amazon review
 * page. The market sets the QR code's Amazon site and the card's language; products are picked by family (only a
 * product with an ASIN gets a card); copies and A4 sheets are counted (insertsModel.ts). The card text is fixed and
 * honest. `POST /api/review-inserts/bulk` makes the PDF (nothing is sent to anyone); the products are read from the
 * catalogue (`GET /api/products`, top-level products: a family or a single product).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Search } from 'lucide-react'
import { Banner, Card, Field, Listbox, Modal, useToast } from '@/design-system/components'
import { Button, Checkbox, Input, NumberStepper, Skeleton } from '@/design-system/primitives'
import { errorWords, reviewsGet, reviewsUrl, UNREACHABLE_WORDS } from '../../_lib/reviewsFetch'
import {
  INSERT_MARKETS,
  MAX_COPIES,
  cardProducts,
  cardsPlan,
  downloadHeld,
  insertMarket,
  insertStartMarket,
  pickedWords,
  qrTarget,
  togglePick,
  type InsertProduct,
  type InsertsPick,
} from './insertsModel'
import s from './queue.module.css'

const MARKET_OPTIONS = INSERT_MARKETS.map((m) => ({ value: m.code, label: `${m.label} · ${m.site}` }))
const SEARCH_DEBOUNCE_MS = 300

interface ProductsAnswer { products: InsertProduct[]; total: number }

/** Download the PDF the API made (a file: nothing is sent to anyone). */
async function downloadPdf(path: string, body: unknown, fileName: string): Promise<string | null> {
  try {
    const res = await fetch(reviewsUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) return errorWords(res.status, await res.json().catch(() => null))
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    return null
  } catch {
    return UNREACHABLE_WORDS
  }
}

/** `market`: the page's market (an Amazon market page opens it on that market, audit C5); Italy when none. */
export function InsertsModal({ onClose, market: startMarket = null }: { onClose: () => void; market?: string | null }) {
  const { toast } = useToast()
  const [market, setMarket] = useState<string>(() => insertStartMarket(startMarket))
  const [pick, setPick] = useState<InsertsPick>({ all: true, picked: [] })
  const [copies, setCopies] = useState(1)
  const [count, setCount] = useState<{ value: number | null; error: string | null }>({ value: null, error: null })
  const [search, setSearch] = useState('')
  const [products, setProducts] = useState<{ key: string; rows: InsertProduct[] | null; total: number; error: string | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const abort = useRef<AbortController | null>(null)

  useEffect(() => {
    let alive = true
    void reviewsGet<{ count: number }>('/review-inserts/count').then((res) => {
      if (alive) setCount({ value: typeof res.data?.count === 'number' ? res.data.count : null, error: res.error })
    })
    return () => { alive = false }
  }, [])

  const loadProducts = useCallback(async (text: string) => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    try {
      // `includeSales` makes the list read the live rows: the cached catalogue list carries no ASIN (list-products.service.ts).
      const res = await reviewsGet<ProductsAnswer>('/products', { limit: 200, sort: 'name', includeSales: 1, salesDays: 1, search: text.trim() || null }, { signal: controller.signal })
      if (controller.signal.aborted) return
      setProducts({ key: text, rows: res.data?.products ?? null, total: res.data?.total ?? 0, error: res.error })
    } catch {
      // aborted: a newer search is on its way
    }
  }, [])
  useEffect(() => {
    const t = window.setTimeout(() => void loadProducts(search), search ? SEARCH_DEBOUNCE_MS : 0)
    return () => window.clearTimeout(t)
  }, [search, loadProducts])
  useEffect(() => () => abort.current?.abort(), [])

  const rows = useMemo(() => products?.rows ?? [], [products])
  const m = insertMarket(market)
  const productCount = cardProducts(pick, rows, count.value)
  const plan = cardsPlan(productCount ?? 0, copies)
  const held = downloadHeld(pick, rows, count.value) ?? (busy ? 'Making the PDF…' : null)
  const first = pick.all ? rows.find((p) => p.amazonAsin) : rows.find((p) => pick.picked.includes(p.id) && p.amazonAsin)

  const download = useCallback(async () => {
    setBusy(true)
    const body = pick.all ? { marketplace: market } : { marketplace: market, productIds: rows.filter((p) => pick.picked.includes(p.id) && p.amazonAsin).map((p) => p.id) }
    const error = await downloadPdf('/review-inserts/bulk', body, `review-inserts-${market}.pdf`)
    setBusy(false)
    if (error) toast(error, 'danger')
    else toast(`PDF ready: ${plan.words}`, 'success')
  }, [pick, market, rows, plan.words, toast])

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Package inserts"
      subtitle="A printed card for the box, with a QR code to the product’s Amazon review page"
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void download()} heldReason={held}>
            <Download size={13} aria-hidden /> {productCount ? `Download PDF — ${plan.cards} ${plan.cards === 1 ? 'card' : 'cards'}` : 'Download PDF'}
          </Button>
        </>
      )}
    >
      <div className={s.inserts}>
        <div className={s.insertsMain}>
          <Field label="Amazon market" hint={`Sets the QR code’s Amazon site (${m.site}) and the card’s language (${m.language}).`}>
            <Listbox options={MARKET_OPTIONS} value={market} onChange={setMarket} ariaLabel="Amazon market" />
          </Field>

          <fieldset className={s.fieldset}>
            <legend className={s.legend}>Products</legend>
            <Checkbox
              label={`All product families${count.value != null ? ` — every product with an ASIN (${count.value.toLocaleString('en-IE')})` : ''}`}
              checked={pick.all}
              onChange={(e) => setPick({ all: e.target.checked, picked: [] })}
            />
            <p className={s.muted}>{pickedWords(pick, rows, count.value)}</p>
            <Input
              size="sm"
              type="search"
              aria-label="Search products"
              placeholder="Search products"
              leadingIcon={<Search size={13} aria-hidden />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {products?.error ? (
              <Banner tone="danger" title="Could not read the products" action={<Button size="sm" onClick={() => void loadProducts(search)}>Try again</Button>}>
                {products.error} “All product families” still works.
              </Banner>
            ) : !products ? (
              <Skeleton height={160} />
            ) : rows.length === 0 ? (
              <p className={s.muted}>{search ? 'No product matches this search.' : 'No product in the catalogue yet.'}</p>
            ) : (
              <ul className={s.pickList} aria-label="Product families">
                {rows.map((p) => (
                  <li key={p.id}>
                    <Checkbox
                      checked={!pick.all && pick.picked.includes(p.id)}
                      onChange={() => setPick((cur) => togglePick(cur, p.id))}
                      label={(
                        <span className={s.pickLabel}>
                          <span>{p.name}</span>
                          <span className={s.muted}>
                            {p.childCount > 0 ? `${p.childCount} variations · ` : ''}
                            {p.amazonAsin ? `ASIN ${p.amazonAsin}` : 'no ASIN — no card'}
                          </span>
                        </span>
                      )}
                    />
                  </li>
                ))}
              </ul>
            )}
            {products && products.total > rows.length && (
              <p className={s.muted}>Showing {rows.length} of {products.total.toLocaleString('en-IE')}. Search to find the others.</p>
            )}
          </fieldset>

          <Field label="Copies of each card" hint={productCount == null ? 'Counting products…' : plan.words}>
            <NumberStepper value={copies} onChange={setCopies} min={1} max={MAX_COPIES} size="sm" decrementLabel="One copy fewer" incrementLabel="One copy more" />
          </Field>

          <Banner tone="info" title="What a card may say">
            Allowed: “Thank you for your purchase! Feel free to share your honest feedback by leaving a review!” Not allowed: asking for
            positive or 5-star reviews, star graphics, gifts or discounts, QR codes to outside sites, contact details, or “contact us
            first if you’re unhappy”. So the card text is fixed, and its QR code opens only Amazon’s own review page.
          </Banner>
          <p className={s.muted}>
            Easiest for orders you pack yourself. For orders Amazon ships (FBA), put the cards in when you send stock to Amazon. Only
            products with an ASIN get a card.
          </p>
        </div>

        <aside className={s.insertsPreview} aria-label="Preview">
          <h3 className={s.sectionHead}>Preview</h3>
          <Card padded>
            <div className={s.cardPreview}>
              <strong>{first?.name ?? 'Your product'}</strong>
              <span>An honest-review request, in {m.language}</span>
              <span className={s.muted}>QR code → {qrTarget(market, first?.amazonAsin ?? null)}</span>
              <span className={s.muted}>No stars, no offer, no contact details.</span>
            </div>
          </Card>
          <p className={s.muted}>The PDF has one A6 page per product; print it at 4 pages per A4 sheet and cut along the page edges.</p>
        </aside>
      </div>
    </Modal>
  )
}
