'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Recycle, Scissors, X } from 'lucide-react'
import { Banner, Field, KeyValue, Modal, SummaryTable } from '@nexus/ui/components'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Input, Pill, RadioCard, Spinner, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { ScrapRow } from '../api'
import { decideHeld, KIND_TONE, leftToReplace, moneyText, reasonWord, reductionOf, REPLACEMENT_TONE, replaceHeld, SCRAP_NAMESPACE, type Phrase, type ReplaceDraft } from '../model'
import type { ScrapActions, ScrapModel } from './ScrapView'

export function say(t: (key: string, params?: Record<string, string | number>) => string, words: Phrase | null): string | null {
  return words ? t(words.key, words.params) : null
}

const UNIT_WORDS: Readonly<Record<string, string>> = { FT2: 'ft²', M2: 'm²', DM2: 'dm²' }

/**
 * pop:sc-item — the row's detail (design "Scrap 2 pieces · WO-26-0031", a DetailModal: centred, a full-screen sheet on a
 * phone; J / K the next row; A approve, R refuse): the reason, the operation and bundle, the station (never a person),
 * the leather leaving stock per lot and hide with its area, its value (cost grain only), what replaces it, and the
 * decision on a lower order quantity — by another person than the one who asked (production.scrap.approve; a refusal
 * says why). The floor's scrap reports carry no photo yet (named gap). Replace… opens Replace scrapped quantity.
 */
export function ScrapItemDialog({ model, row, ids, actions }: { model: ScrapModel; row: ScrapRow; ids: readonly string[]; actions?: ScrapActions }) {
  const t = useT(SCRAP_NAMESPACE)
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const reduction = reductionOf(row, model.reductions)
  const held = say(t, decideHeld(reduction, model.can, model.me, model.busy))
  const [refusing, setRefusing] = useState(!!model.refusing)
  const [note, setNote] = useState('')
  useEffect(() => {
    setRefusing(!!model.refusing)
    setNote('')
  }, [row.id, model.refusing])

  // A approves, R refuses (never while typing): the design's keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) return
      if (event.key === 'a' && !held && reduction) {
        event.preventDefault()
        actions?.onApprove?.([reduction])
      }
      if (event.key === 'r' && !held && reduction) {
        event.preventDefault()
        setRefusing(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const replaceWhy = row.kind !== 'SCRAP' ? t('replace.held.rework') : !model.can.ask ? t('held.permission', { permission: 'production.scrap' }) : leftToReplace(row) === 0 ? t('replace.held.covered') : null
  return (
    <DetailModal
      open
      onClose={() => actions?.onAddress?.({ open: null })}
      title={t(`item.title.${row.kind}`, { count: row.pieces, number: row.workOrder.number })}
      subtitle={formatDateTime(row.at, place)}
      meta={
        <span className="fw-sc-inline">
          <Pill tone={KIND_TONE[row.kind]}>{t(`kind.${row.kind}`)}</Pill>
          {row.kind === 'REWORK' && row.status && <Tag tone="neutral">{t(`rework.${row.status}`)}</Tag>}
        </span>
      }
      nav={ids.length > 1 ? { ids, current: row.id, onGo: (id) => actions?.onAddress?.({ open: id }), noun: t('item.noun') } : undefined}
      footer={
        <>
          <span className="grow" />
          <Button size="sm" heldReason={replaceWhy} onClick={() => actions?.onReplace?.(row.id)}>
            <Scissors size={13} aria-hidden /> {t('replace.open')}
          </Button>
          {reduction && !refusing && (
            <>
              <Button size="sm" variant="danger-outline" heldReason={held} onClick={() => setRefusing(true)} aria-keyshortcuts="r">
                <X size={13} aria-hidden /> {t('item.refuse')}
              </Button>
              <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onApprove?.([reduction])} aria-keyshortcuts="a">
                {model.busy ? <Spinner size={12} /> : <Check size={13} aria-hidden />} {t('item.approve')}
              </Button>
            </>
          )}
          {reduction && refusing && (
            <>
              <Button size="sm" onClick={() => setRefusing(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" variant="danger" heldReason={held ?? (note.trim().length < 3 ? t('held.reason') : null)} onClick={() => actions?.onRefuse?.(reduction, note.trim())}>
                {model.busy ? <Spinner size={12} /> : <X size={13} aria-hidden />} {t('item.refuseGo')}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="fw-sc-dialog">
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        <KeyValue
          columns={2}
          items={[
            { label: t('item.reason'), value: reasonWord(row, locale), hint: row.reasonCode },
            { label: t('item.operation'), value: row.operation ? `${row.operation.seq} · ${row.operation.name}` : '—', hint: row.operation?.code },
            { label: t('item.bundle'), value: row.bundle?.code ?? '—', hint: `${row.cell.colourwayCode} ${row.cell.size}${row.part ? ` · ${row.part}` : ''}` },
            { label: t('item.station'), value: row.station?.code ?? t('item.noStation') },
            {
              label: t('item.workOrder'),
              value: model.can.workOrders ? (
                <Link className="fw-sc-link" href={`${model.prefix}/production/work-orders/${row.workOrder.id}`}>
                  {row.workOrder.number}
                </Link>
              ) : (
                row.workOrder.number
              ),
              hint: row.workOrder.style?.code,
            },
            ...(model.can.cost ? [{ label: t('item.value'), value: moneyText(row.value, row.currency, locale), hint: t('item.valueHint') }] : []),
          ]}
        />
        <section className="fw-sc-card" aria-label={t('item.leather')}>
          <h3 className="fw-sc-h3">{t('item.leather')}</h3>
          {row.materials.length === 0 ? (
            <p className="fw-sc-hint">{row.kind === 'REWORK' ? t('item.leatherRework') : t('item.leatherNone')}</p>
          ) : (
            <SummaryTable
              label={t('item.leather')}
              columns={[t('item.col.lot'), t('item.col.hide'), t('item.col.area'), ...(model.can.cost ? [t('item.col.value')] : [])]}
              align={[undefined, undefined, 'right', ...(model.can.cost ? (['right'] as const) : [])]}
              rows={row.materials.map((material) => ({
                id: `${material.lotId}|${material.hideId}`,
                cells: [material.lotCode, material.hideCode, `${new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(Number(material.area))} ${UNIT_WORDS[material.uom] ?? material.uom}`, ...(model.can.cost ? [moneyText(material.value, row.currency, locale)] : [])],
              }))}
            />
          )}
          <p className="fw-sc-hint">{t('item.leatherHint')}</p>
        </section>
        <section className="fw-sc-card" aria-label={t('item.replacements')}>
          <h3 className="fw-sc-h3">{t('item.replacements')}</h3>
          {row.replacements.length === 0 ? (
            <p className="fw-sc-hint">{t('item.noReplacement')}</p>
          ) : (
            <ul className="fw-sc-list">
              {row.replacements.map((replacement) => (
                <li key={replacement.id}>
                  <Tag tone={REPLACEMENT_TONE[replacement.status] ?? 'neutral'}>{t('replacement.chip', { kind: t(`replacement.kind.${replacement.kind}`), quantity: replacement.quantity, status: t(`replacement.status.${replacement.status}`) })}</Tag>
                  {replacement.kind === 'REDUCE' && replacement.status === 'OPEN' && reduction?.id === replacement.id && (
                    <span className="fw-sc-hint">{reduction.createdBy ? t('item.askedBy', { name: reduction.createdBy.name, reason: reduction.reason }) : reduction.reason}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        {refusing && reduction && (
          <Field label={t('item.refuseNote')} hint={t('item.refuseHint')}>
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} />
          </Field>
        )}
        <p className="fw-sc-hint">{t('item.noPhoto')}</p>
      </div>
    </DetailModal>
  )
}

export interface ReplaceDraftModel {
  readonly rowId: string
  readonly draft: ReplaceDraft
}

/**
 * pop:sc-replace — Replace scrapped quantity (design production.scrap, from a row; Esc closes): a recut (the cutting
 * room's recut list: a recut need on the cut, cut again as single parts) or a lower order quantity (needs another
 * person's approval, then the order line's short-close); how many garments of the row still need one; the reason.
 * Held with why: no right, a rework row (its garments come back), the work order no longer open, nothing left to replace.
 */
export function ReplaceDialog({ model, actions }: { model: ScrapModel; actions?: ScrapActions }) {
  const t = useT(SCRAP_NAMESPACE)
  const replace = model.replace!
  const row = (model.rows.items ?? []).find((entry) => entry.id === replace.rowId) ?? null
  const draft = replace.draft
  const held = say(t, replaceHeld(row, draft, model.can, model.busy))
  const left = row ? leftToReplace(row) : 0
  const set = (next: Partial<ReplaceDraft>) => actions?.onReplaceDraft?.({ ...draft, ...next })
  return (
    <Modal
      open
      onClose={() => actions?.onReplace?.(null)}
      title={t('replace.title')}
      subtitle={row ? t(`item.title.${row.kind}`, { count: row.pieces, number: row.workOrder.number }) : undefined}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onReplace?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onAsk?.()}>
            {model.busy ? <Spinner size={12} /> : draft.kind === 'RECUT' ? <Scissors size={13} aria-hidden /> : <Recycle size={13} aria-hidden />} {t(`replace.go.${draft.kind}`)}
          </Button>
        </>
      }
    >
      <div className="fw-sc-dialog">
        {model.problem && <Banner tone="danger" title={say(t, model.problem)} />}
        {row && <p>{t('replace.body', { left, pieces: row.pieces, cell: `${row.cell.colourwayCode} ${row.cell.size}` })}</p>}
        <fieldset className="fw-sc-choices">
          <legend className="fw-sc-h3">{t('replace.how')}</legend>
          {(['RECUT', 'REDUCE'] as const).map((kind) => (
            <RadioCard
              key={kind}
              variant="row"
              name="fw-sc-replace-kind"
              value={kind}
              checked={draft.kind === kind}
              selected={draft.kind === kind}
              onChange={() => set({ kind })}
              title={t(`replace.kind.${kind}`)}
              description={kind === 'RECUT' ? t('replace.kind.RECUTHint', { part: row?.part ?? t('list.whole') }) : t('replace.kind.REDUCEHint')}
            />
          ))}
        </fieldset>
        <Field label={t('replace.quantity')} hint={t('replace.quantityHint', { max: left })}>
          <Input size="sm" type="number" inputMode="numeric" min={1} max={Math.max(1, left)} value={draft.quantity} onChange={(event) => set({ quantity: event.target.value })} />
        </Field>
        <Field label={t('replace.reason')}>
          <Textarea value={draft.reason} onChange={(event) => set({ reason: event.target.value })} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
