'use client'

/**
 * The Send to FBA form (Owner 2026-10-07 / 10-08) — ONE component for the Matrix "Send to FBA…" dialog and the draft on
 * the FBA shipments page (Fulfillment › Outbound), so both show exactly the same table, counts and problems:
 *
 *     From [IT-MAIN · Rimini]   To [Amazon IT]   Ready [08/10/2026]
 *     one Banner per kind of whole-plan problem (account, address, day, box)
 *     Prep by [Amazon|Seller]   Labels by [Amazon|Seller]   Saved for these SKUs     ← only when a SKU has "not set"
 *     SKU · Free · Cases (one stepper per case size) · Units · Boxes · Check [· remove] ← Tab / Enter move down a column
 *     Loose units go in 2 mixed boxes · 60 × 40 × 40 cm   ▸ Change box size
 *     one Banner per kind of SKU problem
 *     2 SKUs · 29 units · 3 boxes · 31.4 kg                                            ← the shared `sendSummary`
 *
 * The host owns the state (the dialog reads a new draft when From / To change; the page saves the draft) and the
 * buttons. Nothing here computes a box, a count or a refusal: `sendToFba.ts` hands the shared rules the choice.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'

import { FBA_SEND_COPY, type FbaSendDraft, type FbaSendLine, type FbaSendSku, type FbaSendSummary } from '@nexus/shared/fba-send'
import type { CaseOwner } from '@nexus/shared/stock-cases'

import { Banner, DateField, Disclosure, EmptyState, Field, Listbox } from '@/design-system/components'
// The DS grid's DataGrid (AG Grid, the same props) — the retiring `components/DataGrid` is on the grid-kit ratchet.
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Input, NumberStepper, Pill, SegmentedControl, ToolbarButton } from '@/design-system/primitives'

import {
  OWNER_OPTIONS, caseSteppers, casesOf, locationOption, marketOption, ownersAsked, parseSide, problemBanners, skuBoxes, skuCheck,
  summaryLine, unitsMax, withCases, type SendForm,
} from './sendToFba'
import styles from './fba.module.css'
import dialogs from '../dialogs.module.css'

type Side = 'lengthCm' | 'widthCm' | 'heightCm'
const SIDES: ReadonlyArray<[Side, string]> = [['lengthCm', 'Length'], ['widthCm', 'Width'], ['heightCm', 'Height']]
const SHOWN_MESSAGES = 4

export interface FbaSendFormProps {
  draft: FbaSendDraft
  form: SendForm
  summary: FbaSendSummary | null
  /** Busy (creating, sending) or done: every control is held. */
  disabled: boolean
  /** A new draft is being read: the table says so. */
  reading: boolean
  onFrom: (code: string) => void
  onMarket: (code: string) => void
  /** Any other change of the form (a line, the day, the box, the owners). */
  onForm: (change: (form: SendForm) => SendForm) => void
  /** The page's draft: a remove button per SKU. */
  onRemove?: (sku: FbaSendSku) => void
  /** Shown above the table (the page's "Add SKUs"). */
  tableActions?: ReactNode
  emptyState?: ReactNode
  /** The table's height before it scrolls (the dialog 320; the page more). */
  maxHeight?: number
}

export function FbaSendForm(p: FbaSendFormProps) {
  const { draft, form, summary, disabled } = p
  const tableRef = useRef<HTMLDivElement>(null)
  const [sides, setSides] = useState<Record<Side, string>>(() => ({
    lengthCm: String(form.mixedBox.lengthCm), widthCm: String(form.mixedBox.widthCm), heightCm: String(form.mixedBox.heightCm),
  }))
  const asked = ownersAsked(draft)
  const banners = useMemo(() => (summary ? problemBanners(summary.problems) : []), [summary])

  const setLine = (productId: string, change: (line: FbaSendLine) => FbaSendLine) =>
    p.onForm((f) => ({ ...f, lines: { ...f.lines, [productId]: { ...change(f.lines[productId] ?? { productId, cases: [], looseUnits: 0 }), productId } } }))
  const setSide = (side: Side, text: string) => {
    setSides((s) => ({ ...s, [side]: text }))
    // An empty or non-numeric side is held as 0: the shared box check names it, and nothing is sent.
    p.onForm((f) => ({ ...f, mixedBox: { ...f.mixedBox, [side]: parseSide(text) ?? 0 } }))
  }

  /* Tab / Enter move DOWN a column (the Available pop-up's spreadsheet feel); Shift goes up; past the ends, Tab is Tab.
     The Cases column counts its steppers in order: a SKU's sizes, then the next SKU's. */
  const moveDown = (e: KeyboardEvent<HTMLInputElement>, column: 'cases' | 'units', index: number) => {
    if ((e.key !== 'Tab' && e.key !== 'Enter') || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return
    const next = tableRef.current?.querySelector<HTMLInputElement>(`[data-fba-step="${column}-${index + (e.shiftKey ? -1 : 1)}"]`)
    if (!next) { if (e.key === 'Enter') e.preventDefault(); return }
    e.preventDefault()
    next.focus()
    next.select()
  }

  /* ── the table ── */

  const indexOf = useMemo(() => new Map(draft.skus.map((s, i) => [s.productId, i])), [draft])
  /* The first Cases stepper of each SKU, counted down the column. */
  const caseIndexOf = useMemo(() => {
    const out = new Map<string, number>()
    let next = 0
    for (const s of draft.skus) { out.set(s.productId, next); next += s.caseSizes.length }
    return out
  }, [draft])
  const severalSizes = draft.skus.some((s) => s.caseSizes.length > 1)
  const columns: Column<FbaSendSku>[] = [
    { key: 'sku', label: FBA_SEND_COPY.columns.sku, width: 250, render: (s) => <span className={styles.sku}>{s.sku}</span> },
    { key: 'free', label: FBA_SEND_COPY.columns.free, width: severalSizes ? 128 : 96, numeric: true, render: (s) => FBA_SEND_COPY.free(s.free, s.freeSealed) },
    {
      key: 'cases', label: FBA_SEND_COPY.columns.cases, width: severalSizes ? 148 : 128,
      render: (s) => {
        const steppers = caseSteppers(s)
        if (steppers.length === 0) return <span className={styles.muted}>—</span>
        const line = form.lines[s.productId]
        const one = steppers.length === 1
        const first = caseIndexOf.get(s.productId) ?? 0
        // One case size: the stepper exactly as before. Several: one per size, stacked, each marked with its size.
        const list = steppers.map(({ unitsPerCase, max }, k) => (
          <NumberStepper key={unitsPerCase} size="sm" min={0} max={Math.max(max, casesOf(line, unitsPerCase))} value={casesOf(line, unitsPerCase)} disabled={disabled}
            suffix={one ? undefined : `×${unitsPerCase}`}
            aria-label={one ? `Cases of ${s.sku}` : `Cases of ${unitsPerCase} (${s.sku})`}
            decrementLabel={one ? `One case less of ${s.sku}` : `One case of ${unitsPerCase} less (${s.sku})`}
            incrementLabel={one ? `One case more of ${s.sku}` : `One case of ${unitsPerCase} more (${s.sku})`}
            data-fba-step={`cases-${first + k}`} onKeyDown={(e) => moveDown(e, 'cases', first + k)}
            onFocus={(e) => e.currentTarget.select()} onChange={(n) => setLine(s.productId, (l) => withCases(l, unitsPerCase, n))} />
        ))
        return one ? list[0] : <span className={styles.steppers}>{list}</span>
      },
    },
    {
      key: 'units', label: FBA_SEND_COPY.columns.units, width: 128,
      render: (s) => {
        const value = form.lines[s.productId]?.looseUnits ?? 0
        return (
          <NumberStepper size="sm" min={0} max={Math.max(unitsMax(s), value)} value={value} disabled={disabled}
            aria-label={`Loose units of ${s.sku}`} decrementLabel={`One unit less of ${s.sku}`} incrementLabel={`One unit more of ${s.sku}`}
            data-fba-step={`units-${indexOf.get(s.productId) ?? 0}`} onKeyDown={(e) => moveDown(e, 'units', indexOf.get(s.productId) ?? 0)}
            onFocus={(e) => e.currentTarget.select()} onChange={(n) => setLine(s.productId, (l) => ({ ...l, looseUnits: n }))} />
        )
      },
    },
    { key: 'boxes', label: FBA_SEND_COPY.columns.boxes, width: 96, numeric: true, render: (s) => (summary ? skuBoxes(summary.plan, s.productId) : '—') },
    {
      key: 'check', label: FBA_SEND_COPY.columns.check, width: 200,
      render: (s) => {
        const check = summary ? skuCheck(summary, s.productId, form.lines[s.productId]) : null
        return check ? <Pill tone={check.tone}>{check.text}</Pill> : null
      },
    },
    ...(p.onRemove ? [{
      key: 'remove', label: '', width: 48,
      render: (s: FbaSendSku) => (
        <ToolbarButton label={FBA_SEND_COPY.removeSku(s.sku)} icon={<X size={14} />} tooltipAlign="end" disabled={disabled} onClick={() => p.onRemove?.(s)} />
      ),
    } satisfies Column<FbaSendSku>] : []),
  ]

  /* ── the parts ── */

  const list = (messages: readonly string[]) => (messages.length === 1 ? messages[0] : (
    <ul className={styles.list}>
      {messages.slice(0, SHOWN_MESSAGES).map((m) => <li key={m}>{m}</li>)}
      {messages.length > SHOWN_MESSAGES && <li>…and {messages.length - SHOWN_MESSAGES} more</li>}
    </ul>
  ))
  const bannersOf = (whole: boolean) => banners.filter((b) => b.whole === whole).map((b) => <Banner key={b.code} tone={b.tone} title={b.title}>{list(b.messages)}</Banner>)

  return (
    <>
      <div className={styles.where}>
        <Field label={FBA_SEND_COPY.from}>
          <Listbox size="sm" options={draft.locations.map(locationOption)} value={draft.from?.code} placeholder="Choose a warehouse"
            disabled={disabled} onChange={p.onFrom} />
        </Field>
        <Field label={FBA_SEND_COPY.to}>
          <Listbox size="sm" options={draft.markets.map(marketOption)} value={draft.markets.some((m) => m.code === draft.market) ? draft.market : undefined}
            placeholder={draft.market} disabled={disabled} onChange={p.onMarket} />
        </Field>
        <Field label={FBA_SEND_COPY.ready}>
          <DateField value={form.readyToShipOn} min={draft.today || undefined} disabled={disabled}
            onChange={(day) => p.onForm((f) => ({ ...f, readyToShipOn: day }))} />
        </Field>
      </div>
      {bannersOf(true)}
      {asked && (
        <div className={styles.owners}>
          {(['prepOwner', 'labelOwner'] as const).map((key) => (
            <div key={key} className="nds-field-w">
              <span className="nds-field-lbl" aria-hidden="true">{key === 'prepOwner' ? FBA_SEND_COPY.prepBy : FBA_SEND_COPY.labelsBy}</span>
              <SegmentedControl ariaLabel={key === 'prepOwner' ? FBA_SEND_COPY.prepBy : FBA_SEND_COPY.labelsBy} size="sm" className={dialogs.seg} value={form.owners[key]}
                disabled={disabled} options={OWNER_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                onChange={(v) => p.onForm((f) => ({ ...f, owners: { ...f.owners, [key]: v as CaseOwner } }))} />
            </div>
          ))}
          <span className={styles.muted}>{FBA_SEND_COPY.ownersHint}</span>
        </div>
      )}
      {p.tableActions}
      <div ref={tableRef} className={styles.table} aria-busy={p.reading || undefined}>
        <DataGrid ariaLabel="SKUs to send" size="sm" keyboardScroll headerMenus={false} maxHeight={p.maxHeight ?? 320} columns={columns} rows={draft.skus} rowKey={(s) => s.productId}
          emptyState={p.emptyState ?? <EmptyState title="No SKU to send" description="None of the ticked rows is a SKU this business sells." />} />
      </div>
      {summary && summary.looseUnits > 0 && (
        <div className={styles.box}>
          {summary.mixedLine && <span>{summary.mixedLine}</span>}
          <Disclosure summary={FBA_SEND_COPY.changeBox}>
            <div className={styles.sides}>
              {SIDES.map(([side, word]) => (
                <Field key={side} label={word}>
                  <Input size="sm" inputMode="decimal" autoComplete="off" suffix="cm" value={sides[side]} disabled={disabled}
                    aria-invalid={parseSide(sides[side]) === null ? true : undefined} onChange={(e) => setSide(side, e.target.value)} />
                </Field>
              ))}
            </div>
          </Disclosure>
        </div>
      )}
      {bannersOf(false)}
      {/* ONE summary line (Owner): what the plan sends, as the shared rules count it. */}
      {summary && <p className={styles.totals} role="status">{summaryLine(summary)}</p>}
    </>
  )
}
