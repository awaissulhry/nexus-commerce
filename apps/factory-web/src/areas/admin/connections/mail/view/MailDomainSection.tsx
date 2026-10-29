'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Mail } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, Modal } from '@nexus/ui/components'
import { Button, Input, Pill, RadioCard, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { DISPLAY_NAME_POLICIES, IDENTITY_KINDS, type SendingIdentity } from '../../api'
import { ConnNotice, CopyButton, CopyField } from '../../view/parts'
import { dnsRows, draftProblems, emptyDraft, fromAddressOf, IDENTITY_TONE, identityState, RECORD_TONE, recordsText, type AddDomainDraft, type MailDomainModel } from '../model'

export type { MailDomainModel } from '../model'

export interface MailDomainActions {
  onAdd?: (open: boolean) => void
  onCreate?: (draft: AddDomainDraft) => Promise<boolean>
  onCheck?: (identity: SendingIdentity) => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-015 — Connections & API › Your mail domain (design 02 admin.connections `mail-domain`; PLT-230, COL-020, COL-022):
 * send and receive mail from the company's own domain. Per sending identity: the records to add at the registrar, each
 * with Copy and its state as SES last saw it; Check now (a fresh code: email.manage is a step-up right); Copy all
 * records for whoever keeps the domain. SPF, DMARC and the reply MX are listed as not checked by Nexus yet (honest: the
 * API reads only SES's domain and DKIM state). The anchor `#mail` lands here. Fetches nothing.
 */
export function MailDomainSection({ model, actions, prefix }: { model: MailDomainModel; actions?: MailDomainActions; prefix: string }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const items = model.identities.items
  const addHeld = !model.can.manage
    ? tAdmin('held.needs', { right: t('mail.right.manage') })
    : model.sesAccounts.length === 0
      ? t('mail.held.noSes')
      : model.companies.length === 0
        ? t('mail.held.noCompany')
        : null
  return (
    <section id="mail" className="fw-adm-stack" aria-labelledby="fw-adm-conn-mail-title">
      <div className="fw-adm-head">
        <div className="fw-adm-head-text">
          <h2 id="fw-adm-conn-mail-title" className="fw-adm-name">
            {t('mail.title')}
          </h2>
          <p className="fw-adm-intro">{t('mail.intro')}</p>
        </div>
        <div className="fw-adm-actions">
          <Button size="sm" onClick={() => actions?.onAdd?.(true)} heldReason={addHeld}>
            {t('mail.add.open')}
          </Button>
        </div>
      </div>
      <ConnNotice notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {model.identities.problem ? (
        <Card padded>
          <EmptyState
            title={t('mail.failedTitle')}
            description={tAdmin(model.identities.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {tAdmin('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : items === null ? (
        <Card padded aria-busy="true">
          <p className="fw-adm-loading" role="status">
            <Spinner size={14} /> {tAdmin('list.loading')}
          </p>
          <div className="fw-adm-skeleton">
            <Skeleton height={20} />
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        </Card>
      ) : items.length === 0 ? (
        <Card padded>
          <EmptyState
            icon={<Mail size={24} aria-hidden />}
            title={t('mail.empty.title')}
            description={t('mail.empty.body')}
            action={
              <Button variant="primary" onClick={() => actions?.onAdd?.(true)} heldReason={addHeld}>
                {t('mail.add.open')}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="fw-adm-conn-identities">
          {items.map((identity) => (
            <IdentityCard key={identity.id} identity={identity} model={model} actions={actions} />
          ))}
        </div>
      )}
      <Card header={t('mail.rule.title')} headingLevel={3} padded>
        <div className="fw-adm-stack">
          <p className="fw-adm-intro">{t('mail.rule.reply')}</p>
          <p className="fw-adm-intro">{t('mail.rule.checks')}</p>
          <p className="fw-adm-hint">
            <Link href={`${prefix}/home/mail-to-sort`}>{t('mail.rule.toSort')}</Link>
          </p>
          <p className="fw-adm-hint">{t('mail.rule.capture')}</p>
        </div>
      </Card>
      <AddDomainModal model={model} actions={actions} />
    </section>
  )
}

function IdentityCard({ identity, model, actions }: { identity: SendingIdentity; model: MailDomainModel; actions?: MailDomainActions }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const locale = useLocale()
  const state = identityState(identity)
  const company = model.companies.find((item) => item.id === identity.companyId)?.name
  const checking = model.checking === identity.id
  const rows = dnsRows(identity)
  return (
    <Card padded>
      <div className="fw-adm-stack">
        <div className="fw-adm-conn-identity-head">
          <div className="fw-adm-cell">
            <h3 className="fw-adm-name">{identity.domain}</h3>
            <span className="fw-adm-hint">{[company ?? '—', t(`mail.kind.${identity.kind}`)].join(' · ')}</span>
          </div>
          <span className="fw-adm-tags">
            <Pill tone={IDENTITY_TONE[state]}>{t(`mail.state.${state}`)}</Pill>
            {identity.isDefault && <Tag>{t('mail.default')}</Tag>}
          </span>
        </div>
        {state === 'waiting' && <Banner tone="info" title={t('mail.banner.waiting')} />}
        {state === 'failed' && <Banner tone="danger" title={t('mail.banner.failed')} />}
        {state === 'disabled' && <Banner tone="neutral" title={t('mail.banner.disabled')} />}
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('mail.field.from'), value: identity.fromAddress },
            { label: t('mail.field.policy'), value: t(`mail.policy.${identity.displayNamePolicy}`), hint: identity.displayName },
            { label: t('mail.field.reply'), value: identity.replyDomain, hint: t('mail.field.replyHint') },
            { label: t('mail.field.checked'), value: identity.lastCheckedAt ? formatDateTime(identity.lastCheckedAt, { locale }) : t('mail.notCheckedYet') },
          ]}
        />
        <div className="fw-adm-conn-dns" role="table" aria-label={t('mail.records.label', { domain: identity.domain })}>
          <div className="fw-adm-sr" role="row">
            <span role="columnheader">{t('mail.records.type')}</span>
            <span role="columnheader">{t('mail.records.name')}</span>
            <span role="columnheader">{t('mail.records.value')}</span>
            <span role="columnheader">{t('mail.records.state')}</span>
          </div>
          {rows.map((row) => (
            <div key={row.id} className="fw-adm-conn-dns-row" role="row">
              <span className="fw-adm-cell" role="cell">
                <span className="fw-adm-code">{row.type}</span>
                <span className="fw-adm-hint">{t(`mail.purpose.${row.purpose}`)}</span>
              </span>
              <span role="cell">
                <CopyField value={row.name} label={t('mail.records.nameOf', { purpose: t(`mail.purpose.${row.purpose}`) })} />
              </span>
              <span role="cell">{row.value ? <CopyField value={row.value} label={t('mail.records.valueOf', { purpose: t(`mail.purpose.${row.purpose}`) })} /> : <span className="fw-adm-hint">{t('mail.records.noValue')}</span>}</span>
              <span role="cell">
                <Pill tone={RECORD_TONE[row.state]}>{t(`mail.record.${row.state}`)}</Pill>
              </span>
            </div>
          ))}
        </div>
        <p className="fw-adm-hint">{t('mail.records.later')}</p>
        <div className="fw-adm-actions">
          <CopyButton text={recordsText(identity)} label={t('mail.copyAll')} what={t('mail.records.label', { domain: identity.domain })} />
          <Button
            size="sm"
            variant="primary"
            onClick={() => actions?.onCheck?.(identity)}
            heldReason={!model.can.manage ? tAdmin('held.needs', { right: t('mail.right.manage') }) : checking ? t('mail.checking') : null}
          >
            {checking ? <Spinner size={12} /> : null} {checking ? t('mail.checking') : t('mail.check')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function AddDomainModal({ model, actions }: { model: MailDomainModel; actions?: MailDomainActions }) {
  const t = useT('admin-connections')
  const tAdmin = useT('admin')
  const open = !!model.add
  const fresh = useMemo(() => model.add?.draft ?? emptyDraft(model.companies[0]?.id ?? '', model.sesAccounts.find((account) => account.status === 'ACTIVE')?.id ?? model.sesAccounts[0]?.id ?? ''), [model.add, model.companies, model.sesAccounts])
  const [draft, setDraft] = useState<AddDomainDraft>(fresh)
  const [tried, setTried] = useState(!!model.add?.draft)
  useEffect(() => {
    setDraft(fresh)
    setTried(!!model.add?.draft)
  }, [fresh, model.add])
  if (!open) return null
  const problems = draftProblems(draft)
  const count = Object.keys(problems).length
  const show = (field: keyof AddDomainDraft) => (tried && problems[field] ? t(problems[field]!) : undefined)
  const from = fromAddressOf(draft)
  const submit = () => {
    setTried(true)
    if (count === 0) void actions?.onCreate?.(draft)
  }
  return (
    <Modal
      open
      onClose={() => actions?.onAdd?.(false)}
      title={t('mail.add.title')}
      subtitle={t('mail.add.subtitle')}
      size="lg"
      busy={model.busy}
      footer={
        <>
          <Button onClick={() => actions?.onAdd?.(false)}>{tAdmin('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} heldReason={model.busy ? tAdmin('common.saving') : tried && count > 0 ? tAdmin('form.fixFirst', { count }) : null}>
            {t('mail.add.go')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        {model.dialogProblem && <Banner tone="danger" title={tAdmin(model.dialogProblem)} />}
        <div className="fw-adm-form">
          <Field label={t('mail.field.company')} required error={show('companyId')}>
            <Select value={draft.companyId} onChange={(event) => setDraft({ ...draft, companyId: event.target.value })}>
              <option value="">{t('mail.add.pickCompany')}</option>
              {model.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('mail.field.account')} required error={show('accountId')} hint={t('mail.add.accountHint')}>
            <Select value={draft.accountId} onChange={(event) => setDraft({ ...draft, accountId: event.target.value })}>
              <option value="">{t('mail.add.pickAccount')}</option>
              {model.sesAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label} · {t(`conn.mode.${account.mode}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('mail.field.domain')} required error={show('domain')} hint={t('mail.add.domainHint')}>
            <Input value={draft.domain} placeholder="mail.example.com" onChange={(event) => setDraft({ ...draft, domain: event.target.value })} autoFocus />
          </Field>
          <Field label={t('mail.field.localPart')} required error={show('localPart')} hint={from ? t('mail.add.fromWillBe', { address: from }) : t('mail.add.localHint')}>
            <Input value={draft.localPart} onChange={(event) => setDraft({ ...draft, localPart: event.target.value })} />
          </Field>
        </div>
        <fieldset className="fw-adm-form">
          <legend className="fw-adm-name">{t('mail.field.kind')}</legend>
          {IDENTITY_KINDS.map((kind) => (
            <RadioCard key={kind} name="fw-adm-conn-kind" checked={draft.kind === kind} selected={draft.kind === kind} onChange={() => setDraft({ ...draft, kind })} title={t(`mail.kind.${kind}`)} description={t(`mail.kindHint.${kind}`)} />
          ))}
        </fieldset>
        <fieldset className="fw-adm-form">
          <legend className="fw-adm-name">{t('mail.field.policy')}</legend>
          {DISPLAY_NAME_POLICIES.map((policy) => (
            <RadioCard
              key={policy}
              name="fw-adm-conn-policy"
              checked={draft.displayNamePolicy === policy}
              selected={draft.displayNamePolicy === policy}
              onChange={() => setDraft({ ...draft, displayNamePolicy: policy })}
              title={t(`mail.policy.${policy}`)}
              description={t(`mail.policyHint.${policy}`)}
            />
          ))}
        </fieldset>
        <p className="fw-adm-hint">{t('mail.add.stepUp')}</p>
      </div>
    </Modal>
  )
}
