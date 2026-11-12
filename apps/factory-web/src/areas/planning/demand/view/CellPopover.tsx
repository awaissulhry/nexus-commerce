'use client'

import Link from 'next/link'
import { ExternalLink, Lock } from 'lucide-react'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import { documentWords, kindLayer, kindsWords, kindWords, listOnCellOf, pieces, piecesWords, POPOVER_SHOWN, queryOf, recordHref, shownKinds, sizeWords, whenWords, type GridLine, type Words } from '../model'
import type { SourceRow } from '../api'
import type { DemandActions, DemandModel, DemandPopover } from '../view-model'

/**
 * "What makes this number" (design planning.demand sec:phased, the cell popover): the cell's sources in our words ("3 orders,
 * 1 remake · 38 pieces", from the kinds the API counted, those of the layers shown), then the first sources with their
 * documents — each a real link to its record (record-links), so ⌘-click opens the source document in a new tab (design
 * tab:source) and the ↗ opens it there at once; a source the person may not open says so (held, never a dead link). "Show all
 * in Demand rows" narrows the list below to this cell.
 */
export function CellPopover({ model, actions, words, line, bucketName, popover }: { model: DemandModel; actions?: DemandActions; words: Words; line: GridLine; bucketName: string; popover: DemandPopover }) {
  const { t } = words
  const layers = model.controls.layers
  const title = `${line.kind === 'size' ? `${line.row.style.code} · ${line.row.colourway?.name ?? t('grid.anyColour')} · ${line.size === null ? t('grid.mtm') : t('grid.size', { size: line.size ?? '' })}` : `${line.row.style.code} · ${line.row.colourway?.name ?? t('grid.anyColour')}`} · ${bucketName}`

  if (popover.rows.status === 'loading') {
    return (
      <div className="fw-dm-pop" aria-busy="true">
        <b>{title}</b>
        <p className="fw-dm-hint" role="status">
          {t('popover.loading')}
        </p>
        <Skeleton height={16} />
        <Skeleton height={16} />
      </div>
    )
  }
  if (popover.rows.status === 'error') {
    return (
      <div className="fw-dm-pop">
        <b>{title}</b>
        <p className="fw-dm-hint" role="alert">
          {t('popover.error')} {t(popover.rows.problem)}
        </p>
        <Button size="sm" onClick={() => actions?.onRetryCell?.()}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }
  const answer = popover.rows.value
  const kinds = shownKinds(answer.kinds, layers)
  const rows = answer.rows.filter((row) => layers.includes(kindLayer(row.kind)))
  const total = kinds.reduce((sum, entry) => sum + entry.pieces, 0)
  const more = kinds.reduce((sum, entry) => sum + entry.sources, 0) - Math.min(rows.length, POPOVER_SHOWN)
  const toList = `${model.prefix}/planning/demand?${queryOf(listOnCellOf(model.controls, line, popover.ref.bucket))}#fw-dm-list`

  return (
    <div className="fw-dm-pop">
      <b>{title}</b>
      <p className="fw-dm-pop-sum">
        {kinds.length > 0 ? t('popover.sum', { kinds: kindsWords(kinds, t), pieces: piecesWords(total, words) }) : t('popover.none')}
      </p>
      {rows.length > 0 && (
        <ul className="fw-dm-pop-list">
          {rows.slice(0, POPOVER_SHOWN).map((row) => (
            <SourceLine key={row.key} row={row} model={model} words={words} />
          ))}
        </ul>
      )}
      {more > 0 && <p className="fw-dm-hint">{t('popover.more', { count: more })}</p>}
      <div className="fw-dm-pop-foot">
        <Button
          size="sm"
          asChild
        >
          <Link
            href={toList}
            onClick={(event) => {
              if (!actions?.onList || event.metaKey || event.ctrlKey || event.shiftKey) return
              event.preventDefault()
              const next = listOnCellOf(model.controls, line, popover.ref.bucket)
              actions.onCell?.(null)
              actions.onList({ layer: next.layer, rq: next.rq, style: next.style, colour: next.colour, size: next.size, mtm: next.mtm, cell: next.cell })
              document.getElementById('fw-dm-list')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
            }}
          >
            {t('popover.showAll')}
          </Link>
        </Button>
        <span className="fw-dm-hint">{t('popover.newTab')}</span>
      </div>
    </div>
  )
}

function SourceLine({ row, model, words }: { row: SourceRow; model: DemandModel; words: Words }) {
  const { t, locale } = words
  const when = whenWords(row, words)
  const doc = documentWords(row, t)
  const href = recordHref(model.prefix, model.built, row.source)
  return (
    <li className="fw-dm-pop-row">
      <span className="fw-dm-pop-main">
        <Pill tone={row.layer === 'QUOTES' ? 'neutral' : row.layer === 'REMAKES' ? 'warning' : row.layer === 'SAMPLES' ? 'info' : 'success'}>{kindWords(row, t)}</Pill>
        {row.source.mayOpen ? (
          <>
            <Link className="fw-dm-link" href={href}>
              {doc}
            </Link>
            <a className="fw-dm-newtab" href={href} target="_blank" rel="noreferrer" aria-label={t('popover.openNewTab', { doc })} title={t('popover.openNewTab', { doc })}>
              <ExternalLink size={12} aria-hidden />
            </a>
          </>
        ) : (
          <span className="fw-dm-held" title={t('rows.mayNotOpen')} aria-label={`${doc} — ${t('rows.mayNotOpen')}`}>
            <Lock size={11} aria-hidden /> {doc}
          </span>
        )}
      </span>
      <span className="fw-dm-sub">
        {t('popover.line', { pieces: pieces(row.pieces, locale), size: sizeWords(row, t), day: when.day })}
        {when.late ? ` · ${when.late}` : ''}
        {row.party ? ` · ${row.party.name}` : ''}
        {row.origin ? ` · ${t('rows.from', { origin: row.origin.number })}` : ''}
      </span>
    </li>
  )
}
