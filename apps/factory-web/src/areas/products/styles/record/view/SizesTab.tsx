'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Ruler } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Pill, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { PartFailed, PartReading, Quiet, Section } from '../../../../../lib/record-sections/Kit'
import type { StyleView } from '../../api'
import { RangeFields, type RangeValue } from '../../forms'
import { mayEditFacts, rangeEffect } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../record-model'
import { howToOf, ridersOf, sizesAnswerOf } from '../product-model'
import { useProductWords } from '../product-words'
import { PrepacksSection } from '../prepacks/view/PrepacksSection'
import { ProtectorsSection } from '../protectors/view/ProtectorsSection'
import { SpecSection } from '../spec/view/SpecSection'

/**
 * SCR-041 Sizes & measurements — owb-pd4 step 4.4 (design § 5r, prototype prod.js prodSizesTab): the tab in the section kit, top to
 * bottom — the answer line · Sizes (made to measure, the range and its base size; a change says first what it does to the SKUs) · Size
 * table (points × sizes in mm, graded from the base: today's Measurement spec — "fill from the base by an increment", a typed value
 * kept, a value of 0 or less refused) · Riders' measurement sheets (a made-to-measure product: one row per open order line, the file,
 * typed, or "Not here yet", linked to the order's Files) · How to measure (one sentence per point, the words the customer reads) ·
 * Protectors (the zones and their level) · Prepacks (kept). A released revision is frozen: no field to type in (each part's own rule);
 * sales reads it all and presses nothing.
 */
export function SizesTab({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const { t } = useProductWords()
  const answer = sizesAnswerOf(style)
  const riders = model.orders?.status === 'ready' ? ridersOf(model.orders.value.lines) : []
  const showRiders = model.orders !== undefined && (style.mtmAllowed || riders.length > 0)
  return (
    <div className="fw-pt fw-pd-sz">
      <p className="fw-pd-answer">
        <Ruler size={16} aria-hidden />
        <span>{t(answer.key, answer.params)}</span>
      </p>
      <SizesSection style={style} model={model} actions={actions} />
      {model.can.bomView ? (
        <SpecSection style={style} model={model} spec={model.spec} actions={actions?.spec} recordActions={actions} />
      ) : (
        <Section id="pd-table" title={t('sizes.table.title')} answer={t('sizes.table.held')} info={<p>{t('sizes.table.info')}</p>}>
          <Quiet>{t('sizes.table.heldWhy')}</Quiet>
        </Section>
      )}
      {showRiders ? <RidersSection model={model} actions={actions} /> : null}
      {model.can.bomView ? <HowToSection model={model} /> : null}
      {model.can.bomView ? <ProtectorsSection style={style} model={model} actions={actions?.protectors} recordActions={actions} /> : null}
      <PrepacksSection model={model} actions={actions?.prepacks} />
    </div>
  )
}

/** Sizes: made to measure or in sizes, the range and its base size. product.styles.manage, or the designer while the newest revision is a draft. */
function SizesSection({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const { t } = useProductWords()
  const tp = useT('products')
  const may = mayEditFacts(style, model.can)
  const base = useMemo<RangeValue>(() => ({ sizeScaleId: style.sizeScale.id, sizes: [...style.sizes], baseSize: style.baseSize }), [style])
  const [draft, setDraft] = useState<RangeValue>(model.rangeDraft ?? base)
  const [saving, setSaving] = useState(false)
  // A new read starts the editor again unless it holds unsaved changes (after Apply they equal the new read).
  const lastBase = useRef(base)
  useEffect(() => {
    setDraft((current) => (JSON.stringify(current) === JSON.stringify(lastBase.current) ? base : current))
    lastBase.current = base
  }, [base])
  const dirty = draft.sizeScaleId !== base.sizeScaleId || draft.baseSize !== base.baseSize || draft.sizes.join(',') !== base.sizes.join(',')
  const effect = rangeEffect(style, draft.sizes)
  const held = draft.sizes.length === 0 ? tp('range.held.empty') : draft.baseSize === null ? tp('range.held.base') : saving ? tp('held.busy') : null
  const save = async () => {
    if (held || !dirty) return
    setSaving(true)
    await actions?.onSaveRange?.(draft)
    setSaving(false)
  }
  return (
    <Section id="pd-sizes-range" title={t('sizes.title')} answer={may ? tp('range.intro') : t('sizes.readOnly')} info={<p>{t('sizes.info')}</p>}>
      <div className="fw-pd-mtm">
        <span className="fw-pt-label">{t('sizes.mtm.label')}</span>
        {may ? (
          <span className="fw-st-inline">
            <Toggle checked={style.mtmAllowed} onChange={(next) => void actions?.onSaveIdentity?.({ mtmAllowed: next })} aria-label={t('sizes.mtm.label')} disabled={model.busy} />
            {t(style.mtmAllowed ? 'sizes.mtm.on' : 'sizes.mtm.off')}
          </span>
        ) : (
          <span>{t(style.mtmAllowed ? 'sizes.mtm.on' : 'sizes.mtm.off')}</span>
        )}
      </div>
      <RangeFields value={draft} scales={model.libraries.scales} onChange={setDraft} scaleLocked={style.matrix.generated ? 'range.scaleLocked' : null} readOnly={!may} />
      {dirty && may && (
        <>
          {(effect.added.length > 0 || effect.removed.length > 0) && (
            <Banner tone={effect.skusOff > 0 ? 'warning' : 'info'} title={tp('range.effectTitle')}>
              <ul className="fw-st-list">
                {effect.added.length > 0 && <li>{tp(style.matrix.generated ? 'range.effectAdd' : 'range.effectAddPlain', { sizes: effect.added.join(', '), count: effect.skusOn })}</li>}
                {effect.removed.length > 0 && <li>{tp(style.matrix.generated ? 'range.effectRemove' : 'range.effectRemovePlain', { sizes: effect.removed.join(', '), count: effect.skusOff })}</li>}
              </ul>
            </Banner>
          )}
          <EditModeBar message={tp('range.unsaved')} count={1} onDiscard={() => setDraft(base)} onApply={() => void save()} applyLabel={tp('range.apply')} applyHeldReason={held} busy={saving} saveShortcut />
        </>
      )}
    </Section>
  )
}

/** Riders' measurement sheets: one row per open made-to-measure order line — the file, typed, or not here yet — linked to the order's Files. */
function RidersSection({ model, actions }: { model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const { t } = useProductWords()
  const part = model.orders
  const rows = part?.status === 'ready' ? ridersOf(part.value.lines) : []
  const waiting = rows.filter((row) => row.state === 'MISSING').length
  return (
    <Section
      id="pd-riders"
      title={t('sizes.riders.title')}
      answer={part?.status === 'ready' ? (rows.length === 0 ? t('sizes.riders.none') : waiting > 0 ? t('sizes.riders.waiting', { count: waiting }) : t('sizes.riders.allHere')) : undefined}
      info={<p>{t('sizes.riders.info')}</p>}
    >
      {!part || part.status === 'idle' || part.status === 'loading' ? (
        <PartReading rows={2} />
      ) : part.status === 'error' ? (
        <PartFailed part={t('sizes.riders.title')} problem={part.problem} onRetry={actions?.onRetryOrders} />
      ) : rows.length > 0 ? (
        <table className="fw-pt-table">
          <thead>
            <tr>
              <th>{t('sizes.riders.col.order')}</th>
              <th>{t('sizes.riders.col.customer')}</th>
              <th>{t('sizes.riders.col.sheet')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.lineId}>
                <td className="fw-pt-first">
                  {model.ordersOpen ? (
                    <Link className="fw-pt-link" href={`${model.prefix}/sales/orders/${encodeURIComponent(row.orderId)}?tab=files`}>
                      {row.orderNumber}
                    </Link>
                  ) : (
                    row.orderNumber
                  )}
                </td>
                <td data-label={t('sizes.riders.col.customer')}>{row.customer ?? '—'}</td>
                <td data-label={t('sizes.riders.col.sheet')}>
                  <Pill tone={row.state === 'MISSING' ? 'warning' : 'success'}>{t(`sizes.riders.state.${row.state}`)}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </Section>
  )
}

/** How to measure: one plain sentence per point of the size table (the point's own words; the customer reads the same). */
function HowToSection({ model }: { model: StyleRecordViewModel }) {
  const { t } = useProductWords()
  const locale = useLocale()
  const part = model.spec?.part
  const rows = part?.status === 'ready' ? howToOf(part.value.points, locale) : []
  return (
    <Section id="pd-howto" title={t('sizes.howTo.title')} answer={part?.status === 'ready' && rows.length === 0 ? t('sizes.howTo.none') : undefined} info={<p>{t('sizes.howTo.info')}</p>}>
      {!part || part.status === 'idle' || part.status === 'loading' ? (
        <PartReading rows={2} />
      ) : part.status === 'error' ? (
        <Quiet>{t('sizes.howTo.failed')}</Quiet>
      ) : rows.length > 0 ? (
        <ol className="fw-pd-howto">
          {rows.map((row) => (
            <li key={row.code}>
              <b>{row.name}</b>
              <span>{row.text ?? t('sizes.howTo.noWords')}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </Section>
  )
}
