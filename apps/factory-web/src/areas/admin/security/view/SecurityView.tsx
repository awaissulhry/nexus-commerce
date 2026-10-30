'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, CircleAlert, CircleDashed, CircleX, Copy, ShieldCheck, ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue } from '@nexus/ui/components'
import { IdentityCell, type ColDef } from '@nexus/ui/grid'
import { Button, Pill, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Translate } from '../../../../lib/i18n/messages'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { WithMessages } from '../../../../record-panels/i18n'
import { adminHref } from '../../shared/model'
import { cellOf } from '../../shared/view/cells'
import { BulkButton, heldText, ListKeysHelp, StepUp, useRoleWords } from '../../shared/view/parts'
import type { StepUpModel } from '../../shared/model'
import type { Drill, FingerprintAnswer, SecurityFacts, StatusLine, TwoFactorList, TwoFactorRole } from '../api'
import { bulkHeld, drillWords, grouped, matchedOf, overallOf, rowHeld, STATUS_LINKS, STATUS_TONE, statusWords, withoutTwoFactor, type Read, type SecurityViewModel } from '../model'
import { DayTimeField, DrillDialog, TwoFactorDialog, type DrillActions, type TwoFactorActions } from './SecurityDialogs'
import '../security.css'

export type { SecurityViewModel } from '../model'

export interface SecurityActions extends DrillActions, TwoFactorActions {
  onRecheck?: () => void
  onRetry?: () => void
  /** Bulk: ask (or stop asking) two-factor of the ticked roles: opens the dialog with who it affects. */
  onTwoFactor?: (roleIds: readonly string[], requireMfa: boolean) => void
  onRecordDrill?: () => void
  /** THIS database's fingerprint as of a time (for a copy restored here). */
  onFingerprint?: (asOf: string) => void
  onCopy?: (text: string) => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpClose?: () => void
}

/** The words of the page: the shared Admin text and the page's own (`admin-security.json`, prefix `sec.`). */
export function SecurityMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={['admin', 'records', 'admin-security']}>{children}</WithMessages>
}

/**
 * SCR-166 — Admin › Access › Security & health (design admin.security; B-W2a-36): Is everything working? (a plain line
 * per part, never "all working" while a part is not watched), Sign-in rules (the fixed rules shown; two-factor per role
 * in the list frame: tick roles, Ask two-factor N / Stop asking N, who it affects first, a fresh code), Backups and
 * restore drills (the proof the data can come back: the drills with their checksum result, Record a restore drill, this
 * database's fingerprint), Protection in place (facts, not settings). Fetches nothing (SecurityPage.tsx reads the API).
 */
export function SecurityView({ model, actions, stepUp }: { model: SecurityViewModel; actions?: SecurityActions; stepUp?: StepUpModel }) {
  return (
    <SecurityMessages>
      <Security model={model} actions={actions} stepUp={stepUp} />
    </SecurityMessages>
  )
}

function Security({ model, actions, stepUp }: { model: SecurityViewModel; actions?: SecurityActions; stepUp?: StepUpModel }) {
  const t = useT('admin-security')
  const locale = useLocale()
  const facts = model.facts
  if (facts.state === 'no-right') {
    return (
      <div className="fw-adm">
        <Card padded>
          <EmptyState title={t('sec.noAccess.title')} description={t('sec.noAccess.body')} />
        </Card>
      </div>
    )
  }
  const value = facts.state === 'ok' ? facts.value : null
  const overall = value ? overallOf(value.status) : null
  return (
    <div className="fw-adm fw-sec">
      <div className="fw-adm-head">
        <div className="fw-adm-head-text">
          <p className="fw-adm-intro">{t('sec.intro')}</p>
          <p className="fw-adm-asof" role="status">
            {facts.state === 'failed' ? t('sec.overall.unavailable') : overall ? `${t(overall.key, overall.params)} · ${formatTime(value!.asOf, { locale })}` : t('sec.overall.checking')}
          </p>
        </div>
        <div className="fw-adm-actions">
          <Button size="sm" onClick={() => actions?.onRecheck?.()} heldReason={facts.state === 'loading' ? t('sec.checkingHeld') : null}>
            {t('sec.recheck')}
          </Button>
        </div>
      </div>
      {model.notice && (
        <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params)} onDismiss={actions?.onDismissNotice} />
      )}
      <div className="fw-sec-grid">
        <StatusCard facts={facts} prefix={model.prefix} onRetry={actions?.onRetry} />
        <ProtectionCard facts={facts} />
      </div>
      <SignInCard model={model} actions={actions} />
      <BackupsCard model={model} actions={actions} />
      <p className="fw-adm-hint">{t('sec.later')}</p>
      {model.dialog.kind === 'drill' && <DrillDialog dialog={model.dialog} actions={actions} />}
      {model.dialog.kind === 'twoFactor' && model.twoFactor.state === 'ok' && <TwoFactorDialog dialog={model.dialog} roles={model.twoFactor.value.roles} actions={actions} />}
      <StepUp model={stepUp} onSubmit={actions?.onStepUpSubmit} onClose={actions?.onStepUpClose} />
    </div>
  )
}

/** A section's own loading and failure (the other sections keep working). */
function SectionState({ read, onRetry, rows = 4 }: { read: Read<unknown>; onRetry?: () => void; rows?: number }) {
  const t = useT('admin-security')
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (read.state !== 'loading') return
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [read.state])
  if (read.state === 'failed')
    return (
      <EmptyState
        title={t('sec.failed.title')}
        description={t('sec.failed.body')}
        action={
          <Button size="sm" onClick={() => onRetry?.()}>
            {t('sec.retry')}
          </Button>
        }
      />
    )
  return (
    <div className="fw-adm-skeleton" aria-busy="true">
      {slow && (
        <p className="fw-adm-loading" role="status">
          {t('sec.stillLoading')}
        </p>
      )}
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={20} />
      ))}
    </div>
  )
}

const STATE_ICON = { ok: CheckCircle2, warning: CircleAlert, needs: CircleAlert, failing: CircleX, unknown: CircleDashed } as const

/** SetupChecklist (design "new" part) stand-in: one plain line per part, its state, its detail, linked. */
function StatusCard({ facts, prefix, onRetry }: { facts: Read<SecurityFacts>; prefix: string; onRetry?: () => void }) {
  const t = useT('admin-security')
  const locale = useLocale()
  return (
    <section id="status" aria-labelledby="sec-status" className="fw-sec-section">
      <Card header={<span id="sec-status">{t('sec.status.title')}</span>} description={t('sec.status.hint')} headingLevel={2}>
        {facts.state !== 'ok' ? (
          facts.state === 'failed' ? (
            <EmptyState title={t('sec.status.unavailable')} description={t('sec.status.unavailableBody')} action={<Button size="sm" onClick={() => onRetry?.()}>{t('sec.retry')}</Button>} />
          ) : (
            <SectionState read={facts} onRetry={onRetry} rows={7} />
          )
        ) : (
          <ul className="fw-sec-lines">
            {facts.value.status.map((line: StatusLine) => {
              const Icon = STATE_ICON[line.state]
              const words = statusWords(line, facts.value.backups.drill)
              const link = STATUS_LINKS[line.part]
              return (
                <li key={line.part} className={`fw-sec-line is-${line.state}`}>
                  <span className="fw-sec-line-icon" aria-hidden>
                    <Icon size={16} />
                  </span>
                  <span className="fw-sec-line-body">
                    <span className="fw-sec-line-head">
                      <span className="fw-sec-line-name">{t(`sec.part.${line.part}`)}</span>
                      <Pill tone={STATUS_TONE[line.state]}>{t(`sec.state.${line.state}`)}</Pill>
                    </span>
                    <span className="fw-sec-line-detail">
                      {t(words.key, line.part === 'drill' && facts.value.backups.drill.lastOn ? { ...words.params, day: formatDate(facts.value.backups.drill.lastOn, { locale, timeZone: 'UTC' }) } : words.params)}
                    </span>
                  </span>
                  {link && (
                    <Button size="sm" variant="quiet" asChild>
                      <Link href={link.startsWith('#') ? link : adminHref(prefix, link)}>
                        {t('sec.open')}
                        <span className="fw-adm-sr"> {t(`sec.part.${line.part}`)}</span>
                      </Link>
                    </Button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>
    </section>
  )
}

function ProtectionCard({ facts }: { facts: Read<SecurityFacts> }) {
  const t = useT('admin-security')
  return (
    <section id="protection" aria-labelledby="sec-protection" className="fw-sec-section">
      <Card header={<span id="sec-protection">{t('sec.protection.title')}</span>} description={t('sec.protection.intro')} headingLevel={2} padded>
        {facts.state !== 'ok' ? (
          <SectionState read={facts} rows={6} />
        ) : (
          <KeyValue
            labelCase="sentence"
            items={facts.value.protection.map((fact) => ({
              label: t(`sec.protection.label.${fact.fact}`),
              value: (
                <span className="fw-sec-fact">
                  <Tag tone={fact.state === 'on' ? 'success' : fact.state === 'off' ? 'warning' : 'neutral'}>{t(`sec.protection.state.${fact.state}`)}</Tag>
                  {fact.fact === 'virusScan' && fact.count !== null && fact.count > 0 && <span className="fw-adm-hint">{t('sec.protection.quarantined', { count: fact.count })}</span>}
                </span>
              ),
              hint: t(`sec.protection.hint.${fact.fact}`, { count: fact.count ?? 0 }),
            }))}
          />
        )}
      </Card>
    </section>
  )
}

/** The two-factor list's columns (exported: a test draws each cell alone). */
export function twoFactorColumns(ctx: { t: Translate; prefix: string; words: { name: (role: { key: string; name: string }) => string } }): ColDef<TwoFactorRole>[] {
  const { t, words } = ctx
  return [
    {
      colId: 'name',
      headerName: t('sec.tf.col.role'),
      valueGetter: ({ data }) => (data ? words.name(data) : ''),
      flex: 1.6,
      minWidth: 200,
      cellRenderer: cellOf<TwoFactorRole>((role) => (
        <IdentityCell noImage title={words.name(role)} titleAttr={words.name(role)} href={adminHref(ctx.prefix, `/roles/${role.id}?tab=rules`)} sub={<Tag tone={role.system ? 'neutral' : 'info'}>{t(role.system ? 'sec.tf.readyMade' : 'sec.tf.custom')}</Tag>} />
      )),
    },
    {
      colId: 'asks',
      headerName: t('sec.tf.col.asks'),
      valueGetter: ({ data }) => (data ? t(data.requireMfa ? 'sec.tf.asks.yes' : 'sec.tf.asks.no') : ''),
      flex: 1,
      minWidth: 150,
      cellRenderer: cellOf<TwoFactorRole>((role) => (
        <Pill tone={role.requireMfa ? 'success' : 'neutral'} icon={role.requireMfa ? <ShieldCheck size={12} aria-hidden /> : <ShieldOff size={12} aria-hidden />}>
          {t(role.requireMfa ? 'sec.tf.asks.yes' : 'sec.tf.asks.no')}
        </Pill>
      )),
    },
    {
      colId: 'holders',
      headerName: t('sec.tf.col.holders'),
      valueGetter: ({ data }) => data?.holders.length ?? 0,
      width: 110,
      type: 'numericColumn',
    },
    {
      colId: 'without',
      headerName: t('sec.tf.col.without'),
      valueGetter: ({ data }) => (data ? withoutTwoFactor(data).length : 0),
      flex: 1.4,
      minWidth: 180,
      cellRenderer: cellOf<TwoFactorRole>((role) => {
        const without = withoutTwoFactor(role)
        if (without.length === 0) return <span className="fw-adm-hint">{t('sec.tf.without.none')}</span>
        const names = without.map((holder) => holder.name).filter((name): name is string => !!name)
        return <span title={names.join(', ')}>{names.length > 0 ? names.join(', ') : t('sec.tf.without.count', { count: without.length })}</span>
      }),
    },
    {
      colId: 'why',
      headerName: t('sec.tf.col.fixed'),
      valueGetter: ({ data }) => (data?.lock ? t(`sec.tf.lock.${data.lock}`) : ''),
      flex: 1.6,
      minWidth: 200,
      cellRenderer: cellOf<TwoFactorRole>((role) => <span className="fw-adm-hint">{role.lock ? t(`sec.tf.lock.${role.lock}`) : t('sec.tf.lock.none')}</span>),
    },
  ]
}

function SignInCard({ model, actions }: { model: SecurityViewModel; actions?: SecurityActions }) {
  const t = useT('admin-security')
  const words = useRoleWords()
  const [selected, setSelected] = useState<readonly string[]>(model.selected ?? [])
  useEffect(() => setSelected(model.selected ?? []), [model.selected])
  const [help, setHelp] = useState(false)
  const columns = useMemo(() => twoFactorColumns({ t, prefix: model.prefix, words }), [t, model.prefix, words])
  const facts = model.facts.state === 'ok' ? model.facts.value.signIn : null
  const list: TwoFactorList | null = model.twoFactor.state === 'ok' ? model.twoFactor.value : null
  const roles = list?.roles ?? []
  const ticked = selected.filter((id) => roles.some((role) => role.id === id))
  const askHeld = bulkHeld(roles, ticked, true)
  const stopHeld = bulkHeld(roles, ticked, false)
  return (
    <section id="sign-in" aria-labelledby="sec-sign-in" className="fw-sec-section">
      <Card header={<span id="sec-sign-in">{t('sec.signIn.title')}</span>} description={t('sec.signIn.hint')} headingLevel={2} padded>
        <div className="fw-adm-stack">
          {!facts ? (
            <SectionState read={model.facts} rows={3} />
          ) : (
            <KeyValue
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('sec.signIn.password'), value: t('sec.signIn.passwordRule', { min: facts.password.minLength, max: facts.password.maxLength }), hint: t('sec.signIn.fixed') },
                { label: t('sec.signIn.lockout'), value: t('sec.signIn.lockoutRule', { count: facts.lockout.afterFailures, first: facts.lockout.firstLockMinutes, max: facts.lockout.maxLockMinutes }), hint: t('sec.signIn.fixed') },
                { label: t('sec.signIn.sessions'), value: t('sec.signIn.sessionsRule', { idle: facts.sessions.idleHours, days: facts.sessions.absoluteDays }), hint: t('sec.signIn.fixed') },
                { label: t('sec.signIn.stepUp'), value: t('sec.signIn.stepUpRule', { minutes: facts.sessions.stepUpMinutes }), hint: t('sec.signIn.fixed') },
                ...(facts.twoFactor
                  ? [{ label: t('sec.signIn.twoFactor'), value: t('sec.signIn.twoFactorRule', { asking: facts.twoFactor.asking, total: facts.twoFactor.officeRoles }), hint: facts.twoFactor.holdersWithout > 0 ? t('sec.signIn.twoFactorWithout', { count: facts.twoFactor.holdersWithout }) : t('sec.signIn.twoFactorAll') }]
                  : []),
              ]}
            />
          )}
          {model.twoFactor.state !== 'no-right' && (
            <>
              <h3 className="fw-sec-sub">{t('sec.tf.title')}</h3>
              <p className="fw-adm-hint">{t('sec.tf.hint')}</p>
              <ListFrame<TwoFactorRole>
                label={t('sec.tf.title')}
                listKey={null}
                rows={list ? roles : null}
                rowId={(role) => role.id}
                columns={columns}
                count={list ? t('sec.tf.count', { count: roles.length }) : '—'}
                isRowSelectable={(role) => heldText((key, params) => t(key, params), rowHeld(role, list?.canChange ?? false))}
                selection={{
                  selected: ticked,
                  onChange: setSelected,
                  actions: (
                    <>
                      <BulkButton icon={<ShieldCheck size={13} aria-hidden />} label={t('sec.tf.bulk.ask', { count: ticked.length })} held={askHeld ? t(askHeld) : null} tone="primary" onClick={() => actions?.onTwoFactor?.(ticked, true)} />
                      <BulkButton icon={<ShieldOff size={13} aria-hidden />} label={t('sec.tf.bulk.stop', { count: ticked.length })} held={stopHeld ? t(stopHeld) : null} onClick={() => actions?.onTwoFactor?.(ticked, false)} />
                    </>
                  ),
                }}
                onHelp={() => setHelp(true)}
                state={
                  model.twoFactor.state === 'failed' ? (
                    <EmptyState title={t('sec.failed.title')} description={t('sec.failed.body')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('sec.retry')}</Button>} />
                  ) : undefined
                }
              />
              <p className="fw-adm-hint">
                {t('sec.tf.nextSignIn')} <Link href={adminHref(model.prefix, '/roles')}>{t('sec.tf.toRoles')}</Link>
              </p>
              <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection />
            </>
          )}
        </div>
      </Card>
    </section>
  )
}

/** The drills' columns (exported: a test draws each cell alone). */
export function drillColumns(ctx: { t: Translate; locale: ReturnType<typeof useLocale> }): ColDef<Drill>[] {
  const { t, locale } = ctx
  return [
    {
      colId: 'day',
      headerName: t('sec.drill.col.day'),
      valueGetter: ({ data }) => data?.drilledOn ?? '',
      width: 130,
      cellRenderer: cellOf<Drill>((drill) => formatDate(drill.drilledOn, { locale, timeZone: 'UTC' })),
    },
    {
      colId: 'result',
      headerName: t('sec.drill.col.result'),
      valueGetter: ({ data }) => (data ? t(`sec.drill.result.${data.result}`) : ''),
      width: 150,
      cellRenderer: cellOf<Drill>((drill) => <Pill tone={drill.result === 'PASSED' ? 'success' : 'danger'}>{t(`sec.drill.result.${drill.result}`)}</Pill>),
    },
    {
      colId: 'checks',
      headerName: t('sec.drill.col.checks'),
      valueGetter: ({ data }) => (data ? t('sec.drill.matched', matchedOf(data)) : ''),
      width: 170,
    },
    { colId: 'environment', headerName: t('sec.drill.col.environment'), field: 'environment', flex: 1.2, minWidth: 150 },
    {
      colId: 'backup',
      headerName: t('sec.drill.col.backup'),
      valueGetter: ({ data }) => (data?.backupAt ? formatDateTime(data.backupAt, { locale }) : '—'),
      width: 170,
    },
    {
      colId: 'took',
      headerName: t('sec.drill.col.took'),
      valueGetter: ({ data }) => (data?.durationMinutes != null ? t('sec.drill.minutes', { count: data.durationMinutes }) : '—'),
      width: 110,
    },
    { colId: 'by', headerName: t('sec.drill.col.by'), valueGetter: ({ data }) => data?.performedBy?.name ?? '—', flex: 1, minWidth: 140 },
    {
      colId: 'evidence',
      headerName: t('sec.drill.col.evidence'),
      valueGetter: ({ data }) => (data ? t(data.evidenceFileId ? 'sec.drill.evidence.yes' : 'sec.drill.evidence.no') : ''),
      width: 130,
    },
  ]
}

function BackupsCard({ model, actions }: { model: SecurityViewModel; actions?: SecurityActions }) {
  const t = useT('admin-security')
  const locale = useLocale()
  const [help, setHelp] = useState(false)
  const [asOf, setAsOf] = useState('')
  const columns = useMemo(() => drillColumns({ t, locale }), [t, locale])
  const value = model.facts.state === 'ok' ? model.facts.value.backups : null
  const last: Drill | undefined = value?.drills[0]
  const drill = value?.drill
  const words = drill ? drillWords(drill) : null
  return (
    <section id="backups" aria-labelledby="sec-backups" className="fw-sec-section">
      <Card
        header={<span id="sec-backups">{t('sec.backups.title')}</span>}
        description={t('sec.backups.hint')}
        headingLevel={2}
        padded
        headerAction={
          value?.canRecord ? (
            <Button size="sm" variant="primary" onClick={() => actions?.onRecordDrill?.()}>
              {t('sec.drill.record')}
            </Button>
          ) : null
        }
      >
        {!value ? (
          <SectionState read={model.facts} rows={4} />
        ) : (
          <div className="fw-adm-stack">
            <KeyValue
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('sec.backups.recovery'), value: t('sec.backups.recoveryValue'), hint: t('sec.backups.recoveryHint') },
                { label: t('sec.backups.secondCopy'), value: t('sec.backups.secondCopyValue'), hint: t('sec.backups.secondCopyHint') },
                { label: t('sec.backups.files'), value: t('sec.backups.filesValue'), hint: t('sec.backups.filesHint') },
                {
                  label: t('sec.backups.lastDrill'),
                  value: last ? (
                    <span className="fw-sec-fact">
                      <Pill tone={last.result === 'PASSED' ? 'success' : 'danger'}>{t(`sec.drill.result.${last.result}`)}</Pill>
                      {t('sec.drill.lastLine', { day: formatDate(last.drilledOn, { locale, timeZone: 'UTC' }), ...matchedOf(last) })}
                    </span>
                  ) : (
                    t('sec.drill.none')
                  ),
                  hint: words ? t(words.key, { ...words.params, ...(drill?.lastOn ? { day: formatDate(drill.lastOn, { locale, timeZone: 'UTC' }) } : {}) }) : undefined,
                },
              ]}
            />
            {!value.canRecord && <p className="fw-adm-hint">{t('sec.drill.recordHeld')}</p>}
            <h3 className="fw-sec-sub">{t('sec.drill.history')}</h3>
            <ListFrame<Drill>
              label={t('sec.drill.history')}
              listKey={null}
              rows={value.drills}
              rowId={(row) => row.id}
              columns={columns}
              count={t('sec.drill.count', { count: value.drills.length })}
              onHelp={() => setHelp(true)}
              state={value.drills.length === 0 ? <EmptyState title={t('sec.drill.emptyTitle')} description={t('sec.drill.emptyBody')} /> : undefined}
            />
            {last && last.checks.length > 0 && (
              <div className="fw-sec-checks" aria-label={t('sec.drill.lastChecks')}>
                {last.checks.map((check) => (
                  <Tag key={check.key} tone={check.match ? 'success' : 'danger'}>
                    {t(check.match ? 'sec.drill.check.match' : 'sec.drill.check.differs', { key: (DRILL_KEY_SET.has(check.key) ? t(`sec.drill.key.${check.key}`) : check.key) })}
                  </Tag>
                ))}
              </div>
            )}
            {value.canRecord && (
              <FingerprintPanel fingerprint={model.fingerprint} asOf={asOf} onAsOf={setAsOf} onRead={(at) => actions?.onFingerprint?.(at)} onCopy={(text) => actions?.onCopy?.(text)} />
            )}
            <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection={false} />
          </div>
        )}
      </Card>
    </section>
  )
}

const DRILL_KEY_SET: ReadonlySet<string> = new Set(['orders', 'invoices', 'stockMoves', 'parties', 'files'])

/** This database's fingerprint as of a time: on a restored copy, the line to copy into "Record a restore drill". */
function FingerprintPanel({
  fingerprint,
  asOf,
  onAsOf,
  onRead,
  onCopy,
}: {
  fingerprint: Read<FingerprintAnswer> | null
  asOf: string
  onAsOf: (value: string) => void
  onRead: (asOf: string) => void
  onCopy: (text: string) => void
}) {
  const t = useT('admin-security')
  const locale = useLocale()
  return (
    <div className="fw-sec-print">
      <h3 className="fw-sec-sub">{t('sec.print.title')}</h3>
      <p className="fw-adm-hint">{t('sec.print.hint')}</p>
      <div className="fw-sec-print-row">
        <DayTimeField value={asOf} onChange={onAsOf} label={t('sec.print.asOf')} />
        <Button size="sm" onClick={() => onRead(asOf)}>
          {t('sec.print.read')}
        </Button>
      </div>
      {fingerprint?.state === 'loading' && <Skeleton height={20} />}
      {fingerprint?.state === 'failed' && <p className="fw-adm-hint">{t('sec.print.failed')}</p>}
      {fingerprint?.state === 'ok' && (
        <div className="fw-sec-print-line">
          <code className="fw-sec-code">{fingerprint.value.line}</code>
          <Button size="sm" variant="quiet" onClick={() => onCopy(fingerprint.value.line)} aria-label={t('sec.print.copy')}>
            <Copy size={13} aria-hidden /> {t('sec.print.copy')}
          </Button>
          <span className="fw-adm-hint">{t('sec.print.asOfLine', { time: formatDateTime(fingerprint.value.asOf, { locale }) })}</span>
          <span className="fw-sec-print-keys">{Object.entries(fingerprint.value.fingerprint).map(([key, sum]) => `${t(`sec.drill.key.${key}`)} ${grouped(sum)}`).join(' · ')}</span>
        </div>
      )}
    </div>
  )
}
