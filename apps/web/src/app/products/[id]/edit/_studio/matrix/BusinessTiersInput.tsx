'use client'

/**
 * Amazon Business — the quantity discounts input, ONE control for the B2B price pop-up (`BusinessPricingDialog.tsx`) and
 * the Matrix bulk Edit's B2B tiers field (`bulk/BulkEditDialog.tsx`):
 *
 *     Quantity discounts                 [ % off | Price per unit ]   ← the type, when it may be chosen
 *     From (units)   Discount   Buyer pays                            ← Buyer pays: the pop-up only (one listing's price)
 *     [ 2 ]          [ 3 % ]    €96.76                                ✕
 *     [ 5 ]          [ 5 % ]    €94.76                                ✕
 *     + Add quantity discount                                         (up to 5: Amazon's limit, said on the button)
 *
 * Pure UI: the rows as typed, and every change handed back. What a row's entry says is the caller's (`fieldProblems`,
 * keyed `<tier key>:minQty` · `<tier key>:value`), from the shared rules (`@nexus/shared/business-price`).
 */
import { Plus, X } from 'lucide-react'

import { Button, Input, SegmentedControl, ToolbarButton, Tooltip } from '@/design-system/primitives'
import { matrixMoney } from '@/design-system/grid'
import { BUSINESS_TIERS_MAX, type BusinessTierType } from '@nexus/shared/business-price'

import { BUSINESS_DIALOG_COPY as COPY, type TierDraft } from './businessPricing'
import styles from './BusinessTiersInput.module.css'
import dialogs from './dialogs.module.css'

const TIER_TYPES = [
  { value: 'percent', label: COPY.tierPercent },
  { value: 'fixed', label: COPY.tierFixed },
]

export interface BusinessTiersInputProps {
  tierType: BusinessTierType
  tiers: readonly TierDraft[]
  /** The markets' currency, as a price per unit's prefix shows it (and Buyer pays, when given, is said in it). */
  currency: string
  /** May the type be chosen here? (The pop-up: with an exact business price only — a percent price takes percents.) */
  showType: boolean
  /** A row's entry that is no number, by `<tier key>:minQty` · `<tier key>:value`. */
  fieldProblems: ReadonlyMap<string, string>
  /** Buyer pays, per row, for ONE listing (the pop-up). Absent = no column (the bulk Edit shows it per row in its preview). */
  pays?: ReadonlyArray<number | null>
  disabled?: boolean
  /** The first row's quantity takes the opening focus (`data-autofocus`). */
  autoFocusFirst?: boolean
  onTypeChange: (type: BusinessTierType) => void
  onTierChange: (key: string, field: 'minQty' | 'value', value: string) => void
  onRemove: (key: string) => void
  onAdd: () => void
}

export function BusinessTiersInput(p: BusinessTiersInputProps) {
  const withPays = p.pays !== undefined
  const row = withPays ? styles.tierRow : `${styles.tierRow} ${styles.noPays}`
  const atMax = p.tiers.length >= BUSINESS_TIERS_MAX
  const field = (t: TierDraft, which: 'minQty' | 'value', extra: { ariaLabel: string; prefix?: string; suffix?: string; autoFocus?: boolean }) => (
    <Input
      size="sm" fieldClassName={styles.fill} inputMode={which === 'minQty' ? 'numeric' : 'decimal'} autoComplete="off"
      value={t[which]} prefix={extra.prefix} suffix={extra.suffix} aria-label={extra.ariaLabel}
      aria-invalid={p.fieldProblems.has(`${t.key}:${which}`) ? true : undefined}
      data-autofocus={extra.autoFocus || undefined}
      disabled={p.disabled} onChange={(e) => p.onTierChange(t.key, which, e.target.value)}
    />
  )
  return (
    <div className={styles.tiers} role="group" aria-label={COPY.tiers}>
      <div className={styles.tiersHead}>
        <span className={styles.tiersTitle}>{COPY.tiers}</span>
        {p.showType && (
          <SegmentedControl ariaLabel="Quantity discount type" size="sm" className={dialogs.seg} value={p.tierType}
            onChange={(v) => p.onTypeChange(v as BusinessTierType)} options={TIER_TYPES} disabled={p.disabled} />
        )}
      </div>
      {p.tiers.length === 0 ? <p className={styles.hint}>{COPY.noTiers}</p> : (
        <div className={row} aria-hidden>
          <span className={styles.headCell}>{COPY.fromQty}</span>
          <span className={styles.headCell}>{p.tierType === 'percent' ? COPY.discount : COPY.unitPrice}</span>
          {withPays && <span className={styles.headCell}>{COPY.pays}</span>}
        </div>
      )}
      {p.tiers.map((t, i) => {
        const problem = p.fieldProblems.get(`${t.key}:minQty`) ?? p.fieldProblems.get(`${t.key}:value`) ?? null
        const pays = p.pays?.[i]
        return (
          <div key={t.key} className={row}>
            {field(t, 'minQty', { ariaLabel: `${COPY.fromQty}, discount ${i + 1}`, suffix: '+', autoFocus: p.autoFocusFirst && i === 0 })}
            {p.tierType === 'percent'
              ? field(t, 'value', { ariaLabel: `${COPY.discount} (%), discount ${i + 1}`, suffix: '%' })
              : field(t, 'value', { ariaLabel: `${COPY.unitPrice}, discount ${i + 1}`, prefix: p.currency })}
            {withPays && <span className={styles.pays}>{pays != null ? matrixMoney(pays, p.currency) : '—'}</span>}
            <ToolbarButton label={COPY.remove} icon={<X size={14} />} tooltipAlign="end" onClick={() => p.onRemove(t.key)} disabled={p.disabled} />
            {problem && <span className={styles.rowError} role="alert">{problem}</span>}
          </div>
        )
      })}
      <span className={styles.add}>
        {atMax ? (
          <Tooltip label={COPY.max}>
            <Button size="sm" variant="quiet" aria-disabled><Plus size={14} aria-hidden /> {COPY.add}</Button>
          </Tooltip>
        ) : (
          <Button size="sm" variant="quiet" onClick={p.onAdd} disabled={p.disabled}><Plus size={14} aria-hidden /> {COPY.add}</Button>
        )}
      </span>
    </div>
  )
}
