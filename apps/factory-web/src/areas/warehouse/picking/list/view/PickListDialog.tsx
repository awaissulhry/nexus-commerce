'use client'

import { useId } from 'react'
import Link from 'next/link'
import { CheckCheck, Printer, RotateCcw } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { DetailModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { PickSheet, SheetLine } from '../../api'
import { kitCheck, kitHeld, kitPlaceWords, markCompleteHeld, READINESS_TONE, stopsOf, walkOrder, type PickingCan } from '../../model'
import { CheckList, KitPill, say, useHeldWords, useQty, useReadinessWord, useWords } from '../../parts'
import type { PickingListActions, SheetModel } from '../../view-model'

/**
 * pop:pk-list — "Pick list WO-…" (design warehouse.picking): the lines in the order the picker walks (by bin path), each
 * with where to take it (the lot or hide reserved for the work order, else the one a pick list would propose, oldest
 * first), needed, picked (and the lots and hides the floor's scans issued) and what is still short; the stock that may
 * not be used, held with its reason (a quality hold named with its reason and day); B-W2b-15: the kit's place, chosen from
 * the site's places (never a workshop's) and saved at once; the kit complete check, and "Mark kit complete" (held with why
 * while lines are short), then "Checked complete" with when (never who) and "Open again" with the reason. J / K walk the
 * rows of the list as shown.
 */
export function PickListDialog({
  model,
  ids,
  prefix,
  can,
  timeZone,
  actions,
}: {
  model: SheetModel
  ids: readonly string[]
  prefix: string
  can: PickingCan
  timeZone: string
  actions?: PickingListActions
}) {
  const t = useWords()
  const locale = useLocale()
  const place = { locale, timeZone }
  const qty = useQty()
  const word = useReadinessWord()
  const held = useHeldWords()
  const sheet = model.sheet
  const number = sheet?.workOrder.number ?? ''
  return (
    <DetailModal
      open
      onClose={() => actions?.onOpen?.(null)}
      title={sheet ? t('sheet.title', { number }) : t('sheet.reading')}
      subtitle={
        sheet
          ? [
              `${sheet.workOrder.style.code} · ${sheet.workOrder.style.name}`,
              t('list.pieces', { count: sheet.workOrder.pieces }),
              sheet.cutDate
                ? t('sheet.cut', {
                    date: formatDate(`${sheet.cutDate}T12:00:00Z`, place),
                  })
                : t('list.notPlanned'),
            ].join(' · ')
          : undefined
      }
      meta={
        sheet ? (
          <span className="fw-pk-meta">
            <Pill tone={READINESS_TONE[sheet.readiness.word]}>{word(sheet.readiness.word, sheet.readiness.date)}</Pill>
            <KitPill status={sheet.kit.status} />
            <Tag tone={sheet.pickList.created ? 'info' : 'neutral'}>{sheet.pickList.created ? t('list.hasList') : t('list.noList')}</Tag>
            {sheet.workOrder.onHold && (
              <Tag tone="danger">
                {sheet.workOrder.onHold.reason
                  ? t('list.onHoldWhy', {
                      reason: sheet.workOrder.onHold.reason,
                    })
                  : t('list.onHold')}
              </Tag>
            )}
          </span>
        ) : undefined
      }
      actions={
        sheet ? (
          <span className="fw-pk-buttons">
            <Button size="sm" variant="secondary" onClick={() => actions?.onPrint?.([sheet.workOrder.id])}>
              <Printer size={14} aria-hidden /> {t('sheet.print')}
            </Button>
            {can.workOrders && (
              <Link className="fw-st-link" href={`${prefix}/production/work-orders/${encodeURIComponent(sheet.workOrder.id)}?tab=materials`}>
                {t('list.openWorkOrder')}
              </Link>
            )}
          </span>
        ) : undefined
      }
      nav={
        ids.includes(model.id)
          ? {
              ids,
              current: model.id,
              onGo: (id) => actions?.onOpen?.(id),
              noun: t('sheet.noun'),
            }
          : undefined
      }
      loading={!sheet && !model.problem}
      error={model.problem ? t(`stock:${model.problem}`) : undefined}
      onRetry={() => actions?.onRetrySheet?.()}
      footer={
        sheet ? (
          <span className="fw-pk-buttons">
            <Button variant="primary" heldReason={model.kitBusy ? t('kit.busy') : say(t, markCompleteHeld(sheet, can))} onClick={() => actions?.onCompleteKit?.()}>
              {model.kitBusy ? <Spinner size={12} /> : <CheckCheck size={14} aria-hidden />} {t('kit.mark')}
            </Button>
          </span>
        ) : undefined
      }
    >
      {sheet && <SheetBody sheet={sheet} model={model} can={can} actions={actions} qty={qty} held={held} timeZone={timeZone} />}
    </DetailModal>
  )
}

/** B-W2b-15: where the kit waits — a place of the site chosen here (saved at once), or said in words. */
function KitPlace({ sheet, model, can, actions }: { sheet: PickSheet; model: SheetModel; can: PickingCan; actions?: PickingListActions }) {
  const t = useWords()
  const id = useId()
  const stageHeld = model.kitBusy ? t('kit.busy') : say(t, kitHeld(sheet, can, 'stage'))
  const places = model.places?.items ?? null
  if (stageHeld !== null || !can.places || model.places === null || model.places === undefined) {
    return (
      <p className="fw-pk-sheet-place">
        <b>{t('kit.place')}</b> {say(t, kitPlaceWords(sheet.kit))}
        {stageHeld && can.kits && <span className="fw-st-sub"> · {stageHeld}</span>}
        {!stageHeld && can.kits && !can.places && <span className="fw-st-sub"> · {t('kit.heldNoPlaces')}</span>}
      </p>
    )
  }
  return (
    <div className="fw-pk-sheet-place">
      <Field label={t('kit.placeLabel')} hint={model.places.problem ? t(`stock:${model.places.problem}`) : t('kit.placeHint')}>
        <Select id={id} value={sheet.kit.location?.id ?? ''} disabled={places === null} onChange={(event) => actions?.onStageKit?.(event.target.value || null)}>
          <option value="">{t('kit.placeNone')}</option>
          {sheet.kit.location && !(places ?? []).some((place) => place.id === sheet.kit.location!.id) && <option value={sheet.kit.location.id}>{`${sheet.kit.location.code} · ${sheet.kit.location.name}`}</option>}
          {(places ?? []).map((place) => (
            <option key={place.id} value={place.id}>
              {`${'\u00a0\u00a0'.repeat(place.depth)}${place.code} · ${place.name}`}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
}

/** B-W2b-15: the kit checked complete (when, never who) with "Open again" and its reason. */
function KitChecked({ sheet, model, can, actions, timeZone }: { sheet: PickSheet; model: SheetModel; can: PickingCan; actions?: PickingListActions; timeZone: string }) {
  const t = useWords()
  const locale = useLocale()
  if (!sheet.kit.checkedAt) return null
  const reopenHeld = model.kitBusy ? t('kit.busy') : say(t, kitHeld(sheet, can, 'reopen'))
  return (
    <div className="fw-pk-checked">
      <p>
        <Tag tone="success">{t('kit.checked')}</Tag> <span className="fw-st-sub">{t('kit.checkedAt', { at: formatDateTime(sheet.kit.checkedAt, { locale, timeZone }) })}</span>
      </p>
      {model.reopen ? (
        <div className="fw-pk-reopen">
          <Field label={t('kit.reopenReason')} required>
            <Textarea value={model.reopen.reason} maxLength={500} rows={2} onChange={(event) => actions?.onReopenReason?.(event.target.value)} />
          </Field>
          <span className="fw-pk-buttons">
            <Button size="sm" variant="secondary" onClick={() => actions?.onReopenKit?.(null)}>
              {t('stock:common.cancel')}
            </Button>
            <Button size="sm" variant="primary" heldReason={model.reopen.reason.trim() ? reopenHeld : t('kit.reopenWhy')} onClick={() => actions?.onConfirmReopen?.()}>
              <RotateCcw size={14} aria-hidden /> {t('kit.reopen')}
            </Button>
          </span>
        </div>
      ) : (
        <Button size="sm" variant="secondary" heldReason={reopenHeld} onClick={() => actions?.onReopenKit?.('')}>
          <RotateCcw size={14} aria-hidden /> {t('kit.reopen')}
        </Button>
      )}
    </div>
  )
}

function SheetBody({ sheet, model, can, actions, qty, held, timeZone }: { sheet: PickSheet; model: SheetModel; can: PickingCan; actions?: PickingListActions; qty: ReturnType<typeof useQty>; held: ReturnType<typeof useHeldWords>; timeZone: string }) {
  const t = useWords()
  const locale = useLocale()
  const lines = walkOrder(sheet.lines)
  const check = kitCheck(sheet)
  const where = (line: SheetLine) => {
    const stops = stopsOf(line)
    if (line.covered) return <span className="fw-st-sub">{t('sheet.allPicked')}</span>
    if (stops.length === 0) return <span className="fw-st-sub fw-pk-held">{t('sheet.nothingUsable')}</span>
    return (
      <span className="fw-pk-stops">
        {stops.map((stop, index) => (
          <span key={`${stop.locationCode}-${stop.hideCode ?? stop.lotCode ?? index}`}>
            <b>{stop.locationCode || '—'}</b> {stop.hideCode ? t('sheet.hide', { hide: stop.hideCode }) : stop.lotCode ? t('sheet.lot', { lot: stop.lotCode }) : t('sheet.anyLot')} ·{' '}
            {qty(stop.quantity, line.baseUom)} <span className="fw-st-sub">{stop.reserved ? t('sheet.reserved') : t('sheet.proposed')}</span>
          </span>
        ))}
      </span>
    )
  }
  const picked = (line: SheetLine) => (
    <span className="fw-st-cell">
      <span className="fw-st-num">{qty(line.issued, line.baseUom)}</span>
      {line.atWorkOrder.length > 0 && (
        <span className="fw-st-sub">
          {line.atWorkOrder
            .map((row) => row.hideCode ?? row.lotCode ?? '')
            .filter(Boolean)
            .join(', ')}
        </span>
      )}
    </span>
  )
  const heldEntries = sheet.lines.flatMap((line) => line.held.map((entry) => ({ line, entry })))
  return (
    <div className="fw-pk-sheet">
      {model.kitProblem && <Banner tone="danger" title={say(t, model.kitProblem) ?? ''} />}
      <KitPlace sheet={sheet} model={model} can={can} actions={actions} />
      {lines.length === 0 ? (
        <p className="fw-st-sub">{t('sheet.noLines')}</p>
      ) : (
        <SummaryTable
          label={t('sheet.tableLabel', { number: sheet.workOrder.number })}
          columns={[t('sheet.col.where'), t('sheet.col.material'), t('sheet.col.needed'), t('sheet.col.picked'), t('sheet.col.short')]}
          widths={['38%', '24%', '12%', '14%', '12%']}
          align={[undefined, undefined, 'right', 'right', 'right']}
          stackOnPhone
          rows={lines.map((line) => ({
            id: `${line.itemId}|${line.itemColourId ?? '-'}`,
            cells: [
              where(line),
              <span key="m" className="fw-st-cell">
                <span>{[line.itemCode, line.colourCode].filter(Boolean).join(' ')}</span>
                <span className="fw-st-sub">{line.itemName}</span>
              </span>,
              <span key="n" className="fw-st-num">
                {qty(line.planned, line.baseUom)}
              </span>,
              picked(line),
              <span key="s" className={line.covered ? 'fw-st-num' : 'fw-st-num strong'}>
                {line.covered ? '—' : qty(line.toIssue, line.baseUom)}
              </span>,
            ],
          }))}
        />
      )}
      {heldEntries.length > 0 && (
        <section className="fw-pk-heldlist" aria-label={t('sheet.heldTitle')}>
          <h3 className="fw-pk-h3">{t('sheet.heldTitle')}</h3>
          <ul>
            {heldEntries.map(({ line, entry }) => (
              <li key={`${line.itemId}-${entry.lotId}-${entry.hideId ?? ''}`}>
                <b>{[line.itemCode, line.colourCode].filter(Boolean).join(' ')}</b> · {held(entry)} · {qty(entry.onHand, line.baseUom)}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label={t('kit.check')}>
        <h3 className="fw-pk-h3">{t('kit.check')}</h3>
        <CheckList
          label={t('kit.check')}
          items={[
            {
              id: 'list',
              ok: sheet.pickList.created,
              words: sheet.pickList.created ? t('kit.checkList', { count: sheet.pickList.reservations }) : t('kit.checkNoList'),
            },
            ...lines.map((line) => ({
              id: `${line.itemId}|${line.itemColourId ?? '-'}`,
              ok: line.covered,
              words: line.covered
                ? t('kit.lineDone', {
                    material: [line.itemCode, line.colourCode].filter(Boolean).join(' '),
                  })
                : t('kit.lineShort', {
                    material: [line.itemCode, line.colourCode].filter(Boolean).join(' '),
                    short: qty(line.toIssue, line.baseUom),
                  }),
            })),
            {
              id: 'complete',
              ok: check.complete,
              words: check.complete ? t('kit.allDone') : t('kit.notAllDone', { count: check.short.length }),
            },
          ]}
        />
        <KitChecked sheet={sheet} model={model} can={can} actions={actions} timeZone={timeZone} />
        {(sheet.startedAt || sheet.finishedAt) && (
          <p className="fw-st-sub">
            {[
              sheet.startedAt
                ? t('sheet.started', {
                    at: formatDateTime(sheet.startedAt, { locale, timeZone }),
                  })
                : null,
              sheet.finishedAt
                ? t('sheet.finished', {
                    at: formatDateTime(sheet.finishedAt, { locale, timeZone }),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
      </section>
    </div>
  )
}
