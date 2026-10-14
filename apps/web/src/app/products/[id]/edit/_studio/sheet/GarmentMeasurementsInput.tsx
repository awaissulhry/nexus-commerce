'use client'

/**
 * Garment measurements (2026-10-14) — `Product.fitGarment`: the finished garment's measurements per size, in cm.
 * ONE control for the Shared sheet's pop-up (`GarmentMeasurementsEditor`, master `columns.tsx`) and the record drawer
 * (`RecordField.tsx`):
 *
 *     The finished garment, measured per size. Shoppers never see these numbers; …
 *     [ Add measure… ▾ ]  [ + Add size ]
 *     Size        Chest ✕       Waist ✕       Sleeve length ✕
 *     Flat (half) [◯]           [◯]
 *     [ M     ]   [ 53    ]     [ 94    ]     [ 62,5  ]         ✕
 *     [ L     ]   [ 56    ]     [ 100   ]     [ 64    ]         ✕
 *     ▸ More — room for a good fit (least / most, cm)
 *     • the shared rule's problems, if any                       [ Save ]
 *
 * Every number is checked by the shared rule (`normalizeFitGarment`, @nexus/shared/fit-garment) as it is typed; Save is
 * held while it refuses. A block pasted from a spreadsheet fills the grid from the cell it lands on (`garmentMeasurements.ts`).
 * Design system only: Input, Select, Toggle, Button, ToolbarButton, Disclosure; the CSS module is layout.
 */
import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'

import { Button, Input, Select, Toggle, ToolbarButton } from '@/design-system/primitives'
import { Disclosure } from '@/design-system/components'
import { FIT_MEASURES, FIT_SIZES_MAX, fitGarmentSummary, readFitGarment, type FitGarment, type FitMeasure } from '@nexus/shared/fit-garment'

import {
  GARMENT_HELP, addMeasure, addRow, checkDraft, deleteMeasure, deleteRow, draftFromValue, familySizeNames, isCircumference,
  measureLabel, pasteIntoDraft, sameTable, setCell, setFlat, setName, setRoom, type GarmentDraft,
} from './garmentMeasurements'
import { loadVariationFamily } from './master/variationFamilyLoader'
import styles from './GarmentMeasurementsInput.module.css'

/** The sheet cell's words: "6 sizes · chest, waist, sleeve length", or '' (the cell then shows its empty mark). */
export const garmentSummary = (value: unknown): string => fitGarmentSummary(value)

/** The product's own sizes: the size axis of its family, read through the photo plan's family route (read only). */
export async function loadGarmentSizes(productId: string): Promise<string[]> {
  return familySizeNames(await loadVariationFamily(productId))
}

export interface GarmentMeasurementsInputProps {
  value: unknown
  /** What Save compares with. Default `value`; the sheet's pop-up passes the value the cell opened on. */
  baseline?: unknown
  disabled?: boolean
  /** The product's own size names, read once when the table is empty: a new table starts from them. */
  loadSizes?: () => Promise<string[]>
  /** Every change the rule accepts, as it would be stored (`null` = cleared). */
  onDraft?: (value: FitGarment | null) => void
  /** Save now: the table as it will be stored. */
  onSave: (value: FitGarment | null) => void
}

export function GarmentMeasurementsInput({ value, baseline = value, disabled, loadSizes, onDraft, onSave }: GarmentMeasurementsInputProps) {
  const id = useId()
  const [draft, setDraft] = useState<GarmentDraft>(() => draftFromValue(value))
  const [note, setNote] = useState<string | null>(null)
  const draftRef = useRef(draft)
  const touched = useRef(false)
  draftRef.current = draft

  /* Repaint from the stored value only when it says something the draft does not: the grid echoes every reported change
     back as `value`, and the drawer refetches after a save — neither may reset what is being typed (or drop an empty row
     the operator just added). Compared as stored, so key order and "62,5" against 62.5 never count. */
  const incoming = JSON.stringify(readFitGarment(value).value)
  useEffect(() => {
    if (incoming === JSON.stringify(checkDraft(draftRef.current).value)) return
    setDraft(draftFromValue(value))
    setNote(null)
  }, [incoming]) // eslint-disable-line react-hooks/exhaustive-deps

  // A new table starts from the product's own sizes; a failed read keeps the one empty row.
  const empty = incoming === 'null'
  const loadRef = useRef(loadSizes)
  loadRef.current = loadSizes
  useEffect(() => {
    const load = loadRef.current
    if (!empty || !load) return
    let active = true
    load().then((names) => {
      if (!active || !names.length || touched.current) return
      // The rows keep their keys, so the field that has focus stays the same field (now named).
      setDraft((current) => {
        const next = draftFromValue(null, names)
        return { ...next, rows: next.rows.map((row, i) => (current.rows[i] ? { ...row, key: current.rows[i].key } : row)) }
      })
    }).catch(() => undefined)
    return () => { active = false }
  }, [empty])

  const checked = useMemo(() => checkDraft(draft), [draft])
  const change = (next: GarmentDraft, nextNote: string | null = null) => {
    touched.current = true
    draftRef.current = next
    setDraft(next)
    setNote(nextNote)
    const result = checkDraft(next)
    if (!result.problems.length) onDraft?.(result.value)
  }

  const paste = (row: number, column: number) => (event: ClipboardEvent<HTMLInputElement>) => {
    const filled = pasteIntoDraft(draft, { row, column }, event.clipboardData.getData('text/plain'))
    if (!filled) return // one value: the field takes it as typed
    event.preventDefault()
    change(filled.draft, filled.note)
  }

  const unused = FIT_MEASURES.filter((m) => !draft.measures.includes(m))
  const atMax = draft.rows.length >= FIT_SIZES_MAX
  const unchanged = sameTable(checked.value, baseline)
  const held = disabled ? 'This field cannot be edited here.'
    : checked.problems.length ? 'Fix the problems listed above first.'
      : unchanged ? 'Nothing has changed yet.' : null
  const problemsId = `${id}-problems`

  return (
    <fieldset className={styles.root} disabled={disabled} aria-describedby={`${id}-help`}>
      <legend className="nds-vh">Garment measurements</legend>
      <p className={styles.help} id={`${id}-help`}>{GARMENT_HELP}</p>

      <div className={styles.toolbar}>
        <Select size="sm" aria-label="Add measure" value="" disabled={disabled || !unused.length}
          onChange={(event) => { if (event.target.value) change(addMeasure(draft, event.target.value as FitMeasure)) }}>
          <option value="">{unused.length ? 'Add measure…' : 'Every measure is in the table'}</option>
          {unused.map((m) => <option key={m} value={m}>{measureLabel(m)}</option>)}
        </Select>
        <Button size="sm" variant="quiet" heldReason={atMax ? `A table holds at most ${FIT_SIZES_MAX} sizes.` : null} onClick={() => change(addRow(draft))}>
          <Plus size={14} aria-hidden /> Add size
        </Button>
      </div>

      <div className={styles.scroll}>
        <div className={styles.table} role="table" aria-label="Garment measurements in cm, one row per size">
          <div className={styles.row} role="row">
            <span className={`${styles.name} ${styles.head}`} role="columnheader">Size</span>
            {draft.measures.map((m) => (
              <span key={m} className={`${styles.cell} ${styles.head}`} role="columnheader">
                <span className={styles.headText}>{measureLabel(m)}{draft.flat.includes(m) ? ' (half)' : ''}</span>
                <ToolbarButton label={`Delete the ${measureLabel(m)} column`} icon={<X size={14} />} tooltipAlign="end" disabled={disabled}
                  onClick={() => change(deleteMeasure(draft, m))} />
              </span>
            ))}
            <span className={styles.end} aria-hidden />
          </div>

          {draft.measures.some(isCircumference) && (
            <div className={styles.row} role="row">
              <span className={`${styles.name} ${styles.flatLabel}`} role="rowheader">Measured flat (half)</span>
              {draft.measures.map((m) => (
                <span key={m} className={styles.cell} role="cell">
                  {isCircumference(m) && (
                    <Toggle size="sm" checked={draft.flat.includes(m)} disabled={disabled}
                      aria-label={`${measureLabel(m)} measured flat (half): type the half width, saved doubled`}
                      onChange={(on) => change(setFlat(draft, m, on))} />
                  )}
                </span>
              ))}
              <span className={styles.end} aria-hidden />
            </div>
          )}

          {draft.rows.map((row, r) => {
            const sizeName = row.name.trim() || `row ${r + 1}`
            return (
              <div key={row.key} className={styles.row} role="row" data-garment-row={row.key}>
                <span className={styles.name} role="cell">
                  <Input size="sm" fieldClassName={styles.fill} value={row.name} maxLength={40} autoComplete="off" aria-label={`Size name, row ${r + 1}`}
                    onChange={(event) => change(setName(draft, row.key, event.target.value))} onPaste={paste(r, -1)} />
                </span>
                {draft.measures.map((m, c) => (
                  <span key={m} className={styles.cell} role="cell">
                    <Input size="sm" fieldClassName={styles.fill} inputMode="decimal" autoComplete="off" value={row.cells[m] ?? ''}
                      aria-label={`${sizeName}, ${measureLabel(m)}${draft.flat.includes(m) ? ' (half)' : ''}, cm`}
                      onChange={(event) => change(setCell(draft, row.key, m, event.target.value))} onPaste={paste(r, c)} />
                  </span>
                ))}
                <span className={styles.end} role="cell">
                  <ToolbarButton label={`Delete size ${sizeName}`} icon={<X size={14} />} tooltipAlign="end" disabled={disabled}
                    onClick={() => change(deleteRow(draft, row.key))} />
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {draft.measures.length > 0 && (
        <Disclosure summary="More: room for a good fit" className={styles.more}>
          <p className={styles.help}>The least and the most room the garment should leave round the body, in cm, the full way round. Optional.</p>
          <div className={styles.roomList}>
            {draft.measures.map((m) => (
              <div key={m} className={styles.roomRow} role="group" aria-label={`Room for a good fit, ${measureLabel(m)}`}>
                <span className={styles.roomLabel}>{measureLabel(m)}</span>
                <Input size="sm" fieldClassName={styles.fill} inputMode="decimal" autoComplete="off" prefix="Least"
                  aria-label={`${measureLabel(m)}, least room, cm`} value={draft.room[m]?.least ?? ''}
                  onChange={(event) => change(setRoom(draft, m, 'least', event.target.value))} />
                <Input size="sm" fieldClassName={styles.fill} inputMode="decimal" autoComplete="off" prefix="Most"
                  aria-label={`${measureLabel(m)}, most room, cm`} value={draft.room[m]?.most ?? ''}
                  onChange={(event) => change(setRoom(draft, m, 'most', event.target.value))} />
              </div>
            ))}
          </div>
        </Disclosure>
      )}

      <div className={styles.footer}>
        <div className={styles.messages} aria-live="polite">
          {note && <p className={styles.note}>{note}</p>}
          {checked.problems.length > 0 && (
            <ul className={styles.problems} id={problemsId}>
              {checked.problems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          )}
        </div>
        <Button size="sm" variant="primary" heldReason={held} aria-describedby={checked.problems.length ? problemsId : undefined}
          onClick={() => onSave(checked.value)}>
          Save
        </Button>
      </div>
    </fieldset>
  )
}

/** Tab walks the editor's own controls in the sheet's pop-up; Tab past the last one (Shift+Tab before the first) is AG's. */
const FOCUSABLE = 'input, select, button, summary'
function focusables(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if ((el as HTMLInputElement).disabled) return false
    const details = el.closest('details') as HTMLDetailsElement | null
    return !details || el.tagName === 'SUMMARY' || details.open === true
  })
}
const editorRoot = (target: unknown) => (target && typeof (target as Element).closest === 'function' ? (target as Element).closest('[data-garment-editor]') : null)

/** What a column hands this editor instead of the grid: Tab inside the table, and Enter on a button or a list. */
export function suppressGarmentKeys({ event, editing }: { event: KeyboardEvent | globalThis.KeyboardEvent | { key: string; shiftKey?: boolean; target?: unknown }; editing: boolean }): boolean {
  if (!editing) return false
  const target = event.target as HTMLElement | undefined
  const root = editorRoot(target)
  if (!root || !target) return false
  if (event.key === 'Enter') return ['BUTTON', 'SELECT', 'SUMMARY'].includes(target.tagName)
  if (event.key !== 'Tab') return false
  const list = focusables(root)
  const at = list.indexOf(target)
  if (at < 0) return false
  return event.shiftKey ? at > 0 : at < list.length - 1
}

/**
 * The Shared sheet's pop-up. Every change the rule accepts is reported to the grid (`onValueChange`), so Enter, Tab past
 * the last control, or a click elsewhere keeps it; Save keeps it and closes; Escape closes without it.
 */
export function GarmentMeasurementsEditor({ value, onValueChange, stopEditing, data, garmentSizes }: {
  value?: unknown
  onValueChange: (value: unknown) => void
  stopEditing?: (cancel?: boolean) => void
  data?: { id?: string }
  garmentSizes?: (productId: string) => Promise<string[]>
}) {
  const root = useRef<HTMLDivElement>(null)
  const [opened] = useState(() => value)
  const productId = data?.id
  const loadSizes = useMemo(() => (productId && garmentSizes ? () => garmentSizes(productId) : undefined), [productId, garmentSizes])
  useEffect(() => { root.current?.querySelector<HTMLElement>('input')?.focus() }, [])
  const walk = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !root.current) return
    const list = focusables(root.current)
    const at = list.indexOf(event.target as HTMLElement)
    const next = at < 0 ? null : list[at + (event.shiftKey ? -1 : 1)]
    if (!next) return
    event.preventDefault()
    next.focus()
  }
  // The grid's pop-up editor surface (`nds-list-editor`, as ImpactProtectorsEditor): without it the cells under the pop-up
  // show through the table. The inner box keeps the width, the height limit and the scroll.
  return (
    <div className="nds-list-editor">
      <div ref={root} className={styles.popup} data-garment-editor onKeyDown={walk}>
        <GarmentMeasurementsInput value={value} baseline={opened} loadSizes={loadSizes} onDraft={onValueChange}
          onSave={(next) => { onValueChange(next); stopEditing?.() }} />
      </div>
    </div>
  )
}
