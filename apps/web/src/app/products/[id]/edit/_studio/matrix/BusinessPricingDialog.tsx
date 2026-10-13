'use client'

/**
 * The B2B price pop-up (Amazon Business step 5) — the door of a market's B2B price and Tiers cells. One small DS Modal
 * anchored on the cell, like the Case and Sells from pop-ups:
 *
 *     B2B price · GALE-M                                             ✕
 *     Amazon · IT
 *     Business price   [ % below the price | Exact price | None ]
 *                      [ 5 % ]           Price Nexus sends: €99.75
 *     Quantity discounts                 [ % off | Price per unit ]   ← the type: with an exact price only
 *     From (units)   Discount   Buyer pays
 *     [ 2 ]          [ 3 % ]    €96.76                                ✕
 *     [ 5 ]          [ 5 % ]    €94.76                                ✕
 *     + Add quantity discount
 *     ⚠ a warning (saves) · ✗ what Amazon would refuse (holds Save)
 *                                                    [Cancel] [Save]
 *
 * One Save writes the whole setting through the Matrix door (`businessPrice`, at the version the pop-up opened on); the
 * page then says it in a toast with Undo — the save's own ⌘Z step (2026-10-13), so ⌘Z and the toast are one way back. The
 * rules are `businessPricing.ts` (the server's own, from @nexus/shared).
 */
import { useState, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'

import { Banner, Field, Modal } from '@/design-system/components'
import { Button, Input, SegmentedControl, ToolbarButton, Tooltip } from '@/design-system/primitives'
import { matrixBusinessSendLine, matrixMoney } from '@/design-system/grid'
import { BUSINESS_TIERS_MAX, type BusinessPriceSetting } from '@nexus/shared/business-price'

import {
  BUSINESS_DIALOG_COPY as COPY,
  businessDraftOf, businessSaveHeld, businessSaveLabel, businessSavedSentence, businessUndoOf, nextTier, parseBusinessDraft,
  type BusinessDraft, type BusinessMode, type TierDraft,
} from './businessPricing'
import type { BusinessCell, CoordinateKey, MatrixCoordinate, MatrixWriteOutcome } from './contract'
import styles from './BusinessPricingDialog.module.css'
import dialogs from './dialogs.module.css'
import { useFocusOffClose } from './dialogFocus'

export interface BusinessTarget {
  rowId: string
  sku: string
  coordinate: MatrixCoordinate
  /** The business cell as the pop-up opened on it, and the listing's version then (a change elsewhere is a conflict). */
  business: BusinessCell
  version: number
  /** The listing's sale price, for the warning when a sale is lower than the business price. */
  salePrice: number | null
  /** The cell it opened from (the Modal anchors on it on a wide screen). */
  anchor: HTMLElement | null
}

/** What a save hands the page: the toast's sentence, and its Undo (none when Nexus could not put the old one back). */
export interface BusinessSaved { sentence: string; undo: (() => Promise<string>) | null }

/**
 * The save, answered: the door's outcome, and — the page's one way back — the ⌘Z step it was recorded as (2026-10-13): the
 * toast's Undo is that step, never a second write of the old setting at whatever version the listing has. It throws with
 * the reason when nothing was put back (a newer setting stays).
 */
export interface BusinessWrite { outcome: MatrixWriteOutcome; undo: () => Promise<void> }

export interface BusinessPricingDialogProps {
  target: BusinessTarget
  /** The Matrix door: the whole setting (`null` = no business price) at the version the pop-up opened on; null = no listing there now. */
  writeBusiness: (rowId: string, key: CoordinateKey, setting: BusinessPriceSetting | null, expectedVersion: number) => Promise<BusinessWrite | null>
  onClose: () => void
  onSaved: (saved: BusinessSaved) => void
}

const MODES = [
  { value: 'percent', label: COPY.percent },
  { value: 'exact', label: COPY.exact },
  { value: 'none', label: COPY.none },
]
const TIER_TYPES = [
  { value: 'percent', label: COPY.tierPercent },
  { value: 'fixed', label: COPY.tierFixed },
]

/** A phone: the first field is not focused on open (the keyboard would cover the pop-up). */
const isPhone = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 599px)').matches

export function BusinessPricingDialog(p: BusinessPricingDialogProps) {
  const { target } = p
  const b = target.business
  const where = target.coordinate.label
  const [draft, setDraft] = useState<BusinessDraft>(() => businessDraftOf(b))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [autofocus] = useState(() => !isPhone())
  useFocusOffClose()

  const edit = (next: (d: BusinessDraft) => BusinessDraft) => { setDraft(next); setError(null) }
  const setMode = (mode: string) => edit((d) => ({ ...d, mode: mode as BusinessMode }))
  const setTier = (key: string, field: 'minQty' | 'value', value: string) => edit((d) => ({ ...d, tiers: d.tiers.map((t) => (t.key === key ? { ...t, [field]: value } : t)) }))
  const removeTier = (key: string) => edit((d) => ({ ...d, tiers: d.tiers.filter((t) => t.key !== key) }))

  const parsed = parseBusinessDraft(draft, b, target.salePrice)
  const addTier = () => edit((d) => ({ ...d, tiers: [...d.tiers, nextTier(d, parsed.price)] }))
  /* A price per unit goes with an exact price only (the shared rule): the type is offered there, and a percent price's
     discounts are percents. */
  const setTierType = (type: string) => edit((d) => ({ ...d, tierType: type as BusinessDraft['tierType'], tiers: d.tiers.map((t) => ({ ...t, value: '' })) }))
  const held = busy ? 'Saving…' : businessSaveHeld(parsed, b)
  const money = (v: number | null) => matrixMoney(v, b.currency)
  const atMax = draft.tiers.length >= BUSINESS_TIERS_MAX
  /* What Amazon shows now, when it is not what Nexus says: said once, at the top, in the cell tooltip's words. */
  const failed = b.send && (b.send.state === 'failed' || b.send.state === 'refused') ? matrixBusinessSendLine(b.send) : null
  const differs = b.live && b.live.status !== 'MATCH'
    ? (b.live.status === 'MISSING' || b.live.amazonPrice == null ? 'Amazon shows no business price — differs from Nexus.' : `Amazon shows ${money(b.live.amazonPrice)} — differs from Nexus.`)
    : b.rule == null && b.reported ? `Amazon shows a business price of ${money(b.reported.price)} that Nexus does not keep. Save keeps it in Nexus.` : null

  const save = async () => {
    if (held !== null || parsed.setting === undefined) return
    const setting = parsed.setting
    setBusy(true); setError(null)
    try {
      const saved = await p.writeBusiness(target.rowId, target.coordinate.key, setting, target.version)
      if (!saved) { setError('This listing is no longer here. Close and open the pop-up again.'); return }
      const { outcome } = saved
      if (outcome.outcome === 'refused' || outcome.outcome === 'conflict') { setError(outcome.reason ?? 'Not saved'); return }
      if (outcome.outcome === 'applied') {
        p.onSaved({
          sentence: businessSavedSentence(target.sku, where, setting, b),
          // The ⌘Z step of this save: put back only while the listing still holds this setting.
          undo: businessUndoOf(b) ? async () => {
            await saved.undo()
            return `Put back · ${target.sku} · ${where}`
          } : null,
        })
      }
      p.onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  // Enter in a field saves (the fields are many, so a form would not submit by itself).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.target instanceof HTMLInputElement) { e.preventDefault(); void save() }
  }

  const priceLine = parsed.price != null ? `Price Nexus sends: ${money(parsed.price)}` : b.normalPrice == null ? 'This listing has no price yet.' : null
  const tierField = (t: TierDraft, field: 'minQty' | 'value', extra: { ariaLabel: string; prefix?: string; suffix?: string }) => (
    <Input
      size="sm" fieldClassName={styles.fill} inputMode={field === 'minQty' ? 'numeric' : 'decimal'} autoComplete="off"
      value={t[field]} prefix={extra.prefix} suffix={extra.suffix} aria-label={extra.ariaLabel}
      aria-invalid={parsed.fieldProblems.has(`${t.key}:${field}`) ? true : undefined}
      disabled={busy} onChange={(e) => setTier(t.key, field, e.target.value)}
    />
  )

  const tiers = draft.mode !== 'none' && (
    <div className={styles.tiers} role="group" aria-label={COPY.tiers}>
      <div className={styles.tiersHead}>
        <span className={styles.tiersTitle}>{COPY.tiers}</span>
        {draft.mode === 'exact' && (
          <SegmentedControl ariaLabel="Quantity discount type" size="sm" className={dialogs.seg} value={draft.tierType} onChange={setTierType} options={TIER_TYPES} disabled={busy} />
        )}
      </div>
      {draft.tiers.length === 0 ? <p className={styles.hint}>{COPY.noTiers}</p> : (
        <div className={styles.tierRow} aria-hidden>
          <span className={styles.headCell}>{COPY.fromQty}</span>
          <span className={styles.headCell}>{draft.tierType === 'percent' ? COPY.discount : COPY.unitPrice}</span>
          <span className={styles.headCell}>{COPY.pays}</span>
        </div>
      )}
      {draft.tiers.map((t, i) => {
        const problem = parsed.fieldProblems.get(`${t.key}:minQty`) ?? parsed.fieldProblems.get(`${t.key}:value`) ?? null
        const pays = parsed.unitPrices[i]
        return (
          <div key={t.key} className={styles.tierRow}>
            {tierField(t, 'minQty', { ariaLabel: `${COPY.fromQty}, discount ${i + 1}`, suffix: '+' })}
            {draft.tierType === 'percent'
              ? tierField(t, 'value', { ariaLabel: `${COPY.discount} (%), discount ${i + 1}`, suffix: '%' })
              : tierField(t, 'value', { ariaLabel: `${COPY.unitPrice}, discount ${i + 1}`, prefix: b.currency })}
            <span className={styles.pays}>{pays != null ? money(pays) : '—'}</span>
            <ToolbarButton label={COPY.remove} icon={<X size={14} />} tooltipAlign="end" onClick={() => removeTier(t.key)} disabled={busy} />
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
          <Button size="sm" variant="quiet" onClick={addTier} disabled={busy}><Plus size={14} aria-hidden /> {COPY.add}</Button>
        )}
      </span>
    </div>
  )

  const footer = (
    <>
      <span className={styles.status} role="status">{held === 'Saving…' || held === 'Nothing to change' ? '' : held ?? ''}</span>
      <span className="grow" />
      <Button size="sm" variant="secondary" onClick={p.onClose}>Cancel</Button>
      <Button size="sm" variant={parsed.setting === null ? 'danger' : 'primary'} onClick={() => { void save() }} aria-disabled={held !== null || undefined}>
        {busy ? 'Saving…' : businessSaveLabel(parsed)}
      </Button>
    </>
  )

  return (
    <Modal open onClose={p.onClose} size="md" className={dialogs.box} anchor={target.anchor} title={`B2B price · ${target.sku}`} subtitle={where} footer={footer}>
      <div className={styles.body} onKeyDown={onKeyDown}>
        {failed && <Banner tone="danger">{failed}</Banner>}
        {differs && <Banner tone="info">{differs}</Banner>}
        <Field label={COPY.rule}>
          <SegmentedControl ariaLabel={COPY.rule} size="sm" className={dialogs.seg} value={draft.mode} onChange={setMode} options={MODES} disabled={busy} />
        </Field>
        {draft.mode === 'percent' && (
          <div className={styles.priceRow}>
            <Field label="Percent below the price" error={parsed.fieldProblems.get('percent')}>
              <Input size="sm" fieldClassName={styles.amount} inputMode="decimal" autoComplete="off" suffix="%" data-autofocus={autofocus || undefined}
                value={draft.percent} disabled={busy} onChange={(e) => edit((d) => ({ ...d, percent: e.target.value }))} />
            </Field>
            {priceLine && <span className={styles.sends} role="status">{priceLine}</span>}
          </div>
        )}
        {draft.mode === 'exact' && (
          <div className={styles.priceRow}>
            <Field label="Business price" error={parsed.fieldProblems.get('exact')}>
              <Input size="sm" fieldClassName={styles.amount} inputMode="decimal" autoComplete="off" prefix={b.currency} data-autofocus={autofocus || undefined}
                value={draft.exact} disabled={busy} onChange={(e) => edit((d) => ({ ...d, exact: e.target.value }))} />
            </Field>
            {b.normalPrice != null && <span className={styles.sends}>The price is {money(b.normalPrice)}</span>}
          </div>
        )}
        {draft.mode === 'none' && <p className={styles.hint}>{COPY.noneLine}</p>}
        {tiers}
        {parsed.problems.map((line) => <Banner key={line} tone="danger">{line}</Banner>)}
        {/* A warning only while nothing is refused: "hidden by Amazon" restates the refusal of a price above the price. */}
        {parsed.problems.length === 0 && parsed.warnings.map((line) => <Banner key={line} tone="warning">{line}</Banner>)}
        {b.held && <Banner tone="info">{b.held}</Banner>}
        {error && <Banner tone="danger">{error}</Banner>}
      </div>
    </Modal>
  )
}
