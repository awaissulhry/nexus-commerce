'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink, MoreHorizontal, Pencil } from 'lucide-react'
import { Banner, Menu, type MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { CheckList, Freshness, NoticeBanner, RecordFrame, Section, type CheckLine } from '../../../../quality/_shared/parts'
import { evidenceAddress } from '../../../../quality/_shared/model'
import { actionHeld, ACTIONS, dutyState, evidenceSubject, nextAction, sourceKey, sourceLink, type EntryAction, type EntryRecordModel, type RecordTab } from '../../model'
import { DayText, RegisterMessages, RiskTag, StatusPill, TraceTables } from '../../view/parts'
import { EntryDialogs, type DialogsActions } from './dialogs'

export interface EntryRecordActions extends DialogsActions {
  onDialog?: (action: EntryAction | null) => void
  onCopy?: (text: string) => void
  onReload?: () => void
  onDock?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-113 a PPE register entry (design compliance.register › Register entry, W1): the band (‹ PPE register, the
 * reference with its kind and style, the risk, the status, the next duty as the primary — each action held with its
 * reason — and ⋯), then Event · Affected units · Actions · Activity as link tabs. A closed entry never changes: a
 * correction is a note in its thread. Fetches nothing: EntryRecord.tsx reads and writes; the record panels come in as
 * `panels`, and the reporters the event may name as `parties`.
 */
export function EntryRecordView({ model, actions, panels, parties = null }: { model: EntryRecordModel; actions?: EntryRecordActions; panels?: ReactNode; parties?: DialogsParties }) {
  return (
    <RegisterMessages>
      <EntryRecord model={model} actions={actions} panels={panels} parties={parties} />
    </RegisterMessages>
  )
}

type DialogsParties = Parameters<typeof EntryDialogs>[0]['model']['parties']

function EntryRecord({ model, actions, panels, parties }: { model: EntryRecordModel; actions?: EntryRecordActions; panels?: ReactNode; parties: DialogsParties }) {
  const t = useT('register')
  const locale = useLocale()
  const { entry, can, prefix } = model
  // Activity needs the record panels (threads.read): without them the record opens on Event.
  const tab: RecordTab = model.tab === 'activity' && !panels ? 'event' : model.tab
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

  const tabs: { id: RecordTab; label: string; count?: number | null }[] = [
    { id: 'event', label: t('tab.event') },
    { id: 'affected', label: t('tab.affected'), count: entry.trace.counts.concerned },
    { id: 'actions', label: t('tab.actions'), count: entry.status === 'OPEN' ? openDuties : null },
    ...(panels ? [{ id: 'activity' as RecordTab, label: t('tab.activity') }] : []),
  ]

  return (
    <RecordFrame
      back={{ href: `${prefix}/compliance/register`, label: t('record.back') }}
      title={
        <>
          <span className="fw-q-code">{entry.reference}</span> · {t(`kind.${entry.kind}`)} · {entry.style.code}
        </>
      }
      meta={
        <span className="fw-q-cell-row">
          <span>{entry.style.name}</span>
          {entry.party && <span className="fw-q-hint">{t('record.reportedBy', { name: entry.party.name })}</span>}
          <Freshness asOf={model.asOf} live={model.live} />
        </span>
      }
      status={
        <span className="fw-q-cell-row">
          <RiskTag risk={entry.risk} />
          <StatusPill status={entry.status} />
        </span>
      }
      actions={
        <>
          {next && (
            <Button size="sm" variant="primary" heldReason={held(next)} onClick={() => actions?.onDialog?.(next)}>
              {t(`action.${next}`)}
            </Button>
          )}
          <Menu align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('record.more') }} items={moreItems} />
        </>
      }
      tabs={tabs}
      active={tab}
      tabHref={(id) => `${base}?tab=${id}`}
      dock={tab === 'activity' ? undefined : panels}
      dockOpen={model.dockOpen}
      onDock={actions?.onDock}
    >
      <NoticeBanner notice={model.notice} namespace="register" onDismiss={actions?.onDismissNotice} />
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
          {panels && (
            <>
              {' '}
              <Link className="fw-q-link" href={`${base}?tab=activity`}>
                {t('record.addNote')}
              </Link>
            </>
          )}
        </Banner>
      )}
      {tab === 'event' && <EventTab model={model} held={held} onDialog={actions?.onDialog} />}
      {tab === 'affected' && (
        <Section title={t('affected.title')} sub={t('affected.sub')} id="reg-affected">
          <TraceTables trace={entry.trace} />
          {entry.trace.workOrders.length === 0 && <p className="fw-q-hint">{t('affected.none')}</p>}
        </Section>
      )}
      {tab === 'actions' && <ActionsTab model={model} held={held} onDialog={actions?.onDialog} />}
      {tab === 'activity' && panels}
      <EntryDialogs
        model={{ entry, dialog: model.dialog ?? null, busy: !!model.busy, problem: model.dialogProblem ?? null, today: model.today, parties }}
        actions={actions}
      />
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
