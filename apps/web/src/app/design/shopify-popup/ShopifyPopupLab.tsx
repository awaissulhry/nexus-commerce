'use client'

/**
 * /design/shopify-popup — the REAL Shopify cell pop-up (`CellPanel` + `LinkedFieldEditor`) on made-up cells.
 *
 * Sheet pop-up rebuild P1 (docs/sheet-popup-editor/PLAN-2026-09-27.md §6): a local copy cannot read a Shopify store (no
 * keys; production logins are KMS-sealed) and no local listing is linked to one. So this page answers the pop-up's
 * reference reads for ONE made-up product from a made-up store (`shopifyPopupFixture.ts`), and everything else — the
 * panel, the pickers, the rules, the cell drawing — is the production code.
 */
import { useRef, useState } from 'react'
import { validateShopifyField } from '@nexus/shared/shopify-linked-products'
import { Banner, PressableRow } from '@/design-system/components'
import { EDITOR_KEY_HINT_PANEL, MetafieldValue } from '@/design-system/grid'
import { CellPanel } from '../../products/[id]/edit/_studio/shopify/ShopifyDraftCell'
import { LinkedFieldEditor } from '../../products/[id]/edit/_studio/shopify/LinkedFieldEditor'
import { installLabShopify, LAB_FIELDS, LAB_PRODUCT, LAB_REFERENCES, LAB_SCHEMA, LAB_START } from './shopifyPopupFixture'

installLabShopify()

type Key = keyof typeof LAB_FIELDS
const LABELS = Object.fromEntries(LAB_REFERENCES.map(r => [r.id, r.label]))
const IMAGES = Object.fromEntries(LAB_REFERENCES.flatMap(r => (r.image ? [[r.id, r.image]] : [])))
const SWATCHES = Object.fromEntries(LAB_REFERENCES.flatMap(r => (r.swatch ? [[r.id, r.swatch]] : [])))
const PATH = `/api/products/${LAB_PRODUCT}/shopify-linked?accountId=lab&market=GLOBAL`

export function ShopifyPopupLab() {
  const [values, setValues] = useState<Record<Key, string | null>>(LAB_START)
  const [open, setOpen] = useState<Key | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const cells = useRef(new Map<Key, HTMLDivElement | null>())

  const start = (key: Key) => { setOpen(key); setDraft(values[key]); setError(''); setSaved('') }
  const save = (): boolean => {
    if (!open) return true
    const problem = validateShopifyField(LAB_FIELDS[open], draft)
    if (problem) { setError(`Not saved: ${problem}`); return false }
    if (draft !== values[open]) { setValues(v => ({ ...v, [open]: draft })); setSaved(`${LAB_FIELDS[open].name} saved in the lab.`) }
    setOpen(null)
    return true
  }

  return (
    <div style={{ display: 'grid', gap: 16, maxWidth: 760, padding: 24, color: 'var(--nds-text)' }}>
      <h1>Shopify cell pop-up lab</h1>
      <p>The production Shopify pop-up on made-up cells. Open a cell, pick, drag, search, then press Enter or click outside
        to save; Esc cancels. Every name and picture here is invented; nothing is sent to a store.</p>
      {saved && <Banner tone="success">{saved}</Banner>}
      <div style={{ display: 'grid', gap: 6 }}>
        {(Object.keys(LAB_FIELDS) as Key[]).map(key => (
          <div key={key} ref={el => { cells.current.set(key, el) }}>
            <PressableRow label={LAB_FIELDS[key].name} expanded={open === key} onClick={() => (open === key ? save() : start(key))} stacked>
              <MetafieldValue type={LAB_FIELDS[key].type} raw={values[key]} labels={LABELS} images={IMAGES} swatches={SWATCHES} />
            </PressableRow>
          </div>
        ))}
      </div>
      {open && (
        <CellPanel anchor={cells.current.get(open) ?? null} label={`${LAB_FIELDS[open].name}: SAMPLE-100`} onSave={save} onCancel={() => setOpen(null)}
          footer={<span className="nds-editor-keyhint">{EDITOR_KEY_HINT_PANEL}</span>}>
          <div style={{ display: 'grid', gap: 12 }}>
            <strong>{LAB_FIELDS[open].name} · SAMPLE-100</strong>
            {error && <Banner tone="danger">{error}</Banner>}
            <LinkedFieldEditor path={PATH} schema={LAB_SCHEMA} definition={LAB_FIELDS[open]} value={draft} disabled={false}
              onChange={next => { setDraft(next); setError('') }} />
          </div>
        </CellPanel>
      )}
    </div>
  )
}
