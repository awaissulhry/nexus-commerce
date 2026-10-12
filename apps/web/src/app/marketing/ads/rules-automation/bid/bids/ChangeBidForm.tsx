'use client'

/**
 * Bid page, Bids view — the Change bid form: How · the value · an optional limit. It sits above the DS review's table
 * (`ReviewChangesModal`'s `lead`), and every key works the table out again (`useBidReview`, `adjustModel.ts`). It never
 * sends: Enter in a field does nothing, the review's counted Send does. The value takes the focus when the review opens.
 */
import { Field } from '@/design-system/components'
import { Input, SegmentedControl } from '@/design-system/primitives'
import { isAdjustHow, withHow, type AdjustDraft, type AdjustField, type AdjustForm } from './adjustModel'
import styles from './bids.module.css'

function ValueField({ field, value, locked, autoFocus, onChange }: { field: AdjustField; value: string; locked: boolean; autoFocus?: boolean; onChange: (v: string) => void }) {
  return (
    <div className={styles.adjustBox}>
      <Field label={field.label} error={field.error}>
        <Input
          size="sm" fieldClassName={styles.field} type="text" inputMode="decimal" autoComplete="off" prefix={field.prefix} suffix={field.suffix}
          placeholder={field.placeholder} value={value} readOnly={locked} onChange={(e) => onChange(e.target.value)} data-autofocus={autoFocus || undefined}
        />
      </Field>
    </div>
  )
}

export function ChangeBidForm({ form, draft, locked, onDraft }: {
  form: AdjustForm
  draft: AdjustDraft
  /** While the bids are sent: nothing here moves. */
  locked: boolean
  onDraft: (next: AdjustDraft) => void
}) {
  const set = (next: AdjustDraft) => { if (!locked && next !== draft) onDraft(next) }
  return (
    <form className={styles.adjust} aria-label="Change bid" noValidate onSubmit={(e) => e.preventDefault()}>
      <div className="nds-field-w">
        <span className="nds-field-lbl" aria-hidden="true">How</span>
        <SegmentedControl
          ariaLabel="How" size="sm" wrap value={draft.how} disabled={locked}
          onChange={(v) => { if (isAdjustHow(v)) set(withHow(draft, v)) }}
          options={form.hows}
        />
      </div>
      {(form.amount || form.limit) && (
        <div className={styles.adjustValues}>
          {form.amount && <ValueField field={form.amount} value={draft.amount} locked={locked} autoFocus onChange={(amount) => set({ ...draft, amount })} />}
          {form.limit && <ValueField field={form.limit} value={draft.limit} locked={locked} onChange={(limit) => set({ ...draft, limit })} />}
        </div>
      )}
      {form.note && <p className={styles.hint} role="status">{form.note}</p>}
    </form>
  )
}
