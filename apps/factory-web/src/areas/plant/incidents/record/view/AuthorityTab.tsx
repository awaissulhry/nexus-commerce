'use client'

import { ExternalLink, FilePlus2, FileText, RotateCcw, XCircle } from 'lucide-react'
import { Card, KeyValue } from '@nexus/ui/components'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { ProtectedValue } from '@nexus/ui/components/ProtectedValue/index'
import { Button } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { IncidentRecord, InailFiling } from '../../api'
import { filingHeld, INAIL_PORTAL, peopleHeld } from '../../model'
import type { FilingsOpen, IncidentRecordActions, IncidentRecordModel } from '../../view-model'
import { DeadlineText, FilingStateTag, InailLaw, PeopleLaw, SectionHead, useWhen, useWords } from '../../view/parts'

/**
 * design rec:Incident/authority — What the law asks (the INAIL rule in plain words, D.Lgs. 81/2008 art. 18 c.1 r: an absence of
 * at least one day beyond the event's → statistical communication; over three days → insurance report; both within 48 hours
 * of receiving the medical certificate, filed by hand on the INAIL portal) and Filing (the deadlines with their countdown for
 * every reader — the company's duty; the filings with their type, absence, certificate, filed at/by, protocol and receipt only
 * after the recorded open, for HR and the safety officer; "Open the INAIL portal", an outside site in a new tab).
 */
export function AuthorityTab({ model, incident, actions }: { model: IncidentRecordModel; incident: IncidentRecord; actions?: IncidentRecordActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const when = useWhen()
  const locale = useLocale()
  const rule = incident.inail.rule
  const words = locale === 'it' ? rule.words.it : rule.words.en
  const opened = model.filings.state === 'open' ? model.filings : null
  const held = filingHeld(incident)
  const deadlines = incident.inail.deadlines

  return (
    <div className="fw-inc-tab">
      <section className="fw-inc-section" aria-labelledby="fw-inc-rule">
        <SectionHead id="fw-inc-rule" title={t('rule.title')}>
          <Button size="sm" asChild>
            <a href={INAIL_PORTAL} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={13} aria-hidden /> {t('rule.portal')}
            </a>
          </Button>
        </SectionHead>
        <Card padded>
          <div className="fw-inc-stack">
            <ul className="fw-inc-list">
              {words.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <span className="fw-inc-row">
              <InailLaw />
              <span className="fw-inc-muted">{t('rule.manual')}</span>
            </span>
          </div>
        </Card>
      </section>

      <section className="fw-inc-section" aria-labelledby="fw-inc-filing">
        <SectionHead id="fw-inc-filing" title={t('filing.title')} note={t('filing.note')}>
          <Button size="sm" variant="primary" aria-keyshortcuts="f" heldReason={held ? t(held) : null} onClick={() => actions?.onDialog?.({ kind: 'peopleNote', then: 'filings' })}>
            <FilePlus2 size={13} aria-hidden /> {t('record.filing')}
          </Button>
        </SectionHead>
        <Card padded>
          {deadlines.length === 0 ? (
            <p className="fw-inc-muted">{incident.kind === 'INJURY' ? t('filing.noneInjury') : t('filing.noneOther')}</p>
          ) : (
            <ul className="fw-inc-deadlines" aria-label={t('filing.deadlines')}>
              {deadlines.map((deadline, index) => (
                <li key={deadline.id} className="fw-inc-deadline">
                  <span className="fw-inc-muted">{t('filing.n', { n: index + 1 })}</span>
                  <FilingStateTag state={deadline.state} />
                  {deadline.countdown && (deadline.state === 'DUE' || deadline.state === 'OVERDUE') ? (
                    <span className="fw-inc-cell">
                      <DeadlineText countdown={deadline.countdown} />
                      <span className="fw-inc-muted">{t('filing.dueBy', { at: when.at(deadline.countdown.dueAt) })}</span>
                    </span>
                  ) : deadline.state === 'WAITING_CERTIFICATE' ? (
                    <span className="fw-inc-muted">{t('filing.waitingHint')}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
        {deadlines.length > 0 && (
          <>
            <PrivacyNote level="protected" variant="panel" recorded={incident.canPeople} text={t('filing.privacy')} whoMore={t('people.who')} law={<PeopleLaw />} labels={ds.privacyNote} />
            <ProtectedValue
              label={t('filing.value')}
              allowed={!peopleHeld(incident)}
              value={opened ? <FilingsList filings={opened.value} actions={actions} incident={incident} /> : undefined}
              onOpen={() => actions?.onOpenFilings?.()}
              opening={model.filings.state === 'reading'}
              failed={model.filings.state === 'error'}
              recordedAt={opened ? when.at(opened.at) : undefined}
              restrictedReason={t('filing.restricted')}
              onHide={() => actions?.onHideFilings?.()}
              labels={ds.protectedValue}
            />
          </>
        )}
      </section>
    </div>
  )
}

function FilingsList({ filings, actions, incident }: { filings: FilingsOpen; actions?: IncidentRecordActions | undefined; incident: IncidentRecord }) {
  const t = useWords()
  const when = useWhen()
  const days = (value: number | null) => (value === null ? '—' : t('filing.days', { count: value }))
  return (
    <div className="fw-inc-stack fw-inc-protected">
      {filings.filings.map((filing: InailFiling) => (
        <div key={filing.id} className="fw-inc-filing">
          <div className="fw-inc-head">
            <span className="fw-inc-row">
              <b>{filing.person.name}</b>
              <span>{t(`filingType.${filing.type}`)}</span>
              <FilingStateTag state={filing.state} />
            </span>
            <span className="fw-inc-row">
              {filing.status === 'NOT_NEEDED' ? (
                <Button size="sm" heldReason={incident.canPeople ? null : t('held.noPeople')} onClick={() => actions?.onFilingNeeded?.(filing, true)}>
                  <RotateCcw size={13} aria-hidden /> {t('filing.needed')}
                </Button>
              ) : filing.status !== 'FILED' ? (
                <Button size="sm" variant="quiet" onClick={() => actions?.onFilingNeeded?.(filing, false)}>
                  <XCircle size={13} aria-hidden /> {t('filing.notNeeded')}
                </Button>
              ) : null}
              {filing.receipt ? (
                <Button size="sm" onClick={() => actions?.onOpenReceipt?.(filing)}>
                  <FileText size={13} aria-hidden /> {t('filing.receipt')}
                </Button>
              ) : null}
            </span>
          </div>
          <KeyValue
            columns={3}
            dense
            labelCase="sentence"
            items={[
              { label: t('filing.expected'), value: days(filing.expectedAbsenceDays) },
              { label: t('filing.actual'), value: days(filing.actualAbsenceDays) },
              { label: t('filing.certificate'), value: filing.certificateReceivedAt ? when.at(filing.certificateReceivedAt) : t('filing.noCertificate'), hint: filing.certificateReference ?? undefined },
              { label: t('filing.deadline'), value: filing.countdown && filing.status === 'DUE' ? <DeadlineText countdown={filing.countdown} /> : filing.dueAt ? when.at(filing.dueAt) : '—', hint: filing.dueAt ? t('filing.dueBy', { at: when.at(filing.dueAt) }) : undefined },
              { label: t('filing.filed'), value: filing.filedAt ? t('filing.filedBy', { at: when.at(filing.filedAt), by: filing.filedBy ?? t('record.someone') }) : '—' },
              { label: t('filing.protocol'), value: filing.protocolNumber ?? '—' },
            ]}
          />
          {filing.notNeededAt ? <p className="fw-inc-muted">{t('filing.notNeededBy', { at: when.at(filing.notNeededAt), by: filing.notNeededBy ?? t('record.someone') })}</p> : null}
        </div>
      ))}
    </div>
  )
}
