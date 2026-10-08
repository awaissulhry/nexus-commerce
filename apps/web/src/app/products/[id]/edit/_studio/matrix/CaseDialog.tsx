'use client'

/**
 * The Case pop-up (Step 3 part D, Owner 2026-10-07: "super simple"; several case sizes per SKU, Owner 2026-10-08) — the
 * Case cell's door. One small DS Modal anchored on the cell:
 *
 *     Case · GALE-M                                                  ✕
 *     Case sizes
 *     Units per case   Case size (L × W × H)            Weight
 *     [ 12 ]           [ 60 cm ] × [ 40 cm ] × [ 35 cm ]  [ 14.5 kg ]  ✕
 *     [ 6 ]            [ 40 cm ] × [ 30 cm ] × [ 35 cm ]  [ 7.5 kg ]   ✕
 *     + Add case size
 *     Prep by    [ Amazon | Seller | Not set ]
 *     Labels by  [ Amazon | Seller | Not set ]
 *     ⚠ Amazon EU takes boxes up to 63.5 cm a side and 23 kg.      ← a warning, never a refusal
 *                                              [Cancel] [Save]
 *
 * On the parent the title is "Case · All N variants" and one Save writes every variant. When the variants' sizes differ
 * the sizes read "Variants differ. Each keeps its own." with "Replace for all variants" (it starts from the first
 * variant's list); an owner the variants differ on starts as "Mixed". Left so, each variant keeps its own. Removing a
 * size that has sealed cases in stock answers 409: the pop-up says how many open, and Save becomes "Save · open N cases"
 * (the second click confirms). The rules are `casePack.ts`.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'

import { Banner, Field, Modal } from '@/design-system/components'
import { Button, Input, SegmentedControl, ToolbarButton, Tooltip } from '@/design-system/primitives'
import { MAX_CASE_SIZES } from '@nexus/shared/stock-cases'

import {
  blankSize, CASE_DIALOG_COPY, CASE_SIZE_FIELDS, caseBoxWarning, caseSaveHeld, caseSavedSentence, caseStart, caseWrites, parseSizes, putCasePacks, saveLabel,
  sealedSummary, undoWrites,
  type CaseDraft, type CaseMember, type CaseOwnerField, type CasePut, type CaseSizeField, type CaseWrite, type SealedCases, type SizeDraft,
} from './casePack'
import styles from './CaseDialog.module.css'
import dialogs from './dialogs.module.css'
import { useFocusOffClose } from './dialogFocus'

export interface CaseTarget {
  rowId: string
  /** `GALE-M`, or `All 6 variants` on the parent — the title and the toast name it. */
  label: string
  /** The parent's own SKU under the title; none on a variant. */
  subtitle?: string
  /** The SKUs one Save writes: the variant, or every variant of the parent. */
  members: CaseMember[]
  /** The cell it opened from (the Modal anchors on it on a wide screen). */
  anchor: HTMLElement | null
}

/** What a save hands the page: the toast's sentence, and its Undo (none when sealed cases were opened). */
export interface CaseSaved { sentence: string; undo: (() => Promise<string>) | null }

export interface CaseDialogProps {
  target: CaseTarget
  /** The route; injectable for a test. */
  put?: CasePut
  onClose: () => void
  onSaved: (saved: CaseSaved) => void
}

const OWNERS = [{ value: 'AMAZON', label: 'Amazon' }, { value: 'SELLER', label: 'Seller' }, { value: '', label: 'Not set' }]
const SIDES: ReadonlyArray<[CaseSizeField, string]> = [['caseLengthCm', 'Length'], ['caseWidthCm', 'Width'], ['caseHeightCm', 'Height']]

/** A phone: the first field is not focused on open (the keyboard would cover the pop-up). */
const isPhone = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 599px)').matches

interface Confirm { writes: CaseWrite[]; cases: number; sentence: string }

export function CaseDialog(p: CaseDialogProps) {
  const { target } = p
  const put: CasePut = p.put ?? ((write, open) => putCasePacks(write, open))
  /* The values as they were when the pop-up opened: the fields start from them, and Save compares against them. */
  const [start] = useState(() => caseStart(target.members))
  const [draft, setDraft] = useState<CaseDraft>(() => ({ ...start.draft, sizes: start.draft.sizes?.map((s) => ({ ...s })) ?? null }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [autofocus] = useState(() => !isPhone())
  useFocusOffClose()
  /* What this opening already saved (a parent's writes can land in parts): the toast and its Undo name it. */
  const applied = useRef<{ writes: CaseWrite[]; opened: number }>({ writes: [], opened: 0 })

  const edit = (next: (d: CaseDraft) => CaseDraft) => { setDraft(next); setConfirm(null); setError(null) }
  const setOwner = (field: CaseOwnerField, value: string) => edit((d) => ({ ...d, [field]: value }))
  const setSize = (key: string, field: CaseSizeField, value: string) =>
    edit((d) => ({ ...d, sizes: d.sizes?.map((s) => (s.key === key ? { ...s, [field]: value } : s)) ?? null }))
  const addSize = () => edit((d) => ({ ...d, sizes: [...(d.sizes ?? []), blankSize()] }))
  const removeSize = (key: string) => edit((d) => ({ ...d, sizes: (d.sizes ?? []).filter((s) => s.key !== key) }))
  const replaceAll = () => edit((d) => ({ ...d, sizes: start.firstSizes.map((s) => ({ ...s })) }))

  const parsed = draft.sizes ? parseSizes(draft.sizes) : null
  const problemOf = (row: SizeDraft, field: CaseSizeField): string | null => parsed?.problems.get(`${row.key}:${field}`) ?? null
  const held = busy ? 'Saving…' : confirm ? null : caseSaveHeld(target.members, draft, start)
  const boxWarning = caseBoxWarning(target.members, draft)
  const sizeCount = draft.sizes?.length ?? 0
  const atMax = sizeCount >= MAX_CASE_SIZES

  const finish = () => {
    const { writes, opened } = applied.current
    if (writes.length > 0) {
      const back = undoWrites(target.members, writes)
      p.onSaved({
        sentence: caseSavedSentence(target.label, writes, opened),
        // Opened cases do not seal again: no Undo then.
        undo: opened > 0 ? null : async () => {
          for (const w of back) {
            const a = await put(w, false)
            if (a.kind === 'sealed') throw new Error(sealedSummary(a.sealed)?.sentence ?? 'Not put back')
            const bad = a.results.find((r) => !r.ok)
            if (bad) throw new Error(bad.error ?? 'Not put back')
          }
          return `Put back · ${target.label}`
        },
      })
    }
    p.onClose()
  }

  const save = async () => {
    if (held !== null) return
    const writes = confirm ? confirm.writes : caseWrites(target.members, draft, start)
    const openSealed = !!confirm
    setBusy(true); setError(null)
    try {
      const sealedWrites: CaseWrite[] = []
      const sealed: SealedCases[] = []
      let refused: string | null = null
      for (const w of writes) {
        const a = await put(w, openSealed)
        if (a.kind === 'sealed') { sealedWrites.push(w); sealed.push(...a.sealed); continue }
        const ok = new Set(a.results.filter((r) => r.ok).map((r) => r.productId))
        const done = a.results.length ? w.productIds.filter((id) => ok.has(id)) : w.productIds
        if (done.length) applied.current.writes.push({ productIds: done, values: w.values })
        applied.current.opened += a.results.reduce((n, r) => n + (r.opened ?? []).reduce((m, o) => m + (o.cases || 0), 0), 0)
        refused ??= a.results.find((r) => !r.ok)?.error ?? (a.results.some((r) => !r.ok) ? 'Not saved' : null)
      }
      if (refused) { setError(refused); setConfirm(null); return }
      if (sealedWrites.length) {
        const summary = sealedSummary(sealed)
        setConfirm({ writes: sealedWrites, cases: summary?.cases ?? 0, sentence: summary?.sentence ?? 'Sealed cases become loose units. Count them again under Stock.' })
        return
      }
      finish()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const close = () => { if (applied.current.writes.length) finish(); else p.onClose() }
  // Enter in a field saves (the inputs are many, so a form would not submit by itself).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement) { e.preventDefault(); void save() }
  }

  const numberInput = (row: SizeDraft, field: CaseSizeField, extra: { suffix?: string; ariaLabel: string; decimal?: boolean; first?: boolean }) => (
    <Input
      size="sm" fieldClassName={styles.fill} inputMode={extra.decimal ? 'decimal' : 'numeric'} autoComplete="off"
      // The pop-up opens on the first Units per case (not the ✕), so a keyboard open can type at once.
      data-autofocus={extra.first && autofocus ? true : undefined}
      value={row[field]} suffix={extra.suffix}
      aria-label={extra.ariaLabel} aria-invalid={problemOf(row, field) ? true : undefined}
      disabled={busy} onChange={(e) => setSize(row.key, field, e.target.value)}
    />
  )

  const sizeRows = draft.sizes && (
    <div className={styles.sizes} role="group" aria-label={CASE_DIALOG_COPY.sizes}>
      <div className={styles.sizeHead} aria-hidden>
        <span className={styles.headUnits}>{CASE_DIALOG_COPY.units}</span>
        <span className={styles.headSides}>{CASE_DIALOG_COPY.size}</span>
        <span className={styles.headWeight}>{CASE_DIALOG_COPY.weight}</span>
      </div>
      {draft.sizes.map((row, i) => {
        const rowProblem = CASE_SIZE_FIELDS.map((f) => problemOf(row, f)).find(Boolean) ?? null
        return (
          <div key={row.key} className={styles.sizeRow}>
            <span className={styles.units}>{numberInput(row, 'unitsPerCase', { ariaLabel: `${CASE_DIALOG_COPY.units}, size ${i + 1}`, first: i === 0 })}</span>
            <span className={styles.sides}>
              {SIDES.map(([f, word], k) => (
                <span key={f} className={styles.side}>
                  {k > 0 && <span className={styles.times} aria-hidden>×</span>}
                  {numberInput(row, f, { suffix: 'cm', ariaLabel: `${word} (cm), size ${i + 1}`, decimal: true })}
                </span>
              ))}
            </span>
            <span className={styles.weight}>{numberInput(row, 'caseWeightKg', { suffix: 'kg', ariaLabel: `Case weight (kg), size ${i + 1}`, decimal: true })}</span>
            <span className={styles.remove}>
              <ToolbarButton label={CASE_DIALOG_COPY.remove} icon={<X size={14} />} tooltipAlign="end" onClick={() => removeSize(row.key)} disabled={busy} />
            </span>
            {rowProblem && <span className={styles.rowError} role="alert">{rowProblem}</span>}
          </div>
        )
      })}
      <span className={styles.add}>
        {atMax ? (
          <Tooltip label={CASE_DIALOG_COPY.max}>
            <Button size="sm" variant="quiet" aria-disabled>
              <Plus size={14} aria-hidden /> {CASE_DIALOG_COPY.add}
            </Button>
          </Tooltip>
        ) : (
          <Button size="sm" variant="quiet" onClick={addSize} disabled={busy}>
            <Plus size={14} aria-hidden /> {CASE_DIALOG_COPY.add}
          </Button>
        )}
      </span>
    </div>
  )

  const footer = (
    <>
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={close}>Cancel</Button>
      <Button size="sm" variant="primary" onClick={() => { void save() }} aria-disabled={held !== null || undefined}>
        {busy ? 'Saving…' : saveLabel(confirm ? confirm.cases : null, !!confirm)}
      </Button>
    </>
  )

  return (
    <Modal open onClose={close} size="md" className={dialogs.box} anchor={target.anchor} title={`Case · ${target.label}`} subtitle={target.subtitle} footer={footer}>
      <div className={styles.body} onKeyDown={onKeyDown}>
        {draft.sizes ? sizeRows : (
          <div className={styles.mixed}>
            <span className={styles.mixedText}>{CASE_DIALOG_COPY.sizes}: {CASE_DIALOG_COPY.mixed}</span>
            <Button size="sm" variant="secondary" onClick={replaceAll} disabled={busy}>{CASE_DIALOG_COPY.replace}</Button>
          </div>
        )}
        <Field label="Prep by">
          <SegmentedControl ariaLabel="Prep by" size="sm" className={dialogs.seg} value={draft.fbaPrepOwner} onChange={(v) => setOwner('fbaPrepOwner', v)} options={OWNERS} disabled={busy} />
        </Field>
        <Field label="Labels by">
          <SegmentedControl ariaLabel="Labels by" size="sm" className={dialogs.seg} value={draft.fbaLabelOwner} onChange={(v) => setOwner('fbaLabelOwner', v)} options={OWNERS} disabled={busy} />
        </Field>
        {boxWarning && <Banner tone="warning">{boxWarning}</Banner>}
        {confirm && <Banner tone="warning">{confirm.sentence}</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  )
}
