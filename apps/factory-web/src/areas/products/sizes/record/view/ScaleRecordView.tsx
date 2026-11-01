'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUp, Lock, MoreHorizontal, Pencil, Plus } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { isPageKey, type LibraryCan, type Notice, type Read, type WriteProblem } from '../../../library/model'
import { KeysDialog, LibraryMessages, NoticeBanner, RecordFrame, RecordState, SaveWords } from '../../../library/parts'
import type { BodyMeasures, ScaleView, SizeView, StyleRow } from '../../api'
import {
  BODY_MEASURE_UNITS,
  badSizes,
  measureProblems,
  measuresOf,
  measureText,
  missingFor,
  moved,
  parseSizes,
  pointsOf,
  rangeText,
  reorderHeld,
  rowsOf,
  SCALE_TABS,
  scaleCodeHeld,
  STATUS_TONE,
  type MeasureRow,
  type MeasureUnit,
  type ScaleTab,
} from '../../model'

export type ScaleLoad = { status: 'loading' } | { status: 'ready'; value: ScaleView } | { status: 'error'; problem: string } | { status: 'notFound' } | { status: 'forbidden' }

export type ScaleDialog = { kind: 'rename' } | { kind: 'add' } | { kind: 'size'; sizeId: string } | { kind: 'archive' } | { kind: 'help' }

export interface ScaleRecordViewModel {
  prefix: string
  can: LibraryCan
  tab: ScaleTab
  scale: ScaleLoad
  styles: Read<{ styles: StyleRow[]; count: number }>
  save: { state: 'idle' | 'saving' | 'failed'; at: string | null }
  busy: boolean
  notice: Notice | null
  changed: { at: string } | null
  refused: WriteProblem | null
  dialog: ScaleDialog | null
}

export interface ScaleRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onRename?: (patch: { code?: string; name?: string }) => Promise<boolean>
  onAddSizes?: (codes: string[], before: string | null) => Promise<boolean>
  onReorder?: (codes: string[]) => Promise<boolean>
  onSize?: (size: SizeView, patch: { code?: string; label?: string | null; bodyMeasures?: BodyMeasures | null; status?: 'ACTIVE' | 'ARCHIVED' }) => Promise<boolean>
  onArchive?: (reason: string) => Promise<boolean>
  onReactivate?: () => void
  onDialog?: (dialog: ScaleDialog | null) => void
  onDismissNotice?: () => void
}

const KEYS = [
  { keys: ['n'], does: 'keys.addSizes' },
  { keys: ['?'], does: 'keys.help' },
]

/**
 * SCR-049 — a size scale (design products.sizes "Record: Size scale"): the band (‹ Sizes & measurements, "<code> ·
 * <name>", the range and the styles on it, its state, Add sizes as the primary, ⋯ Rename, Archive / Reactivate, Copy
 * code, Keys) and the tabs Sizes (in order, each with its label and its body measures per point — what the PPE label
 * prints and against which a made-to-measure rider is checked; the order and a used size's code stay once styles use
 * them, said before the click), Measurement points (the points its sizes measure, in their units, and where a size
 * still lacks one) and Where used (the styles on it). It fetches nothing.
 */
export function ScaleRecordView({ model, actions }: { model: ScaleRecordViewModel; actions?: ScaleRecordActions }) {
  return (
    <LibraryMessages>
      <Record model={model} actions={actions} />
    </LibraryMessages>
  )
}

function Record({ model, actions }: { model: ScaleRecordViewModel; actions?: ScaleRecordActions }) {
  const t = useT('library')
  const back = { href: `${model.prefix}/products/sizes`, label: t('scale.back') }
  if (model.scale.status === 'ready') return <Ready scale={model.scale.value} model={model} actions={actions} />
  return <RecordState back={back} state={model.scale.status} problem={model.scale.status === 'error' ? model.scale.problem : null} onRetry={() => actions?.onRetry?.()} />
}

function Ready({ scale, model, actions }: { scale: ScaleView; model: ScaleRecordViewModel; actions?: ScaleRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const href = `${model.prefix}/products/sizes/${scale.id}`
  const archived = scale.status === 'ARCHIVED'
  const manage = model.can.scalesManage && !archived
  const addHeld = archived ? t('scale.held.archived') : !model.can.scalesManage ? t('held.noManage') : model.busy ? t('held.busy') : null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isPageKey(event) || model.dialog) return
      if (event.key === 'n' && manage) {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'add' })
      } else if (event.key === '?') {
        event.preventDefault()
        actions?.onDialog?.({ kind: 'help' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const more: MenuItemDef[] = [
    { id: 'rename', label: t('scale.action.rename'), disabled: !manage, description: manage ? undefined : archived ? t('scale.held.archived') : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'rename' }) },
    archived
      ? { id: 'reactivate', label: t('scale.action.reactivate'), disabled: !model.can.scalesManage, description: model.can.scalesManage ? undefined : t('held.noManage'), onSelect: () => actions?.onReactivate?.() }
      : { id: 'archive', label: t('scale.action.archive'), tone: 'danger', disabled: !model.can.scalesManage, description: model.can.scalesManage ? undefined : t('held.noManage'), onSelect: () => actions?.onDialog?.({ kind: 'archive' }) },
    {
      id: 'copy',
      label: t('list.copyCode'),
      onSelect: () => {
        void navigator.clipboard?.writeText(scale.code).catch(() => undefined)
      },
    },
    { id: 'keys', label: t('keys.menu'), onSelect: () => actions?.onDialog?.({ kind: 'help' }) },
  ]
  const dialog = model.dialog
  const sizeOpen = dialog?.kind === 'size' ? (scale.sizes.find((size) => size.id === dialog.sizeId) ?? null) : null

  return (
    <RecordFrame
      back={{ href: `${model.prefix}/products/sizes`, label: t('scale.back') }}
      title={
        <span className="fw-lib-title">
          {scale.code} <span className="fw-lib-title-name">· {scale.name}</span>
        </span>
      }
      meta={[rangeText(scale.codes), t('sizes.list.styles', { count: scale.styleCount })].join(' · ')}
      actions={
        <>
          <Button size="sm" variant="primary" heldReason={addHeld} onClick={() => actions?.onDialog?.({ kind: 'add' })} aria-keyshortcuts="n">
            <Plus size={14} aria-hidden /> {t('scale.action.add')}
          </Button>
          <Menu label={<MoreHorizontal size={16} aria-label={t('record.more')} />} items={more} align="right" triggerProps={{ 'aria-label': t('record.more') }} />
        </>
      }
      facts={
        <>
          <span className="fw-lib-tags">
            <Pill tone={STATUS_TONE[scale.status]}>{t(`status.${scale.status}`)}</Pill>
            <Tag tone="neutral">{t('sizes.list.sizeCount', { count: scale.codes.length })}</Tag>
            {scale.styleCount > 0 && <Tag tone="info">{t('scale.orderFixedTag')}</Tag>}
          </span>
          <SaveWords state={model.save.state} at={model.save.at} />
        </>
      }
      tabs={SCALE_TABS.map((tab) => ({ id: tab, label: t(`scale.tab.${tab}`), count: tab === 'sizes' ? scale.codes.length : tab === 'whereused' ? scale.styleCount : null }))}
      active={model.tab}
      tabHref={(tab) => `${href}?tab=${tab}`}
    >
      {model.changed && (
        <Banner
          tone="info"
          title={t('record.changed', { time: formatTime(model.changed.at, { locale }) })}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('record.reload')}
            </Button>
          }
        />
      )}
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {archived && <Banner tone="info" title={<span className="fw-lib-inline"><Lock size={14} aria-hidden /> {t('scale.archivedBanner')}</span>} />}
      {model.refused && model.refused.messages.length > 0 && model.notice?.tone === 'danger' && (
        <Banner tone="warning" title={t('material.refusedTitle')}>
          <ul className="fw-lib-list">
            {model.refused.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Banner>
      )}
      {model.tab === 'points' ? <PointsTab scale={scale} /> : model.tab === 'whereused' ? <WhereUsedTab scale={scale} model={model} /> : <SizesTab scale={scale} model={model} actions={actions} />}
      {dialog?.kind === 'rename' && <RenameDialog scale={scale} model={model} actions={actions} />}
      {dialog?.kind === 'add' && <AddSizesDialog scale={scale} model={model} actions={actions} />}
      {sizeOpen && <SizeDialog key={`${sizeOpen.id}-${sizeOpen.version}`} scale={scale} size={sizeOpen} model={model} actions={actions} />}
      {dialog?.kind === 'archive' && <ArchiveDialog scale={scale} busy={model.busy} actions={actions} />}
      {dialog?.kind === 'help' && <KeysDialog keys={KEYS.map((entry) => ({ keys: entry.keys, does: t(entry.does) }))} onClose={() => actions?.onDialog?.(null)} />}
    </RecordFrame>
  )
}

function SizesTab({ scale, model, actions }: { scale: ScaleView; model: ScaleRecordViewModel; actions?: ScaleRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const sizes = [...scale.sizes].sort((a, b) => a.seq - b.seq)
  const points = pointsOf(scale)
  const order = sizes.map((size) => size.code)
  const orderHeld = reorderHeld(scale, model.can)
  const manage = model.can.scalesManage && scale.status === 'ACTIVE'
  return (
    <Card header={t('scale.sizes.title')} description={t('scale.sizes.intro')}>
      <div className="fw-lib-stack">
        {orderHeld === 'scale.held.order' && <p className="fw-lib-hint">{t('scale.held.order', { count: scale.styleCount })}</p>}
        <div className="fw-lib-scroll">
          <table className="fw-lib-measures" aria-label={t('scale.sizes.title')}>
            <thead>
              <tr>
                <th scope="col">{t('scale.sizes.col.size')}</th>
                <th scope="col">{t('scale.sizes.col.label')}</th>
                {points.map((point) => (
                  <th key={point} scope="col">
                    {point} <span className="fw-lib-sub">({scale.measureUnits[point] ?? '—'})</span>
                  </th>
                ))}
                <th scope="col">{t('scale.sizes.col.status')}</th>
                <th scope="col">
                  <span className="fw-lib-hide-phone">{t('scale.sizes.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sizes.map((size, index) => {
                const archived = size.status === 'ARCHIVED'
                return (
                  <tr key={size.id}>
                    <th scope="row" className={archived ? 'is-archived' : undefined}>
                      <span className="fw-lib-inline">
                        <b>{size.code}</b>
                        {size.inUse && <Lock size={12} aria-label={t('scale.sizes.inUse')} />}
                      </span>
                    </th>
                    <td className={archived ? 'is-archived' : undefined}>{size.label ?? '—'}</td>
                    {points.map((point) => (
                      <td key={point} className={archived ? 'is-archived' : undefined}>
                        {measureText(size, point, locale) ?? <span className="fw-lib-hint">—</span>}
                      </td>
                    ))}
                    <td>
                      <Pill tone={STATUS_TONE[size.status]}>{t(`status.${size.status}`)}</Pill>
                    </td>
                    <td>
                      <span className="fw-lib-actions">
                        <Button size="sm" variant="quiet" aria-label={t('scale.sizes.up', { code: size.code })} heldReason={orderHeld ? t(orderHeld, { count: scale.styleCount }) : index === 0 ? t('scale.sizes.first') : model.busy ? t('held.busy') : null} onClick={() => { const next = moved(order, size.code, -1); if (next) void actions?.onReorder?.(next) }}>
                          <ArrowUp size={14} aria-hidden />
                        </Button>
                        <Button size="sm" variant="quiet" aria-label={t('scale.sizes.down', { code: size.code })} heldReason={orderHeld ? t(orderHeld, { count: scale.styleCount }) : index === sizes.length - 1 ? t('scale.sizes.last') : model.busy ? t('held.busy') : null} onClick={() => { const next = moved(order, size.code, 1); if (next) void actions?.onReorder?.(next) }}>
                          <ArrowDown size={14} aria-hidden />
                        </Button>
                        <Button size="sm" aria-label={t('scale.sizes.edit', { code: size.code })} heldReason={manage ? null : scale.status !== 'ACTIVE' ? t('scale.held.archived') : t('held.noManage')} onClick={() => actions?.onDialog?.({ kind: 'size', sizeId: size.id })}>
                          <Pencil size={13} aria-hidden /> <span className="fw-lib-hide-phone">{t('scale.sizes.editShort')}</span>
                        </Button>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {points.length === 0 ? (
          <p className="fw-lib-hint fw-lib-warn">{t('scale.sizes.noMeasures')}</p>
        ) : (
          points
            .filter((point) => missingFor(scale.sizes, point) > 0)
            .map((point) => (
              <p key={point} className="fw-lib-hint fw-lib-warn">
                {t('scale.sizes.missing', { point, count: missingFor(scale.sizes, point) })}
              </p>
            ))
        )}
      </div>
    </Card>
  )
}

function PointsTab({ scale }: { scale: ScaleView }) {
  const t = useT('library')
  const points = pointsOf(scale)
  const active = scale.sizes.filter((size) => size.status === 'ACTIVE').length
  return (
    <Card header={t('scale.points.title')} description={t('scale.points.intro')}>
      {points.length === 0 ? (
        <EmptyState title={t('scale.points.empty.title')} description={t('scale.points.empty.body')} />
      ) : (
        <SummaryTable
          label={t('scale.points.title')}
          stackOnPhone
          columns={[t('scale.points.col.point'), t('scale.points.col.unit'), t('scale.points.col.sizes')]}
          rows={points.map((point) => ({
            id: point,
            cells: [<b key="p">{point}</b>, scale.measureUnits[point] ?? '—', t('scale.points.coverage', { count: active - missingFor(scale.sizes, point), of: active })],
          }))}
        />
      )}
    </Card>
  )
}

function WhereUsedTab({ scale, model }: { scale: ScaleView; model: ScaleRecordViewModel }) {
  const t = useT('library')
  const read = model.styles
  return (
    <Card header={t('scale.tab.whereused')} description={t('scale.used.intro')}>
      {read.problem ? (
        <Banner tone="danger" title={t('scale.used.failed')}>
          {t(read.problem)}
        </Banner>
      ) : read.value === null ? (
        <p className="fw-lib-hint fw-lib-inline" role="status">
          <Spinner size={12} /> {t('record.loading')}
        </p>
      ) : read.value.styles.length === 0 ? (
        <EmptyState title={t('scale.used.empty.title')} description={t('scale.used.empty.body')} />
      ) : (
        <SummaryTable
          label={t('scale.tab.whereused')}
          stackOnPhone
          columns={[t('scale.used.col.style'), t('scale.used.col.range'), t('scale.used.col.base'), t('scale.used.col.status')]}
          rows={read.value.styles.map((style) => ({
            id: style.id,
            cells: [
              <Link key="s" className="fw-lib-link" href={`${model.prefix}/products/styles/${style.id}?tab=variants`}>
                {style.code} · {style.name}
              </Link>,
              rangeText(style.sizes.length ? style.sizes : scale.codes),
              style.baseSize ?? '—',
              t(`styleStatus.${style.status}`),
            ],
          }))}
        />
      )}
    </Card>
  )
}

function RenameDialog({ scale, model, actions }: { scale: ScaleView; model: ScaleRecordViewModel; actions?: ScaleRecordActions }) {
  const t = useT('library')
  const [code, setCode] = useState(scale.code)
  const [name, setName] = useState(scale.name)
  const close = () => actions?.onDialog?.(null)
  const frozen = scaleCodeHeld(scale)
  const patch = { ...(code.trim().toUpperCase() !== scale.code ? { code: code.trim().toUpperCase() } : {}), ...(name.trim() !== scale.name ? { name: name.trim() } : {}) }
  const held = name.trim() === '' ? t('newScale.held.name') : Object.keys(patch).length === 0 ? t('scale.rename.held.same') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={close}
      title={t('scale.rename.title')}
      size="sm"
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => void actions?.onRename?.(patch).then((done) => done && close())}>
            {t('material.save')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <Field label={t('scale.code')} hint={frozen ? t('scale.rename.codeFrozen', { count: scale.styleCount }) : t('material.codeHint')}>
          <Input value={code} maxLength={40} disabled={frozen} onChange={(event) => setCode(event.target.value.toUpperCase())} />
        </Field>
        <Field label={t('scale.name')} required>
          <Input value={name} maxLength={120} autoFocus onChange={(event) => setName(event.target.value)} />
        </Field>
      </div>
    </Modal>
  )
}

function AddSizesDialog({ scale, model, actions }: { scale: ScaleView; model: ScaleRecordViewModel; actions?: ScaleRecordActions }) {
  const t = useT('library')
  const [text, setText] = useState('')
  const [before, setBefore] = useState('')
  const close = () => actions?.onDialog?.(null)
  const codes = parseSizes(text)
  const bad = badSizes(codes)
  const taken = codes.filter((code) => scale.sizes.some((size) => size.code === code))
  const held = codes.length === 0 ? t('newScale.held.sizes') : bad.length > 0 ? t('newScale.held.badSizes', { sizes: bad.join(' ') }) : taken.length > 0 ? t('scale.add.held.taken', { sizes: taken.join(' ') }) : model.busy ? t('held.busy') : null
  const sizes = [...scale.sizes].sort((a, b) => a.seq - b.seq)
  return (
    <Modal
      open
      onClose={close}
      title={t('scale.add.title', { code: scale.code })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => void actions?.onAddSizes?.(codes, before || null).then((done) => done && close())}>
            {t('scale.add.go', { count: codes.length })}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <Field label={t('newScale.sizes')} required hint={t('newScale.sizesHint')}>
          <Textarea value={text} rows={2} autoFocus onChange={(event) => setText(event.target.value)} />
        </Field>
        <Field label={t('scale.add.where')} hint={scale.styleCount > 0 ? t('scale.add.whereUsed') : undefined}>
          <Select value={before} onChange={(event) => setBefore(event.target.value)}>
            <option value="">{t('scale.add.atEnd')}</option>
            {sizes.map((size) => (
              <option key={size.id} value={size.code}>
                {t('scale.add.before', { code: size.code })}
              </option>
            ))}
          </Select>
        </Field>
        {codes.length > 0 && <p className="fw-lib-converter">{t('newScale.preview', { count: codes.length, sizes: codes.join(' · ') })}</p>}
      </div>
    </Modal>
  )
}

/** One size: its label, code (while no record names it), body measures per point and whether it is offered. */
function SizeDialog({ scale, size, model, actions }: { scale: ScaleView; size: SizeView; model: ScaleRecordViewModel; actions?: ScaleRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const units = scale.measureUnits as Record<string, MeasureUnit>
  const [code, setCode] = useState(size.code)
  const [label, setLabel] = useState(size.label ?? '')
  const [rows, setRows] = useState<MeasureRow[]>(rowsOf(size, pointsOf(scale), units, locale))
  const [archived, setArchived] = useState(size.status === 'ARCHIVED')
  const [point, setPoint] = useState('')
  const [unit, setUnit] = useState<MeasureUnit>('cm')
  const close = () => actions?.onDialog?.(null)
  const problems = measureProblems(rows, units)
  const measures = measuresOf(rows)
  const patch: { code?: string; label?: string | null; bodyMeasures?: BodyMeasures | null; status?: 'ACTIVE' | 'ARCHIVED' } = {}
  if (code.trim().toUpperCase() !== size.code) patch.code = code.trim().toUpperCase()
  if ((label.trim() || null) !== size.label) patch.label = label.trim() || null
  if (JSON.stringify(measures) !== JSON.stringify(size.bodyMeasures && Object.keys(size.bodyMeasures).length ? size.bodyMeasures : null)) patch.bodyMeasures = measures
  if ((archived ? 'ARCHIVED' : 'ACTIVE') !== size.status) patch.status = archived ? 'ARCHIVED' : 'ACTIVE'
  const held = problems.length > 0 ? t(`scale.size.held.${problems[0]!.reason}`, { point: problems[0]!.point }) : Object.keys(patch).length === 0 ? t('scale.rename.held.same') : model.busy ? t('held.busy') : null
  const newPoint = point.trim().toLowerCase()
  const pointHeld = !/^[a-z][a-z0-9_]{0,39}$/.test(newPoint) ? t('scale.size.pointRule') : rows.some((row) => row.point === newPoint) ? t('scale.size.pointTaken') : null
  const setRow = (index: number, next: Partial<MeasureRow>) => setRows((current) => current.map((row, at) => (at === index ? { ...row, ...next } : row)))
  return (
    <Modal
      open
      onClose={close}
      title={t('scale.size.title', { code: size.code, scale: scale.code })}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => void actions?.onSize?.(size, patch).then((done) => done && close())}>
            {t('material.save')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <div className="fw-lib-form-grid">
          <Field label={t('scale.size.code')} hint={size.inUse ? t('scale.size.codeInUse') : t('scale.size.codeHint')}>
            <Input value={code} maxLength={10} disabled={size.inUse} onChange={(event) => setCode(event.target.value.toUpperCase())} />
          </Field>
          <Field label={t('scale.size.label')} hint={t('scale.size.labelHint')}>
            <Input value={label} maxLength={40} onChange={(event) => setLabel(event.target.value)} />
          </Field>
          <Field label={t('scale.size.offered')} hint={t('scale.size.offeredHint')}>
            <span className="fw-lib-inline">
              <Toggle checked={!archived} onChange={(next) => setArchived(!next)} aria-label={t('scale.size.offered')} />
              {t(archived ? 'common.no' : 'common.yes')}
            </span>
          </Field>
        </div>
        <h3 className="fw-lib-h3">{t('scale.size.measures')}</h3>
        <p className="fw-lib-hint">{t('scale.size.measuresHint')}</p>
        <div className="fw-lib-rows">
          {rows.map((row, index) => (
            <div key={row.point} className="fw-lib-form-grid">
              <Field label={t('scale.size.min', { point: row.point })}>
                <Input inputMode="decimal" value={row.min} onChange={(event) => setRow(index, { min: event.target.value })} />
              </Field>
              <Field label={t('scale.size.max', { point: row.point })}>
                <Input inputMode="decimal" value={row.max} onChange={(event) => setRow(index, { max: event.target.value })} />
              </Field>
              <Field label={t('scale.size.unit')} hint={units[row.point] ? t('scale.size.unitFixed') : undefined}>
                <Select value={row.unit} disabled={!!units[row.point]} onChange={(event) => setRow(index, { unit: event.target.value as MeasureUnit })}>
                  {BODY_MEASURE_UNITS.map((entry) => (
                    <option key={entry} value={entry}>
                      {entry}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          ))}
        </div>
        <div className="fw-lib-form-grid">
          <Field label={t('scale.size.newPoint')} hint={t('scale.size.pointRule')}>
            <Input value={point} maxLength={40} onChange={(event) => setPoint(event.target.value)} />
          </Field>
          <Field label={t('scale.size.unit')}>
            <Select value={unit} onChange={(event) => setUnit(event.target.value as MeasureUnit)}>
              {BODY_MEASURE_UNITS.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </Select>
          </Field>
          <div className="fw-lib-inline">
            <Button
              size="sm"
              heldReason={point.trim() === '' ? t('scale.size.pointEmpty') : pointHeld}
              onClick={() => {
                setRows((current) => [...current, { point: newPoint, min: '', max: '', unit }])
                setPoint('')
              }}
            >
              <Plus size={13} aria-hidden /> {t('scale.size.addPoint')}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function ArchiveDialog({ scale, busy, actions }: { scale: ScaleView; busy: boolean; actions?: ScaleRecordActions }) {
  const t = useT('library')
  const [reason, setReason] = useState('')
  const close = () => actions?.onDialog?.(null)
  return (
    <Modal
      open
      onClose={close}
      title={t('scale.archive.title', { code: scale.code })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : null} onClick={() => void actions?.onArchive?.(reason.trim()).then((done) => done && close())}>
            {t('scale.action.archive')}
          </Button>
        </>
      }
    >
      <div className="fw-lib-dialog">
        <ul className="fw-lib-list">
          <li>{t('sizes.archive.reach')}</li>
          <li>{t('sizes.archive.kept')}</li>
          <li>{t('sizes.archive.back')}</li>
        </ul>
        <Field label={t('dialog.reason')} hint={t('dialog.reasonHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
