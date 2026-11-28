'use client'

import { ArrowRight, History } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { departmentByNo, unknownDepartment, type Department } from '../../department/model'
import { DeptChip } from '../../department/view/DeptChip'
import { useDepartmentWords } from '../../department/words'
import { StateChip } from '../../order-cells/view/StateChip'
import type { ReadPictures } from '../../record-picture/cache'
import type { PictureSource } from '../../record-picture/model'
import { RecordPicture } from '../../record-picture/view/RecordPicture'
import { logIconOf } from '../icons'
import { actionWordKeyOf, subjectKeyOf, whoViewOf, type ChangeLogState, type LogRow, type LogValue } from '../model'
import { useChangeLogWords, type ChangeLogWords } from '../words'
import '../change-log.css'

/** The log's view model: its state (use-change-log.ts), the departments (useDepartments), the record a picture value belongs to. */
export interface ChangeLogModel {
  readonly rows: ChangeLogState['rows']
  readonly status: ChangeLogState['status']
  readonly more: ChangeLogState['more']
  /** For a DEPT value and a DEPARTMENT face: the host's `useDepartments(api).departments` (the fixed table until it answers). */
  readonly departments: readonly Department[]
  /** The record whose picture a PICTURE value is (its batch read); absent: a picture value says its words. */
  readonly picture?: { readonly source: PictureSource; readonly recordId: string; readonly number: string; readonly read?: ReadPictures | null } | null
}

export interface ChangeLogActions {
  /** "Load more" (the next page by the answer's cursor); absent: no button. */
  readonly onMore?: () => void
  /** "Try again" after a failed read. */
  readonly onRetry?: () => void
}

/**
 * owb-b4 w4.4 (design § 8, § 5zk C, § 5zl; prototype ui.js logTable, fromTo) — the ONE change log of an order, in every door: on a PC a
 * table (when · who · what · from → to), on a phone a list — the part's OWN room decides (a container query: a narrow page beside an
 * open chat is a phone's room too), never the window. Who is drawn from the face only (a name on PERSON; "The factory", "You",
 * "Office", "Nexus"; a department's chip). One icon per action (the answer's lucide id; unknown: a plain dot). From → to as chips: a
 * life → the StateChip, a department → the DeptChip, a day, a text, a count, a picture → a small RecordPicture. A reason shows only
 * when the answer has one (a portal row never has: the server's wall). "Load more" through the host's port. It draws its model only.
 */
export function ChangeLog({ model, actions }: { model: ChangeLogModel; actions?: ChangeLogActions }) {
  const words = useChangeLogWords()
  const { t } = words
  if (model.rows.length === 0) {
    if (model.status === 'reading')
      return (
        <div className="fw-clog" aria-busy>
          <p className="fw-clog-quiet" role="status">
            <History className="fw-clog-icon" aria-hidden />
            {t('reading')}
          </p>
        </div>
      )
    if (model.status === 'failed')
      return (
        <div className="fw-clog">
          <p className="fw-clog-quiet" role="alert">
            {t('failed')}
          </p>
          {actions?.onRetry ? (
            <div className="fw-clog-more">
              <Button onClick={actions.onRetry}>{t('retry')}</Button>
            </div>
          ) : null}
        </div>
      )
    return (
      <div className="fw-clog">
        <p className="fw-clog-quiet">
          <History className="fw-clog-icon" aria-hidden />
          {t('empty')}
        </p>
      </div>
    )
  }
  return (
    <div className="fw-clog">
      <div className="fw-clog-scroll">
        <table className="fw-clog-table">
          <caption className="nds-vh">{t('caption')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('head.when')}</th>
              <th scope="col">{t('head.who')}</th>
              <th scope="col">{t('head.what')}</th>
              <th scope="col">{t('head.fromTo')}</th>
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr key={row.id} data-row={row.id}>
                <td className="fw-clog-when">
                  <time dateTime={row.at}>{words.when(row.at)}</time>
                </td>
                <td>
                  <Who row={row} model={model} words={words} />
                </td>
                <td>
                  <What row={row} words={words} mark />
                </td>
                <td>
                  <FromTo row={row} model={model} words={words} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="fw-clog-list" aria-label={t('caption')}>
        {model.rows.map((row) => (
          <li key={row.id} className="fw-clog-item" data-row={row.id}>
            <span className="fw-clog-mark">
              <ActionMark icon={row.icon} />
            </span>
            <div className="fw-clog-item-body">
              <What row={row} words={words} />
              <FromTo row={row} model={model} words={words} />
              <div className="fw-clog-meta">
                <Who row={row} model={model} words={words} />
                <span aria-hidden>·</span>
                <time dateTime={row.at}>{words.when(row.at)}</time>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <More model={model} actions={actions} words={words} />
    </div>
  )
}

function ActionMark({ icon }: { icon: string }) {
  const Icon = logIconOf(icon)
  return Icon ? <Icon className="fw-clog-icon" aria-hidden /> : <span className="fw-clog-dot" aria-hidden />
}

/** Who: from the face only. */
function Who({ row, model, words }: { row: LogRow; model: ChangeLogModel; words: ChangeLogWords }) {
  const dept = useDepartmentWords()
  const who = whoViewOf(row.who)
  if (who.kind === 'department') return <DeptChip dept={departmentByNo(model.departments, who.no) ?? unknownDepartment(who.no, dept('unknown', { no: who.no }))} />
  return <span className="fw-clog-who">{who.kind === 'name' ? who.name : words.t(who.key)}</span>
}

/** What: the action's icon (table) and words, the subject, and the reason when the answer has one. */
function What({ row, words, mark = false }: { row: LogRow; words: ChangeLogWords; mark?: boolean }) {
  const subject = subjectKeyOf(row.subject)
  return (
    <span className="fw-clog-what">
      <span className="fw-clog-action">
        {mark ? <ActionMark icon={row.icon} /> : null}
        <span>{words.t(actionWordKeyOf(row.action))}</span>
      </span>
      {row.subject.label ? (
        <span className="fw-clog-subject">
          {subject ? `${words.t(subject)} ` : ''}
          <span className="fw-clog-label">{row.subject.label}</span>
        </span>
      ) : null}
      {row.reason ? <span className="fw-clog-reason">{row.reason}</span> : null}
    </span>
  )
}

/** From → to as chips; the words a screen reader hears say "from" and "to". */
function FromTo({ row, model, words }: { row: LogRow; model: ChangeLogModel; words: ChangeLogWords }) {
  if (!row.from && !row.to) return <span className="fw-clog-none">—</span>
  return (
    <span className="fw-clog-fromto">
      {row.from ? (
        <>
          <span className="nds-vh">{words.t('fromTo.from')}</span>
          <span className="fw-clog-from">
            <Value value={row.from} model={model} words={words} />
          </span>
          <ArrowRight className="fw-clog-arrow" aria-hidden />
        </>
      ) : null}
      <span className="nds-vh">{words.t('fromTo.to')}</span>
      <span className="fw-clog-to">{row.to ? <Value value={row.to} model={model} words={words} /> : <Tag tone="neutral">{words.t('value.none')}</Tag>}</span>
    </span>
  )
}

function Value({ value, model, words }: { value: LogValue; model: ChangeLogModel; words: ChangeLogWords }) {
  const dept = useDepartmentWords()
  switch (value.kind) {
    case 'LIFE':
      return <StateChip life={value.life} />
    case 'DEPT':
      return <DeptChip dept={departmentByNo(model.departments, value.no) ?? unknownDepartment(value.no, dept('unknown', { no: value.no }))} />
    case 'DATE':
      return <Tag tone="neutral">{words.day(value.date)}</Tag>
    case 'TEXT':
      return (
        <Tag tone="neutral" truncate title={value.text}>
          {value.text}
        </Tag>
      )
    case 'COUNT':
      return <Tag tone="neutral">{words.count(value.n)}</Tag>
    case 'PICTURE': {
      if (value.fileId === null) return <Tag tone="neutral">{words.t('value.design')}</Tag>
      const host = model.picture
      if (!host) return <Tag tone="neutral">{words.t('value.picture')}</Tag>
      return <RecordPicture source={host.source} recordId={host.recordId} number={host.number} picture={{ styleId: value.fileId, styleCode: '', styleName: words.t('value.picture'), fileId: value.fileId, small: true }} size="log" read={host.read} />
    }
  }
}

/** "Load more" by the cursor; a failed page says so and offers "Try again". */
function More({ model, actions, words }: { model: ChangeLogModel; actions?: ChangeLogActions; words: ChangeLogWords }) {
  if (model.more === 'none' || !actions?.onMore) return null
  const failed = model.more === 'failed'
  return (
    <div className="fw-clog-more" aria-busy={model.more === 'reading' || undefined}>
      {failed ? (
        <p className="fw-clog-quiet" role="alert">
          {words.t('moreFailed')}
        </p>
      ) : null}
      <Button onClick={failed ? (actions.onRetry ?? actions.onMore) : actions.onMore} heldReason={model.more === 'reading' ? words.t('moreReading') : null}>
        {failed ? words.t('retry') : words.t('more')}
      </Button>
    </div>
  )
}
