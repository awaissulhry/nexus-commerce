'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { decimalText, moneyText } from '../../../model'
import type { VersionRecord, VersionRow } from '../../versions/api'
import { CS_NS, type Phrase } from '../../versions/model'
import type { VersionsActions, VersionsModel } from '../../versions/screen'
import { modeOf, percentHeld, removeTypedHeld, TYPED_CATEGORIES, typedDraft, typedHeld, typedHow, typedLinesOf, typedPreview, typedProblems, type TypedCategory, type TypedDraft } from '../model'

/**
 * B-W2b-GB02 (G054; B-W2b-430 gap 1; design products.styles › Cost › Cost sheet "Commissions (W2b)") — the lines typed on the
 * version in view: an agent's commission (a percent of the target price, which it follows), a royalty, a payment fee, or a
 * figure the components do not know; "Type a line…" and Remove on a draft, each held with why. The view fetches nothing.
 */
export function TypedLines({ row, record, model, actions }: { row: VersionRow; record: VersionRecord; model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const locale = useLocale()
  const say = (phrase: Phrase | null) => (phrase ? t(phrase.key, phrase.params) : null)
  const lines = typedLinesOf(record)
  const money = (value: string | null | undefined) => (model.grains.cost && value !== undefined && value !== null ? moneyText(value, row.currency, locale) : null)
  const number = (value: string) => decimalText(value, locale)
  const held = typedHeld(model.can, model.grains, row, model.busy)
  const removeHeld = removeTypedHeld(model.can, row, model.busy)
  return (
    <div className="fw-st-stack">
      <div className="fw-st-sheetrow">
        <h3 className="fw-cs-h3">{t('typed.title')}</h3>
        <span className="fw-st-grow" />
        {row.state === 'DRAFT' && (
          <Button size="sm" variant="secondary" heldReason={say(held)} onClick={() => actions?.onDialog?.({ kind: 'typed' })}>
            <Plus size={14} aria-hidden /> {t('typed.add')}
          </Button>
        )}
      </div>
      <p className="fw-st-hint">{t('typed.intro')}</p>
      {lines.length === 0 ? (
        <p className="fw-st-hint">{t('typed.none')}</p>
      ) : (
        <SummaryTable
          label={t('typed.title')}
          stackOnPhone
          columns={[t('typed.col.what'), t('typed.col.size'), t('typed.col.how'), ...(model.grains.cost ? [t('typed.col.cost')] : []), ...(row.state === 'DRAFT' ? [t('typed.col.actions')] : [])]}
          align={[undefined, undefined, undefined, ...(model.grains.cost ? (['right'] as const) : []), ...(row.state === 'DRAFT' ? (['right'] as const) : [])]}
          rows={lines.map((line) => {
            const how = typedHow(line, money, number)
            return {
              id: line.id,
              cells: [
                <span key="w" className="fw-st-cellstack">
                  <b>{line.label ?? t('stepLine.unnamed')}</b>
                  <span className="nds-summary-sub">{t(`stepCat.${line.category}`)}</span>
                </span>,
                line.size === null ? t('steps.everySize') : line.size,
                t(how.key, how.params),
                ...(model.grains.cost ? [money(line.cost) ?? '·'] : []),
                ...(row.state === 'DRAFT'
                  ? [
                      <Button key="r" size="sm" variant="quiet" heldReason={say(removeHeld)} aria-label={t('typed.removeLabel', { label: line.label ?? '' })} onClick={() => actions?.onDialog?.({ kind: 'removeTyped', lineId: line.id })}>
                        {t('typed.remove')}
                      </Button>,
                    ]
                  : []),
              ],
            }
          })}
        />
      )}
    </div>
  )
}

function Problem({ problem }: { problem: Phrase | null }) {
  const t = useT(CS_NS)
  return problem ? <Banner tone="danger" title={t(problem.key, problem.params)} /> : null
}

/** "Type a line on version N": a commission in percent of the target price or an amount; any typed category as an amount. */
export function TypedLineDialog({ model, actions }: { model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const locale = useLocale()
  const row = model.inView
  const [draft, setDraft] = useState<TypedDraft>(() => typedDraft({ ...(row?.targetPrice ? {} : { mode: 'amount' as const }), ...model.draft?.typed }))
  const set = <K extends keyof TypedDraft>(key: K, value: TypedDraft[K]) => setDraft((current) => ({ ...current, [key]: value }))
  const problems = typedProblems(draft)
  const mode = modeOf(draft)
  const pctHeld = mode === 'percent' ? percentHeld(row, model.grains) : null
  const first = Object.values(problems)[0]
  const held = typedHeld(model.can, model.grains, row, model.busy)
  const reason = held ? t(held.key, held.params) : pctHeld ? t(pctHeld.key, pctHeld.params) : first ? t(first) : null
  const preview = typedPreview(draft, row?.targetPrice)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={t('typed.dialogTitle', { version: row?.sheetVersion ?? '—' })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="primary" heldReason={reason} onClick={() => actions?.onAddTyped?.(draft)}>
            {model.busy ? t('csCommon.working') : t('typed.save')}
          </Button>
        </>
      }
    >
      <div className="fw-st-form">
        <p className="fw-st-hint">{t('typed.dialogIntro')}</p>
        <div className="fw-st-form-grid">
          <Field label={t('typed.category')}>
            <Select value={draft.category} onChange={(event) => set('category', event.target.value as TypedCategory)}>
              {TYPED_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {t(`stepCat.${category}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('typed.label')} hint={t('typed.labelHint')} error={problems.label ? t(problems.label) : undefined}>
            <Input value={draft.label} maxLength={200} onChange={(event) => set('label', event.target.value)} />
          </Field>
          <Field label={t('typed.size')}>
            <Select value={draft.size} onChange={(event) => set('size', event.target.value)}>
              <option value="">{t('steps.everySize')}</option>
              {model.sizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </Field>
          {draft.category === 'COMMISSION' && (
            <Field label={t('typed.mode')}>
              <Select value={draft.mode} onChange={(event) => set('mode', event.target.value as TypedDraft['mode'])}>
                <option value="percent">{t('typed.modePercent')}</option>
                <option value="amount">{t('typed.modeAmount')}</option>
              </Select>
            </Field>
          )}
        </div>
        {mode === 'percent' ? (
          <div className="fw-st-form-grid">
            <Field label={t('typed.pct')} hint={row?.targetPrice && model.grains.price ? t('typed.pctHint', { price: moneyText(row.targetPrice, row.currency, locale) }) : undefined} error={draft.pct.trim() !== '' && problems.pct ? t(problems.pct) : undefined}>
              <Input inputMode="decimal" value={draft.pct} onChange={(event) => set('pct', event.target.value)} />
            </Field>
          </div>
        ) : (
          <div className="fw-st-form-grid">
            <Field label={t('typed.quantity')} error={problems.quantity ? t(problems.quantity) : undefined}>
              <Input inputMode="decimal" value={draft.quantity} onChange={(event) => set('quantity', event.target.value)} />
            </Field>
            <Field label={t('typed.unitCost')} hint={row ? t('typed.unitCostHint', { currency: row.currency }) : undefined} error={draft.unitCost.trim() !== '' && problems.unitCost ? t(problems.unitCost) : undefined}>
              <Input inputMode="decimal" value={draft.unitCost} onChange={(event) => set('unitCost', event.target.value)} />
            </Field>
          </div>
        )}
        {pctHeld && <Banner tone="info" title={t(pctHeld.key, pctHeld.params)} />}
        {preview !== null && model.grains.cost && row && (
          <p className="fw-st-hint">
            <Tag tone="neutral">{t('typed.preview', { amount: moneyText(preview, row.currency, locale) })}</Tag>
          </p>
        )}
        <Field label={t('typed.note')} error={problems.note ? t(problems.note) : undefined}>
          <Textarea rows={2} maxLength={1000} value={draft.note} onChange={(event) => set('note', event.target.value)} />
        </Field>
        {row?.approval?.status === 'PENDING' && <p className="fw-st-hint">{t('typed.sendsBack')}</p>}
        <Problem problem={model.problem} />
      </div>
    </Modal>
  )
}

/** "Remove the typed line …?" */
export function RemoveTypedDialog({ lineId, model, actions }: { lineId: string; model: VersionsModel; actions?: VersionsActions }) {
  const t = useT(CS_NS)
  const row = model.inView
  const record = model.record.status === 'ready' ? model.record.value : null
  const line = record?.lines.find((entry) => entry.id === lineId) ?? null
  const held = removeTypedHeld(model.can, row, model.busy)
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={t('typed.removeTitle', { label: line?.label ?? '—' })}
      footer={
        <>
          <Button onClick={close}>{t('csCommon.cancel')}</Button>
          <Button variant="danger" heldReason={held ? t(held.key, held.params) : !line ? t('verHeld.reading') : null} onClick={() => actions?.onRemoveTyped?.(lineId)}>
            {model.busy ? t('csCommon.working') : t('typed.removeConfirm')}
          </Button>
        </>
      }
    >
      <div className="fw-st-form">
        <p className="fw-st-hint">{row?.approval?.status === 'PENDING' ? t('typed.removeIntroWaiting') : t('typed.removeIntro')}</p>
        <Problem problem={model.problem} />
      </div>
    </Modal>
  )
}
