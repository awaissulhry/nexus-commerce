'use client'

import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { parsePrice, percent, unitPrice } from '../../../model'
import type { PriceReason, PriceStep } from '../api'
import { discountOf, netProblems, reasonLabel, startOf, type NetDraft, type Words } from '../model'
import { PriceDepthMessages, usePriceWords } from '../words'

export interface ManualModel {
  draft: NetDraft
  /** "10 · DEMO-JKT-01 BLK". */
  label: string
  /** The line's net now. */
  current: string | null
  currency: string
  /** The line's stored waterfall (what is kept: its start and discount) and whether a list prices it. */
  steps: readonly PriceStep[] | null
  fromList: boolean
  reasons: readonly PriceReason[]
  saving: boolean
  problem: Words | null
}

export interface ManualActions {
  onDraft?: (next: NetDraft) => void
  onSave?: () => void
  onClose?: () => void
}

/**
 * A manual change of a line's net (design quote.price.lines "Inline edit of Net unit; a manual change asks for a reason
 * code", SAL-175): the net now → the one typed, what is kept (the start the price came from, its discount), the reason of
 * the price adjustment list (in the person's language) and its note when the reason asks one; held with its reason
 * before the click. Save writes one step of the line's waterfall (PUT …/price).
 */
export function ManualChange({ model, actions }: { model: ManualModel; actions?: ManualActions }) {
  return (
    <PriceDepthMessages>
      <Dialog model={model} actions={actions} />
    </PriceDepthMessages>
  )
}

function Dialog({ model, actions }: { model: ManualModel; actions?: ManualActions }) {
  const { t, say } = usePriceWords()
  const locale = useLocale()
  const lang = locale === 'it' ? 'it' : 'en'
  const { draft } = model
  const problems = netProblems(draft, model.current, model.reasons)
  const held = problems.length > 0 ? say(problems[0]) : model.saving ? t('held.busy') : null
  const reason = model.reasons.find((entry) => entry.code === draft.reasonCode) ?? null
  const start = startOf(model.steps)
  const discount = discountOf(model.steps)
  const parsed = parsePrice(draft.text)
  const set = (patch: Partial<NetDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const kept = start
    ? start.kind === 'MANUAL'
      ? t('manual.keptTyped', { price: unitPrice(start.unitPrice, model.currency, locale), reason: start.reasonCode ? reasonLabel(model.reasons, start.reasonCode, lang) : '—' })
      : t(`manual.kept${start.kind}`)
    : t(model.fromList ? 'manual.keptLIST' : 'manual.keptNone')
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('manual.title', { line: model.label })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onSave?.()}>
            {model.saving ? <Spinner size={12} /> : null} {t('manual.save')}
          </Button>
        </>
      }
    >
      <div className="fw-qpd-dialog">
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('manual.now'), value: unitPrice(model.current, model.currency, locale) },
            { label: t('manual.new'), value: parsed ? unitPrice(parsed, model.currency, locale) : '—' },
            { label: t('manual.kept'), value: discount?.pct ? `${kept} · ${t('manual.keptDiscount', { pct: percent(discount.pct, locale) })}` : kept },
          ]}
        />
        <Field label={t('manual.net')} hint={t('manual.netHint')}>
          <Input inputMode="decimal" aria-label={t('manual.net')} value={draft.text} onChange={(event) => set({ text: event.target.value })} />
        </Field>
        <Field label={t('manual.reason')} hint={t('manual.reasonHint')}>
          <Select value={draft.reasonCode} onChange={(event) => set({ reasonCode: event.target.value })} aria-label={t('manual.reason')}>
            <option value="">{t('manual.reasonPick')}</option>
            {model.reasons.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {lang === 'it' ? entry.labelIt : entry.labelEn}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t(reason?.needsDetail ? 'manual.noteNeeded' : 'manual.note')}>
          <Textarea value={draft.note} onChange={(event) => set({ note: event.target.value })} rows={2} maxLength={500} aria-label={t('manual.note')} />
        </Field>
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
      </div>
    </Modal>
  )
}
