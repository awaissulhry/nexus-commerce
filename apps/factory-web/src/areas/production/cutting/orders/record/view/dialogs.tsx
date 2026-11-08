'use client'

import { useMemo, useState } from 'react'
import { Ban, CheckCheck, Layers, Printer, Undo2, X } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { SelectionLabel, type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Checkbox, Input, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../../list-frame/ListFrame'
import type { CutOrderRecord, RollCandidate } from '../../api'
import {
  allocateGoHeld,
  allocateHeld,
  allowedRolls,
  decimalText,
  openLines,
  ORDERS_NAMESPACE,
  pickedPlies,
  printManyHeld,
  proposalFor,
  reasonOk,
  reconcileHeld,
  rollHeld,
  rollsGate,
  rollShade,
  signed,
  usedAgainstEstimate,
  VARIANCE_REASONS,
  voidHeld,
} from '../../model'
import { useSay } from '../../view/parts'
import type { CutOrderRecordActions, CutOrderRecordModel } from './CutOrderRecordView'

const metres = (value: string | null, locale: string): string => (value === null ? '—' : `${decimalText(value, locale)} m`)

// ---- Allocate rolls ---------------------------------------------------------------------------------------------------------------

/**
 * Allocate rolls to a lay (MES-037; design rec:Cut/lay/ct-lays "rolls by shade, width and shrinkage group … mixing shade groups in
 * one lay is refused with the reason"): the rolls of the fabric and colour at the site with the plies each gives, those the lay
 * cannot take un-tickable with why (refused by its own rule — not in stock, rejected, a held lot, too narrow, no whole ply —,
 * another shade group or shrinkage group than the lay's rolls, the lay full), Use the proposal (each lay from one group, ends and
 * part rolls first), the rolls already on the lay with Remove while the lay is planned. Allocate N rolls moves no stock: the table
 * issues the fabric when the lay is cut and its fabric used is confirmed.
 */
export function RollsDialog({ record, model, layId, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; layId: string; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const locale = useLocale()
  const lay = record.lays.find((row) => row.id === layId) ?? null
  const candidates = model.candidates.value
  const [picked, setPicked] = useState<readonly string[]>(model.rollsPicked ?? [])
  const pickedRolls = (candidates?.rolls ?? []).filter((roll) => picked.includes(roll.id))
  const plies = lay ? pickedPlies(lay, pickedRolls) : new Map<string, number>()
  const given = [...plies.values()].reduce((sum, value) => sum + value, 0)
  const columns = useMemo<ColDef<RollCandidate>[]>(() => {
    const RollCell = ({ data }: ICellRendererParams<RollCandidate>) =>
      data ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-code">{data.code}</span>
          <span className="fw-ct-sub">{[data.lot.code, data.lot.dyeBatch, data.location?.code].filter(Boolean).join(' · ')}</span>
        </span>
      ) : null
    const ShadeCell = ({ data }: ICellRendererParams<RollCandidate>) =>
      data ? (
        <span className="fw-ct-inline">
          <span>{rollShade(data) ?? t('rolls.shadeUnknown')}</span>
          {data.shadeGroup?.outOfShade && <Tag tone="warning">{t('rolls.outOfShade')}</Tag>}
        </span>
      ) : null
    const LeftCell = ({ data }: ICellRendererParams<RollCandidate>) =>
      data ? (
        <span className="fw-ct-cell">
          <span className="fw-ct-num">{`${decimalText(data.lengthLeft, locale)} ${data.uom.toLowerCase()}`}</span>
          <span className="fw-ct-sub">{Number(data.planned) > 0 ? t('rolls.plannedElsewhere', { length: decimalText(data.planned, locale), uom: data.uom.toLowerCase() }) : t('rolls.free')}</span>
        </span>
      ) : null
    return [
      { colId: 'roll', headerName: t('rolls.col.roll'), minWidth: 150, flex: 1.2, cellRenderer: RollCell, valueGetter: (params) => params.data?.code ?? '' },
      { colId: 'shade', headerName: t('rolls.col.shade'), minWidth: 110, flex: 0.9, cellRenderer: ShadeCell },
      { colId: 'shrinkage', headerName: t('rolls.col.shrinkage'), minWidth: 90, flex: 0.6, valueGetter: (params) => params.data?.shrinkageGroup ?? '—' },
      { colId: 'width', headerName: t('rolls.col.width'), minWidth: 80, flex: 0.5, type: 'rightAligned', valueGetter: (params) => (params.data?.widthCm ? `${decimalText(params.data.widthCm, locale)} cm` : '—') },
      { colId: 'left', headerName: t('rolls.col.left'), minWidth: 120, flex: 0.9, cellRenderer: LeftCell },
      { colId: 'plies', headerName: t('rolls.col.plies'), minWidth: 80, flex: 0.5, type: 'rightAligned', valueGetter: (params) => params.data?.plies ?? 0 },
      { colId: 'take', headerName: t('rolls.col.take'), minWidth: 80, flex: 0.5, type: 'rightAligned', valueGetter: (params) => (params.data && plies.has(params.data.id) ? plies.get(params.data.id) : '') },
    ]
  }, [t, locale, plies])
  if (!lay) return null
  const held = say(allocateGoHeld(record, lay, pickedRolls, model.can, model.busy))
  const removeHeld = say(allocateHeld(record, { ...lay, allocated: 0 }, model.can)) ?? (model.busy ? t('held.busy') : null)
  const proposal = candidates ? proposalFor(candidates, lay.id) : []
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('rolls.title', { seq: lay.seq, number: record.cutOrder.number })}
      size="xl"
      footer={
        <>
          <span className="fw-ct-hint">{t('rolls.give', { given, need: Math.max(0, lay.plies - lay.allocated) })}</span>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onAllocate?.(lay.id, pickedRolls.map((roll) => ({ rollId: roll.id, plies: plies.get(roll.id) ?? 0 })).filter((row) => row.plies > 0))}>
            {model.busy ? <Spinner size={12} /> : <Layers size={13} aria-hidden />} {t('rolls.go', { count: pickedRolls.length })}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        <p>{t('rolls.body', { seq: lay.seq, plies: lay.plies, allocated: lay.allocated })}</p>
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        <section aria-label={t('rolls.onLay', { seq: lay.seq })}>
          <h3 className="fw-ct-h3">{t('rolls.onLay', { seq: lay.seq })}</h3>
          {lay.rolls.length === 0 ? (
            <p className="fw-ct-hint">{t('rolls.noneOnLay')}</p>
          ) : (
            <ul className="fw-ct-list">
              {lay.rolls.map((roll) => (
                <li key={roll.id}>
                  <span className="fw-ct-inline">
                    <span className="fw-ct-code">{roll.code}</span>
                    <span className="fw-ct-hint">{t('rolls.onLayLine', { lot: roll.lotCode, shade: roll.shade ?? '—', shrinkage: roll.shrinkageGroup ?? '—', plies: roll.plies })}</span>
                  </span>
                  <Button size="sm" variant="quiet" heldReason={removeHeld} aria-label={t('rolls.removeOf', { code: roll.code })} onClick={() => actions?.onRemoveRoll?.(lay.id, roll.id)}>
                    <X size={13} aria-hidden /> {t('rolls.remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        {model.candidates.problem ? (
          <EmptyState title={t('part.failed', { part: t('rolls.candidates') })} description={t(model.candidates.problem)} action={<Button size="sm" onClick={() => actions?.onRetryPart?.('candidates')}>{t('common.retry')}</Button>} />
        ) : !candidates ? (
          <p className="fw-ct-hint" role="status">
            <Spinner size={12} /> {t('part.loading', { part: t('rolls.candidates') })}
          </p>
        ) : (
          <>
            <div className="fw-ct-card-head">
              <h3 className="fw-ct-h3">{t('rolls.candidates')}</h3>
              <Button size="sm" heldReason={proposal.length === 0 ? t('rolls.noProposal') : null} onClick={() => setPicked(allowedRolls(proposal.map((roll) => roll.id), candidates.rolls, lay, record.cutOrder.number))}>
                {t('rolls.useProposal')}
              </Button>
            </div>
            <p className="fw-ct-hint">{t('rolls.perPly', { metres: decimalText(candidates.perPlyMetres, locale, 4), allowance: candidates.allowanceCm })}</p>
            <ListFrame<RollCandidate>
              // The boxes are drawn again when the lay's group or fullness changes (the grid asks isRowSelectable per row once).
              key={rollsGate(lay, pickedRolls)}
              label={t('rolls.candidates')}
              rows={candidates.rolls}
              rowId={(roll) => roll.id}
              columns={columns}
              count={t('rolls.count', { count: candidates.rolls.length })}
              listKey={null}
              selection={{ selected: picked, onChange: (ids) => setPicked(allowedRolls(ids, candidates.rolls, lay, record.cutOrder.number)), actions: <SelectionLabel>{t('rolls.picked', { count: pickedRolls.length, plies: given })}</SelectionLabel> }}
              isRowSelectable={(roll) => say(rollHeld(roll, lay, pickedRolls, record.cutOrder.number))}
              state={candidates.rolls.length === 0 ? <EmptyState title={t('rolls.empty.title')} description={t('rolls.empty.body')} /> : undefined}
            />
            <p className="fw-ct-hint">{t('rolls.rule')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

// ---- Reconcile cut ------------------------------------------------------------------------------------------------------------------

/**
 * pop:ct-recon — Reconcile cut (design: "planned vs cut per size, material issued vs used vs returned, end bits, variance reason";
 * a confirm opened from the record's primary): the sizes ordered and cut, each line with its difference and — where cut differs
 * from ordered — a variance reason (Other in words), the fabric issued, used and returned with the end bits; Reconcile closes the
 * cut order (RECONCILED). Held with why: the right, a cut order not cut, a lay's fabric not confirmed, a reason missing.
 */
export function ReconcileDialog({ record, model, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const locale = useLocale()
  const recon = model.recon.value
  const draft = model.reconcile
  const held = say(reconcileHeld(recon, draft, model.can, model.busy))
  const material = recon?.material ?? null
  const against = material ? usedAgainstEstimate(material.sum, locale) : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('reconcile.title', { number: record.cutOrder.number })}
      size="xl"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onReconcile?.()}>
            {model.busy ? <Spinner size={12} /> : <CheckCheck size={13} aria-hidden />} {t('reconcile.go')}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        {model.recon.problem ? (
          <EmptyState title={t('part.failed', { part: t('reconcile.figures') })} description={t(model.recon.problem)} action={<Button size="sm" onClick={() => actions?.onRetryPart?.('recon')}>{t('common.retry')}</Button>} />
        ) : !recon ? (
          <p className="fw-ct-hint" role="status">
            <Spinner size={12} /> {t('part.loading', { part: t('reconcile.figures') })}
          </p>
        ) : (
          <>
            {recon.refusal && <Banner tone="warning" title={t(`refusal.${recon.refusal.code}`)} />}
            <p>{t('reconcile.sum', { ordered: recon.garments.ordered, cut: recon.garments.cut, difference: signed(recon.garments.cut - recon.garments.ordered) })}</p>
            <section aria-label={t('reconcile.sizes')}>
              <h3 className="fw-ct-h3">{t('reconcile.sizes')}</h3>
              <SummaryTable
                label={t('reconcile.sizes')}
                stackOnPhone
                columns={[t('pieces.col.size'), t('pieces.col.ordered'), t('pieces.col.cut'), t('pieces.col.recut'), t('pieces.col.difference')]}
                align={['left', 'right', 'right', 'right', 'right']}
                rows={recon.sizes.map((size) => ({ id: size.size, cells: [size.size, String(size.ordered), String(size.cut), String(size.recut), signed(size.difference)] }))}
              />
            </section>
            {material && (
              <section aria-label={t('reconcile.material')}>
                <h3 className="fw-ct-h3">{t('reconcile.material')}</h3>
                <KeyValue
                  columns={3}
                  dense
                  items={[
                    { label: t('material.issued'), value: metres(material.sum.issued, locale) },
                    { label: t('material.used'), value: metres(material.sum.used, locale) },
                    { label: t('material.returned'), value: metres(material.sum.endsReturned, locale) },
                    { label: t('material.endBits'), value: metres(material.sum.endLoss, locale) },
                    { label: t('material.estimated'), value: metres(material.sum.estimated, locale) },
                    { label: t('material.recorded'), value: metres(material.sum.recorded, locale) },
                  ]}
                />
                {against && <p className="fw-ct-hint">{say(against)}</p>}
              </section>
            )}
            <section aria-label={t('reconcile.lines')}>
              <h3 className="fw-ct-h3">{t('reconcile.lines')}</h3>
              {openLines(recon).length === 0 ? (
                <p className="fw-ct-hint">{t('reconcile.allDone')}</p>
              ) : (
                <SummaryTable
                  label={t('reconcile.lines')}
                  density="roomy"
                  stackOnPhone
                  columns={[t('lines.col.cell'), t('pieces.col.ordered'), t('pieces.col.cut'), t('pieces.col.difference'), t('reconcile.col.reason')]}
                  align={['left', 'right', 'right', 'right', 'left']}
                  widths={['26%', '11%', '11%', '12%', '40%']}
                  rows={openLines(recon).map((line) => {
                    const label = `${line.workOrder.number} ${line.colourway.code} ${line.size}`
                    return {
                      id: line.id,
                      cells: [
                        label,
                        String(line.ordered),
                        String(line.cut),
                        signed(line.difference),
                        line.needsReason ? (
                          <span key="reason" className="fw-ct-reason">
                            <Select size="sm" aria-label={t('reconcile.reasonOf', { cell: label })} value={draft.reason[line.id] ?? ''} onChange={(event) => actions?.onReconcileDraft?.({ ...draft, reason: { ...draft.reason, [line.id]: event.target.value } })}>
                              <option value="">{t('reconcile.pickReason')}</option>
                              {VARIANCE_REASONS.map((code) => (
                                <option key={code} value={code}>
                                  {t(`reason.${code}`)}
                                </option>
                              ))}
                            </Select>
                            <Input size="sm" aria-label={t('reconcile.noteOf', { cell: label })} placeholder={t('reconcile.col.note')} maxLength={500} value={draft.note[line.id] ?? ''} onChange={(event) => actions?.onReconcileDraft?.({ ...draft, note: { ...draft.note, [line.id]: event.target.value } })} />
                          </span>
                        ) : (
                          t('reconcile.asOrdered')
                        ),
                      ],
                    }
                  })}
                />
              )}
            </section>
            <p className="fw-ct-hint">{t('reconcile.hint')}</p>
          </>
        )}
      </div>
    </Modal>
  )
}

// ---- Print, void, back to planning, cancel ----------------------------------------------------------------------------------------

/** Print N tickets on a label printer of the site (the default: the table's, else the site's only one), or show the label. */
export function PrintDialog({ record, model, ticketIds, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; ticketIds: readonly string[]; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const locale = useLocale()
  const tickets = record.tickets.filter((ticket) => ticketIds.includes(ticket.id))
  const [printer, setPrinter] = useState('')
  const [language, setLanguage] = useState<'it' | 'en'>(locale === 'en' ? 'en' : 'it')
  const held = say(printManyHeld(tickets, model.can, model.busy)) ?? (printer === 'show' && tickets.length !== 1 ? t('print.held.showOne') : null)
  const printers = model.printers.value ?? []
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('print.title', { count: tickets.length })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onPrint?.(ticketIds, printer === '' ? undefined : printer === 'show' ? null : printer, language)}>
            {model.busy ? <Spinner size={12} /> : <Printer size={13} aria-hidden />} {printer === 'show' ? t('print.show') : t('print.go', { count: tickets.length })}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        <p>{t('print.body', { list: tickets.map((ticket) => ticket.number).join(', ') })}</p>
        <Field label={t('print.printer')} hint={model.printers.problem ? t(model.printers.problem) : t('print.printerHint')}>
          <Select size="sm" value={printer} onChange={(event) => setPrinter(event.target.value)}>
            <option value="">{t('print.default')}</option>
            {printers.map((row) => (
              <option key={row.id} value={row.id}>
                {`${row.code} · ${row.name}`}
              </option>
            ))}
            <option value="show">{t('print.showOnly')}</option>
          </Select>
        </Field>
        <Field label={t('print.language')}>
          <Select size="sm" value={language} onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'it')}>
            <option value="it">{t('language.it')}</option>
            <option value="en">{t('language.en')}</option>
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

/** Void a lost or wrong ticket with the reason; a new ticket for the same lay by default (a void ticket never scans again). */
export function VoidDialog({ record, model, ticketId, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; ticketId: string; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const ticket = record.tickets.find((row) => row.id === ticketId) ?? null
  const [reason, setReason] = useState('')
  const [replace, setReplace] = useState(true)
  const held = !ticket ? t('held.loading') : (say(voidHeld(ticket, model.can, model.busy)) ?? (!reasonOk(reason) ? t('held.reason') : null))
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('void.title', { number: ticket?.number ?? '—' })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={held} onClick={() => ticket && actions?.onVoid?.(ticket.id, reason.trim(), replace)}>
            {model.busy ? <Spinner size={12} /> : <Ban size={13} aria-hidden />} {t('void.go')}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        <p>{t('void.body')}</p>
        <Field label={t('void.reason')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
        <Checkbox label={t('void.replace')} checked={replace} onChange={(event) => setReplace(event.target.checked)} />
      </div>
    </Modal>
  )
}

/** Back to planning (no ticket scanned: tickets voided, rolls taken off) or Cancel (nothing started), each with a reason. */
export function ReasonDialog({ record, model, kind, actions }: { record: CutOrderRecord; model: CutOrderRecordModel; kind: 'back' | 'cancel'; actions?: CutOrderRecordActions }) {
  const t = useT(ORDERS_NAMESPACE)
  const say = useSay()
  const [reason, setReason] = useState('')
  const held = !reasonOk(reason) ? t('held.reason') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(`${kind}.title`, { number: record.cutOrder.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onDialog?.(null)}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant={kind === 'cancel' ? 'danger' : 'primary'} heldReason={held} onClick={() => (kind === 'back' ? actions?.onBack?.(reason.trim()) : actions?.onCancel?.(reason.trim()))}>
            {model.busy ? <Spinner size={12} /> : kind === 'back' ? <Undo2 size={13} aria-hidden /> : <Ban size={13} aria-hidden />} {t(`${kind}.go`)}
          </Button>
        </>
      }
    >
      <div className="fw-ct-dialog">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        <p>{t(`${kind}.body`)}</p>
        <Field label={t('void.reason')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
