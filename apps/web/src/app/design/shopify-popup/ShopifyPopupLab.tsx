'use client'

/**
 * /design/shopify-popup — the REAL Shopify cell pop-up (`CellPanel` + `LinkedFieldEditor` + `EntryEditor`) on a made-up
 * store with every Shopify metafield type (Lane B slice B0, docs/shopify-metafields/PLAN-2026-09-28.md §9).
 *
 * A local copy cannot read a Shopify store (no keys; production logins are KMS-sealed) and no local listing is linked to
 * one. So the pop-up's calls for ONE made-up product are answered by a stand-in store (`labStandIn.ts`), and everything
 * else — the panel, the editors, the pickers, the rules, the cell drawing, the entry editor — is the production code.
 *
 * Four tabs: a mirror of a real store's 39 fields, every entry kind, every Shopify type (118), and bad or old values.
 * Known gaps are shown on the rows they affect (`labGaps.ts`), never hidden. Nothing is sent to a store.
 */
import { useMemo, useRef, useState } from 'react'
import { shopifyTypeReason, validateShopifyField, type ShopifyFieldDefinition, type ShopifyReusableEntry } from '@nexus/shared/shopify-linked-products'
import { SHOPIFY_MEASUREMENT_KINDS, shopifyBaseType } from '@nexus/shared/shopify-type-catalog'
import { LAB_ENTRY_KINDS, LAB_ODD_VALUES, LAB_SCHEMA, LAB_STORE_FIELDS, LAB_STORE_START, LAB_TYPE_FIELDS, labBadValues, labGoodValue, labTypeField } from '@nexus/shared/shopify-lab-store'
import { Banner, EmptyState, MediaMark, PressableRow, Tabs, tabPanelProps } from '@/design-system/components'
import { Button, FilterChip, Input, Tag, Toggle } from '@/design-system/primitives'
import { EDITOR_KEY_HINT_PANEL, MetafieldValue, metafieldDisplay } from '@/design-system/grid'
import { CellPanel } from '../../products/[id]/edit/_studio/shopify/ShopifyDraftCell'
import { LinkedFieldEditor } from '../../products/[id]/edit/_studio/shopify/LinkedFieldEditor'
import { EntryEditor } from '../../products/[id]/edit/_studio/shopify/EntryEditor'
import { installLabShopify } from './shopifyPopupFixture'
import { LAB_PATH, labStoreReferences, resetLabStore, setLabRefusal } from './labStandIn'
import { labGapsFor } from './labGaps'
import styles from './shopifyPopupLab.module.css'

installLabShopify()

type TabId = 'store' | 'entries' | 'types' | 'bad'
interface LabRow { id: string; label: string; field: ShopifyFieldDefinition; start: string | null; group: string; note?: { tone: 'danger' | 'warning' | 'neutral'; text: string } }
interface OpenEntry { id: string | null; copy?: boolean; type?: string }

const FAMILIES = ['Text', 'Numbers', 'Dates', 'Yes/no, colour, rating, money', 'Web addresses', 'JSON and codes', 'Measurements', 'Store references', 'Entries', 'Shopify taxonomy'] as const
function familyOf(type: string): (typeof FAMILIES)[number] {
  const base = shopifyBaseType(type)
  if (SHOPIFY_MEASUREMENT_KINDS.includes(base)) return 'Measurements'
  if (['single_line_text_field', 'multi_line_text_field', 'rich_text_field'].includes(base)) return 'Text'
  if (['number_integer', 'number_decimal'].includes(base)) return 'Numbers'
  if (['date', 'date_time'].includes(base)) return 'Dates'
  if (['boolean', 'color', 'rating', 'money'].includes(base)) return 'Yes/no, colour, rating, money'
  if (['url', 'link'].includes(base)) return 'Web addresses'
  if (['json', 'id', 'language', 'jurisdiction'].includes(base)) return 'JSON and codes'
  if (['metaobject_reference', 'mixed_reference', 'disclosure_reference'].includes(base)) return 'Entries'
  if (base.startsWith('product_taxonomy_')) return 'Shopify taxonomy'
  return 'Store references'
}

/** The field's rules in short words for the lab's meta line (the pop-up's plain rule line is B1, gap G6). */
function ruleText(field: ShopifyFieldDefinition): string {
  return field.validations.map(({ name, value }) => {
    if (name === 'metaobject_definition_id') return `entries: ${LAB_ENTRY_KINDS.find(kind => kind.id === value)?.name ?? 'unknown kind'}`
    if (name === 'metaobject_definition_ids') return `entries: ${(JSON.parse(value) as string[]).map(id => LAB_ENTRY_KINDS.find(kind => kind.id === id)?.name ?? 'unknown').join(', ')}`
    if (name === 'schema') return 'JSON schema'
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return `${name} ${parsed.join(', ')}`; if (parsed && typeof parsed === 'object') return `${name} ${parsed.value} ${parsed.unit}` } catch { /* plain text */ }
    return `${name} ${value}`
  }).join(' · ')
}

const STORE_ROWS: LabRow[] = LAB_STORE_FIELDS.map(field => ({ id: `store:${field.id}`, label: field.name, field, start: LAB_STORE_START[field.id] ?? null,
  group: field.ownerType === 'PRODUCT' ? 'Product fields' : 'Variant fields' }))
const TYPE_ROWS: LabRow[] = LAB_TYPE_FIELDS.map(field => ({ id: `type:${field.type}`, label: field.name, field, start: labGoodValue(field.type), group: familyOf(field.type) }))
const BAD_ROWS: LabRow[] = [
  ...LAB_TYPE_FIELDS.flatMap(field => labBadValues(field.type).map((bad, i) => {
    const today = validateShopifyField(field, bad.value)
    return { id: `bad:${field.type}:${i}`, label: `${field.name} — breaks “${bad.rule}”`, field, start: bad.value, group: 'Values the rules must refuse',
      note: today ? { tone: 'neutral' as const, text: 'Refused today' } : { tone: 'warning' as const, text: `Accepted today — gap ${bad.gap ?? '?'}` } }
  })),
  ...LAB_ODD_VALUES.map((odd, i) => ({ id: `odd:${i}`, label: `${labTypeField(odd.type).name} — ${odd.note}`, field: labTypeField(odd.type), start: odd.value, group: 'Old or odd stored values' })),
]

export function ShopifyPopupLab() {
  const [tab, setTab] = useState<TabId>('store')
  const [values, setValues] = useState<Record<string, string | null>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')
  const [query, setQuery] = useState('')
  const [onlyProblems, setOnlyProblems] = useState(false)
  const [refusal, setRefusal] = useState(false)
  const [entry, setEntry] = useState<OpenEntry | null>(null)
  const [expandedKind, setExpandedKind] = useState<string | null>(null)
  const [storeVersion, setStoreVersion] = useState(0)
  const anchors = useRef(new Map<string, HTMLDivElement | null>())

  /* Names, pictures and swatches for the cells — re-read after an entry is saved in this tab. */
  const maps = useMemo(() => {
    const refs = labStoreReferences()
    return {
      labels: Object.fromEntries(refs.map(r => [r.id, r.label])),
      images: Object.fromEntries(refs.flatMap(r => (r.image ? [[r.id, r.image]] : []))),
      swatches: Object.fromEntries(refs.flatMap(r => (r.swatch ? [[r.id, r.swatch]] : []))),
    }
    // storeVersion is the store's change counter; the references are read from the stand-in, not from React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeVersion])

  const valueOf = (row: LabRow) => (row.id in values ? values[row.id] : row.start)
  const allRows = [...STORE_ROWS, ...TYPE_ROWS, ...BAD_ROWS]
  const openRow = allRows.find(row => row.id === open) ?? null
  const problemOf = (row: LabRow) => {
    const value = valueOf(row)
    return shopifyTypeReason(row.field.type) ?? validateShopifyField(row.field, value)
      ?? (metafieldDisplay(row.field.type, value, maps).kind === 'invalid' ? 'The cell cannot read this value.' : null)
  }
  const matches = (row: LabRow) => {
    const q = query.trim().toLowerCase()
    if (q && !`${row.label} ${row.field.type}`.toLowerCase().includes(q)) return false
    return !onlyProblems || !!problemOf(row) || labGapsFor(row.field.type).length > 0 || row.note?.tone === 'warning'
  }

  const start = (row: LabRow) => { setOpen(row.id); setDraft(valueOf(row)); setError(''); setSaved('') }
  /* Closing hands focus back to the row, as the sheet hands it back to the cell (ShopifyDraftCell.tsx:161): a keyboard
     user keeps their place. */
  const close = () => {
    const id = open
    setOpen(null)
    if (id) requestAnimationFrame(() => anchors.current.get(id)?.querySelector<HTMLButtonElement>('.nds-prow-action')?.focus())
  }
  const save = (): boolean => {
    if (!openRow) return true
    if (draft === valueOf(openRow)) { close(); return true }
    const problem = validateShopifyField(openRow.field, draft)
    if (problem) { setError(`Not saved: ${problem}`); return false }
    setValues(v => ({ ...v, [openRow.id]: draft }))
    setSaved(`${openRow.label} saved in the lab.`)
    close()
    return true
  }
  /* The same hand-back as the sheet's pop-up (ShopifyDraftCell.tsx:196-203): a copy replaces the entry it was copied
     from; a NEW entry is picked straight away. */
  const entrySaved = (result: ShopifyReusableEntry) => {
    setStoreVersion(v => v + 1)
    if (!entry || !openRow) { if (entry && (entry.copy || !entry.id)) setEntry(null); return }
    const list = openRow.field.type.startsWith('list.')
    if (entry.copy) setDraft(previous => list ? JSON.stringify(JSON.parse(previous ?? '[]').map((id: string) => id === entry.id ? result.id : id)) : result.id)
    else if (!entry.id) setDraft(previous => list ? JSON.stringify([...JSON.parse(previous ?? '[]'), result.id]) : result.id)
    if (entry.copy || !entry.id) setEntry(null)
  }
  const reset = () => {
    resetLabStore(); setValues({}); setOpen(null); setEntry(null); setRefusal(false); setSaved('Lab reset: every value and entry is back to the start.'); setStoreVersion(v => v + 1)
  }

  const row = (r: LabRow) => {
    const value = valueOf(r)
    const gaps = labGapsFor(r.field.type)
    const readOnly = shopifyTypeReason(r.field.type)
    return (
      <div key={r.id} ref={el => { anchors.current.set(r.id, el) }}>
        <PressableRow label={r.label} expanded={open === r.id} onClick={() => (open === r.id ? save() : start(r))} stacked
          description={`${r.field.type}. Opens the Shopify pop-up.`}>
          <span className={styles.rowBody}>
            <span className={styles.cell}>
              <MetafieldValue type={r.field.type} raw={value} labels={maps.labels} images={maps.images} swatches={maps.swatches} />
            </span>
            <span className={styles.meta}>
              <code>{r.field.type}</code>{r.field.validations.length > 0 && <span>{ruleText(r.field)}</span>}
            </span>
            {(r.note || readOnly || gaps.length > 0) && <span className={styles.tags}>
              {r.note && <Tag tone={r.note.tone}>{r.note.text}</Tag>}
              {readOnly && <Tag tone="neutral">Read-only in Nexus: Shopify does not expose this type</Tag>}
              {gaps.map(gap => <Tag key={gap.id} tone="warning">{`${gap.id} · ${gap.text} (fix: ${gap.slice})`}</Tag>)}
            </span>}
          </span>
        </PressableRow>
      </div>
    )
  }
  const groups = (rows: LabRow[]) => {
    const shown = rows.filter(matches)
    if (!shown.length) return <EmptyState title="No field matches" description="Change the search words or turn off “Only with problems”." />
    const names = [...new Set(rows.map(r => r.group))]
    return names.map(name => {
      const inGroup = shown.filter(r => r.group === name)
      return inGroup.length ? <section key={name} className={styles.group} aria-label={name}>
        <h2 className={styles.groupTitle}>{name} <span className={styles.count}>{inGroup.length}</span></h2>
        <div className={styles.rows}>{inGroup.map(row)}</div>
      </section> : null
    })
  }

  const kinds = LAB_ENTRY_KINDS.filter(kind => {
    const q = query.trim().toLowerCase()
    return !q || `${kind.name} ${kind.type} ${kind.fields.map(f => f.type).join(' ')}`.toLowerCase().includes(q)
  })
  const refs = labStoreReferences()

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1>Shopify pop-up lab</h1>
        <p>The production Shopify pop-up on a made-up store with every Shopify metafield type. Open a row, edit, then press
          Enter or click outside to save; Esc cancels. Every name, picture and id is invented; nothing is sent to a store.</p>
      </header>
      <div className={styles.toolbar}>
        <Input size="sm" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search fields or types" aria-label="Search fields or types" />
        <FilterChip pressed={onlyProblems} onClick={() => setOnlyProblems(v => !v)}>Only with problems</FilterChip>
        <span className={styles.switch}>
          <Toggle size="sm" checked={refusal} onChange={next => { setRefusal(next); setLabRefusal(next) }} aria-labelledby="lab-refusal-label" />
          <span id="lab-refusal-label">Answer entry saves with a Shopify refusal</span>
        </span>
        <Button size="sm" variant="quiet" onClick={reset}>Reset the lab</Button>
      </div>
      {saved && <Banner tone="success">{saved}</Banner>}
      <Tabs ariaLabel="Lab sections" idBase="shopify-lab" active={tab} onChange={id => { setTab(id as TabId); setOpen(null) }} tabs={[
        { id: 'store', label: 'Your store’s fields', count: STORE_ROWS.length },
        { id: 'entries', label: 'Entry kinds', count: LAB_ENTRY_KINDS.length },
        { id: 'types', label: 'Every Shopify type', count: TYPE_ROWS.length },
        { id: 'bad', label: 'Bad and old values', count: BAD_ROWS.length },
      ]} />
      <div {...tabPanelProps('shopify-lab', tab)} className={styles.panel}>
        {tab === 'store' && <>
          <p className={styles.intro}>A mirror of a real store’s 39 fields: the same types and rules, made-up names.</p>
          {groups(STORE_ROWS)}
        </>}
        {tab === 'types' && <>
          <p className={styles.intro}>One field per type in Shopify’s live list (118 types, read 2026-09-28), each with a good value.</p>
          {groups(TYPE_ROWS)}
        </>}
        {tab === 'bad' && <>
          <p className={styles.intro}>Each value breaks one rule of its field. “Refused today” is right; “Accepted today” is a known gap. Open a row to see the pop-up’s answer.</p>
          {groups(BAD_ROWS)}
        </>}
        {tab === 'entries' && <>
          <p className={styles.intro}>A mirror of a real store’s 23 entry kinds (field types, required fields, file limits) plus one made-up disclosure kind. Entries save to the stand-in store only.</p>
          {kinds.length === 0 && <EmptyState title="No entry kind matches" description="Change the search words." />}
          <div className={styles.rows}>{kinds.map(kind => {
            const own = refs.filter(r => r.type === kind.type)
            const expanded = expandedKind === kind.id
            return <div key={kind.id} className={styles.kind}>
              <PressableRow label={kind.name} expanded={expanded} onClick={() => setExpandedKind(expanded ? null : kind.id)} stacked
                actions={<Button size="xs" onClick={() => setEntry({ id: null, type: kind.type })}>Add new entry</Button>}>
                <span className={styles.meta}>
                  <code>{kind.type}</code>
                  <span>{kind.fields.map(f => `${f.name} (${f.type}${f.required ? ', required' : ''})`).join(' · ')}</span>
                  <span>{own.length} {own.length === 1 ? 'entry' : 'entries'}</span>
                </span>
              </PressableRow>
              {expanded && <div className={styles.entryList} role="group" aria-label={`${kind.name} entries`}>
                {own.map(ref => <PressableRow key={ref.id} label={ref.label} onClick={() => setEntry({ id: ref.id })}
                  leading={<MediaMark choice={{ image: ref.image, swatch: ref.swatch ?? null, label: ref.label }} size="chip" />} />)}
              </div>}
            </div>
          })}</div>
        </>}
      </div>

      {openRow && (
        <CellPanel anchor={anchors.current.get(openRow.id) ?? null} label={`${openRow.field.name}: SAMPLE-100`} onSave={save} onCancel={close}
          footer={<><span className="nds-editor-keyhint">{EDITOR_KEY_HINT_PANEL}</span><span className={styles.footerNote}>Saves in the lab only</span></>}>
          <div className={styles.panelBody}>
            <strong>{openRow.field.name} · SAMPLE-100</strong>
            {error && <Banner tone="danger">{error}</Banner>}
            <LinkedFieldEditor path={LAB_PATH} schema={LAB_SCHEMA} definition={openRow.field} value={draft} disabled={false}
              onChange={next => { setDraft(next); setError('') }}
              onOpenEntry={id => setEntry({ id })} onCopyEntry={id => setEntry({ id, copy: true })} onCreateEntry={type => setEntry({ id: null, type })} />
          </div>
        </CellPanel>
      )}
      {entry && <EntryEditor key={`${entry.id}:${!!entry.copy}:${entry.type ?? ''}`} id={entry.id} copy={entry.copy} initialType={entry.type} path={LAB_PATH}
        schema={LAB_SCHEMA} canPublish onClose={() => setEntry(null)} onSaved={entrySaved} />}
    </div>
  )
}

