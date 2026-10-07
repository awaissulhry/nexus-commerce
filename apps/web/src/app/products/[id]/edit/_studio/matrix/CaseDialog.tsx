'use client'

/**
 * The Case pop-up (Step 3 part D, Owner 2026-10-07: "super simple") — the Case cell's door. One small DS Modal anchored
 * on the cell:
 *
 *     Case · GALE-M                                      ✕
 *     Units per case [ 12 ]     Case weight [ 14.5 kg ]
 *     Case size (L × W × H)  [ 60 cm ] × [ 40 cm ] × [ 35 cm ]
 *     Prep by    [ Amazon | Seller | Not set ]
 *     Labels by  [ Amazon | Seller | Not set ]
 *     ⚠ Amazon EU takes boxes up to 63.5 cm a side and 23 kg.      ← a warning, never a refusal
 *                                              [Cancel] [Save]
 *
 * On the parent the title is "Case · All N variants" and one Save writes every variant; a field the variants differ on
 * starts as "Mixed" and, left so, keeps each variant's own value. A change of units per case while sealed cases are in
 * stock answers 409: the pop-up says how many open, and Save becomes "Save · open N cases" (the second click confirms).
 * The rules are `casePack.ts`.
 */
import { useId, useRef, useState, type KeyboardEvent } from 'react'

import { Banner, Field, Modal } from '@/design-system/components'
import { Button, Input, SegmentedControl } from '@/design-system/primitives'

import {
  CASE_KEEP, caseBoxWarning, caseFieldProblem, caseSaveHeld, caseSavedSentence, caseStart, caseWrites, putCasePacks, saveLabel, sealedSummary, undoWrites,
  type CaseDraft, type CaseField, type CaseMember, type CaseNumberField, type CasePut, type CaseWrite, type SealedCases,
} from './casePack'
import styles from './CaseDialog.module.css'

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
const SIDES: ReadonlyArray<[CaseNumberField, string]> = [['caseLengthCm', 'Length'], ['caseWidthCm', 'Width'], ['caseHeightCm', 'Height']]

interface Confirm { writes: CaseWrite[]; cases: number; sentence: string }

export function CaseDialog(p: CaseDialogProps) {
  const { target } = p
  const put: CasePut = p.put ?? ((write, open) => putCasePacks(write, open))
  const sizeId = useId()
  /* The values as they were when the pop-up opened: the fields start from them, and Save compares against them. */
  const [start] = useState(() => caseStart(target.members))
  const [draft, setDraft] = useState<CaseDraft>(() => ({ ...start.draft }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  /* What this opening already saved (a parent's writes can land in parts): the toast and its Undo name it. */
  const applied = useRef<{ writes: CaseWrite[]; opened: number }>({ writes: [], opened: 0 })

  const set = (field: CaseField, value: string) => {
    // A field the variants differ on, emptied again, goes back to "keep each variant's own".
    setDraft((d) => ({ ...d, [field]: value === '' && start.mixed.has(field) && field !== 'fbaPrepOwner' && field !== 'fbaLabelOwner' ? CASE_KEEP : value }))
    setConfirm(null); setError(null)
  }
  const problemOf = (field: CaseField): string | null => (draft[field] === start.draft[field] ? null : caseFieldProblem(field, draft[field]))
  const held = busy ? 'Saving…' : confirm ? null : caseSaveHeld(target.members, draft, start)
  const boxWarning = caseBoxWarning(target.members, draft, start)

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

  const numberInput = (field: CaseNumberField, extra: { suffix?: string; ariaLabel?: string; id?: string; decimal?: boolean }) => {
    const keep = draft[field] === CASE_KEEP
    return (
      <Input
        id={extra.id} size="sm" inputMode={extra.decimal ? 'decimal' : 'numeric'} autoComplete="off"
        // The pop-up opens on Units per case (not the ✕), so a keyboard open can type at once.
        data-autofocus={field === 'unitsPerCase' ? true : undefined}
        value={keep ? '' : draft[field]} placeholder={keep ? 'Mixed' : undefined} suffix={extra.suffix}
        aria-label={extra.ariaLabel} aria-invalid={problemOf(field) ? true : undefined}
        disabled={busy} onChange={(e) => set(field, e.target.value)}
      />
    )
  }
  const sideProblem = SIDES.map(([f]) => problemOf(f)).find(Boolean) ?? null

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
    <Modal open onClose={close} size="sm" anchor={target.anchor} title={`Case · ${target.label}`} subtitle={target.subtitle} footer={footer}>
      <div className={styles.body} onKeyDown={onKeyDown}>
        <div className={styles.pair}>
          <Field label="Units per case" error={problemOf('unitsPerCase')}>{numberInput('unitsPerCase', {})}</Field>
          <Field label="Case weight" error={problemOf('caseWeightKg')}>{numberInput('caseWeightKg', { suffix: 'kg', decimal: true })}</Field>
        </div>
        <Field label="Case size (L × W × H)" htmlFor={sizeId} error={sideProblem}>
          <div className={styles.sides}>
            {SIDES.map(([f, word], i) => (
              <span key={f} className={styles.side}>
                {i > 0 && <span className={styles.times} aria-hidden>×</span>}
                {numberInput(f, { suffix: 'cm', ariaLabel: `${word} (cm)`, id: i === 0 ? sizeId : undefined, decimal: true })}
              </span>
            ))}
          </div>
        </Field>
        <Field label="Prep by">
          <SegmentedControl ariaLabel="Prep by" size="sm" value={draft.fbaPrepOwner} onChange={(v) => set('fbaPrepOwner', v)} options={OWNERS} disabled={busy} />
        </Field>
        <Field label="Labels by">
          <SegmentedControl ariaLabel="Labels by" size="sm" value={draft.fbaLabelOwner} onChange={(v) => set('fbaLabelOwner', v)} options={OWNERS} disabled={busy} />
        </Field>
        {boxWarning && <Banner tone="warning">{boxWarning}</Banner>}
        {confirm && <Banner tone="warning">{confirm.sentence}</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  )
}
