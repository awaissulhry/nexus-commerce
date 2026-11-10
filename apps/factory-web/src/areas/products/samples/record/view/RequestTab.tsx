'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { SizeGridEditor, SizeGridView, type SizeGridColour } from '@nexus/ui/grid/size-grid/index'
import { Input, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, EditModeBar, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import type { RoundView } from '../../api'
import { ANY_COLOUR, chargeText, gridOfCells, refusalPhrase, requestChanges, requestDraftOf, roundPhrase, type Phrase } from '../../model'
import { useWords } from '../../parts'
import { useGridCopy } from '../../view/grid-copy'
import type { SampleRecordActions, SampleRecordModel } from '../view-model'

const CURRENCIES = ['EUR', 'GBP', 'USD', 'CHF'] as const

/**
 * Request (design rec tab sample.request, SAL-311; explicit save with the EditModeBar): what is asked, for whom, by when —
 * the style and the revision it is made from (pinned; changed only while requested), the type and round, colourways ×
 * sizes × pieces, the due day, the charge to the customer (a price: absent without it), who asked, the instructions and,
 * for a CE test sample, the sizes and zones sent. Read-only (closed, or no right) it is drawn as text with the reason.
 */
export function RequestTab({ model, round, actions }: { model: SampleRecordModel; round: RoundView; actions?: SampleRecordActions }) {
  const { t, say, locale, day } = useWords()
  const copy = useGridCopy()
  const offline = model.live === 'offline'
  const style = model.request.style.value
  const editHeld: Phrase | null = !model.can.manage ? { key: 'request.viewOnly' } : !round.actions.edit.allowed ? refusalPhrase(round.actions.edit.refusal?.code) : null
  const editable = !editHeld
  const draft = model.request.draft ?? requestDraftOf(round, locale)
  const changes = requestChanges(round, draft, model.can)
  const revisionHeld = !round.actions.changeRevision.allowed ? refusalPhrase(round.actions.changeRevision.refusal?.code) : null
  const charge = (round.chargeAmountMinor as number | null | undefined) ?? null

  const colours = useMemo<SizeGridColour[]>(() => {
    const rows: SizeGridColour[] = [{ key: ANY_COLOUR, label: t('grid.anyColour') }]
    const named = new Map<string, string>()
    for (const cell of round.cells) if (cell.colourwayId) named.set(cell.colourwayId, cell.colourwayCode ?? cell.colourwayId)
    if (style) for (const colourway of style.colourways.filter((one) => one.status !== 'ARCHIVED' || named.has(one.id))) rows.push({ key: colourway.id, label: `${colourway.code} · ${colourway.name}`, offered: colourway.offeredSizes.length > 0 ? colourway.offeredSizes : null })
    else for (const [id, code] of named) rows.push({ key: id, label: code })
    return rows
  }, [round.cells, style, t])
  const sizes = useMemo(() => {
    const order = style?.sizes ?? [...new Set(round.cells.map((cell) => cell.size))]
    return order.map((size) => ({ key: size, label: size }))
  }, [style, round.cells])
  const usedColours = editable ? colours : colours.filter((colour) => round.cells.some((cell) => (cell.colourwayId ?? ANY_COLOUR) === colour.key))

  const items = [
    { label: t('request.style'), value: model.can.styles ? <Link className="fw-smp-link" href={`${model.prefix}/products/styles/${encodeURIComponent(round.style.id)}?rev=${encodeURIComponent(round.revision.id)}`}>{`${round.style.code} · ${round.style.name}`}</Link> : `${round.style.code} · ${round.style.name}` },
    { label: t('request.kind'), value: say(roundPhrase(round.kind, round.roundNo)) },
    { label: t('request.for'), value: round.party ? `${round.party.code} · ${round.party.name}` : t('row.internal') },
    { label: t('request.askedBy'), value: round.createdBy ? t('request.askedByOn', { name: round.createdBy.name, when: formatDateTime(round.createdAt, { locale }) }) : formatDateTime(round.createdAt, { locale }) },
  ]

  return (
    <div className="fw-smp-stack">
      {editHeld && <Banner tone="info" title={t('request.readOnly', { reason: say(editHeld) ?? '' })} />}
      {round.releasedRevision && round.releasedRevision.id !== round.revision.id && (
        <Banner tone="info" title={t('request.newerRevision', { released: round.releasedRevision.revision, pinned: round.revision.revision })} />
      )}
      <div className="fw-smp-two">
        <Card padded>
          <h2 className="fw-smp-h2">{t('request.what')}</h2>
          <KeyValue items={items} labelCase="sentence" />
          <div className="fw-smp-form-grid">
            <Field label={t('request.revision')} hint={revisionHeld ? say(revisionHeld) : t('request.revisionHint')}>
              {editable && !revisionHeld && style ? (
                <Select size="sm" value={draft.revisionId} onChange={(event) => actions?.onRequestDraft?.({ revisionId: event.target.value })}>
                  {style.revisions
                    .filter((revision) => revision.status !== 'OBSOLETE' || revision.id === round.revision.id)
                    .sort((a, b) => b.revision - a.revision)
                    .map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {t('new.revisionOption', { revision: revision.revision, status: t(`revision.${revision.status}`) })}
                      </option>
                    ))}
                </Select>
              ) : (
                <span className="fw-smp-value">{t('request.revisionPinned', { revision: round.revision.revision, status: t(`revision.${round.revision.status}`) })}</span>
              )}
            </Field>
            <Field label={t('new.roundNo')}>
              {editable ? <Input size="sm" inputMode="numeric" value={draft.roundNo} onChange={(event) => actions?.onRequestDraft?.({ roundNo: event.target.value })} /> : <span className="fw-smp-value">{round.roundNo}</span>}
            </Field>
            <Field label={t('new.due')}>
              {editable ? <DateField value={draft.dueDate} clearable onChange={(value) => actions?.onRequestDraft?.({ dueDate: value })} /> : <span className="fw-smp-value">{day(round.dueDate)}</span>}
            </Field>
            {model.can.price && (
              <Field label={t('new.charge')} hint={round.party ? undefined : t('refusal.CHARGE_INTERNAL')}>
                {editable && round.party ? (
                  <div className="fw-smp-pick fw-smp-pick-row">
                    <Input size="sm" inputMode="decimal" aria-label={t('new.charge')} value={draft.charge} onChange={(event) => actions?.onRequestDraft?.({ charge: event.target.value })} />
                    <Select size="sm" aria-label={t('new.currency')} value={draft.currency} onChange={(event) => actions?.onRequestDraft?.({ currency: event.target.value })}>
                      {CURRENCIES.map((currency) => (
                        <option key={currency} value={currency}>
                          {currency}
                        </option>
                      ))}
                    </Select>
                  </div>
                ) : (
                  <span className="fw-smp-value">{charge !== null && round.chargeCurrency ? chargeText(charge, round.chargeCurrency, INTL_LOCALE[locale]) : '—'}</span>
                )}
              </Field>
            )}
          </div>
        </Card>
        <Card padded>
          <h2 className="fw-smp-h2">{t('request.notes')}</h2>
          <div className="fw-smp-form">
            <Field label={t('new.instructions')}>
              {editable ? <Textarea value={draft.instructions} rows={5} honourRows maxLength={4000} onChange={(event) => actions?.onRequestDraft?.({ instructions: event.target.value })} /> : <p className="fw-smp-text">{round.instructions ?? '—'}</p>}
            </Field>
            {round.kind === 'CERTIFICATION' && (
              <Field label={t('new.testZones')} hint={t('new.testZonesHint')}>
                {editable ? <Textarea value={draft.testZones} rows={3} honourRows maxLength={1000} onChange={(event) => actions?.onRequestDraft?.({ testZones: event.target.value })} /> : <p className="fw-smp-text">{round.testZones ?? '—'}</p>}
              </Field>
            )}
            <p className="fw-smp-hint">{t('request.commentsLater')}</p>
          </div>
        </Card>
      </div>
      <Card padded>
        <h2 className="fw-smp-h2">{t('new.cells')}</h2>
        <p className="fw-smp-hint">{t('request.pieces', { count: round.pieces })}</p>
        {model.request.style.problem && editable && <Banner tone="warning" title={t('request.styleFailed')}>{t(model.request.style.problem)}</Banner>}
        {editable && !style && !model.request.style.problem && model.can.styles ? (
          <Skeleton height={120} />
        ) : editable && style ? (
          <div className="fw-smp-bleed">
            <SizeGridEditor colours={colours} sizes={sizes} value={draft.grid} onChange={(grid) => actions?.onRequestGrid?.(grid)} max={1000} layout="auto" locale={INTL_LOCALE[locale]} copy={copy} caption={t('new.cells')} />
          </div>
        ) : (
          <div className="fw-smp-bleed">
            <SizeGridView colours={usedColours} sizes={sizes} value={gridOfCells(round.cells)} locale={INTL_LOCALE[locale]} copy={copy} caption={t('new.cells')} />
          </div>
        )}
      </Card>
      {editable && changes.count > 0 && (
        <EditModeBar
          count={changes.count}
          busy={model.request.saving}
          applyHeldReason={model.request.saving ? t('common.working') : say(changes.problem) ?? (offline ? t('held.offlineKept') : null)}
          onApply={() => actions?.onRequestSave?.()}
          onDiscard={() => actions?.onRequestDiscard?.()}
          saveShortcut
        />
      )}
    </div>
  )
}
