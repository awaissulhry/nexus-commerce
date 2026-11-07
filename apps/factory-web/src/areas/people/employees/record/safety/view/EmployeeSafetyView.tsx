'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, HardHat, ShieldCheck, Stethoscope } from 'lucide-react'
import { Banner, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { ProtectedValue } from '@nexus/ui/components/ProtectedValue/index'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { useDay, useTrainingWords, useWhen } from '../../../../skills/training/view/parts'
import type { PersonRoleSheet, PpeCard } from '../api'
import { itemName, missingKit, outcomeKey, ppeRowsOf, receiptTone, SAFETY_NAMESPACES, type FitnessState, type SafetyCan } from '../model'

/** A section's read, never drawn as empty when it failed. */
export type SafetySection<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'restricted' }

export interface EmployeeSafetyModel {
  can: SafetyCan
  employeeId: string
  roleSheet: SafetySection<PersonRoleSheet>
  ppe: SafetySection<PpeCard>
  fitness: FitnessState
  /** Plant › PPE's Issue PPE for this person, when that page is built; null: said why. */
  issueHref: string | null
  /** Plant › Risk assessment (the role sheet's owner) and Plant › Incidents, when built. */
  riskHref: string | null
  incidentsHref: string | null
}

export interface EmployeeSafetyActions {
  onRetry?: (section: 'roleSheet' | 'ppe' | 'fitness') => void
  onShowFitness?: () => void
  onHideFitness?: () => void
}

/**
 * Employee › Safety (B-W2b-146; design people.employees rec:Employee tab "Safety"): what the person's role means for them
 * (risks, PPE, training, surveillance needed — the visit need only to who may know it), the PPE they received with the signed
 * receipts and what their kit still misses, their fitness judgement as the outcome only (never clinical data) behind
 * ProtectedValue — every Show recorded by the API, the value kept in this tab's state alone — and their incidents (not served
 * by the API yet: said so). Each section reads and fails on its own.
 */
export function EmployeeSafetyView({ model, actions }: { model: EmployeeSafetyModel; actions?: EmployeeSafetyActions }) {
  return (
    <WithMessages namespaces={SAFETY_NAMESPACES}>
      <div className="fw-tr-sections">
        <RoleSheetSection model={model} actions={actions} />
        <FitnessSection model={model} actions={actions} />
        <PpeSection model={model} actions={actions} />
        <IncidentsSection model={model} />
      </div>
    </WithMessages>
  )
}

function Loading() {
  const t = useTrainingWords()
  return (
    <div className="fw-tr-loading" aria-busy="true">
      <Skeleton height={28} />
      <Skeleton height={28} />
      <span className="fw-tr-slow" role="status">
        {t('common.stillLoading')}
      </span>
    </div>
  )
}

function Failed({ problem, onRetry }: { problem: string; onRetry?: (() => void) | undefined }) {
  const t = useTrainingWords()
  return (
    <EmptyState
      title={t('safety.failed')}
      description={t(problem)}
      action={
        problem === 'problem.forbidden' ? undefined : (
          <Button size="sm" onClick={() => onRetry?.()}>
            {t('common.retry')}
          </Button>
        )
      }
    />
  )
}

function Section({ id, title, icon, children, tools }: { id: string; title: string; icon: ReactNode; children: ReactNode; tools?: ReactNode }) {
  return (
    <section className="fw-tr-section" aria-labelledby={id}>
      <div className="fw-tr-head">
        <span className="fw-tr-row">
          {icon}
          <h3 id={id}>{title}</h3>
        </span>
        {tools ? <span className="fw-tr-row">{tools}</span> : null}
      </div>
      {children}
    </section>
  )
}

// ---- Role risk sheet ---------------------------------------------------------------------------------------------------------------

function RoleSheetSection({ model, actions }: { model: EmployeeSafetyModel; actions?: EmployeeSafetyActions | undefined }) {
  const t = useTrainingWords()
  const ds = useDsWords()
  const day = useDay()
  const section = model.roleSheet
  const value = section.status === 'ready' ? section.value : null
  return (
    <Section id="fw-es-role" title={t('safety.role.title')} icon={<ShieldCheck size={16} aria-hidden />} tools={value?.roleSheet && model.riskHref ? <Button size="sm" variant="quiet" asChild><Link href={model.riskHref}>{t('safety.role.open')}</Link></Button> : null}>
      {section.status === 'loading' && <Loading />}
      {section.status === 'error' && <Failed problem={section.problem} onRetry={() => actions?.onRetry?.('roleSheet')} />}
      {section.status === 'restricted' && <p className="fw-tr-muted">{t('safety.role.restricted')}</p>}
      {value && !value.roleSheet && <EmptyState title={t('safety.role.none')} description={t('safety.role.noneHint')} />}
      {value?.roleSheet && value.asks && (
        <>
          <KeyValue
            dense
            items={[
              { label: t('safety.role.role'), value: `${value.roleSheet.name} · ${value.roleSheet.code}` },
              { label: t('safety.role.since'), value: day(value.since) },
              { label: t('safety.role.risks'), value: value.asks.risks.length ? value.asks.risks.join(', ') : t('safety.role.noRisks') },
              {
                label: t('safety.role.ppe'),
                value: value.asks.kit.length ? (
                  <span className="fw-tr-row">
                    {value.asks.kit.map((line) => (
                      <Pill key={line.ppeItemId} tone={line.held >= line.quantity ? 'success' : 'warning'}>
                        {t('safety.role.kitLine', { item: line.item?.name ?? '—', held: line.held, quantity: line.quantity })}
                      </Pill>
                    ))}
                  </span>
                ) : (
                  t('safety.role.noKit')
                ),
              },
              {
                label: t('safety.role.training'),
                value: value.asks.courses.length ? (
                  <span className="fw-tr-row">
                    {value.asks.courses.map((line) => (
                      <Pill key={line.courseId} tone={line.held ? 'success' : 'danger'}>
                        {`${line.held ? '✓' : '✗'} ${line.course?.name ?? '—'}`}
                      </Pill>
                    ))}
                  </span>
                ) : (
                  t('safety.role.noCourses')
                ),
              },
              ...(value.asks.visits.shown
                ? [{ label: t('safety.role.surveillance'), value: value.asks.visits.needed ? (value.asks.visits.frequencyMonths ? t('safety.role.surveillanceEvery', { count: value.asks.visits.frequencyMonths }) : t('safety.role.surveillanceYes')) : t('safety.role.surveillanceNo') }]
                : []),
            ]}
          />
          <LawRef law={value.law.roleSheet} plain={t('law.roleSheet')} labels={ds.lawRef} />
        </>
      )}
    </Section>
  )
}

// ---- PPE issued ------------------------------------------------------------------------------------------------------------------------

function PpeSection({ model, actions }: { model: EmployeeSafetyModel; actions?: EmployeeSafetyActions | undefined }) {
  const t = useTrainingWords()
  const locale = useLocale()
  const when = useWhen()
  const section = model.ppe
  const card = section.status === 'ready' ? section.value : null
  const rows = card ? ppeRowsOf(card) : []
  const missing = card ? missingKit(card) : []
  const issueHeld = !card ? t('common.loading') : !card.canIssue ? t('held.issue') : !model.issueHref ? t('held.ppePage') : null
  const issue = model.issueHref && card?.canIssue ? (
    <Button size="sm" asChild>
      <Link href={model.issueHref}>
        <HardHat size={13} aria-hidden /> {t('safety.ppe.issue')}
      </Link>
    </Button>
  ) : (
    <Button size="sm" heldReason={issueHeld}>
      <HardHat size={13} aria-hidden /> {t('safety.ppe.issue')}
    </Button>
  )
  return (
    <Section id="fw-es-ppe" title={t('safety.ppe.title')} icon={<HardHat size={16} aria-hidden />} tools={section.status === 'restricted' ? null : issue}>
      {section.status === 'loading' && <Loading />}
      {section.status === 'error' && <Failed problem={section.problem} onRetry={() => actions?.onRetry?.('ppe')} />}
      {section.status === 'restricted' && <p className="fw-tr-muted">{t('safety.ppe.restricted')}</p>}
      {card && (
        <>
          {missing.length > 0 && (
            <Banner tone="warning" title={t('safety.ppe.missing', { count: missing.length })}>
              <span className="fw-tr-row">
                {missing.map((line) => (
                  <Tag key={line.ppeItemId} tone="warning">
                    {t('safety.ppe.missingLine', { item: itemName(line.item, locale), count: line.missing })}
                  </Tag>
                ))}
              </span>
            </Banner>
          )}
          {rows.length === 0 ? (
            <EmptyState title={t('safety.ppe.none')} />
          ) : (
            <SummaryTable
              label={t('safety.ppe.label')}
              columns={[t('safety.ppe.col.date'), t('safety.ppe.col.item'), t('safety.ppe.col.size'), t('safety.ppe.col.quantity'), t('safety.ppe.col.receipt')]}
              widths={['22%', '32%', '12%', '12%', '22%']}
              align={[undefined, undefined, undefined, 'right', 'left']}
              stackOnPhone
              rows={rows.map((row) => {
                const tone = receiptTone(row.receipt)
                return { id: row.id, cells: [when(row.issuedAt), itemName(row.item, locale), row.size ?? '—', String(row.quantity), <Pill key="r" tone={tone.tone}>{t(tone.key)}</Pill>] }
              })}
            />
          )}
          <p className="fw-tr-muted">{t('safety.ppe.noCost')}</p>
        </>
      )}
    </Section>
  )
}

// ---- Fitness judgement (protected) -----------------------------------------------------------------------------------------------------

function FitnessSection({ model, actions }: { model: EmployeeSafetyModel; actions?: EmployeeSafetyActions | undefined }) {
  const t = useTrainingWords()
  const ds = useDsWords()
  const day = useDay()
  const fitness = model.fitness
  const allowed = model.can.health
  const shown = fitness.status === 'shown' ? fitness : null
  const row = fitness.status === 'hidden' || fitness.status === 'opening' || fitness.status === 'failed' ? fitness.judgement : null
  const outcome = shown ? outcomeKey(shown.judgement) : null
  const value = shown ? (
    <span className="fw-tr-stack">
      <strong>{t(outcome!.key, { date: day(outcome!.until) })}</strong>
      {shown.judgement.taskLimits && <span>{t('fitness.limits', { limits: shown.judgement.taskLimits })}</span>}
      <span className="fw-tr-muted">{t('fitness.dates', { date: day(shown.judgement.judgedOn), until: shown.judgement.expiresOn ? day(shown.judgement.expiresOn) : t('fitness.noExpiry') })}</span>
      <span className="fw-tr-muted">{shown.next ? t('fitness.next', { date: day(shown.next.booked?.on ?? shown.next.dueOn) }) : t('fitness.noNext')}</span>
    </span>
  ) : undefined
  return (
    <Section id="fw-es-fitness" title={t('safety.fitness.title')} icon={<Stethoscope size={16} aria-hidden />}>
      <PrivacyNote level="protected" text={t('fitness.privacy')} whoMore={t('fitness.who')} recorded={allowed} labels={ds.privacyNote} />
      {fitness.status === 'loading' && <Loading />}
      {fitness.status === 'error' && <Failed problem={fitness.problem} onRetry={() => actions?.onRetry?.('fitness')} />}
      {fitness.status === 'none' && <p className="fw-tr-muted">{t('fitness.none')}</p>}
      {(fitness.status === 'restricted' || row || shown) && (
        <ProtectedValue
          label={t('fitness.label')}
          allowed={allowed}
          value={value}
          onOpen={() => actions?.onShowFitness?.()}
          opening={fitness.status === 'opening'}
          failed={fitness.status === 'failed'}
          {...(shown ? { recordedAt: t('fitness.recordedAt', { at: shown.recordedAt }) } : {})}
          restrictedReason={t('fitness.restricted')}
          onHide={() => actions?.onHideFitness?.()}
          labels={ds.protectedValue}
        />
      )}
      {row && <p className="fw-tr-muted">{t('fitness.anonymised', { date: day(row.judgedOn), state: t(`fitness.state.${row.state}`) })}</p>}
      {fitness.status === 'restricted' && <p className="fw-tr-muted">{t('fitness.nextRestricted')}</p>}
      <LawRef law="D.Lgs. 81/2008 art. 41; GDPR art. 9" plain={t('law.fitness')} labels={ds.lawRef} />
    </Section>
  )
}

// ---- Incidents ---------------------------------------------------------------------------------------------------------------------------

function IncidentsSection({ model }: { model: EmployeeSafetyModel }) {
  const t = useTrainingWords()
  return (
    <Section id="fw-es-incidents" title={t('safety.incidents.title')} icon={<AlertTriangle size={16} aria-hidden />}>
      {model.can.incidents ? (
        <>
          <p className="fw-tr-muted">{t('safety.incidents.notServed')}</p>
          {model.incidentsHref && (
            <span>
              <Button size="sm" asChild>
                <Link href={model.incidentsHref}>
                  <ExternalLink size={13} aria-hidden /> {t('safety.incidents.open')}
                </Link>
              </Button>
            </span>
          )}
        </>
      ) : (
        <p className="fw-tr-muted">{t('safety.incidents.restricted')}</p>
      )}
    </Section>
  )
}
