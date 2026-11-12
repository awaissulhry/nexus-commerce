'use client'

import Link from 'next/link'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Checkbox, RadioCard, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, Modal } from '../../../../lib/i18n/ds-parts'
import type { RoundView } from '../api'
import { NoticeLine, useWords } from '../parts'
import type { RecordDialog, SampleRecordModel } from '../record/view-model'
import { bothWays, cellsWithoutLine, needsColourway, workOrderFacts, type WorkOrderMode } from './model'

type WorkOrderDialogState = Extract<RecordDialog, { kind: 'workOrder' }>

/**
 * Make sample work order (the round's Sample tab; MES-018): on an order line of the style (checkbox per line, the round's
 * cells each would take), or, B-W2b-284, without an order line for an internal or uncharged proto, fit or salesman round — the
 * round's own cells, and the colourway its cells of "any colourway" are made in. Then the plant and the due day. The way is
 * chosen only when both are open; Make is held with the first reason in words; made, the receipt links the work order.
 */
export function WorkOrderDialog({
  model,
  round,
  dialog,
  footer,
  onClose,
  onPatch,
}: {
  model: SampleRecordModel
  round: RoundView
  dialog: WorkOrderDialogState
  footer: React.ReactNode
  onClose: () => void
  onPatch: (patch: Partial<WorkOrderDialogState>) => void
}) {
  const { t, say } = useWords()
  const options = dialog.options
  const facts = options ? workOrderFacts(options, dialog.lineIds, dialog) : null
  const way = (mode: WorkOrderMode) => (
    <RadioCard
      key={mode}
      name="wo-way"
      value={mode}
      title={t(`wo.way.${mode}`)}
      description={t(`wo.way.${mode}Body`)}
      checked={dialog.mode === mode}
      selected={dialog.mode === mode}
      onChange={() => onPatch({ mode })}
    />
  )
  return (
    <Modal open onClose={onClose} title={t('wo.title')} subtitle={round.number} size="xl" footer={footer}>
      <div className="fw-smp-form">
        {dialog.made ? (
          <Banner tone="success" title={t('wo.made', { number: dialog.made.number })}>
            {model.can.workOrdersView ? (
              <Link className="fw-smp-link" href={`${model.prefix}/production/work-orders/${encodeURIComponent(dialog.made.id)}`}>
                {t('wo.open', { number: dialog.made.number })}
              </Link>
            ) : null}
          </Banner>
        ) : !options ? (
          dialog.problem ? (
            <Banner tone="danger" title={t('wo.failed')}>
              {t(dialog.problem)}
            </Banner>
          ) : (
            <Skeleton height={160} />
          )
        ) : (
          <>
            <p className="fw-smp-hint">{t(dialog.mode === 'none' ? 'wo.bodyNone' : 'wo.body', { revision: options.round.revision.revision })}</p>
            {bothWays(options) && (
              <fieldset className="fw-smp-radios">
                <legend className="fw-smp-legend">{t('wo.way.legend')}</legend>
                {way('none')}
                {way('lines')}
              </fieldset>
            )}
            {facts!.blockers.map((line) => (
              <Banner key={line.key} tone="danger" title={say(line)} />
            ))}
            {facts!.warnings.map((line) => (
              <Banner key={line.key} tone="warning" title={say(line)} />
            ))}
            {dialog.mode === 'lines' && options.lines.length > 0 && (
              <SummaryTable
                label={t('wo.lines')}
                density="roomy"
                stackOnPhone
                columns={[t('wo.col.take'), t('wo.col.line'), t('wo.col.colourway'), t('wo.col.open'), t('wo.col.takes')]}
                rows={options.lines.map((line) => ({
                  id: line.id,
                  cells: [
                    <Checkbox
                      key="c"
                      aria-label={t('wo.takeLine', { order: line.orderNumber, seq: line.seq })}
                      checked={dialog.lineIds.includes(line.id)}
                      onChange={(event) => onPatch({ lineIds: event.target.checked ? [...dialog.lineIds, line.id] : dialog.lineIds.filter((id) => id !== line.id) })}
                    />,
                    t('wo.lineName', { order: line.orderNumber, seq: line.seq }),
                    line.colourwayCode,
                    line.open.map((size) => `${size.size}: ${size.open}`).join(' · ') || '—',
                    line.proposed.map((size) => `${size.size} × ${size.quantity}`).join(' · ') || t('wo.takesNothing'),
                  ],
                }))}
              />
            )}
            {dialog.mode === 'none' && options.withoutLine.allowed && (
              <>
                {needsColourway(options) && (
                  <Field label={t('wo.none.colourway')} hint={t('wo.none.colourwayHint')} required>
                    <Select size="sm" value={dialog.colourwayId} onChange={(event) => onPatch({ colourwayId: event.target.value })}>
                      <option value="">{t('wo.none.pickColourway')}</option>
                      {options.withoutLine.colourways.map((colourway) => (
                        <option key={colourway.id} value={colourway.id}>
                          {colourway.code} · {colourway.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                <SummaryTable
                  label={t('wo.none.cells')}
                  density="roomy"
                  stackOnPhone
                  columns={[t('wo.col.colourway'), t('wo.none.size'), t('wo.none.pieces')]}
                  rows={cellsWithoutLine(options, dialog.colourwayId).map((cell) => ({
                    id: cell.key,
                    cells: [cell.colourway ?? t('wo.none.anyColour'), cell.size, String(cell.quantity)],
                  }))}
                />
              </>
            )}
            <div className="fw-smp-form-grid">
              <Field label={t('wo.site')} required>
                <Select size="sm" value={dialog.siteId} onChange={(event) => onPatch({ siteId: event.target.value })}>
                  <option value="">{t('wo.pickSite')}</option>
                  {options.sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.code} · {site.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('wo.due')} hint={t('wo.dueHint')}>
                <DateField value={dialog.dueDate} clearable onChange={(value) => onPatch({ dueDate: value })} />
              </Field>
            </div>
          </>
        )}
        <NoticeLine notice={dialog.notice} />
      </div>
    </Modal>
  )
}
