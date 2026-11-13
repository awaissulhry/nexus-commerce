'use client'

import { PRODUCT_TYPES } from '@nexus/factory-domain/product/styles/rules'
import { MINIMUM_ACTIONS, MINIMUM_PER } from '@nexus/factory-domain/sales/pricing-depth/rules'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale } from '../../../../../lib/i18n/provider'
import { percent, unitPrice } from '../../../quotes/model'
import type { PriceEntry, PriceListDetail } from '../../api'
import { breakHeld, daysHeld, emptyBreak, emptyMinimum, emptySurcharge, minimumHeld, sortedBreaks, surchargeHeld, type BreakDraft, type MinimumDraft, type SurchargeDraft } from '../../depth/model'
import { parseListPrice, sortedEntries } from '../../model'
import { useDay, useDepthWords, useSayAny, useWords } from '../../parts'
import type { PriceListRecordActions, PriceListRecordModel, RecordDialog } from '../record-model'

/**
 * The record's W2b dialogs (B-W2b-343): a price's days (Valid from–to, through the dated prices: a new first day takes the
 * price's own breaks with the old row, said before the click), Add a break, Remove N breaks, Add a surcharge (every
 * style or one, sizes typed, an amount or a percent), New minimum (a style, a kind of garment or a material; per order,
 * colourway or line; warn, block or a small-run surcharge). Each is held with its reason before the click. They fetch
 * nothing.
 */
export function DepthDialog({ list, model, actions, dialog }: { list: PriceListDetail; model: PriceListRecordModel; actions?: PriceListRecordActions; dialog: RecordDialog }) {
  const close = () => actions?.onDialog?.(null)
  switch (dialog.kind) {
    case 'days':
      return <DaysDialog list={list} model={model} dialog={dialog} actions={actions} onClose={close} />
    case 'addBreak':
      return <AddBreakDialog list={list} model={model} draft={dialog.draft ?? emptyBreak()} actions={actions} onClose={close} />
    case 'removeBreaks':
      return <RemoveBreaksDialog list={list} model={model} actions={actions} onClose={close} />
    case 'addSurcharge':
      return <AddSurchargeDialog list={list} model={model} draft={dialog.draft ?? emptySurcharge()} actions={actions} onClose={close} />
    case 'addMinimum':
      return <AddMinimumDialog list={list} model={model} draft={dialog.draft ?? emptyMinimum()} actions={actions} onClose={close} />
    default:
      return null
  }
}

interface Props {
  list: PriceListDetail
  model: PriceListRecordModel
  actions?: PriceListRecordActions
  onClose: () => void
}

function Problem({ model }: { model: PriceListRecordModel }) {
  const sayAny = useSayAny()
  return model.dialogProblem ? <Banner tone="danger" title={sayAny(model.dialogProblem) ?? ''} /> : null
}

const entryLabel = (entry: PriceEntry, every: string) => `${entry.style.code} · ${entry.colourway ? entry.colourway.code : every}`

function DaysDialog({ list, model, dialog, actions, onClose }: Props & { dialog: Extract<RecordDialog, { kind: 'days' }> }) {
  const t = useDepthWords()
  const w = useWords()
  const locale = useLocale()
  const day = useDay()
  const entries = model.prices.answer?.entries ?? []
  const entry = entries.find((row) => row.id === dialog.entryId) ?? null
  if (!entry) return null
  const set = (patch: Partial<{ validFrom: string; validTo: string; price: string }>) => actions?.onDialog?.({ ...dialog, ...patch })
  const held = daysHeld(entries, { styleId: entry.styleId, colourwayId: entry.colourwayId, validFrom: dialog.validFrom, validTo: dialog.validTo, exceptId: entry.id })
  const price = parseListPrice(dialog.price)
  const newStart = (dialog.validFrom || null) !== entry.validFrom
  const ownBreaks = model.breaks?.rules.status === 'ready' ? model.breaks.rules.value.breaks.filter((row) => row.entryId === entry.id).length : 0
  const heldWords = held ? t(held.key, Object.fromEntries(Object.entries(held.params ?? {}).map(([name, value]) => [name, value === '—' ? '—' : day(String(value))]))) : price === null ? t('days.held.price') : model.busy ? w('held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('days.title', { price: entryLabel(entry, t('breaks.everyColour')) })}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{w('common.back')}</Button>
          <Button variant="primary" heldReason={heldWords} onClick={() => actions?.onDays?.(entry, { validFrom: dialog.validFrom, validTo: dialog.validTo, price: dialog.price })}>
            {model.busy ? <Spinner size={12} /> : null} {t('days.save')}
          </Button>
        </>
      }
    >
      <div className="fw-pd-dialog">
        <p className="fw-pl-hint">{t('days.body')}</p>
        <div className="fw-pd-fields">
          <Field label={t('days.from')} hint={t('days.fromHint')}>
            <DateField value={dialog.validFrom} onChange={(value) => set({ validFrom: value })} locale={INTL_LOCALE[locale]} clearable />
          </Field>
          <Field label={t('days.to')} hint={t('days.toHint')}>
            <DateField value={dialog.validTo} onChange={(value) => set({ validTo: value })} locale={INTL_LOCALE[locale]} min={dialog.validFrom || undefined} clearable />
          </Field>
          <Field label={t('days.price', { currency: list.currency })}>
            <Input inputMode="decimal" value={dialog.price} onChange={(event) => set({ price: event.target.value })} aria-label={t('days.price', { currency: list.currency })} />
          </Field>
        </div>
        {newStart && entry.validFrom !== null && <p className="fw-pl-hint">{t(ownBreaks > 0 ? 'days.newStartBreaks' : 'days.newStart', { count: ownBreaks })}</p>}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function AddBreakDialog({ list, model, draft, actions, onClose }: Props & { draft: BreakDraft }) {
  const t = useDepthWords()
  const w = useWords()
  const locale = useLocale()
  const entries = sortedEntries(model.prices.answer?.entries ?? [])
  const rules = model.breaks?.rules.status === 'ready' ? model.breaks.rules.value : { breaks: [] }
  const set = (patch: Partial<BreakDraft>) => actions?.onDialog?.({ kind: 'addBreak', draft: { ...draft, ...patch, ...(patch.entryId === '' ? { kind: 'PCT' as const } : {}) } })
  const held = breakHeld(draft, rules, entries)
  const heldWords = held ? t(held.key, held.key === 'breaks.held.lower' ? { price: unitPrice(String(held.params?.price ?? ''), list.currency, locale) } : held.params) : model.busy ? w('held.busy') : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('breaks.addTitle')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{w('common.back')}</Button>
          <Button variant="primary" heldReason={heldWords} onClick={() => actions?.breaks?.onAddBreak?.(draft)}>
            {model.busy ? <Spinner size={12} /> : null} {t('breaks.addGo')}
          </Button>
        </>
      }
    >
      <div className="fw-pd-dialog">
        <p className="fw-pl-hint">{t('breaks.addBody')}</p>
        <Field label={t('breaks.col.price')}>
          <Select value={draft.entryId} onChange={(event) => set({ entryId: event.target.value })} aria-label={t('breaks.col.price')}>
            <option value="">{t('breaks.everyPrice')}</option>
            {entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entryLabel(entry, t('breaks.everyColour'))}
                {entry.unitPrice !== undefined ? ` — ${unitPrice(entry.unitPrice, list.currency, locale)}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="fw-pd-fields">
          <Field label={t('breaks.col.from')} hint={t('breaks.fromHint')}>
            <Input inputMode="numeric" value={draft.minQuantity} onChange={(event) => set({ minQuantity: event.target.value })} aria-label={t('breaks.col.from')} />
          </Field>
          <Field label={t(draft.kind === 'PRICE' ? 'breaks.col.unitPrice' : 'breaks.col.discount')}>
            <Input inputMode="decimal" value={draft.value} onChange={(event) => set({ value: event.target.value })} aria-label={t(draft.kind === 'PRICE' ? 'breaks.col.unitPrice' : 'breaks.col.discount')} />
          </Field>
        </div>
        {draft.entryId !== '' && (
          <div className="fw-pd-fields" role="radiogroup" aria-label={t('breaks.gives')}>
            <RadioCard name="break-kind" value="PCT" checked={draft.kind === 'PCT'} selected={draft.kind === 'PCT'} onChange={() => set({ kind: 'PCT' })} title={t('breaks.givesPct')} />
            <RadioCard name="break-kind" value="PRICE" checked={draft.kind === 'PRICE'} selected={draft.kind === 'PRICE'} onChange={() => set({ kind: 'PRICE' })} title={t('breaks.givesPrice')} />
          </div>
        )}
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function RemoveBreaksDialog({ list, model, actions, onClose }: Props) {
  const t = useDepthWords()
  const w = useWords()
  const locale = useLocale()
  const rules = model.breaks?.rules.status === 'ready' ? model.breaks.rules.value : null
  const picked = rules ? sortedBreaks(rules.breaks).filter((row) => model.breaks?.selectedBreaks.includes(row.id)) : []
  return (
    <Modal
      open
      onClose={onClose}
      title={t('breaks.removeTitle', { count: picked.length })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{w('common.back')}</Button>
          <Button variant="danger" heldReason={picked.length === 0 ? t('breaks.held.none') : model.busy ? w('held.busy') : null} onClick={() => actions?.breaks?.onRemoveBreaks?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('breaks.remove', { count: picked.length })}
          </Button>
        </>
      }
    >
      <div className="fw-pd-dialog">
        <ul className="fw-pd-list">
          {picked.map((row) => (
            <li key={row.id}>
              {row.entry ? `${row.entry.style.code} · ${row.entry.colourway?.code ?? t('breaks.everyColour')}` : t('breaks.everyPrice')} — {t('breaks.pieces', { count: row.minQuantity })} → {row.unitPrice ? unitPrice(row.unitPrice, list.currency, locale) : row.discountPct ? `−${percent(row.discountPct, locale)}` : '—'}
            </li>
          ))}
        </ul>
        <p className="fw-pl-hint">{t('breaks.removeBody')}</p>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function AddSurchargeDialog({ list, model, draft, actions, onClose }: Props & { draft: SurchargeDraft }) {
  const t = useDepthWords()
  const w = useWords()
  const styles = [...new Map((model.prices.answer?.entries ?? []).map((entry) => [entry.styleId, entry.style])).entries()].sort((a, b) => a[1].code.localeCompare(b[1].code))
  const set = (patch: Partial<SurchargeDraft>) => actions?.onDialog?.({ kind: 'addSurcharge', draft: { ...draft, ...patch } })
  const held = surchargeHeld(draft)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('surcharges.addTitle')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{w('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held.key) : model.busy ? w('held.busy') : null} onClick={() => actions?.breaks?.onAddSurcharge?.(draft)}>
            {model.busy ? <Spinner size={12} /> : null} {t('surcharges.addGo')}
          </Button>
        </>
      }
    >
      <div className="fw-pd-dialog">
        <p className="fw-pl-hint">{t('surcharges.addBody')}</p>
        <Field label={t('surcharges.col.who')}>
          <Select value={draft.styleId} onChange={(event) => set({ styleId: event.target.value })} aria-label={t('surcharges.col.who')}>
            <option value="">{t('surcharges.everyStyle')}</option>
            {styles.map(([id, style]) => (
              <option key={id} value={id}>
                {style.code} · {style.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="fw-pd-fields">
          <Field label={t('surcharges.sizes')} hint={t('surcharges.sizesHint')}>
            <Input value={draft.sizes} onChange={(event) => set({ sizes: event.target.value })} aria-label={t('surcharges.sizes')} />
          </Field>
          <Field label={t(draft.kind === 'amount' ? 'surcharges.kindAmount' : 'surcharges.kindPct', { currency: list.currency })}>
            <Input inputMode="decimal" value={draft.value} onChange={(event) => set({ value: event.target.value })} aria-label={t(draft.kind === 'amount' ? 'surcharges.kindAmount' : 'surcharges.kindPct', { currency: list.currency })} />
          </Field>
        </div>
        <div className="fw-pd-fields" role="radiogroup" aria-label={t('surcharges.gives')}>
          <RadioCard name="surcharge-kind" value="amount" checked={draft.kind === 'amount'} selected={draft.kind === 'amount'} onChange={() => set({ kind: 'amount' })} title={t('surcharges.givesAmount', { currency: list.currency })} />
          <RadioCard name="surcharge-kind" value="pct" checked={draft.kind === 'pct'} selected={draft.kind === 'pct'} onChange={() => set({ kind: 'pct' })} title={t('surcharges.givesPct')} />
        </div>
        <Problem model={model} />
      </div>
    </Modal>
  )
}

function AddMinimumDialog({ list, model, draft, actions, onClose }: Props & { draft: MinimumDraft }) {
  const t = useDepthWords()
  const w = useWords()
  const styles = [...new Map((model.prices.answer?.entries ?? []).map((entry) => [entry.styleId, entry.style])).entries()].sort((a, b) => a[1].code.localeCompare(b[1].code))
  const minimums = model.breaks?.minimums.status === 'ready' ? model.breaks.minimums.value : []
  const materials = model.breaks?.materials ?? { query: '', results: null }
  const set = (patch: Partial<MinimumDraft>) => actions?.onDialog?.({ kind: 'addMinimum', draft: { ...draft, ...patch } })
  const held = minimumHeld(draft, minimums)
  return (
    <Modal
      open
      onClose={onClose}
      title={t('minimums.addTitle')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{w('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held.key) : model.busy ? w('held.busy') : null} onClick={() => actions?.breaks?.onAddMinimum?.(draft)}>
            {model.busy ? <Spinner size={12} /> : null} {t('minimums.addGo')}
          </Button>
        </>
      }
    >
      <div className="fw-pd-dialog">
        <p className="fw-pl-hint">{t('minimums.addBody', { code: list.code })}</p>
        <Field label={t('minimums.col.subject')}>
          <Select value={draft.subject} onChange={(event) => set({ subject: event.target.value as MinimumDraft['subject'] })} aria-label={t('minimums.col.subject')}>
            {(['STYLE', 'PRODUCT_TYPE', 'MATERIAL'] as const).map((subject) => (
              <option key={subject} value={subject}>
                {t(`minimums.subject.${subject}`)}
              </option>
            ))}
          </Select>
        </Field>
        {draft.subject === 'STYLE' && (
          <Field label={t('minimums.subject.STYLE')}>
            <Select value={draft.styleId} onChange={(event) => set({ styleId: event.target.value })} aria-label={t('minimums.subject.STYLE')}>
              <option value="">{t('minimums.pick')}</option>
              {styles.map(([id, style]) => (
                <option key={id} value={id}>
                  {style.code} · {style.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {draft.subject === 'PRODUCT_TYPE' && (
          <Field label={t('minimums.subject.PRODUCT_TYPE')}>
            <Select value={draft.productType} onChange={(event) => set({ productType: event.target.value })} aria-label={t('minimums.subject.PRODUCT_TYPE')}>
              <option value="">{t('minimums.pick')}</option>
              {PRODUCT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`minimums.type.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {draft.subject === 'MATERIAL' && (
          <div className="fw-pd-fields">
            <Field label={t('minimums.materialSearch')}>
              <Input type="search" value={materials.query} onChange={(event) => actions?.breaks?.onMaterialQuery?.(event.target.value)} aria-label={t('minimums.materialSearch')} />
            </Field>
            <Field label={t('minimums.subject.MATERIAL')}>
              <Select value={draft.itemId} onChange={(event) => set({ itemId: event.target.value })} aria-label={t('minimums.subject.MATERIAL')}>
                <option value="">{materials.results === null ? w('common.loading') : t('minimums.pick')}</option>
                {(materials.results ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.code} · {item.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="fw-pd-fields">
          <Field label={t('minimums.quantity')}>
            <Input inputMode="numeric" value={draft.minQuantity} onChange={(event) => set({ minQuantity: event.target.value })} aria-label={t('minimums.quantity')} />
          </Field>
          <Field label={t('minimums.countedPer')}>
            <Select value={draft.per} onChange={(event) => set({ per: event.target.value as MinimumDraft['per'] })} aria-label={t('minimums.countedPer')}>
              {MINIMUM_PER.map((per) => (
                <option key={per} value={per}>
                  {t(`minimums.perName.${per}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('minimums.col.action')}>
            <Select value={draft.action} onChange={(event) => set({ action: event.target.value as MinimumDraft['action'] })} aria-label={t('minimums.col.action')}>
              {MINIMUM_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {t(`minimums.action.${action}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="fw-pl-hint">{t(`minimums.actionHint.${draft.action}`)}</p>
        {draft.action === 'SURCHARGE' && (
          <div className="fw-pd-fields">
            <Field label={t('minimums.surchargeKind')}>
              <Select value={draft.surchargeKind} onChange={(event) => set({ surchargeKind: event.target.value as MinimumDraft['surchargeKind'] })} aria-label={t('minimums.surchargeKind')}>
                <option value="amount">{t('surcharges.givesAmount', { currency: list.currency })}</option>
                <option value="pct">{t('surcharges.givesPct')}</option>
              </Select>
            </Field>
            <Field label={t(draft.surchargeKind === 'amount' ? 'surcharges.kindAmount' : 'surcharges.kindPct', { currency: list.currency })}>
              <Input inputMode="decimal" value={draft.surcharge} onChange={(event) => set({ surcharge: event.target.value })} aria-label={t(draft.surchargeKind === 'amount' ? 'surcharges.kindAmount' : 'surcharges.kindPct', { currency: list.currency })} />
            </Field>
          </div>
        )}
        <Field label={t('minimums.col.note')}>
          <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} rows={2} maxLength={500} aria-label={t('minimums.col.note')} />
        </Field>
        {!model.can.price && <KeyValue dense labelCase="sentence" items={[{ label: t('minimums.col.action'), value: t('held.noPrice') }]} />}
        <Problem model={model} />
      </div>
    </Modal>
  )
}
