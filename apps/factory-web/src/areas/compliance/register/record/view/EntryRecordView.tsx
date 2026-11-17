'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, Pencil, Siren } from 'lucide-react'
import { Banner, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { CheckList, Freshness, NoticeBanner, RecordProblem, RecordSkeleton, Section, type CheckLine } from '../../../../quality/_shared/parts'
import { evidenceAddress } from '../../../../quality/_shared/model'
import { actionHeld, ACTIONS, dutyState, evidenceSubject, nextAction, sourceKey, sourceLink, type EntryAction, type EntryRecordModel, type RecordTab } from '../../model'
import { DayText, RegisterMessages, RiskTag, StatusPill, TraceTables } from '../../view/parts'
import { EntryDialogs, type DialogsActions } from './dialogs'
// B-W2b-271: the entry's W2b parts — the Authority notices tab, recall progress and the distributor log, their dialogs.
import type { Notice } from '../../../../quality/_shared/model'
import { authorityCount, recallAddress, recallVerb } from '../../depth/model'
import { ActionsDepth } from '../../depth/view/ActionsDepth'
import { AuthorityTab } from '../../depth/view/AuthorityTab'
import { DepthDialogs } from '../../depth/view/DepthDialogs'
import type { DepthActions, DepthModel } from '../../depth/view/types'
// ---- B-TH-267: the register entry on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../_shared/record-frame/RecordNotices'

/** B-W2b-271: the depth parts as the record mounts them (absent: a W1 record, as before). */
export interface EntryDepth {
  readonly model: DepthModel
  readonly actions?: DepthActions
  readonly notice?: Notice | null
  readonly onDismissNotice?: () => void
}

export interface EntryRecordActions extends DialogsActions {
  onDialog?: (action: EntryAction | null) => void
  onCopy?: (text: string) => void
  onReload?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-113 a PPE register entry (design compliance.register › Register entry, W1), on RecordFrame (B-TH-267; the rule of picture 38,
 * the tabs of 08-tabs O-CMP-REG): the band in the shell's band row (‹ PPE register, the reference with its kind and style, ONE status
 * pill; the risk, the style's name, who reported it and the freshness in its details; the next duty as the primary — each action held
 * with its reason — beside the recall's door; the Thread button ⌘J, the frame's; ⋯ with its Keyboard line), the docked thread beside
 * every tab (Activity's tools in its "⋯", R-ACT), then Event · Affected units · Authority notices · Actions as link tabs. A closed
 * entry never changes: a correction is a note in its thread. Fetches nothing: EntryRecord.tsx reads and writes; the docked thread
 * comes in as `thread` (the print view's form as `printThread`), and the reporters the event may name as `parties`.
 */
// B-TH-267: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function EntryRecordView({ model, actions, thread, printThread, parties = null, depth }: { model: EntryRecordModel; actions?: EntryRecordActions; thread?: ReactNode; printThread?: ReactNode; parties?: DialogsParties; depth?: EntryDepth }) {
  return (
    <RegisterMessages>
      <EntryRecord model={model} actions={actions} thread={thread} printThread={printThread} parties={parties} depth={depth} />
    </RegisterMessages>
  )
}

/**
 * B-TH-267: the entry while it is read (no problem yet), or when it cannot be (not found, not for this role, the API did not
 * answer): inside the frame — the band stays with the way back, no thread.
 */
export function EntryRecordState({ prefix, problem, personId = null, onRetry }: { prefix: string; problem: string | null; personId?: string | null; onRetry?: () => void }) {
  return (
    <RegisterMessages>
      <EntryState prefix={prefix} problem={problem} personId={personId} onRetry={onRetry} />
    </RegisterMessages>
  )
}

function EntryState({ prefix, problem, personId, onRetry }: { prefix: string; problem: string | null; personId: string | null; onRetry?: () => void }) {
  const t = useT('register')
  const back = (
    <Link className="fw-q-link" href={`${prefix}/compliance/register`}>
      {t('record.back')}
    </Link>
  )
  return (
    <RecordFrame recordType="PpeRegisterEntry" personId={personId} band={{ back, title: problem ? t('record.name') : <Skeleton width={260} height={22} />, moreLabel: t('record.more') }} thread={null} threadLabel={t('record.dockLabel')}>
      {problem ? <RecordProblem problem={problem} back={back} onRetry={onRetry} /> : <RecordSkeleton />}
    </RecordFrame>
  )
}

type DialogsParties = Parameters<typeof EntryDialogs>[0]['model']['parties']

function EntryRecord({ model, actions, thread, printThread, parties, depth }: { model: EntryRecordModel; actions?: EntryRecordActions; thread?: ReactNode; printThread?: ReactNode; parties: DialogsParties; depth?: EntryDepth }) {
  const t = useT('register')
  const d = useT('compliance-register-depth')
  const locale = useLocale()
  const { entry, can, prefix } = model
  // B-W2b-271: Authority notices needs the depth parts (without them the record opens on Event).
  const tab: RecordTab = model.tab === 'authority' && !depth ? 'event' : model.tab
  const next = nextAction(entry)
  const held = (action: EntryAction) => {
    const key = actionHeld(action, entry, can)
    return key ? t(key) : null
  }
  const base = `${prefix}/compliance/register/${encodeURIComponent(entry.id)}`
  const subject = evidenceSubject(entry)
  const evidence = subject ? evidenceAddress(prefix, subject) : null
  const openDuties = entry.duties.filter((duty) => dutyState(duty) === 'OPEN').length

  const moreItems: MenuItemDef[] = [
    evidence
      ? { id: 'evidence', label: t(subject?.batch ? 'record.evidenceBatch' : 'record.evidenceSerial', { code: subject?.batch ?? subject?.serial ?? '' }), href: evidence, target: '_blank', icon: <ExternalLink size={14} aria-hidden /> }
      : { id: 'evidence', label: t('record.evidence'), disabled: true, description: t('held.noSubject') },
    { id: 'copy', label: t('row.copy'), onSelect: () => actions?.onCopy?.(entry.reference) },
    { id: 'sep', separator: true } as MenuItemDef,
    ...ACTIONS.filter((action) => action !== next).map((action) => {
      const reason = held(action)
      return { id: action, label: t(`action.${action}`), onSelect: () => actions?.onDialog?.(action), disabled: !!reason, description: reason ?? undefined } as MenuItemDef
    }),
  ]

  // B-TH-267: the four tabs (Authority notices only with the depth parts), each counting what it lists.
  const tabs: TabItem[] = [
    { id: 'event', label: t('tab.event') },
    { id: 'affected', label: t('tab.affected'), count: entry.trace.counts.concerned },
    // B-W2b-271: notices sent and requests received (the count: notices not cancelled + requests still open).
    ...(depth ? [{ id: 'authority', label: d('tab.authority'), count: authorityCount(depth.model.surveillance.value) }] : []),
    { id: 'actions', label: t('tab.actions'), count: entry.status === 'OPEN' ? openDuties : null },
  ].map((item) => ({ ...item, href: `${base}?tab=${item.id}` }))

  return (
    <RecordFrame
      recordType="PpeRegisterEntry"
      personId={model.personId ?? null}
      threadLabel={t('record.dockLabel')}
      thread={thread ?? null}
      printThread={printThread}
      band={{
        back: (
          <Link className="fw-q-link" href={`${prefix}/compliance/register`}>
            {t('record.back')}
          </Link>
        ),
        title: (
          <>
            <span className="fw-q-code">{entry.reference}</span> · {t(`kind.${entry.kind}`)} · {entry.style.code}
          </>
        ),
        // ONE status pill; the risk, the style's name, who reported it and the freshness in the band's details.
        status: <StatusPill status={entry.status} />,
        meta: (
          <span className="fw-q-cell-row">
            <RiskTag risk={entry.risk} />
            <span>{entry.style.name}</span>
            {entry.party && <span className="fw-q-hint">{t('record.reportedBy', { name: entry.party.name })}</span>}
            <Freshness asOf={model.asOf} live={model.live} />
          </span>
        ),
        // The next duty, and beside it the recall's door (B-W2b-271: Start recall / Open the recall running) — both kept.
        primary:
          next || depth ? (
            <>
              {next && (
                <Button size="sm" variant="primary" heldReason={held(next)} onClick={() => actions?.onDialog?.(next)}>
                  {t(`action.${next}`)}
                </Button>
              )}
              {depth && <RecallBandButton depth={depth} />}
            </>
          ) : undefined,
        more: moreItems,
        moreLabel: t('record.more'),
      }}
    >
      <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={tab} size="sm" overflow="scroll" />
      {/* B-TH-267: ONE notice in the body column, the most serious first; the rest behind "N more notices". A closed entry's
          correction is a note in the thread docked beside it (the old "Add a note" link to Activity went with the tab). */}
      <RecordNotices>
        <NoticeBanner notice={model.notice} namespace="register" onDismiss={actions?.onDismissNotice} />
        {depth && <NoticeBanner notice={depth.notice} namespace="compliance-register-depth" onDismiss={depth.onDismissNotice} />}
        {model.changedAt && (
          <Banner
            tone="info"
            title={t('record.changed', { time: formatDateTime(model.changedAt, { locale }) })}
            action={
              <Button size="sm" onClick={() => actions?.onReload?.()}>
                {t('record.reload')}
              </Button>
            }
          />
        )}
        {entry.status === 'CLOSED' && (
          <Banner tone="neutral" title={t('record.closed', { date: entry.closedAt ? formatDate(entry.closedAt, { locale }) : '—' })}>
            {t('record.closedBody')}
          </Banner>
        )}
      </RecordNotices>
      {tab === 'event' && <EventTab model={model} held={held} onDialog={actions?.onDialog} />}
      {tab === 'affected' && (
        <Section title={t('affected.title')} sub={t('affected.sub')} id="reg-affected">
          <TraceTables trace={entry.trace} />
          {entry.trace.workOrders.length === 0 && <p className="fw-q-hint">{t('affected.none')}</p>}
        </Section>
      )}
      {tab === 'authority' && depth && <AuthorityTab model={depth.model} actions={depth.actions} />}
      {tab === 'actions' && <ActionsTab model={model} held={held} onDialog={actions?.onDialog} />}
      {tab === 'actions' && depth && <ActionsDepth model={depth.model} actions={depth.actions} />}
      <EntryDialogs
        model={{ entry, dialog: model.dialog ?? null, busy: !!model.busy, problem: model.dialogProblem ?? null, today: model.today, parties }}
        actions={actions}
      />
      {depth && <DepthDialogs model={depth.model} actions={depth.actions} />}
    </RecordFrame>
  )
}

function Fields({ items }: { items: readonly { label: string; value: ReactNode; wide?: boolean }[] }) {
  return (
    <dl className="fw-reg-fields">
      {items.map((item) => (
        <div key={item.label} className={item.wide ? 'fw-reg-field wide' : 'fw-reg-field'}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function SourceText({ model }: { model: EntryRecordModel }) {
  const t = useT('register')
  const link = sourceLink(model.entry, model.releases)
  if (link.kind === 'release')
    return (
      <Link className="fw-q-link" href={`${model.prefix}/quality/inspections?open=${encodeURIComponent(link.releaseId)}`}>
        {t('record.sourceRelease', { label: link.label })}
      </Link>
    )
  if (link.kind === 'lot')
    return (
      <Link className="fw-q-link" href={`${model.prefix}/compliance/tests/${encodeURIComponent(link.lotId)}`}>
        {t('record.sourceLot')}
      </Link>
    )
  if (link.kind === 'complaint')
    return (
      <Link className="fw-q-link" href={`${model.prefix}/quality/complaints/${encodeURIComponent(link.complaintId)}`}>
        {t('source.Complaint')}
      </Link>
    )
  return <>{t(sourceKey(model.entry))}</>
}

function EventTab({ model, held, onDialog }: { model: EntryRecordModel; held: (action: EntryAction) => string | null; onDialog?: (action: EntryAction | null) => void }) {
  const t = useT('register')
  const locale = useLocale()
  const { entry } = model
  const edit = (action: EntryAction, label: string) => (
    <Button size="sm" onClick={() => onDialog?.(action)} heldReason={held(action)}>
      <Pencil size={13} aria-hidden /> {label}
    </Button>
  )
  return (
    <div className="fw-q-stack">
      <Section title={t('event.title')} sub={t('event.sub')} id="reg-event" actions={edit('edit', t('action.edit'))}>
        <p className="fw-reg-text">{entry.description}</p>
        <Fields
          items={[
            { label: t('event.kind'), value: t(`kind.${entry.kind}`) },
            { label: t('event.reportedAt'), value: formatDateTime(entry.reportedAt, { locale }) },
            { label: t('event.reporter'), value: entry.party ? `${entry.party.name} (${entry.party.code})` : t('event.noReporter') },
            { label: t('event.style'), value: `${entry.style.code} · ${entry.style.name}` },
            { label: t('event.batches'), value: entry.batchNumbers.length > 0 ? <span className="fw-q-code">{entry.batchNumbers.join(', ')}</span> : '—' },
            { label: t('event.serials'), value: entry.serials.length > 0 ? <span className="fw-q-code">{entry.serials.join(', ')}</span> : '—' },
            { label: t('event.source'), value: <SourceText model={model} /> },
            { label: t('event.added'), value: formatDateTime(entry.createdAt, { locale }) },
          ]}
        />
      </Section>
      <div className="fw-q-two">
        <Section title={t('assess.title')} sub={t('assess.sub')} id="reg-assess" actions={edit('risk', t('action.risk'))}>
          <Fields
            items={[
              { label: t('assess.risk'), value: <RiskTag risk={entry.risk} /> },
              { label: t('assess.investigation'), value: entry.investigation ? <span className="fw-reg-text">{entry.investigation}</span> : t('assess.noInvestigation'), wide: true },
            ]}
          />
          <p className="fw-q-hint">{t(`riskHint.${entry.risk}`)}</p>
        </Section>
        <Section title={t('corrective.title')} sub={t('corrective.sub')} id="reg-corrective" actions={edit('action', t('action.action'))}>
          <Fields
            items={[
              { label: t('corrective.text'), value: entry.actionTaken ? <span className="fw-reg-text">{entry.actionTaken}</span> : t('corrective.none'), wide: true },
              { label: t('corrective.done'), value: entry.actionCompletedAt ? formatDate(entry.actionCompletedAt, { locale }) : t('corrective.notDone') },
            ]}
          />
        </Section>
      </div>
    </div>
  )
}

function ActionsTab({ model, held, onDialog }: { model: EntryRecordModel; held: (action: EntryAction) => string | null; onDialog?: (action: EntryAction | null) => void }) {
  const t = useT('register')
  const locale = useLocale()
  const { entry } = model
  const checks: CheckLine[] = entry.duties.map((duty) => ({
    id: duty.code,
    state: dutyState(duty),
    name: t(`duty.${duty.code}.name`),
    text: `${t(`duty.${duty.code}.${dutyState(duty)}`)} (${duty.law})`,
    fix: t(`duty.${duty.code}.fix`),
  }))
  const button = (action: EntryAction) => (
    <Button size="sm" variant={action === nextAction(entry) ? 'primary' : 'secondary'} onClick={() => onDialog?.(action)} heldReason={held(action)}>
      {t(`action.${action}`)}
    </Button>
  )
  return (
    <div className="fw-q-stack">
      <div className="fw-q-main-side">
        <Section title={t('duties.title')} sub={t('duties.sub')} id="reg-duties">
          <CheckList checks={checks} label={t('duties.title')} />
        </Section>
        <Section title={t('toClose.title')} id="reg-close" actions={button('close')}>
          {entry.status === 'CLOSED' ? (
            <Fields
              items={[
                { label: t('toClose.closedAt'), value: entry.closedAt ? formatDateTime(entry.closedAt, { locale }) : '—' },
                { label: t('toClose.reason'), value: entry.closeReason ? <span className="fw-reg-text">{entry.closeReason}</span> : '—', wide: true },
              ]}
            />
          ) : entry.toClose.length === 0 ? (
            <p className="fw-q-hint">{t('toClose.ready')}</p>
          ) : (
            <ul className="fw-q-lines">
              {entry.toClose.map((problem) => (
                <li key={problem.code}>{problem.message}</li>
              ))}
            </ul>
          )}
        </Section>
      </div>
      <div className="fw-q-three">
        <Section title={t('corrective.title')} actions={button('action')} id="reg-act-corrective">
          <Fields
            items={[
              { label: t('corrective.text'), value: entry.actionTaken ? <span className="fw-reg-text">{entry.actionTaken}</span> : t('corrective.none'), wide: true },
              { label: t('corrective.done'), value: entry.actionCompletedAt ? formatDate(entry.actionCompletedAt, { locale }) : t('corrective.notDone') },
            ]}
          />
        </Section>
        <Section title={t('distributors.title')} sub={t('distributors.sub')} actions={button('distributors')} id="reg-act-distributors">
          <Fields
            items={[
              { label: t('distributors.informed'), value: entry.distributorsInformedAt ? <DayText value={entry.distributorsInformedAt} /> : t('list.notYet') },
              { label: t('distributors.needed'), value: entry.trace.shippedGoods ? t('distributors.neededYes', { count: entry.trace.counts.customers }) : t('distributors.neededNo') },
            ]}
          />
          <p className="fw-q-hint">{t('distributors.where')}</p>
        </Section>
        <Section title={t('authority.title')} sub={t('authority.sub')} actions={button('authority')} id="reg-act-authority">
          <Fields
            items={[
              { label: t('authority.notified'), value: entry.authorityNotifiedAt ? <DayText value={entry.authorityNotifiedAt} /> : t('list.notYet') },
              { label: t('authority.reference'), value: entry.authorityReference ? <Tag>{entry.authorityReference}</Tag> : '—' },
              { label: t('authority.needed'), value: entry.risk === 'YES' ? t('authority.neededYes') : entry.risk === 'ASSESSING' ? t('authority.neededAssessing') : t('authority.neededNo') },
            ]}
          />
        </Section>
      </div>
    </div>
  )
}

/** B-W2b-271 (design: record band "Start recall"): a recall or withdrawal in progress opens its page; none: start one. */
function RecallBandButton({ depth }: { depth: EntryDepth }) {
  const d = useT('compliance-register-depth')
  const recalls = depth.model.surveillance.value?.recalls ?? null
  if (recalls === null) return null
  const verb = recallVerb(depth.model.entry, recalls)
  if (verb.kind === 'open')
    return (
      <Button size="sm" asChild>
        <Link href={recallAddress(depth.model.prefix, verb.recallId)}>
          <Siren size={14} aria-hidden /> {d('recalls.openLive', { number: verb.number })}
        </Link>
      </Button>
    )
  const held = !depth.model.can.recallManage ? d('held.manage') : depth.model.entry.status !== 'OPEN' ? d('held.entryClosed') : null
  return (
    <Button size="sm" heldReason={held} onClick={() => depth.actions?.onDialog?.({ kind: 'startRecall' })}>
      <Siren size={14} aria-hidden /> {d(verb.recallKind === 'WITHDRAWAL' ? 'recalls.startWithdrawal' : 'recalls.start')}
    </Button>
  )
}
