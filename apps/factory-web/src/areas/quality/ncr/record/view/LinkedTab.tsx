'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Link2, Lock, Unlink } from 'lucide-react'
import { Card, SummaryTable } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import type { NcrLink, NcrRecord } from '../../api'
import { isOpenStage, recordLabel, type Say } from '../../model'
import { holdStatusKey, isSourceLink, linkGroupsOf, recordHref, type LinkGroup, type NcrRecordActions, type NcrRecordModel } from '../view-model'
import type { RecordWords } from './words'

/**
 * Linked records (design rec NCR › linked, ncr-links: "EntityLinks grouped: source inspection · holds · rework orders ·
 * complaint · CAPA · supplier · lots · shipments · PPE register entry"): every record this NCR touches, in groups, each a
 * real link (its own page once built, else the record panel). Link… finds a record by number (global search, the kinds an
 * NCR links); Unlink is kept in Activity; the source stays linked. The holds this NCR decides close with it, or now.
 */
export function LinkedTab({ model, record, words, actions }: { model: NcrRecordModel; record: NcrRecord; words: RecordWords; actions?: NcrRecordActions }) {
  const { t, r, say, person, when } = words
  const ncr = record.ncr
  const groups = linkGroupsOf(record)
  const frozen: Say | null = !isOpenStage(ncr.stage) ? { key: 'held.frozen', params: { stage: ncr.stage } } : null
  const linkHeld = frozen ?? (model.can.raise ? null : { key: 'held.noRaise' })
  const unlinkHeld = frozen ?? (model.can.manage ? null : { key: 'held.noManage' })
  // The notes the factory writes itself ("Decision 2", "Line 10") in our words; a person's note as typed.
  const noteWords = (note: string | null): string => {
    if (!note) return '—'
    const decision = /^Decision (\d+)$/.exec(note)
    if (decision) return r('linked.noteDecision', { seq: decision[1]! })
    const line = /^Line (\d+)$/.exec(note)
    return line ? r('linked.noteLine', { seq: line[1]! }) : note
  }
  const hrefOf = (link: Pick<NcrLink, 'recordType' | 'recordId' | 'label'>) => recordHref(model.prefix, { type: link.recordType, id: link.recordId, label: link.label })

  const linkRows = (links: readonly NcrLink[]) =>
    links.map((link) => ({
      id: link.id,
      cells: [
        t(`recordType.${link.recordType}`),
        <Link key="record" className="fw-q-link" href={hrefOf(link)}>
          {recordLabel(t, link.recordType, link.label)}
        </Link>,
        noteWords(link.note),
        `${when(link.createdAt)} · ${person(link.createdById)}`,
        isSourceLink(record, link) ? (
          <span key="source" className="fw-ncr-r-sub">
            <Lock size={12} aria-hidden /> {r('linked.sourceStays')}
          </span>
        ) : (
          <Button key="unlink" size="xs" variant="quiet" heldReason={say(unlinkHeld)} aria-label={r('linked.unlinkOne', { label: recordLabel(t, link.recordType, link.label) })} onClick={() => actions?.onUnlink?.(link.id)}>
            <Unlink size={13} aria-hidden /> {r('linked.unlink')}
          </Button>
        ),
      ],
    }))

  const group = (id: LinkGroup, title: string, empty: string, extra?: ReactNode) => (
    <Card padded key={id}>
      <section className="fw-q-stack" aria-labelledby={`ncr-links-${id}`}>
        <h2 id={`ncr-links-${id}`} className="fw-ncr-h3">
          {title}
        </h2>
        {extra}
        {groups[id].length === 0 ? (
          <p className="fw-q-hint">{empty}</p>
        ) : (
          <SummaryTable label={title} density="roomy" stackOnPhone columns={[r('col.type'), r('col.record'), r('col.note'), r('col.linked'), t('col.actions')]} widths={['18%', '24%', '24%', '20%', undefined]} rows={linkRows(groups[id])} />
        )}
      </section>
    </Card>
  )

  const sourceWithoutLink = groups.source.length === 0 && ncr.sourceType && ncr.sourceId

  return (
    <div className="fw-q-stack">
      <div className="fw-ncr-head">
        <p className="fw-q-hint">{r('linked.intro')}</p>
        <Button size="sm" variant="primary" heldReason={say(linkHeld)} onClick={() => actions?.onDialog?.({ kind: 'link', query: '', hits: null, searching: false, picked: null, note: '', busy: false, notice: null })}>
          <Link2 size={14} aria-hidden /> {r('linked.link')}
        </Button>
      </div>
      {group(
        'source',
        r('linked.source'),
        sourceWithoutLink ? '' : r('linked.sourceNone'),
        sourceWithoutLink ? (
          <p>
            <Link className="fw-q-link" href={recordHref(model.prefix, { type: ncr.sourceType!, id: ncr.sourceId! })}>
              {t(`recordType.${ncr.sourceType}`)}
            </Link>
          </p>
        ) : null,
      )}
      <Card padded>
        <section className="fw-q-stack" aria-labelledby="ncr-links-holds">
          <h2 id="ncr-links-holds" className="fw-ncr-h3">
            {r('linked.holds')}
          </h2>
          {record.holds.length === 0 ? (
            <p className="fw-q-hint">{r('linked.holdsNone')}</p>
          ) : (
            <SummaryTable
              label={r('linked.holds')}
              density="roomy"
              stackOnPhone
              columns={[r('col.hold'), r('col.reason'), r('col.state'), r('col.placed'), t('col.actions')]}
              widths={['22%', '28%', '16%', '16%', undefined]}
              rows={record.holds.map((hold) => ({
                id: hold.id,
                cells: [
                  <Link key="hold" className="fw-q-link" href={recordHref(model.prefix, { type: 'QualityHold', id: hold.id })}>
                    {r('linked.holdOf', { type: t(`recordType.${hold.subjectType}`), count: hold.subjectIds.length })}
                  </Link>,
                  [hold.reasonCode, hold.reasonNote].filter(Boolean).join(' · '),
                  <Tag key="state" tone={hold.status === 'ACTIVE' ? 'warning' : 'neutral'}>
                    {r(holdStatusKey(hold.status))}
                  </Tag>,
                  when(hold.placedAt),
                  hold.status === 'ACTIVE' && hold.decidedHere ? (
                    <Button key="close" size="xs" heldReason={say(unlinkHeld)} onClick={() => actions?.onDialog?.({ kind: 'closeHold', holdId: hold.id, note: '', busy: false, notice: null })}>
                      {r('linked.closeHold')}
                    </Button>
                  ) : (
                    <span key="none" className="fw-ncr-r-sub">
                      {hold.decidedHere ? r('linked.holdDone') : r('linked.holdOther')}
                    </span>
                  ),
                ],
              }))}
            />
          )}
          <p className="fw-q-hint">{r('linked.holdsHint')}</p>
        </section>
      </Card>
      {group('follow', r('linked.follow'), r('linked.followNone'))}
      {group('other', r('linked.other'), r('linked.otherNone'))}
      <Card padded>
        <section className="fw-q-stack" aria-labelledby="ncr-links-register">
          <h2 id="ncr-links-register" className="fw-ncr-h3">
            {r('linked.register')}
          </h2>
          {record.register ? (
            <p>
              <Link className="fw-q-link" href={recordHref(model.prefix, { type: 'PpeRegisterEntry', id: record.register.id, label: record.register.reference })}>
                {record.register.reference}
              </Link>{' '}
              <Tag tone="info">{r(record.register.status === 'CLOSED' ? 'register.CLOSED' : 'register.OPEN')}</Tag>
            </p>
          ) : (
            <p className="fw-q-hint">{ncr.style?.ppe ? r('linked.registerPpe') : r('side.registerNotPpe')}</p>
          )}
        </section>
      </Card>
    </div>
  )
}
