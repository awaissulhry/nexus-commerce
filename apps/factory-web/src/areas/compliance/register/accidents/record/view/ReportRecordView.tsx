'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { ProtectedValue } from '@nexus/ui/components/ProtectedValue/index'
import { Button, Pill, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { FileRow, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { SafetyPhotos } from '../../../../../../lib/safety-reports/view/SafetyPhotos'
import { RecordProblem, RecordSkeleton, Section } from '../../../../../quality/_shared/parts'
import type { Report, Revision } from '../../api'
import { actionHeld, garmentOf, nameOf, primaryOf, RECORD_TABS, reportHref, REPORTS_PATH, LOG_PATH, type RecordTab } from '../../model'
import { AuthorityCell, OutcomeTag, SafetyMessages, SourceTag, StatusPill, useWords } from '../../parts'
import { toldDialogFor, dialogFor } from '../dialogs'
import type { ReportRecordActions, ReportRecordModel } from '../view-model'
import { RecordDialogs } from './RecordDialogs'
// ---- B-TH-267: the safety report on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame } from '../../../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../../../_shared/record-frame/RecordNotices'

/**
 * SCR-421-record — a product-safety report in the office (B-W2b-357 on B-W2b-351's API; SAL-414, SAL-415, SAL-423), on RecordFrame
 * (B-TH-267; the rule of picture 38, the tabs of 08-tabs O-CMP-SAFE): the band in the shell's band row (‹ Product-safety reports, the
 * number, ONE status pill; where it came from, "not seen yet", the authority to tell and the customer in its details; ONE primary —
 * Mark seen · Start assessing · Close… —; the Thread button ⌘J, the frame's; ⋯ every other verb, each held with why, and its Keyboard
 * line), the docked thread beside both tabs (the report's customer its only party, none: notes only; Activity's tools in its "⋯"),
 * then two tabs:
 *   Report & photos  what happened and the garment (ours or as typed), who reported (the reporter's data only for those who manage
 *              reports; erased on request), whether someone was hurt — a ProtectedValue behind a recorded opening, read only by
 *              the product-safety role (GDPR art. 9), never in a list —, where it went (its SAFETY case, the PPE register), then the
 *              photos: each opening recorded through the report's own route (R-4: never the thread's Files view or a generic
 *              viewer), Add a photo by the camera.
 *   Accident log  the accident log's revisions with what the log says (the authority to tell, told, or nothing to tell) and the
 *              law (GPSR art. 20, the Owner's open question Q37); Record in the accident log / a revision / the authority told.
 * Fetches nothing: ReportRecord.tsx reads and writes.
 */
// B-TH-267: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows of it.
export function ReportRecordView({ model, actions, thread, printThread }: { model: ReportRecordModel; actions?: ReportRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  return (
    <SafetyMessages>
      <RecordBody model={model} actions={actions} thread={thread} printThread={printThread} />
    </SafetyMessages>
  )
}

function RecordBody({ model, actions, thread, printThread }: { model: ReportRecordModel; actions?: ReportRecordActions; thread?: ReactNode; printThread?: ReactNode }) {
  const { t, when } = useWords()
  const back = { href: `${model.prefix}${REPORTS_PATH}`, label: t('record.back') }
  const report = model.can.view && !model.problem ? model.report : null
  if (!report) {
    // B-TH-267: loading, failed, not found and not for this role draw inside the frame — the band stays, no thread.
    const backLink = <Link href={back.href}>{back.label}</Link>
    return (
      <RecordFrame
        recordType="ProductSafetyReport"
        personId={model.personId ?? null}
        band={{ back: backLink, title: model.can.view && !model.problem ? <Skeleton width={220} height={22} /> : t('record.name'), moreLabel: t('record.more') }}
        thread={null}
        threadLabel={t('record.dockLabel')}
      >
        {!model.can.view ? (
          <RecordProblem problem="problem.forbidden" back={backLink} />
        ) : model.problem ? (
          <RecordProblem problem={model.problem === 'read.notFound' ? 'problem.notFound' : model.problem === 'read.forbidden' ? 'problem.forbidden' : 'problem.unavailable'} back={backLink} onRetry={actions?.onRetry} />
        ) : (
          <RecordSkeleton />
        )}
      </RecordFrame>
    )
  }

  const held = (action: Parameters<typeof actionHeld>[1]) => actionHeld(report, action, model.offline)
  const heldText = (action: Parameters<typeof actionHeld>[1]) => {
    const key = held(action)
    return key ? t(key) : null
  }
  const open = (kind: Parameters<typeof dialogFor>[0]) => actions?.onDialog?.(dialogFor(kind, report))
  const primary = primaryOf(report)
  const primaryButton =
    primary === 'seen' ? (
      <Button size="sm" variant="primary" onClick={() => actions?.onSeen?.()} heldReason={heldText('seen')}>
        {t('record.seen')}
      </Button>
    ) : primary === 'assess' ? (
      <Button size="sm" variant="primary" onClick={() => actions?.onAssess?.()} heldReason={heldText('assess')}>
        {t('record.assess')}
      </Button>
    ) : primary === 'close' ? (
      <Button size="sm" variant="primary" onClick={() => open('close')} heldReason={heldText('close')}>
        {t('record.close')}
      </Button>
    ) : null
  const item = (id: string, label: string, action: Parameters<typeof actionHeld>[1], onSelect: () => void): MenuItemDef => {
    const reason = heldText(action)
    return reason ? { id, label, disabled: true, description: reason } : { id, label, onSelect }
  }
  const more: MenuItemDef[] = [
    ...(primary !== 'assess' && report.status === 'NEW' ? [item('assess', t('record.assess'), 'assess', () => actions?.onAssess?.())] : []),
    ...(primary !== 'close' ? [item('close', t('record.close'), 'close', () => open('close'))] : []),
    item('file', t('record.file'), 'file', () => open('file')),
    item('revise', report.accidentLog.revisions === 0 ? t('record.logFirst') : t('record.revise'), 'logAccident', () => open('revise')),
    ...(report.accidentLog.revisions > 0 && !report.accidentLog.state.told ? [item('told', t('record.told'), 'logAccident', () => actions?.onDialog?.(toldDialogFor(report, model.today)))] : []),
    item('facts', t('record.facts'), 'edit', () => open('facts')),
    item('eraseReporter', t('record.eraseReporter'), 'eraseReporter', () => open('eraseReporter')),
    { id: 'sep', separator: true } as MenuItemDef,
    { id: 'copy', label: t('row.copy'), onSelect: () => actions?.onCopy?.(report.number) },
  ]
  // B-TH-267: the two tabs — Report & photos counts the photos, Accident log its revisions.
  const tabs: TabItem[] = RECORD_TABS.map((tab) => ({
    id: tab,
    href: reportHref(model.prefix, report.id, tab),
    label: t(`record.tab.${tab}`),
    count: tab === 'accident' ? report.accidentLog.revisions : report.photos.length,
  }))

  return (
    <>
      <RecordFrame
        recordType="ProductSafetyReport"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabel')}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: <Link href={back.href}>{back.label}</Link>,
          title: <span className="fw-acc-mono">{report.number}</span>,
          // ONE status pill; where it came from, "not seen yet", the authority to tell and the customer in the band's details.
          status: <StatusPill status={report.status} />,
          meta: (
            <span className="fw-acc-actions">
              {!report.seen && report.status !== 'CLOSED' && <Tag tone="warning">{t('list.notSeen')}</Tag>}
              {report.accidentLog.state.mustTell && <Pill tone="danger">{t('authority.toTell')}</Pill>}
              <SourceTag source={report.source} />
              <span className="fw-acc-hint">{t('record.received', { when: when(report.receivedAt) })}</span>
              {report.party && <span className="fw-acc-hint">{report.party.legalName}</span>}
            </span>
          ),
          primary: primaryButton ?? undefined,
          more,
          moreLabel: t('record.more'),
        }}
      >
        <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
        {/* B-TH-267: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
        <RecordNotices>
          {model.changed && (
            <Banner tone="warning" title={t('record.changedTitle')} action={<Button size="sm" onClick={() => actions?.onReload?.()}>{t('record.reload')}</Button>}>
              {t('record.changedBody')}
            </Banner>
          )}
          {model.notice && (
            <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>{t('common.dismiss')}</Button>} />
          )}
        </RecordNotices>
        <div className="fw-acc-stack">
          {model.tab === 'accident' ? (
            <AccidentTab model={model} report={report} actions={actions} />
          ) : (
            // B-TH-267: Report & photos — the report, then its photos (each opening recorded: R-4).
            <>
              <ReportTab model={model} report={report} actions={actions} />
              <PhotosTab model={model} report={report} actions={actions} />
            </>
          )}
        </div>
      </RecordFrame>
      {model.dialog && <RecordDialogs model={model} report={report} state={model.dialog} actions={actions} />}
    </>
  )
}

function ReportTab({ model, report, actions }: { model: ReportRecordModel; report: Report; actions?: ReportRecordActions }) {
  const { t, day, when } = useWords()
  const ds = useDsWords()
  const garment = garmentOf(report)
  const heldText = (action: Parameters<typeof actionHeld>[1]) => {
    const key = actionHeld(report, action, model.offline)
    return key ? t(key) : null
  }
  const open = (kind: Parameters<typeof dialogFor>[0]) => actions?.onDialog?.(dialogFor(kind, report))
  const injuryOpen = model.injury.state === 'open' ? model.injury : null
  return (
    <div className="fw-acc-grid">
      <div className="fw-acc-stack">
        <Section id="fw-acc-what" title={t('record.what')} sub={t('record.whatHint')}>
          <p className="fw-acc-words">{report.whatHappened}</p>
          <KeyValue
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('intake.occurredOn'), value: day(report.occurredOn) },
              { label: t('intake.worn'), value: report.wornAsIntended === null ? t('record.notSaid') : report.wornAsIntended ? t('intake.wornValue.yes') : t('intake.wornValue.no') },
            ]}
          />
        </Section>
        <Section
          id="fw-acc-garment"
          title={t('intake.garment')}
          actions={
            <Button size="sm" variant="secondary" onClick={() => open('facts')} heldReason={heldText('edit')}>
              {t('record.facts')}
            </Button>
          }
        >
          <KeyValue
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('intake.serial'), value: garment.serial ? <span className="fw-acc-mono">{garment.serial}</span> : '—', hint: report.garmentSerial ? t('garment.serialOurs') : report.serial ? t('garment.serialTyped') : undefined },
              { label: t('intake.batch'), value: garment.batch ? <span className="fw-acc-mono">{garment.batch}</span> : '—', hint: report.garmentBatch ? t('garment.batchOurs') : report.batchNumber ? t('garment.batchTyped') : undefined },
              { label: t('record.style'), value: report.style ? `${report.style.code} · ${report.style.name}` : t('garment.noStyle'), hint: report.colourway ? `${report.colourway.code} · ${report.colourway.name}` : undefined },
              { label: t('intake.size'), value: report.size ?? '—' },
            ]}
          />
        </Section>
      </div>
      <div className="fw-acc-stack">
        <Section
          id="fw-acc-reporter"
          title={t('record.reporter')}
          actions={
            <Button size="sm" variant="secondary" onClick={() => open('eraseReporter')} heldReason={heldText('eraseReporter')}>
              {t('record.eraseReporter')}
            </Button>
          }
        >
          <KeyValue
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('record.source'), value: t(`source.${report.source}`) },
              { label: t('record.receivedAt'), value: when(report.receivedAt) },
              { label: t('list.col.customer'), value: report.party ? `${report.party.code} · ${report.party.legalName}` : t('list.noCustomer'), hint: report.contact ? report.contact.name : undefined },
              {
                label: t('record.reporterData'),
                value: report.reporterHidden ? t('record.reporterHidden') : report.reporter && (report.reporter.name || report.reporter.email || report.reporter.phone) ? [report.reporter.name, report.reporter.email, report.reporter.phone].filter(Boolean).join(' · ') : t('record.reporterNone'),
              },
            ]}
          />
        </Section>
        <Section id="fw-acc-injury" title={t('record.injury')}>
          <PrivacyNote level="protected" variant="panel" recorded={report.injury.mayOpen} text={t('record.injuryNote')} whoMore={t('record.injuryWho')} law={<LawRef law="GDPR art. 9" plain={t('intake.consentLaw')} labels={ds.lawRef} />} labels={ds.privacyNote} />
          {report.injury.recorded ? (
            <ProtectedValue
              label={t('record.injuryValue')}
              allowed={report.injury.mayOpen}
              value={injuryOpen ? <InjuryWords injury={injuryOpen.value} people={report.people} /> : undefined}
              onOpen={() => actions?.onOpenInjury?.()}
              opening={model.injury.state === 'reading'}
              failed={model.injury.state === 'failed'}
              recordedAt={injuryOpen ? when(injuryOpen.at) : undefined}
              restrictedReason={t('record.injuryRestricted')}
              onHide={() => actions?.onHideInjury?.()}
              labels={ds.protectedValue}
            />
          ) : (
            <p className="fw-acc-hint">{t('record.injuryUnsaid')}</p>
          )}
          <div className="fw-acc-actions">
            {!report.injury.recorded && (
              <Button size="sm" variant="secondary" onClick={() => open('recordInjury')} heldReason={heldText('recordInjury')}>
                {t('record.recordInjury')}
              </Button>
            )}
            {report.injury.recorded && (
              <Button size="sm" variant="secondary" onClick={() => open('eraseInjury')} heldReason={heldText('eraseInjury')}>
                {t('record.eraseInjury')}
              </Button>
            )}
          </div>
        </Section>
        <Section id="fw-acc-where" title={t('record.where')}>
          <KeyValue
            labelCase="sentence"
            columns={2}
            items={[
              { label: t('record.case'), value: report.case ? <Link className="fw-acc-mono" href={`${model.prefix}/sales/service/${encodeURIComponent(report.case.id)}`}>{report.case.number}</Link> : '—', hint: t('record.caseHint') },
              {
                label: t('record.register'),
                value: report.registerEntry ? <Link className="fw-acc-mono" href={`${model.prefix}/compliance/register/${encodeURIComponent(report.registerEntry.id)}`}>{report.registerEntry.reference}</Link> : t('record.notFiled'),
                hint: report.registerEntry ? undefined : t('record.fileHint'),
              },
              { label: t('record.seenBy'), value: report.seenAt ? t('record.seenValue', { when: when(report.seenAt), who: nameOf(report.people, report.seenById) ?? t('record.someone') }) : t('record.notSeenYet') },
              ...(report.closed ? [{ label: t('record.closedBy'), value: t('record.seenValue', { when: when(report.closed.at), who: nameOf(report.people, report.closed.byId) ?? t('record.someone') }) }] : []),
            ]}
          />
          {report.closed?.note && <p className="fw-acc-words">{report.closed.note}</p>}
          {!report.registerEntry && (
            <div>
              <Button size="sm" variant="secondary" onClick={() => open('file')} heldReason={heldText('file')}>
                {t('record.file')}
              </Button>
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}

function InjuryWords({ injury, people }: { injury: NonNullable<Extract<ReportRecordModel['injury'], { state: 'open' }>['value']>; people: Report['people'] }) {
  const { t, when } = useWords()
  return (
    <span className="fw-acc-cell">
      <b>{injury.injured ? t('intake.injuredYes') : t('intake.injuredNo')}</b>
      {injury.injured && <span className="fw-acc-hint">{injury.consentAt ? t('record.consentAt', { when: when(injury.consentAt) }) : t('record.noConsent')}</span>}
      {injury.erased ? (
        <span className="fw-acc-hint">{t('record.injuryErased', { when: when(injury.erased.at), who: nameOf(people, injury.erased.byId) ?? t('record.someone') })}</span>
      ) : injury.words ? (
        <span className="fw-acc-words">{injury.words}</span>
      ) : (
        injury.injured && <span className="fw-acc-hint">{t('record.injuryNoWords')}</span>
      )}
    </span>
  )
}

function AccidentTab({ model, report, actions }: { model: ReportRecordModel; report: Report; actions?: ReportRecordActions }) {
  const { t, day, when } = useWords()
  const ds = useDsWords()
  const state = report.accidentLog.state
  const newest = report.accidentLog.newest
  const logHeld = actionHeld(report, 'logAccident', model.offline)
  const heldWords = logHeld ? t(logHeld) : null
  const revisions = model.revisions.items
  return (
    <div className="fw-acc-stack">
      {!newest ? (
        <Banner tone="info" title={t('accident.none')}>
          {t('accident.noneBody')}
        </Banner>
      ) : state.told ? (
        <Banner tone="success" title={newest.authority ? t('accident.toldOn', { date: day(newest.authority.toldAt) }) : t('authority.told')}>
          {newest.authority?.reference ? t('accident.reference', { reference: newest.authority.reference }) : null}
        </Banner>
      ) : state.mustTell ? (
        <Banner tone="danger" title={t('accident.mustTell', { outcome: t(`outcome.${newest.outcome}`) })}>
          {t('accident.mustTellBody')}
        </Banner>
      ) : (
        <Banner tone="info" title={t('accident.inLog', { outcome: t(`outcome.${newest.outcome}`) })} />
      )}
      <div className="fw-acc-law">
        <span className="fw-acc-hint">{t('log.lawLine')}</span>
        <LawRef law="Reg. (EU) 2023/988 art. 20" plain={t('log.law')} labels={ds.lawRef} />
        <span className="fw-acc-hint">{t('log.q37Body')}</span>
      </div>
      <Section
        id="fw-acc-revisions"
        title={t('accident.revisions')}
        sub={t('accident.revisionsHint')}
        actions={
          <span className="fw-acc-actions">
            {newest && !state.told && (
              <Button size="sm" variant="secondary" onClick={() => actions?.onDialog?.(toldDialogFor(report, model.today))} heldReason={heldWords}>
                {t('record.told')}
              </Button>
            )}
            <Button size="sm" variant={newest ? 'secondary' : 'primary'} onClick={() => actions?.onDialog?.(dialogFor('revise', report))} heldReason={heldWords}>
              {newest ? t('record.revise') : t('record.logFirst')}
            </Button>
          </span>
        }
      >
        {model.revisions.problem ? (
          <EmptyState title={t('read.failedTitle')} description={t(model.revisions.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
        ) : revisions === null ? (
          <p className="fw-acc-hint" role="status">
            <Spinner size={12} /> {t('common.loading')}
          </p>
        ) : revisions.length === 0 ? (
          <p className="fw-acc-hint">{t('accident.noRevisions')}</p>
        ) : (
          <div className="fw-acc-stack" role="list">
            {revisions.map((revision) => (
              <RevisionCard key={revision.id} revision={revision} report={report} when={when} day={day} />
            ))}
          </div>
        )}
        <p className="fw-acc-hint">
          <Link href={`${model.prefix}${LOG_PATH}`}>{t('accident.toLog')}</Link>
        </p>
      </Section>
    </div>
  )
}

function RevisionCard({ revision, report, when, day }: { revision: Revision; report: Report; when: (value: string | null) => string; day: (value: string | null) => string }) {
  const { t } = useWords()
  return (
    <Card padded role="listitem">
      <div className="fw-acc-stack">
        <span className="fw-acc-actions">
          <b>{t('accident.revision', { n: revision.revision })}</b>
          <span className="fw-acc-hint">{t('accident.recorded', { when: when(revision.recordedAt), who: nameOf(report.people, revision.recordedById) ?? t('record.atIntake') })}</span>
        </span>
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: t('log.col.day'), value: day(revision.occurredOn) },
            { label: t('log.col.place'), value: revision.place },
            { label: t('log.col.outcome'), value: <OutcomeTag outcome={revision.outcome} /> },
            { label: t('log.col.authority'), value: <AuthorityCell told={revision.authority !== null} toldAt={revision.authority?.toldAt ?? null} reference={revision.authority?.reference ?? null} mustTell={false} outcome={revision.outcome} />, hint: revision.authority ? t('accident.toldBy', { who: nameOf(report.people, revision.authority.byId) ?? t('record.someone') }) : undefined },
            ...(revision.serial || revision.batchNumber ? [{ label: t('intake.garment'), value: <span className="fw-acc-mono">{[revision.serial, revision.batchNumber].filter(Boolean).join(' · ')}</span> }] : []),
          ]}
        />
        {revision.note && <p className="fw-acc-words">{revision.note}</p>}
      </div>
    </Card>
  )
}

/**
 * The report's photos, under the report (B-TH-267: Photos merged into Report & photos). A photo opens ONLY through the report's own
 * recorded opening (`onOpenPhoto` → POST …/photos/:fileId/open, read into a new tab): never the thread's Files view, never the frame's
 * file viewer (R-4; GDPR art. 9 — a photo may show an injury).
 */
function PhotosTab({ model, report, actions }: { model: ReportRecordModel; report: Report; actions?: ReportRecordActions }) {
  const { t, when } = useWords()
  return (
    <div className="fw-acc-stack">
      <Section id="fw-acc-photos" title={t('record.photos')} sub={t('record.photosHint')}>
        {report.photos.length === 0 ? (
          <p className="fw-acc-hint">{t('record.noPhotos')}</p>
        ) : (
          <ul className="fw-acc-photo-list">
            {report.photos.map((photo) => (
              <li key={photo.id}>
                <FileRow
                  name={photo.name}
                  size={photo.sizeBytes}
                  status={photo.availableAt ? when(photo.availableAt) : t('record.photoWaiting')}
                  actions={
                    <Button size="sm" variant="secondary" onClick={() => actions?.onOpenPhoto?.(photo.id)} heldReason={model.opening === photo.id ? t('common.loading') : !photo.availableAt ? t('record.photoWaiting') : null}>
                      <ExternalLink size={14} aria-hidden /> {t('record.openPhoto')}
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {model.photos && <SafetyPhotos model={model.photos} actions={actions?.photos} />}
      </Section>
    </div>
  )
}

export type { RecordTab }
