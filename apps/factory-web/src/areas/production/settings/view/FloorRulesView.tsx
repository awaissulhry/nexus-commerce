'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Scale, ShieldOff, SlidersHorizontal } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Modal, Tabs, type TabItem } from '@nexus/ui/components'
import { saveKeyAction, StepUpModal } from '@nexus/ui/patterns'
import { Button, Input, NumberStepper, Pill, RadioCard, Select, Skeleton, Spinner, Textarea } from '@nexus/ui/primitives'
import type { BundleRules, FloorRules, FullLists } from '../w2b-api'
import type { ChecksDraft, CouponsDraft } from '../w2b-model'
import { CouponsCard, FloorChecksCard, FullListsNote } from './W2bCards'
import { MONITORING_BASES } from '@nexus/factory-domain/production/settings/monitoring'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { BasisKind, NoticeAcks, RulesDetail, ScanSubject, SiteRules } from '../api'
import { bundleHeld, draftOf, FLOOR_RULES_NAMESPACES, impactOf, MAX_BUNDLE, planOf, readinessOf, TABS, type FloorRulesCan, type Line, type SwitchDraft, type SwitchPlan, type Tab } from '../model'
import '../floor-rules.css'

export interface Part<T> {
  value: T | null
  problem: string | null
}

export interface FloorRulesModel {
  prefix: string
  can: FloorRulesCan
  tab: Tab
  timeZone: string
  sites: { status: 'loading' } | { status: 'ready'; items: SiteRules[] } | { status: 'error'; problem: string }
  siteId: string | null
  detail: Part<RulesDetail>
  acks: Part<NoticeAcks>
  asOf: string | null
  busy: 'switch' | 'bundle' | 'checks' | 'coupons' | 'full' | null
  /** B-W2b-58: the site's floor checks (fr-rules) with the fixed rules and idle sign-out, and its bundle codes (fr-bundle). */
  floor?: Part<FloorRules>
  coupons?: Part<BundleRules>
  /** B-W2b-58 (fr-reasons, MES-293): what the full floor lists still lack (the Reason codes tab). */
  full?: Part<FullLists>
  notice: { tone: 'success' | 'danger'; key: string; params?: Record<string, string | number> } | null
  /** The site's rules changed on another screen meanwhile (production.monitoring_changed): Reload. */
  changedElsewhere: boolean
  stepUp: { open: boolean; busy: boolean; problem: string | null }
  /** Design cases: a draft typed, the station confirm open, a bundle size typed. */
  draft?: SwitchDraft
  confirmOpen?: boolean
  bundleDraft?: number | ''
  checksDraft?: ChecksDraft
  couponsDraft?: CouponsDraft
}

export interface FloorRulesActions {
  onSite?: (siteId: string) => void
  onApplySwitch?: (draft: SwitchDraft, plan: SwitchPlan) => void
  onBundle?: (size: number) => void
  /** B-W2b-58: Apply the floor checks, the bundle codes; add the full reason lists. */
  onChecks?: (draft: ChecksDraft) => void
  onCoupons?: (draft: CouponsDraft) => void
  onFullLists?: () => void
  onStepUp?: (code: string) => void
  onStepUpCancel?: () => void
  onReload?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-074 — Production › Settings › Floor rules & codes (design production.settings): one site at a time (a picker when
 * the person reaches several), two link tabs. Floor rules: who floor records name — the monitoring switch (WORKER /
 * STATION, each in words) with the legal basis on record (L. 300/1970 art. 4 c.1: the kind and its reference, who
 * recorded it and when), whether the site is ready for real floor work, the worker notice as counts only (Owner answer
 * W1), what a change reaches; Apply held until the basis and reference are given for WORKER and a reason for widening;
 * widening asks a fresh code, narrowing asks "Record stations only"; the standard bundle size; the rules this version
 * fixes. Reason codes (SCR-088, B-W2a-46): the shared reason list editor, passed in by the page as `codes`. Fetches nothing.
 */
export function FloorRulesView({ model, actions, codes, offstd, routing }: { model: FloorRulesModel; actions?: FloorRulesActions; codes?: ReactNode; offstd?: ReactNode; routing?: ReactNode }) {
  return (
    <WithMessages namespaces={FLOOR_RULES_NAMESPACES}>
      <FloorRules model={model} actions={actions} codes={codes} offstd={offstd} routing={routing} />
    </WithMessages>
  )
}

const lineText = (t: (key: string, params?: Readonly<Record<string, string | number>>) => string, line: Line) => t(line.key, line.params)

function FloorRules({ model, actions, codes, offstd, routing }: { model: FloorRulesModel; actions?: FloorRulesActions; codes?: ReactNode; offstd?: ReactNode; routing?: ReactNode }) {
  const t = useT('floor-rules')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }

  if (!model.can.view)
    return (
      <div className="fw-fr">
        <Card padded>
          <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('fr.noAccess.title')} description={t('fr.noAccess.body')} />
        </Card>
      </div>
    )
  if (model.sites.status === 'loading')
    return (
      <div className="fw-fr" aria-busy="true">
        <Skeleton height={32} />
        <div className="fw-fr-grid">
          <Skeleton height={320} />
          <Skeleton height={320} />
        </div>
      </div>
    )
  if (model.sites.status === 'error') return <Failed actions={actions} problem={model.sites.problem} />
  if (model.sites.items.length === 0)
    return (
      <div className="fw-fr">
        <Card padded>
          <EmptyState icon={<SlidersHorizontal size={22} aria-hidden />} title={t('fr.noSites.title')} description={t('fr.noSites.body')} />
        </Card>
      </div>
    )

  const sites = model.sites.items
  const site = sites.find((entry) => entry.site.id === model.siteId) ?? sites[0]!
  const href = (tab: Tab) => `${model.prefix}/production/settings?site=${encodeURIComponent(site.site.id)}&tab=${tab}`
  // B-W2b-58: Off-standard codes and Help-call routing are grids saved per cell, each its own link tab.
  const tabs: TabItem[] = TABS.map((id) => ({ id, label: t(`fr.tab.${id}`), href: href(id) }))
  const detail = model.detail.value
  const ready = detail ? readinessOf(detail, model.acks.value).ready : site.status.readyForFloor

  return (
    <div className="fw-fr">
      <div className="fw-fr-head">
        <span className="fw-fr-status" role="status">
          <Pill tone={ready ? 'success' : 'warning'}>{ready ? t('fr.ready.yes') : t('fr.ready.no')}</Pill>
          <span className="fw-fr-sub">{model.asOf ? t('fr.updated', { time: formatTime(model.asOf, place) }) : ''}</span>
        </span>
        {sites.length > 1 && (
          <Select size="sm" aria-label={t('fr.site')} value={site.site.id} onChange={(event) => actions?.onSite?.(event.target.value)}>
            {sites.map((entry) => (
              <option key={entry.site.id} value={entry.site.id}>
                {t('fr.siteOption', { code: entry.site.code, name: entry.site.name })}
              </option>
            ))}
          </Select>
        )}
      </div>
      <Tabs ariaLabel={t('fr.tabs')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />

      {model.changedElsewhere && (
        <Banner
          tone="warning"
          title={t('fr.elsewhere.title')}
          action={
            <Button size="sm" onClick={() => actions?.onReload?.()}>
              {t('fr.elsewhere.reload')}
            </Button>
          }
        >
          {t('fr.elsewhere.body')}
        </Banner>
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('fr.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}

      {model.tab === 'codes' ? (
        <Codes model={model} codes={codes} actions={actions} />
      ) : model.tab === 'offstd' ? (
        <Slot allowed={model.can.offstd} title="fr.off.noAccess.title" body="fr.off.noAccess.body">
          {offstd}
        </Slot>
      ) : model.tab === 'calls' ? (
        <Slot allowed={model.can.calls} title="fr.route.noAccess.title" body="fr.route.noAccess.body">
          {routing}
        </Slot>
      ) : detail ? (
        <Rules key={`${detail.site.id}-${detail.rules.version ?? 0}`} model={model} actions={actions} detail={detail} />
      ) : model.detail.problem ? (
        <Failed actions={actions} problem={model.detail.problem} />
      ) : (
        <div className="fw-fr-grid" aria-busy="true">
          <Skeleton height={320} />
          <Skeleton height={320} />
        </div>
      )}

      <StepUpModal
        open={model.stepUp.open}
        title={t('fr.stepUp.title')}
        sentence={t('fr.stepUp.sentence')}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUp?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('fr.stepUp.confirm')}
      />
    </div>
  )
}

function Failed({ actions, problem }: { actions?: FloorRulesActions; problem: string }) {
  const t = useT('floor-rules')
  return (
    <div className="fw-fr">
      <Banner
        tone="danger"
        title={t(problem)}
        action={
          actions?.onRetry ? (
            <Button size="sm" onClick={actions.onRetry}>
              {t('fr.retry')}
            </Button>
          ) : undefined
        }
      />
    </div>
  )
}

const BASIS_WORDS: Record<BasisKind, string> = { UNION_AGREEMENT: 'fr.basis.UNION_AGREEMENT', INL_AUTHORISATION: 'fr.basis.INL_AUTHORISATION', NOT_REQUIRED: 'fr.basis.NOT_REQUIRED' }

function Rules({ model, actions, detail }: { model: FloorRulesModel; actions?: FloorRulesActions; detail: RulesDetail }) {
  const t = useT('floor-rules')
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const rules = detail.rules
  const saved = useMemo(() => draftOf(rules), [rules])
  const [draft, setDraft] = useState<SwitchDraft>(model.draft ?? saved)
  const [confirm, setConfirm] = useState(!!model.confirmOpen)
  useEffect(() => setConfirm(!!model.confirmOpen), [model.confirmOpen])
  const plan = planOf(rules, draft)
  const editable = model.can.manage
  const busy = model.busy === 'switch'
  const readiness = readinessOf(detail, model.acks.value)
  const impact = impactOf(rules.scanSubject, draft.subject, detail.affected)
  const set = (change: Partial<SwitchDraft>) => setDraft((current) => ({ ...current, ...change }))
  const apply = () => {
    if (!plan.action || plan.held || busy) return
    if (plan.confirm) setConfirm(true)
    else actions?.onApplySwitch?.(draft, plan)
  }
  // ⌘S / Ctrl+S applies the switch (not while it is held or busy, when the key does nothing).
  const latest = useRef(apply)
  latest.current = apply
  const keyState = useRef({ held: true, busy: false })
  keyState.current = { held: !plan.action || !!plan.held || confirm, busy }
  useEffect(() => {
    if (!editable) return
    const onKey = (event: KeyboardEvent) => {
      const action = saveKeyAction(event, keyState.current)
      if (action === 'ignore') return
      event.preventDefault()
      if (action === 'save') latest.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [editable])
  const subjectWords = (subject: ScanSubject) => ({ title: t(`fr.subject.${subject}.title`), description: t(`fr.subject.${subject}.body`) })
  const naming = draft.subject === 'WORKER'
  const basis = rules.legalBasis

  return (
    <div className="fw-fr-grid">
      <Card padded>
        <section className="fw-fr-section" aria-labelledby="fr-monitor">
          <h2 id="fr-monitor" className="fw-fr-title">
            {t('fr.monitor.title')}
          </h2>
          <p className="fw-fr-sub">{t('fr.monitor.intro')}</p>
          <div className="fw-fr-radios" role="radiogroup" aria-label={t('fr.monitor.title')}>
            {(['WORKER', 'STATION'] as const).map((subject) => (
              <RadioCard
                key={subject}
                name="fr-subject"
                value={subject}
                checked={draft.subject === subject}
                selected={draft.subject === subject}
                disabled={!editable || busy}
                onChange={() => set({ subject })}
                {...subjectWords(subject)}
              />
            ))}
          </div>

          {naming && (
            <div className="fw-fr-basis">
              <h3 className="fw-fr-subtitle">{t('fr.basis.title')}</h3>
              {editable ? (
                <>
                  <Field label={t('fr.basis.kind')} required={!basis}>
                    <Select value={draft.basisKind} disabled={busy} onChange={(event) => set({ basisKind: event.target.value as BasisKind | '' })}>
                      <option value="" disabled>
                        {t('fr.basis.pick')}
                      </option>
                      {MONITORING_BASES.map((kind) => (
                        <option key={kind} value={kind}>
                          {t(BASIS_WORDS[kind])}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t('fr.basis.reference')} required={!basis} hint={t('fr.basis.referenceHint')}>
                    <Input value={draft.reference} maxLength={240} disabled={busy} onChange={(event) => set({ reference: event.target.value })} />
                  </Field>
                </>
              ) : (
                <p className="fw-fr-text">{basis ? t('fr.basis.onRecord', { kind: t(BASIS_WORDS[basis.kind]), reference: basis.reference }) : t('fr.basis.none')}</p>
              )}
              {basis && (
                <p className="fw-fr-sub">
                  {basis.recordedByName
                    ? t('fr.basis.recordedBy', { name: basis.recordedByName, when: formatDateTime(basis.recordedAt, place) })
                    : t('fr.basis.recordedAt', { when: formatDateTime(basis.recordedAt, place) })}
                </p>
              )}
            </div>
          )}
          {!naming && basis && rules.scanSubject === 'WORKER' && <p className="fw-fr-sub">{t('fr.basis.kept')}</p>}

          {editable && plan.change === 'WIDEN' && (
            <Field label={t('fr.reason.label')} required hint={t('fr.reason.hint')}>
              <Textarea rows={2} value={draft.reason} maxLength={600} disabled={busy} onChange={(event) => set({ reason: event.target.value })} />
            </Field>
          )}

          {impact.length > 0 && (
            <div className="fw-fr-impact" role="note">
              <h3 className="fw-fr-subtitle">{t('fr.impact.title')}</h3>
              <ul className="fw-fr-list">
                {impact.map((line) => (
                  <li key={line.key}>{lineText(t, line)}</li>
                ))}
              </ul>
            </div>
          )}

          {editable ? (
            plan.action ? (
              <div className="fw-fr-savebar" role="region" aria-label={t('fr.save.region')}>
                <span className="fw-fr-text">{t('fr.save.unsaved', { count: plan.changes })}</span>
                <span className="fw-fr-actions">
                  <Button size="sm" disabled={busy} onClick={() => setDraft(saved)}>
                    {t('fr.save.discard')}
                  </Button>
                  <Button size="sm" variant="primary" heldReason={busy ? t('fr.busy') : plan.held ? t(plan.held) : null} onClick={apply} aria-keyshortcuts="Meta+S Control+S">
                    {busy ? <Spinner size={13} /> : null} {plan.stepUp ? t('fr.save.applyCode') : t('fr.save.apply')}
                  </Button>
                </span>
              </div>
            ) : (
              <p className="fw-fr-sub">{rules.updatedAt ? t('fr.save.lastChange', { when: formatDateTime(rules.updatedAt, place) }) : t('fr.save.default')}</p>
            )
          ) : (
            <p className="fw-fr-sub">{t('fr.viewOnly')}</p>
          )}
        </section>
      </Card>

      <div className="fw-fr-stack">
        <Card padded>
          <section className="fw-fr-section" aria-labelledby="fr-ready">
            <h2 id="fr-ready" className="fw-fr-title">
              {t('fr.ready.title')}
            </h2>
            <ul className="fw-fr-list">
              {readiness.lines.map((line) => (
                <li key={line.key}>{lineText(t, line)}</li>
              ))}
            </ul>
            <LegalBasisNote detail={detail} />
          </section>
        </Card>

        <Card padded>
          <section className="fw-fr-section" aria-labelledby="fr-notice">
            <h2 id="fr-notice" className="fw-fr-title">
              {t('fr.notice.title')}
            </h2>
            {model.acks.value ? (
              <>
                <p className="fw-fr-text">
                  {model.acks.value.workers.active === 0 ? t('fr.notice.noWorkers') : t('fr.notice.counts', { acknowledged: model.acks.value.workers.acknowledged, active: model.acks.value.workers.active })}
                </p>
                {model.acks.value.workers.notAcknowledged > 0 && <p className="fw-fr-sub">{t('fr.notice.waiting', { count: model.acks.value.workers.notAcknowledged })}</p>}
                {model.acks.value.versions.length > 0 && (
                  <ul className="fw-fr-list">
                    {model.acks.value.versions.map((version) => (
                      <li key={version.noticeVersion}>{t('fr.notice.version', { version: version.noticeVersion, count: version.workers })}</li>
                    ))}
                  </ul>
                )}
                <p className="fw-fr-sub">{t('fr.notice.countsOnly')}</p>
              </>
            ) : model.acks.problem ? (
              <p className="fw-fr-sub">{t(model.acks.problem)}</p>
            ) : (
              <Skeleton height={40} />
            )}
            {model.can.privacy && (
              <Link className="fw-fr-link" href={`${model.prefix}/admin/privacy`}>
                {t('fr.notice.toPrivacy')}
              </Link>
            )}
          </section>
        </Card>

        <BundleCard model={model} actions={actions} detail={detail} />
      </div>

      {/* B-W2b-58: Floor rules per site (fr-rules) beside Bundle codes (fr-bundle), each with its EditModeBar. */}
      <div className="fw-fr-wide">
        <FloorChecksCard model={model} actions={actions} />
        <CouponsCard model={model} actions={actions} />
      </div>

      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(false)}
          title={t('fr.confirm.title')}
          footer={
            <>
              <Button onClick={() => setConfirm(false)}>{t('fr.confirm.cancel')}</Button>
              <Button
                variant="primary"
                heldReason={busy ? t('fr.busy') : null}
                onClick={() => {
                  setConfirm(false)
                  actions?.onApplySwitch?.(draft, plan)
                }}
              >
                {t('fr.confirm.do')}
              </Button>
            </>
          }
        >
          <div className="fw-fr-section">
            <p className="fw-fr-text">{t('fr.confirm.body')}</p>
            <ul className="fw-fr-list">
              {impact
                .filter((line) => line.key !== 'fr.impact.narrow' && line.key !== 'fr.impact.keep')
                .map((line) => (
                  <li key={line.key}>{lineText(t, line)}</li>
                ))}
            </ul>
          </div>
        </Modal>
      )}
    </div>
  )
}

/**
 * The law beside the switch (design LegalBasisNote: a DS part not built yet, composed here): Statuto dei Lavoratori art.
 * 4 in plain words, the basis on record with its reference, who recorded it and when.
 */
function LegalBasisNote({ detail }: { detail: RulesDetail }) {
  const t = useT('floor-rules')
  const locale = useLocale()
  const basis = detail.rules.legalBasis
  return (
    <aside className="fw-fr-law" aria-label={t('fr.law.label')}>
      <Scale size={16} aria-hidden />
      <div className="fw-fr-section">
        <span className="fw-fr-subtitle">{t('fr.law.title')}</span>
        <p className="fw-fr-sub">{t('fr.law.body')}</p>
        <p className="fw-fr-sub">
          {basis
            ? t('fr.law.recorded', { kind: t(BASIS_WORDS[basis.kind]), reference: basis.reference, when: formatDateTime(basis.recordedAt, { locale, timeZone: 'Europe/Rome' }) })
            : t('fr.law.none')}
        </p>
      </div>
    </aside>
  )
}

function BundleCard({ model, actions, detail }: { model: FloorRulesModel; actions?: FloorRulesActions; detail: RulesDetail }) {
  const t = useT('floor-rules')
  const saved = detail.rules.standardBundleSize
  const [value, setValue] = useState<number | ''>(model.bundleDraft ?? saved)
  const busy = model.busy === 'bundle'
  const held = bundleHeld(value, saved)
  return (
    <Card padded>
      <section className="fw-fr-section" aria-labelledby="fr-bundle">
        <h2 id="fr-bundle" className="fw-fr-title">
          {t('fr.bundle.title')}
        </h2>
        <p className="fw-fr-sub">{t('fr.bundle.intro')}</p>
        {model.can.manage ? (
          <div className="fw-fr-row">
            <NumberStepper value={value} min={1} max={MAX_BUNDLE} size="sm" onChange={(next) => setValue(next)} suffix={t('fr.bundle.suffix')} decrementLabel={t('fr.bundle.less')} incrementLabel={t('fr.bundle.more')} />
            <Button size="sm" variant={value !== saved ? 'primary' : 'secondary'} heldReason={busy ? t('fr.busy') : held ? t(held) : null} onClick={() => typeof value === 'number' && actions?.onBundle?.(value)}>
              {busy ? <Spinner size={13} /> : null} {t('fr.bundle.save')}
            </Button>
          </div>
        ) : (
          <p className="fw-fr-text">{t('fr.bundle.value', { count: saved })}</p>
        )}
        {value !== '' && (value < 1 || value > MAX_BUNDLE) && <p className="fw-fr-sub fw-fr-warning">{t('fr.bundle.range')}</p>}
        <p className="fw-fr-sub">{t('fr.bundle.mtm')}</p>
      </section>
    </Card>
  )
}

/**
 * Reason codes (SCR-088; design production.settings fr-reasons; B-W2a-46): the page passes the shared reason list editor
 * (areas/_shared/reasons, B-W2a-18) as `codes` — pause, scrap, rework, downtime, help-call, adjustment, hold and cancel
 * reasons with words per language, icon and colour, active and used count, saved per cell. The view fetches nothing.
 */
function Codes({ model, codes, actions }: { model: FloorRulesModel; codes?: ReactNode; actions?: FloorRulesActions }) {
  const t = useT('floor-rules')
  if (!model.can.reasons)
    return (
      <Card padded>
        <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t('fr.codes.noAccess.title')} description={t('fr.codes.noAccess.body')} />
      </Card>
    )
  return (
    <div className="fw-fr-stack">
      <FullListsNote model={model} actions={actions} />
      {codes ?? null}
    </div>
  )
}

/** A W2b grid tab (Off-standard codes, Help-call routing): the editor the page passes, or why the role may not see it. */
function Slot({ allowed, title, body, children }: { allowed: boolean; title: string; body: string; children?: ReactNode }) {
  const t = useT('floor-rules')
  if (!allowed)
    return (
      <Card padded>
        <EmptyState icon={<ShieldOff size={22} aria-hidden />} title={t(title)} description={t(body)} />
      </Card>
    )
  return <div className="fw-fr-stack">{children ?? null}</div>
}
