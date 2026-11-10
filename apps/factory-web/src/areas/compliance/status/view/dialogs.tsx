'use client'

import { useMemo, useRef, useState } from 'react'
import { Download, ExternalLink } from 'lucide-react'
import { EmptyState, Field } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, Select, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ActionLine } from '../api'
import { actionsCsvRows, fixHeld, fixHref, marketName } from '../model'
import { cellOfLine, Failed, lineHead } from './Panels'
import type { StatusActions, StatusModel } from './types'

/**
 * "See all N" (design cs-actions "Then 'See all 14'"): every Needs action line (at most 200) on the list frame inside a Modal —
 * worst first, each with who can clear it and where; Enter (or a row's style × market) opens its checklist (cs-cell); the lines
 * as a file. Read only: no selection (nothing to do to several lines at once).
 */
export function AllActionsDialog({ model, actions }: { model: StatusModel; actions?: StatusActions | undefined }) {
  const t = useT('compliance-status')
  const read = model.allActions
  const board = model.board.status === 'ready' ? model.board.value : null
  const locale = useLocale()
  const latest = useRef({ model, actions, locale })
  latest.current = { model, actions, locale }
  const columns = useMemo((): ColDef<ActionLine>[] => {
    const SeverityCell = ({ data }: ICellRendererParams<ActionLine>) => (data ? <Tag tone={data.severity === 'BLOCKED' ? 'danger' : data.severity === 'MISSING' ? 'warning' : 'info'}>{t(`severity.${data.severity}`)}</Tag> : null)
    const LineCell = ({ data }: ICellRendererParams<ActionLine>) => {
      if (!data) return null
      const now = latest.current
      const value = now.model.board.status === 'ready' ? now.model.board.value : null
      const cell = cellOfLine(value, data)
      return (
        <span className="fw-cs-style">
          <button type="button" className="fw-cs-linkbutton" onClick={() => now.actions?.onCell?.({ styleId: data.styleId, market: data.marketCode })}>
            {lineHead(t, data, cell, marketName(data.marketCode, value?.markets ?? [], latest.current.locale))}
          </button>
          <span className="fw-cs-muted fw-cs-wrap">{cell?.first?.code === data.requirementCode ? `${data.requirementCode} · ${cell.first.message}` : data.requirementCode}</span>
        </span>
      )
    }
    const FixCell = ({ data }: ICellRendererParams<ActionLine>) => {
      if (!data) return null
      const now = latest.current
      const href = fixHref(data.fixPlace, now.model.prefix, now.model.can)
      return (
        <Button size="sm" heldReason={href ? null : t(fixHeld(data.fixPlace, now.model.can) ?? 'fix.held.settings')} onClick={() => (href ? now.actions?.onGo?.(href) : undefined)}>
          {t(`fixPlace.${data.fixPlace}`)}
        </Button>
      )
    }
    return [
      { colId: 'severity', headerName: t('all.col.severity'), cellRenderer: SeverityCell, sortable: false, width: 120, minWidth: 110, valueGetter: (params) => (params.data ? t(`severity.${params.data.severity}`) : '') },
      { colId: 'line', headerName: t('all.col.line'), cellRenderer: LineCell, sortable: false, flex: 2.6, minWidth: 280, valueGetter: (params) => (params.data ? `${params.data.styleCode} · ${params.data.marketCode} · ${params.data.requirementCode}` : '') },
      { colId: 'who', headerName: t('all.col.who'), sortable: false, flex: 0.8, minWidth: 120, valueGetter: (params) => (params.data ? t(`who.${params.data.who}`) : '') },
      { colId: 'fix', headerName: t('all.col.fix'), cellRenderer: FixCell, sortable: false, flex: 1.3, minWidth: 260 },
    ]
  }, [t])
  if (!read) return null
  const value = read.status === 'ready' ? read.value : null
  const state =
    read.status === 'error' ? (
      <Failed title={t('all.failed')} problem={read.problem} onRetry={() => actions?.onRetry?.('allActions')} />
    ) : value && value.lines.length === 0 ? (
      <EmptyState title={t('actions.empty')} description={t('actions.emptyBody')} />
    ) : undefined
  return (
    <Modal
      open
      onClose={() => actions?.onAllActions?.(false)}
      title={value ? t('all.title', { count: value.count }) : t('section.actions')}
      size="xxl"
      footer={
        <>
          <Button
            heldReason={value && value.lines.length > 0 ? null : t('all.exportHeld')}
            onClick={() => (value ? actions?.onExport?.('actions', [t('csv.severity'), t('csv.style'), t('csv.market'), t('csv.requirement'), t('csv.who'), t('csv.words')], actionsCsvRows(value.lines)) : undefined)}
          >
            <Download size={13} aria-hidden /> {t('all.export')}
          </Button>
          <Button variant="primary" onClick={() => actions?.onAllActions?.(false)}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="fw-cs-dialog">
        <p className="fw-cs-hint">{model.address.gap ? t('actions.hintGap', { gap: t(`gap.${model.address.gap}`) }) : t('all.intro')}</p>
        <ListFrame<ActionLine>
          label={t('section.actions')}
          listKey={null}
          rows={read.status === 'error' ? [] : (value?.lines ?? null)}
          rowId={(line) => `${line.styleId}|${line.marketCode}`}
          columns={columns}
          count={value ? t('all.count', { count: value.lines.length, total: value.count }) : '—'}
          onOpen={(line) => actions?.onCell?.({ styleId: line.styleId, market: line.marketCode })}
          state={state}
        />
        {board?.more ? <p className="fw-cs-hint">{t('matrix.more', { count: board.rows.length })}</p> : null}
      </div>
    </Modal>
  )
}

const EVIDENCE_KINDS = ['serial', 'batch'] as const

/**
 * "Show evidence for…" (design cs-find, the band's primary): one field for a garment serial or a batch number and the evidence
 * trail in a new tab (`/compliance/evidence/<serial|batch>/<number>`, W1's page). Other numbers (lot, work order, shipment,
 * style, certificate) open their own records from the board; the finder takes the two the trail reads.
 */
export function EvidenceFinder({ model, actions }: { model: StatusModel; actions?: StatusActions | undefined }) {
  const t = useT('compliance-status')
  const [kind, setKind] = useState<(typeof EVIDENCE_KINDS)[number]>('serial')
  const [value, setValue] = useState('')
  if (!model.finder) return null
  const number = value.trim()
  const href = `${model.prefix}/compliance/evidence/${kind}/${encodeURIComponent(number)}`
  const open = () => {
    if (!number) return
    window.open(href, '_blank', 'noopener')
    actions?.onFinder?.(false)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onFinder?.(false)}
      title={t('finder.title')}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onFinder?.(false)}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={number ? null : t('finder.held')} onClick={open}>
            <ExternalLink size={13} aria-hidden /> {t('finder.open')}
          </Button>
        </>
      }
    >
      <form
        className="fw-cs-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          open()
        }}
      >
        <Field label={t('finder.kind')} htmlFor="cs-finder-kind">
          <Select id="cs-finder-kind" size="sm" value={kind} onChange={(event) => setKind(event.target.value === 'batch' ? 'batch' : 'serial')}>
            {EVIDENCE_KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {t(`finder.kinds.${entry}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('finder.number')} hint={t('finder.hint')} htmlFor="cs-finder-number">
          <Input id="cs-finder-number" autoFocus value={value} maxLength={120} onChange={(event) => setValue(event.target.value)} />
        </Field>
      </form>
    </Modal>
  )
}

/** The page's keys (design kb: e — Show evidence for…; J / K, ⇧J / ⇧K in the cell modal). */
export function KeysDialog({ onClose }: { onClose: () => void }) {
  const t = useT('compliance-status')
  return (
    <Modal open onClose={onClose} title={t('keys.title')} size="sm">
      <dl className="fw-cs-keymap">
        {(
          [
            ['e', t('keys.evidence')],
            ['a', t('keys.arrange')],
            ['p', t('keys.print')],
            ['J / K', t('keys.cells')],
            ['⇧J / ⇧K', t('keys.rows')],
            ['?', t('keys.help')],
          ] as const
        ).map(([key, does]) => (
          <div key={key}>
            <dt>
              <kbd>{key}</kbd>
            </dt>
            <dd>{does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
