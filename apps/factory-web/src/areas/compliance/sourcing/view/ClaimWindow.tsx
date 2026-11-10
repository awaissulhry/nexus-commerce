'use client'

import { useMemo } from 'react'
import { CheckCircle2, ExternalLink, FilePlus2, Pencil, Plus, Replace, Undo2 } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { SignOffPanel, type SignOffStep } from '@nexus/ui/components/SignOffPanel/index'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { CLAIM_LIMITS, CLAIMS_LAW, validityOf } from '@nexus/factory-domain/compliance/claims/rules'
import { DetailModal, FileRow, Textarea, Timeline, useDsWords, Combobox } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { Activity, Claim, ClaimRecord, ClaimUse, Evidence } from '../api'
import { approveHeld, CLAIM_TABS, EVIDENCE_RECORDS, FILE_CATEGORIES, draftChanged, draftProblems, endedUses, liveUses, scopeText, useHeld, USE_KINDS, withdrawHeld, wordsIn, type ClaimTab } from '../model'
import type { OpenState, SourcingPageActions, SourcingPageModel } from '../view-model'
import { ClaimFields } from './ClaimForm'
import { languageName, StatePill, useDay, useWords, ValidityBar } from './parts'

/**
 * The claim's window (design pop:sc-claim, a DetailModal; J / K over the list's rows): the tabs Wording (the words per language
 * with the checker's results and the law), Evidence (each file with its validity, the claim's own last valid day), Where used
 * (labels, styles, catalogue, web shop; a claim whose evidence no longer holds flags every place it is still used) and Activity
 * (who drafted, approved, recorded or withdrew, when). Its modes (`?do=`): a draft's Edit, Approve (the DS SignOffPanel: the
 * approval asks a fresh code), Withdraw with the reason (its uses end with it) and Record a use; Draft a replacement opens New
 * claim. Every button held with the reason while it cannot run.
 */
export function ClaimWindow({ model, state, actions }: { model: SourcingPageModel; state: OpenState; actions?: SourcingPageActions | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const record = state.read.status === 'ready' ? state.read.value : null
  const claim = record?.claim ?? null
  const rows = model.claims.status === 'ready' ? model.claims.value.claims : null
  const ids = useMemo(() => (rows ? rows.map((row) => row.id) : []), [rows])
  const canManage = !!claim && claim.canManage && model.can.manage
  const manageHeld = !claim ? t('common.reading') : canManage ? null : t('held.manage')
  const close = () => actions?.onAddress?.({ open: null })
  const back = () => actions?.onAddress?.({ mode: 'view' })
  const today = record?.today ?? model.today

  let footer = null
  if (claim && state.mode === 'edit' && state.draft) {
    const problems = draftProblems(state.draft, false)
    const held = state.busy ? t('held.busy') : problems[0] ? t(problems[0].key) : draftChanged(claim, state.draft) ? null : t('held.nothingChanged')
    footer = (
      <>
        <Button onClick={back}>{t('common.back')}</Button>
        <Button variant="primary" heldReason={held} onClick={() => actions?.onSaveEdit?.()}>
          {t('edit.save')}
        </Button>
      </>
    )
  } else if (claim && state.mode === 'withdraw') {
    const held = withdrawHeld(state.reason, state.busy)
    footer = (
      <>
        <Button onClick={back}>{t('common.back')}</Button>
        <Button variant="danger" heldReason={held ? t(held) : manageHeld} onClick={() => actions?.onWithdraw?.()}>
          <Undo2 size={14} aria-hidden /> {t('withdraw.save')}
        </Button>
      </>
    )
  } else if (claim && record && state.mode === 'use') {
    const held = useHeld(claim, state.use, state.busy)
    footer = (
      <>
        <Button onClick={back}>{t('common.back')}</Button>
        <Button variant="primary" heldReason={held ? t(held) : manageHeld} onClick={() => actions?.onAddUse?.()}>
          <Plus size={14} aria-hidden /> {t('use.save')}
        </Button>
      </>
    )
  } else if (claim && state.mode === 'approve') {
    footer = <Button onClick={back}>{t('common.back')}</Button>
  } else if (claim) {
    const replaceHeld = claim.status === 'DRAFT' ? t('held.replaceDraft') : claim.supersededBy && claim.supersededBy.status !== 'WITHDRAWN' ? t('held.replaced', { code: claim.supersededBy.code }) : manageHeld
    const approve = approveHeld(claim, today, model.can, state.busy)
    footer = (
      <>
        {claim.status !== 'WITHDRAWN' && (
          <Button heldReason={manageHeld} onClick={() => actions?.onAddress?.({ mode: 'withdraw' })}>
            <Undo2 size={14} aria-hidden /> {t('withdraw.open')}
          </Button>
        )}
        {claim.status === 'DRAFT' ? (
          <>
            <Button heldReason={manageHeld} onClick={() => actions?.onAddress?.({ mode: 'edit' })}>
              <Pencil size={14} aria-hidden /> {t('edit.open')}
            </Button>
            <Button variant="primary" heldReason={approve === 'held.busy' ? t(approve) : !model.can.approve || !claim.canApprove ? t('held.approve') : null} onClick={() => actions?.onAddress?.({ mode: 'approve' })}>
              <CheckCircle2 size={14} aria-hidden /> {t('approve.open')}
            </Button>
          </>
        ) : (
          <>
            {claim.status === 'APPROVED' && (
              <Button heldReason={claim.state === 'BLOCKED' ? t('refusal.NOT_HOLDING') : manageHeld} onClick={() => actions?.onAddress?.({ mode: 'use', tab: 'where' })}>
                <FilePlus2 size={14} aria-hidden /> {t('use.open')}
              </Button>
            )}
            <Button variant={claim.state === 'APPROVED' ? 'secondary' : 'primary'} heldReason={replaceHeld} onClick={() => actions?.onAddress?.({ add: true, replaces: claim.id })}>
              <Replace size={14} aria-hidden /> {t('replace.open')}
            </Button>
          </>
        )}
      </>
    )
  }

  const tabbed = state.mode === 'view'
  return (
    <DetailModal
      open
      onClose={close}
      title={claim ? `${claim.code} · ${t(`kind.${claim.kind}`)}` : t('claim.noun')}
      subtitle={claim ? wordsIn(claim.wording, locale) : undefined}
      meta={claim ? <StatePill state={claim.state} /> : undefined}
      tabs={tabbed && claim ? CLAIM_TABS.map((tab) => ({ id: tab, label: t(`tab.${tab}`), ...(tab === 'where' ? { count: claim.uses.live } : {}) })) : undefined}
      activeTab={state.tab}
      onTabChange={(tab) => actions?.onAddress?.({ tab: tab as ClaimTab })}
      tabsLabel={t('tab.label')}
      nav={ids.includes(state.id) && state.mode === 'view' ? { ids, current: state.id, onGo: (id) => actions?.onAddress?.({ open: id }), noun: t('claim.noun') } : undefined}
      loading={state.read.status === 'loading'}
      error={state.read.status === 'error' ? t(state.read.problem) : undefined}
      onRetry={actions?.onRetryOpen}
      footer={footer}
    >
      {claim && record && (
        <div className="fw-sc-stack">
          {state.saved && <Banner tone="success" title={t(state.saved.key, state.saved.params ?? {})} />}
          {state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}
          {state.mode === 'edit' && state.draft ? (
            <ClaimFields draft={state.draft} choices={state.choices} problem={state.problem} isNew={false} canUpload={model.can.upload} onDraft={(draft) => actions?.onEditDraft?.(draft)} onFiles={(files) => actions?.onEditFiles?.(files)} onRetryChoices={actions?.onRetryChoices} />
          ) : state.mode === 'approve' ? (
            <ApproveBody claim={claim} state={state} model={model} actions={actions} today={today} />
          ) : state.mode === 'withdraw' ? (
            <div className="fw-sc-form">
              <p className="fw-sc-muted">{claim.uses.live > 0 ? t('withdraw.usesEnd', { count: claim.uses.live }) : t('withdraw.noUses')}</p>
              <Field label={t('withdraw.reason')} required>
                <Textarea value={state.reason} rows={3} maxLength={CLAIM_LIMITS.reason} onChange={(event) => actions?.onReason?.(event.target.value)} />
              </Field>
            </div>
          ) : state.mode === 'use' ? (
            <UseBody claim={claim} state={state} actions={actions} />
          ) : state.tab === 'evidence' ? (
            <EvidenceTab claim={claim} today={today} onOpen={(id) => actions?.onOpenEvidence?.(id)} />
          ) : state.tab === 'where' ? (
            <WhereTab claim={claim} record={record} prefix={model.prefix} canManage={canManage} busy={state.busy} onEnd={(id) => actions?.onEndUse?.(id)} />
          ) : state.tab === 'activity' ? (
            <ActivityTab activity={record.activity} />
          ) : (
            <WordingTab claim={claim} record={record} companyName={model.companyName} />
          )}
        </div>
      )}
    </DetailModal>
  )
}

/** The claim's words per language with the checker's results, what it covers, and how it stands. */
function WordingTab({ claim, record, companyName }: { claim: Claim; record: ClaimRecord; companyName: string }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const when = (at: string | null) => (at ? formatDateTime(at, { locale }) : '—')
  return (
    <div className="fw-sc-stack">
      <section className="fw-sc-section" aria-labelledby="fw-sc-wording">
        <span className="fw-sc-row">
          <h3 id="fw-sc-wording" className="fw-sc-h3">
            {t('wording.title')}
          </h3>
          <LawRef law={record.law.claims ?? CLAIMS_LAW} plain={t('law.claims')} labels={ds.lawRef} />
        </span>
        <dl className="fw-sc-facts">
          {Object.entries(claim.wording).map(([language, text]) => (
            <div key={language} className="fw-sc-fact">
              <dt>{languageName(language, locale)}</dt>
              <dd>
                <span>{text}</span>
                {(record.findings[language] ?? []).map((finding, index) => (
                  <span key={index} className={finding.severity === 'refuse' ? 'fw-sc-danger-text' : 'fw-sc-muted'}>
                    {t(`finding.${finding.code}`, { words: finding.words })}
                  </span>
                ))}
                {!record.findings[language] && <span className="fw-sc-muted">{t('wording.checked')}</span>}
              </dd>
            </div>
          ))}
        </dl>
        {claim.phraseKey && <p className="fw-sc-muted">{t('wording.phrase', { key: claim.phraseKey })}</p>}
      </section>
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('wording.covers'), value: scopeText(claim, companyName || t('scope.COMPANY')) },
          { label: t('wording.part'), value: claim.scopeNote ?? '—' },
          { label: t('wording.drafted'), value: `${claim.createdBy?.name ?? t('wording.someone')} · ${when(claim.createdAt)}` },
          { label: t('wording.approved'), value: claim.approvedAt ? `${claim.approvedBy?.name ?? t('wording.someone')} · ${when(claim.approvedAt)}` : t('wording.notApproved') },
          ...(claim.supersedes ? [{ label: t('wording.replaces'), value: claim.supersedes.code }] : []),
          ...(claim.supersededBy ? [{ label: t('wording.replacedBy'), value: `${claim.supersededBy.code} · ${t(`status.${claim.supersededBy.status}`)}` }] : []),
          ...(claim.withdrawnAt ? [{ label: t('wording.withdrawn'), value: `${when(claim.withdrawnAt)} · ${claim.withdrawReason ?? ''}` }] : []),
          ...(claim.note ? [{ label: t('wording.note'), value: claim.note }] : []),
        ]}
      />
    </div>
  )
}

/** What proves it: each file with its state and validity; the claim's own last valid day; why it no longer holds. */
function EvidenceTab({ claim, today, onOpen }: { claim: Claim; today: string; onOpen: (fileId: string) => void }) {
  const t = useWords()
  const day = useDay()
  return (
    <div className="fw-sc-stack">
      {claim.state === 'BLOCKED' && (
        <Banner tone="danger" title={t('evidence.blocked')}>
          <ul className="fw-sc-list">
            {claim.blockReasons.map((reason, index) => (
              <li key={index}>{t(`block.${reason.cause}`, { date: day(reason.day), file: claim.evidence.find((file) => file.id === reason.fileId)?.name ?? '' })}</li>
            ))}
          </ul>
        </Banner>
      )}
      <section className="fw-sc-section" aria-labelledby="fw-sc-until">
        <h3 id="fw-sc-until" className="fw-sc-h3">
          {t('evidence.until')}
        </h3>
        <ValidityBar validity={claim.validity} until={claim.validUntil} from={claim.approvedAt ?? claim.createdAt} today={today} />
      </section>
      <section className="fw-sc-section" aria-labelledby="fw-sc-files">
        <h3 id="fw-sc-files" className="fw-sc-h3">
          {t('evidence.files')}
        </h3>
        {claim.evidence.length === 0 ? (
          <p className="fw-sc-muted">{t('evidence.none')}</p>
        ) : (
          <div className="fw-sc-files">
            {claim.evidence.map((file) => (
              <EvidenceRow key={file.id} file={file} today={today} onOpen={() => onOpen(file.id)} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function EvidenceRow({ file, today, onOpen }: { file: Evidence; today: string; onOpen: () => void }) {
  const t = useWords()
  const validity = validityOf(file.expiresOn, today)
  const gone = file.status !== 'AVAILABLE'
  return (
    <FileRow
      name={file.name}
      size={file.sizeBytes || undefined}
      tone={gone || validity.state === 'EXPIRED' ? 'danger' : 'neutral'}
      status={
        <span className="fw-sc-stack-tight">
          <span>{[file.category && FILE_CATEGORIES.includes(file.category) ? t(`category.${file.category}`) : t('evidence.file'), file.recordType && EVIDENCE_RECORDS.includes(file.recordType) ? t('evidence.of', { record: t(`record.${file.recordType}`) }) : null, gone ? t(`fileStatus.${file.status}`) : null].filter(Boolean).join(' · ')}</span>
          <ValidityBar validity={validity} until={file.expiresOn} from={file.availableAt} today={today} mini />
        </span>
      }
      actions={
        <Button size="sm" variant="quiet" heldReason={gone ? t('held.fileGone') : null} aria-label={t('evidence.openNamed', { name: file.name })} onClick={onOpen}>
          <ExternalLink size={13} aria-hidden /> {t('evidence.open')}
        </Button>
      }
    />
  )
}

/** Where it appears: every live use (End), then the ended ones; a claim that no longer holds flags each live one. */
function WhereTab({ claim, record, prefix, canManage, busy, onEnd }: { claim: Claim; record: ClaimRecord; prefix: string; canManage: boolean; busy: boolean; onEnd: (useId: string) => void }) {
  const t = useWords()
  const locale = useLocale()
  const live = liveUses(record)
  const ended = endedUses(record)
  const flagged = (claim.state === 'BLOCKED' || claim.state === 'RETIRED') && live.length > 0
  const when = (at: string | null) => (at ? formatDateTime(at, { locale }) : '—')
  const recordCell = (use: ClaimUse) => {
    const words = use.record ? `${use.record.code} · ${use.record.name}` : t('where.outOfSight')
    return (
      <a className="fw-sc-link" href={`${prefix}${recordAddress({ type: use.recordType, id: use.recordId }, OFFICE_PAGES)}`}>
        {words}
      </a>
    )
  }
  if (record.uses.length === 0) return <EmptyState title={t('where.noneTitle')} description={claim.state === 'APPROVED' ? t('where.none') : t('where.noneNotApproved')} />
  return (
    <div className="fw-sc-stack">
      {flagged && <Banner tone="danger" title={t(claim.state === 'BLOCKED' ? 'where.flagBlocked' : 'where.flagRetired', { count: live.length })} />}
      <section className="fw-sc-section" aria-labelledby="fw-sc-live">
        <h3 id="fw-sc-live" className="fw-sc-h3">
          {t('where.live', { count: live.length })}
        </h3>
        {live.length === 0 ? (
          <p className="fw-sc-muted">{t('where.noLive')}</p>
        ) : (
          <SummaryTable
            label={t('where.live', { count: live.length })}
            density="roomy"
            stackOnPhone
            columns={[t('where.col.kind'), t('where.col.record'), t('where.col.label'), t('where.col.since'), t('where.col.end')]}
            rows={live.map((use) => ({
              id: use.id,
              cells: [
                <span key="k" className={flagged ? 'fw-sc-danger-text' : undefined}>
                  {t(`use.${use.kind}`)}
                  {flagged ? ` · ${t('where.mustChange')}` : ''}
                </span>,
                recordCell(use),
                use.label ?? '—',
                `${when(use.createdAt)}${use.createdBy ? ` · ${use.createdBy.name}` : ''}`,
                <Button key="e" size="sm" variant="quiet" heldReason={busy ? t('held.busy') : canManage ? null : t('held.manage')} aria-label={t('where.endNamed', { kind: t(`use.${use.kind}`), record: use.record?.code ?? '' })} onClick={() => onEnd(use.id)}>
                  {t('where.end')}
                </Button>,
              ],
            }))}
          />
        )}
      </section>
      {ended.length > 0 && (
        <section className="fw-sc-section" aria-labelledby="fw-sc-ended">
          <h3 id="fw-sc-ended" className="fw-sc-h3">
            {t('where.ended', { count: ended.length })}
          </h3>
          <SummaryTable
            label={t('where.ended', { count: ended.length })}
            stackOnPhone
            columns={[t('where.col.kind'), t('where.col.record'), t('where.col.label'), t('where.col.ended')]}
            rows={ended.map((use) => ({ id: use.id, cells: [t(`use.${use.kind}`), recordCell(use), use.label ?? '—', `${when(use.endedAt)}${use.endedBy ? ` · ${use.endedBy.name}` : ''}`] }))}
          />
        </section>
      )}
    </div>
  )
}

/** Changes and approvals, newest first (the claim's audit rows in words). */
function ActivityTab({ activity }: { activity: readonly Activity[] }) {
  const t = useWords()
  if (activity.length === 0) return <p className="fw-sc-muted">{t('activity.none')}</p>
  const tone = (action: string) => (action.endsWith('approve') ? 'success' : action.endsWith('withdraw') || action.endsWith('replaced') || action.endsWith('evidenceExpired') ? 'danger' : 'neutral')
  return (
    <Timeline
      label={t('activity.label')}
      steps={activity.map((entry) => {
        const action = entry.action.split('.').pop() ?? entry.action
        const facts = entry.facts
        const detail = [entry.by ? entry.by.name : t('activity.system'), typeof facts.label === 'string' ? facts.label : null, typeof facts.kind === 'string' && action.endsWith('Use') ? t(`use.${facts.kind}`) : null, entry.reason].filter(Boolean).join(' · ')
        return { key: entry.id, label: t(`activity.${action}`, { code: typeof facts.replacedBy === 'string' ? facts.replacedBy : typeof facts.replaces === 'string' ? facts.replaces : '', count: typeof facts.liveUses === 'number' ? facts.liveUses : typeof facts.usesEnded === 'number' ? facts.usesEnded : 0 }), tone: tone(action), at: entry.at, detail }
      })}
    />
  )
}

/** Approve: the sign-off (drafted, then approved with a fresh code), the evidence it rests on, and why it is held. */
function ApproveBody({ claim, state, model, actions, today }: { claim: Claim; state: OpenState; model: SourcingPageModel; actions?: SourcingPageActions | undefined; today: string }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  const held = approveHeld(claim, today, model.can, state.busy)
  const steps: SignOffStep[] = [
    { id: 'draft', label: t('approve.stepDraft', { code: claim.code }), role: t('approve.roleKeeper'), state: 'signed', ...(claim.createdBy ? { signer: claim.createdBy.name } : {}), signedAt: formatDateTime(claim.createdAt, { locale }) },
    {
      id: 'approve',
      label: t('approve.stepApprove', { code: claim.code }),
      role: t('approve.roleApprover'),
      state: 'waiting',
      whoMay: t('approve.whoMay'),
      heldReason: held && held !== 'held.busy' ? t(held, { code: claim.code }) : null,
      action: { label: t('approve.do'), onClick: () => actions?.onApprove?.(), busy: state.busy, busyLabel: t('common.working') },
      note: claim.supersedes ? t('approve.replacesNote', { code: claim.supersedes.code }) : t('approve.note'),
    },
  ]
  return (
    <div className="fw-sc-form">
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: t('approve.evidence'), value: claim.evidence.length === 0 ? t('evidence.none') : claim.evidence.map((file) => file.name).join(', ') },
          { label: t('approve.until'), value: <ValidityBar validity={claim.validity} until={claim.validUntil} today={today} mini /> },
        ]}
      />
      <SignOffPanel title={t('approve.signOff')} steps={steps} labels={ds.signOffPanel} headingLevel={3} />
      <p className="fw-sc-muted">{t('approve.code')}</p>
    </div>
  )
}

/** Record a use: where it appears (a label template, or a style for its texts, catalogue or web shop page), named. */
function UseBody({ claim, state, actions }: { claim: Claim; state: OpenState; actions?: SourcingPageActions | undefined }) {
  const t = useWords()
  const choices = state.choices?.status === 'ready' ? state.choices.value : null
  const set = (change: Partial<OpenState['use']>) => actions?.onUseDraft?.({ ...state.use, ...change })
  const options = state.use.kind === 'LABEL' ? (choices?.labels ?? []).map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` })) : (choices?.styles ?? []).map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }))
  return (
    <div className="fw-sc-form">
      <p className="fw-sc-muted">{t('use.hint', { code: claim.code })}</p>
      {state.choices?.status === 'error' && <Banner tone="warning" title={t('form.choicesFailed')}>{t(state.choices.problem)}</Banner>}
      <div className="fw-sc-form-grid">
        <Field label={t('use.kind')} required>
          <Select value={state.use.kind} onChange={(event) => set({ kind: event.target.value as OpenState['use']['kind'], recordId: null })}>
            {USE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`use.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={state.use.kind === 'LABEL' ? t('use.label') : t('use.style')} required>
          <span id="fw-sc-use-record" className="fw-sc-vh">
            {state.use.kind === 'LABEL' ? t('use.label') : t('use.style')}
          </span>
          <Combobox labelledBy="fw-sc-use-record" options={options} value={state.use.recordId ?? ''} onChange={(value) => set({ recordId: value || null })} />
        </Field>
      </div>
      <Field label={t('use.name')} required={state.use.kind === 'CATALOGUE' || state.use.kind === 'OTHER'} hint={t('use.nameHint')}>
        <Input value={state.use.label} maxLength={CLAIM_LIMITS.label} onChange={(event) => set({ label: event.target.value })} />
      </Field>
      <Field label={t('use.note')}>
        <Textarea value={state.use.note} rows={2} maxLength={CLAIM_LIMITS.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
    </div>
  )
}
