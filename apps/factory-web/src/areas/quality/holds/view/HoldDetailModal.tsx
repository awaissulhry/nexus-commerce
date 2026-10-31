'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, FileSearch, GitBranch, Printer, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Banner, KeyValue, SummaryTable } from '@nexus/ui/components'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Input, Kbd, Select, Tag, Textarea } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { CheckList, type CheckLine } from '../../_shared/parts'
import type { Read } from '../../_shared/model'
import type { Hold, HoldDetail } from '../api'
import {
  blocksKey,
  changeHeld,
  checkLineKey,
  checkNameKey,
  evidenceOf,
  kindKey,
  nounKey,
  ownerWords,
  placedByKey,
  quantityWords,
  quarantineKey,
  reasonText,
  releasedByKey,
  releaseHeld,
  sourceKey,
  SOURCE_RECORD,
  SUBJECT_RECORD,
  tagAddress,
  traceOf,
  type HoldsListModel,
  type RecordTab,
} from '../model'
import type { HoldsListActions } from './HoldsView'
import { HoldPill, SaveMark } from './parts'

const NOBODY = '__nobody__'

/** The hold's release checks as CheckList lines: our words per check, the API's sentence under them (data). */
export function checkLines(detail: Pick<HoldDetail, 'release'>, t: (key: string, params?: Record<string, string | number>) => string): CheckLine[] {
  return detail.release.checks.map((check) => ({
    id: check.key,
    state: check.key === 'STATEMENT' && !check.ok ? 'UNKNOWN' : check.ok ? 'OK' : 'OPEN',
    word: check.key === 'STATEMENT' && !check.ok ? 'check.NOT_YET' : undefined,
    name: t(checkNameKey(check.key)),
    text: (
      <>
        {t(checkLineKey(check.key, check.ok))}
        <span className="fw-q-hint fw-hd-api"> {check.words}</span>
      </>
    ),
    fix: check.ok ? null : t(`check.${check.key}.fix`),
  }))
}

/**
 * A hold (design quality.holds "Hold" record, §2.3: holds are reviewed in sequence, so a DetailModal at
 * `/quality/holds?open=<id>&tab=hold|decision|activity`): Hold — why, on what, by whom, until when, the quarantine move,
 * the work orders it holds; owner, expected release and note saved as they change. Decision — what must be true to
 * release it (the GateExplainer: each check in our words with the API's sentence under it), the four-eyes and maker
 * lines, Release… (held with the first open check) and Decide in NCR for reject, rework or scrap. Activity — the hold's
 * thread, files and history (the record panels). "Affected" (the trace of what it touches) comes with W2b. J / K walk the
 * list; r opens the release.
 */
export function HoldDetailModal({
  open,
  id,
  detail,
  tab,
  model,
  panels,
  nav,
  actions,
}: {
  open: boolean
  id: string
  detail: Read<HoldDetail>
  tab: RecordTab
  model: HoldsListModel
  panels?: ReactNode
  nav: readonly string[] | null
  actions?: HoldsListActions
}) {
  const t = useT('holds')
  const q = useT('quality')
  const locale = useLocale()
  const value = detail.value
  const hold = value?.hold ?? null
  const index = nav ? nav.indexOf(id) : -1
  const prev = nav && index > 0 ? nav[index - 1]! : null
  const next = nav && index >= 0 && index < nav.length - 1 ? nav[index + 1]! : null
  const release = hold && value ? releaseHeld(hold, value, model.can) : null
  const releaseText = release ? t(release.key, release.params) : null

  // J / K walk the list, r opens the release (not while typing, not inside a menu or another dialog).
  const latest = useRef({ prev, next, releaseText, hold, actions, open })
  latest.current = { prev, next, releaseText, hold, actions, open }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const now = latest.current
      if (!now.open || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"]') || target.isContentEditable)) return
      const key = event.key.toLowerCase()
      if (key === 'j' && now.next) {
        event.preventDefault()
        now.actions?.onOpen?.(now.next)
      } else if (key === 'k' && now.prev) {
        event.preventDefault()
        now.actions?.onOpen?.(now.prev)
      } else if (key === 'r' && now.hold && !now.releaseText) {
        event.preventDefault()
        now.actions?.onDialog?.({ kind: 'release', ids: [now.hold.id] })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const tabs = [
    { id: 'hold', label: t('detail.tab.hold') },
    { id: 'decision', label: t('detail.tab.decision'), count: value ? value.release.checks.filter((check) => !check.ok).length || null : null },
    { id: 'activity', label: t('detail.tab.activity') },
  ]
  const codes = hold ? `${hold.subjects.map((subject) => subject.label ?? '—').slice(0, 3).join(', ')}${hold.subjects.length > 3 ? ` ${t('subject.more', { count: hold.subjects.length - 3 })}` : ''}` : ''
  const title = hold ? (hold.subjects.length === 1 ? `${t(kindKey(hold.subjectType))} ${codes}` : `${hold.subjects.length} ${t(nounKey(hold.subjectType), { count: hold.subjects.length })}: ${codes}`) : t('detail.title')
  return (
    <DetailModal
      open={open}
      onClose={() => actions?.onOpen?.(null)}
      title={title}
      subtitle={hold ? t('detail.subtitle', { reason: reasonText(hold, model.reasons, locale), date: formatDate(hold.placedAt, { locale }) }) : undefined}
      meta={
        hold ? (
          <span className="fw-q-tags">
            <HoldPill hold={hold} />
            {hold.quarantine !== 'NOT_NEEDED' && <Tag tone={hold.quarantine === 'MOVED' ? 'success' : 'warning'}>{t(quarantineKey(hold))}</Tag>}
          </span>
        ) : undefined
      }
      actions={
        <>
          <span className="fw-q-cell-row">
            <Button size="sm" variant="quiet" aria-label={t('detail.prev')} heldReason={prev ? null : t('detail.firstOne')} onClick={() => prev && actions?.onOpen?.(prev)} aria-keyshortcuts="k">
              <ChevronUp size={16} aria-hidden /> <Kbd>K</Kbd>
            </Button>
            <Button size="sm" variant="quiet" aria-label={t('detail.next')} heldReason={next ? null : t('detail.lastOne')} onClick={() => next && actions?.onOpen?.(next)} aria-keyshortcuts="j">
              <ChevronDown size={16} aria-hidden /> <Kbd>J</Kbd>
            </Button>
          </span>
          {hold && (
            <Button size="sm" variant="primary" heldReason={releaseText} onClick={() => actions?.onDialog?.({ kind: 'release', ids: [hold.id] })} aria-keyshortcuts="r">
              <ShieldCheck size={14} aria-hidden /> {t('detail.release')} <Kbd>R</Kbd>
            </Button>
          )}
        </>
      }
      tabs={tabs}
      activeTab={tab}
      onTabChange={(next) => actions?.onTab?.(next as RecordTab)}
      tabsLabel={t('detail.tabsLabel')}
      loading={detail.value === null && !detail.problem}
      error={detail.problem ? q(detail.problem) : undefined}
      onRetry={actions?.onRetryDetail}
    >
      {value && hold && (
        <div className="fw-q-stack">
          {tab === 'hold' && <HoldTab value={value} model={model} actions={actions} />}
          {tab === 'decision' && <DecisionTab value={value} model={model} actions={actions} releaseText={releaseText} />}
          {tab === 'activity' && (panels ?? <p className="fw-q-hint">{model.can.threadsRead ? t('detail.activityLater') : t('held.noThreads')}</p>)}
        </div>
      )}
    </DetailModal>
  )
}

function HoldTab({ value, model, actions }: { value: HoldDetail; model: HoldsListModel; actions?: HoldsListActions }) {
  const t = useT('holds')
  const locale = useLocale()
  const hold = value.hold
  const held = value.canChange ? null : changeHeld(hold, model.can) ?? 'held.noPlace'
  const people = model.people[hold.siteId]
  const owner = ownerWords(hold, model.me)
  const source = hold.sourceType as keyof typeof SOURCE_RECORD | null
  const sourceHref = source && hold.sourceId && SOURCE_RECORD[source] ? `${model.prefix}${recordAddress({ type: SOURCE_RECORD[source], id: hold.sourceId }, OFFICE_PAGES)}` : null
  const trace = traceOf(model.prefix, hold)
  const evidence = evidenceOf(model.prefix, hold, value)
  const tag = tagAddress(model.prefix, [hold.id])
  const released = releasedByKey(hold, model.me)
  useEffect(() => {
    if (!held && people === undefined) actions?.onNeedPeople?.(hold.siteId)
  }, [held, people, hold.siteId, actions])

  const subjects = (
    <span className="fw-hd-links">
      {hold.subjects.map((subject) => (
        <Link key={subject.id} className="fw-q-link fw-q-code" href={`${model.prefix}${recordAddress({ type: SUBJECT_RECORD[hold.subjectType], id: subject.id, label: subject.label ?? undefined, companyId: hold.companyId, siteId: hold.siteId }, OFFICE_PAGES)}`}>
          {subject.label ?? '—'}
        </Link>
      ))}
    </span>
  )
  const ownerField = held ? (
    t(owner.key, owner.params)
  ) : (
    <span className="fw-q-cell-row">
      <Select size="sm" aria-label={t('detail.owner')} value={hold.ownerId ?? NOBODY} onChange={(event) => actions?.onOwner?.(hold, event.target.value === NOBODY ? null : event.target.value)}>
        <option value={NOBODY}>{t('owner.nobody')}</option>
        {hold.ownerId && !(people?.value ?? []).some((person) => person.id === hold.ownerId) && <option value={hold.ownerId}>{t(owner.key, owner.params)}</option>}
        {(people?.value ?? []).map((person) => (
          <option key={person.id} value={person.id}>
            {person.me ? t('owner.meNamed', { name: person.name }) : person.name}
          </option>
        ))}
      </Select>
      <SaveMark mark={model.cells[`${hold.id}:owner`]} />
    </span>
  )
  const expectedField = held ? (
    hold.expectedReleaseOn ? formatDate(hold.expectedReleaseOn, { locale }) : t('expected.none')
  ) : (
    <span className="fw-q-cell-row">
      <Input
        size="sm"
        type="date"
        min={model.today}
        aria-label={t('detail.expected')}
        defaultValue={hold.expectedReleaseOn ?? ''}
        key={`${hold.id}:${hold.version}`}
        onBlur={(event) => {
          const day = event.target.value || null
          if (day !== hold.expectedReleaseOn) actions?.onExpected?.(hold, day)
        }}
      />
      <SaveMark mark={model.cells[`${hold.id}:expected`]} />
    </span>
  )
  return (
    <>
      {held && hold.status === 'ACTIVE' && <p className="fw-q-hint">{t(held)}</p>}
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('detail.records', { count: hold.subjects.length }), value: subjects, hint: t(nounKey(hold.subjectType), { count: hold.subjects.length }) },
          { label: t('detail.quantity'), value: quantityWords(hold.quantity, t) ?? '—' },
          { label: t('detail.blocks'), value: t(blocksKey(hold.subjectType)) },
          { label: t('detail.reason'), value: reasonText(hold, model.reasons, locale), hint: hold.reasonNote ?? undefined },
          {
            label: t('detail.source'),
            value: sourceHref ? (
              <Link className="fw-q-link" href={sourceHref}>
                {t(sourceKey(hold))}
              </Link>
            ) : (
              t(sourceKey(hold))
            ),
          },
          { label: t('detail.placed'), value: t(placedByKey(hold, model.me)), hint: formatDateTime(hold.placedAt, { locale }) },
          { label: t('detail.owner'), value: ownerField },
          { label: t('detail.expected'), value: expectedField, hint: hold.overdue ? t('expected.overdue') : undefined },
          {
            label: t('detail.quarantine'),
            value: t(quarantineKey(hold)),
            hint:
              hold.quarantine === 'NOT_NEEDED'
                ? undefined
                : [hold.quarantineLocation ? `${hold.quarantineLocation.code} · ${hold.quarantineLocation.name}` : t('move.noPlace'), hold.quarantine === 'MOVED' && hold.quarantineMovedAt ? t('move.movedAt', { at: formatDateTime(hold.quarantineMovedAt, { locale }) }) : t('move.notConfirmed')].join(' · '),
          },
          { label: t('detail.site'), value: hold.site ? `${hold.site.code} · ${hold.site.name}` : '—' },
          ...(hold.status === 'RELEASED' && released ? [{ label: t('detail.released'), value: t(released), hint: [hold.releasedAt ? formatDateTime(hold.releasedAt, { locale }) : null, hold.releaseNote].filter(Boolean).join(' · ') || undefined }] : []),
          ...(hold.status === 'CLOSED' ? [{ label: t('detail.closed'), value: hold.closedAt ? formatDateTime(hold.closedAt, { locale }) : '—', hint: hold.closeNote ?? undefined }] : []),
        ]}
      />
      <div className="fw-q-section">
        <div className="fw-q-section-title">
          <strong>{t('detail.note')}</strong>
        </div>
        {held ? (
          <p className="fw-q-hint">{hold.note ?? t('detail.noNote')}</p>
        ) : (
          <span className="fw-hd-note">
            <Textarea
              rows={3}
              aria-label={t('detail.note')}
              defaultValue={hold.note ?? ''}
              key={`${hold.id}:note:${hold.version}`}
              onBlur={(event) => {
                const note = event.target.value.trim() || null
                if (note !== hold.note) actions?.onNote?.(hold, note)
              }}
            />
            <SaveMark mark={model.cells[`${hold.id}:note`]} />
          </span>
        )}
      </div>
      {value.workOrders.length > 0 && (
        <div className="fw-q-section">
          <div className="fw-q-section-title">
            <strong>{t('detail.workOrders')}</strong>
            <p className="fw-q-hint">{t('detail.workOrdersHint')}</p>
          </div>
          <SummaryTable
            label={t('detail.workOrders')}
            stackOnPhone
            columns={[t('detail.wo.number'), t('detail.wo.status'), t('detail.wo.heldFrom'), t('detail.wo.byThis')]}
            rows={value.workOrders.map((order) => ({
              id: order.id,
              cells: [
                <Link key="n" className="fw-q-link fw-q-code" href={`${model.prefix}${recordAddress({ type: 'WorkOrder', id: order.id, label: order.number }, OFFICE_PAGES)}`}>
                  {order.number}
                </Link>,
                t(`woStatus.${order.status}`),
                order.heldFromStatus ? t(`woStatus.${order.heldFromStatus}`) : '—',
                order.heldByThis ? t('detail.wo.yes') : order.status === 'ON_HOLD' ? t('detail.wo.other') : t('detail.wo.keeps'),
              ],
            }))}
          />
        </div>
      )}
      <div className="fw-q-actions">
        {tag && (
          <Button size="sm" onClick={() => window.open(tag, '_blank')}>
            <Printer size={14} aria-hidden /> {t('detail.tag')}
          </Button>
        )}
        <Button size="sm" heldReason={trace.held ? t(trace.held) : null} onClick={() => trace.href && window.open(trace.href, '_blank')}>
          <GitBranch size={14} aria-hidden /> {t('detail.trace')}
        </Button>
        <Button size="sm" heldReason={evidence.held ? t(evidence.held) : null} onClick={() => evidence.href && window.open(evidence.href, '_blank')}>
          <FileSearch size={14} aria-hidden /> {t('detail.evidence')}
        </Button>
      </div>
    </>
  )
}

function DecisionTab({ value, model, actions, releaseText }: { value: HoldDetail; model: HoldsListModel; actions?: HoldsListActions; releaseText: string | null }) {
  const t = useT('holds')
  const hold = value.hold
  const ncrHref = hold.ncrId ? `${model.prefix}${recordAddress({ type: 'Nonconformance', id: hold.ncrId }, OFFICE_PAGES)}` : null
  const ncrHeld = !model.can.ncrRaise ? t('held.noNcr') : hold.status !== 'ACTIVE' ? t('held.notActive') : null
  return (
    <>
      {hold.status !== 'ACTIVE' ? (
        <Banner tone="info" title={t(hold.status === 'RELEASED' ? 'decision.released' : 'decision.closed')}>
          {hold.status === 'RELEASED' ? (hold.releaseNote ?? t('decision.noNote')) : (hold.closeNote ?? t('decision.noNote'))}
        </Banner>
      ) : (
        <p className="fw-q-hint">{t('decision.intro')}</p>
      )}
      <div className="fw-q-section">
        <div className="fw-q-section-title">
          <strong>{t('decision.checks')}</strong>
        </div>
        <CheckList checks={checkLines(value, t)} label={t('decision.checks')} />
      </div>
      <div className="fw-q-section">
        <div className="fw-q-section-title">
          <strong>{t('decision.whoTitle')}</strong>
        </div>
        <ol className="fw-q-lines">
          <li>{t('decision.who.placed', { who: t(placedByKey(hold, model.me)) })}</li>
          <li>{t(value.release.mayRelease ? 'decision.who.youMay' : model.can.holdsRelease ? 'decision.who.notHere' : 'decision.who.quality')}</li>
          <li>{t('decision.who.rule')}</li>
        </ol>
      </div>
      <div className="fw-q-actions">
        <Button variant="primary" heldReason={releaseText} onClick={() => actions?.onDialog?.({ kind: 'release', ids: [hold.id] })}>
          <ShieldCheck size={14} aria-hidden /> {t('detail.release')}
        </Button>
        {ncrHref ? (
          <Link className="fw-q-link" href={ncrHref}>
            {t('decision.openNcr')}
          </Link>
        ) : (
          <Button heldReason={ncrHeld} onClick={() => actions?.onRaiseNcr?.(hold as Hold)}>
            <TriangleAlert size={14} aria-hidden /> {t('decision.raiseNcr')}
          </Button>
        )}
      </div>
      <p className="fw-q-hint">{t('decision.ncrHint')}</p>
    </>
  )
}
