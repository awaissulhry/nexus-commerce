'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ShieldOff } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { StepUpModal } from '@nexus/ui/patterns'
import { Button, Input, Pill, Select, Skeleton, Spinner } from '@nexus/ui/primitives'
import { LEGAL_WORDING } from '@nexus/factory-domain/tax/vat-treatment'
import { TAX_RULES } from '@nexus/factory-domain/tax/rules'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import type { CompanySettings } from '../../_shared/api'
import { money } from '../../_shared/model'
import { CheckList, PartState } from '../../_shared/parts'
import { ibanGroups, ibanProblem, type FinanceSettingsActions, type FinanceSettingsModel } from '../settings-model'
import '../../_shared/finance.css'

export type { FinanceSettingsActions, FinanceSettingsModel } from '../settings-model'

/** The reasons without VAT the rules print today, with the wording on the invoice (factory-domain tax/vat-treatment). */
const WORDING = [
  { code: 'N3.2', key: 'INTRA_EU_SUPPLY', text: LEGAL_WORDING.INTRA_EU_SUPPLY },
  { code: 'N3.1', key: 'EXPORT', text: LEGAL_WORDING.EXPORT },
  { code: 'N2.1', key: 'EU_B2B_SERVICES', text: LEGAL_WORDING.EU_B2B_SERVICES },
  { code: 'N2.1', key: 'EXTRA_EU_SERVICES', text: LEGAL_WORDING.EXTRA_EU_SERVICES },
] as const

/** Which document follows a deposit's payment, per customer, and whether the rule is settled (factory-domain tax/rules). */
const DEPOSIT_RULES = ['DEPOSIT_INVOICE_IT', 'DEPOSIT_EU_B2B_GOODS', 'DEPOSIT_EU_B2B_SERVICES', 'DEPOSIT_EU_B2C', 'DEPOSIT_EXPORT'] as const

/** The rules every invoice follows, settled or waiting for the accountant (shown as they are: never as settled). */
const OPEN_RULES = Object.values(TAX_RULES).filter((rule) => rule.status === 'UNVERIFIED' && !(DEPOSIT_RULES as readonly string[]).includes(rule.id))

/** The accountant's open points the build found (HANDOFF "For the accountant", 2026-10-29). */
const ACCOUNTANT_POINTS = ['foreignConsumer', 'resendDays', 'progressive'] as const

/**
 * SCR-083 — Finance settings (design finance.settings; read where invoicing reads them, per company): Company & tax (the
 * data every invoice header takes, what is missing to issue one; changed in Admin › Companies), the bank account the
 * invoices and the deposit page print (edited here with a fresh authenticator code), E-invoicing (SDI: the connection,
 * its mode — FAKE: nothing goes to SDI —, changed in Admin › Connections), Legal archiving (at the intermediary once
 * SDI delivers), the fiscal number series, the reasons without VAT with the wording printed on the invoice, the deposit
 * rules and the points that wait for the accountant — said as open, never as settled. One readable column of cards on a
 * narrow screen, two on a wide one. W1: the VAT rules and their wording are the code's (W2b brings tax settings).
 */
export function FinanceSettingsView({ model, actions }: { model: FinanceSettingsModel; actions?: FinanceSettingsActions }) {
  return (
    <WithMessages namespaces={['finance']}>
      <Settings model={model} actions={actions} />
    </WithMessages>
  )
}

function Settings({ model, actions }: { model: FinanceSettingsModel; actions?: FinanceSettingsActions }) {
  const t = useT('finance')
  const loaded = model.settings
  if (loaded.status !== 'ready') {
    if (loaded.status === 'loading')
      return (
        <div className="fw-fin">
          <div className="fw-fin-cards">
            {Array.from({ length: 4 }, (_, index) => (
              <Card key={index} padded aria-busy="true">
                <div className="fw-fin-stack-tight">
                  <Skeleton width={180} height={18} />
                  <Skeleton height={14} />
                  <Skeleton height={14} />
                </div>
              </Card>
            ))}
          </div>
          <p className="fw-fin-hint" role="status">
            <Spinner size={12} /> {t('settings.loading')}
          </p>
        </div>
      )
    return (
      <div className="fw-fin">
        <Card padded>
          <EmptyState
            icon={loaded.status === 'forbidden' ? <ShieldOff size={24} aria-hidden /> : undefined}
            title={t(loaded.status === 'error' ? 'settings.failed' : `settings.state.${loaded.status}.title`)}
            description={loaded.status === 'error' ? t(loaded.problem) : t(`settings.state.${loaded.status}.body`)}
            action={
              loaded.status === 'error' ? (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              ) : undefined
            }
          />
        </Card>
      </div>
    )
  }
  const companies = loaded.value.companies
  const company = companies.find((entry) => entry.id === model.companyId) ?? companies[0] ?? null
  if (!company)
    return (
      <div className="fw-fin">
        <Card padded>
          <EmptyState title={t('settings.noCompany.title')} description={t('settings.noCompany.body')} />
        </Card>
      </div>
    )
  return (
    <div className="fw-fin">
      <div className="fw-fin-head">
        <p className="fw-fin-hint">{t('settings.explain')}</p>
        {companies.length > 1 && (
          <Select size="sm" aria-label={t('settings.companyLabel')} value={company.id} onChange={(event) => actions?.onCompany?.(event.target.value)}>
            {companies.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.legalName}
              </option>
            ))}
          </Select>
        )}
      </div>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.words.key, model.notice.words.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('common.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {company.sdi.accounts.some((account) => account.mode === 'FAKE') && <Banner tone="warning" title={t('settings.testMode')} />}
      <div className="fw-fin-cards">
        <CompanyCard company={company} model={model} />
        <BankCard model={model} actions={actions} />
        <SdiCard company={company} model={model} />
        <ArchiveCard company={company} />
        <SeriesCard company={company} model={model} />
        <PaymentCard />
      </div>
      <WordingCard />
      <div className="fw-fin-cards fw-fin-cards--two">
        <DepositCard />
        <AccountantCard />
      </div>
      <StepUpModal
        open={model.stepUp.open}
        title={t('stepUp.title')}
        sentence={model.stepUp.sentence ? t(model.stepUp.sentence) : ''}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('stepUp.confirm')}
      />
    </div>
  )
}

const missingKey = (path: string): string => {
  if (path.endsWith('vatNumber')) return 'settings.missing.vatNumber'
  if (path.endsWith('regimeFiscale')) return 'settings.missing.regime'
  if (path.endsWith('address')) return 'settings.missing.address'
  return 'settings.missing.other'
}

function CompanyCard({ company, model }: { company: CompanySettings; model: FinanceSettingsModel }) {
  const t = useT('finance')
  const locale = useLocale()
  const identity = company.identity
  const address = identity?.address
  const adminHref = OFFICE_PAGES.has('/admin/companies/[companyId]') && model.can.manageCompanies ? `${model.prefix}/admin/companies/${company.id}` : null
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{t('settings.company.title')}</h2>
        <Pill tone={company.seller.ready ? 'success' : 'danger'}>{t(company.seller.ready ? 'settings.company.ready' : 'settings.company.notReady')}</Pill>
      </div>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('settings.company.legalName'), value: company.legalName },
          { label: t('settings.company.vat'), value: identity?.vatNumber ?? '—' },
          { label: t('settings.company.taxCode'), value: identity?.fiscalCode ?? '—' },
          { label: t('settings.company.regime'), value: identity?.regimeFiscale ? t('settings.company.regimeValue', { code: identity.regimeFiscale }) : '—' },
          { label: t('settings.company.rea'), value: identity?.reaOffice && identity.reaNumber ? `${identity.reaOffice} ${identity.reaNumber}` : '—' },
          { label: t('settings.company.capital'), value: identity?.shareCapital ? money(Math.round(Number(identity.shareCapital) * 100), 'EUR', locale) : '—' },
          { label: t('settings.company.address'), value: address ? [address.line1, address.line2, `${address.postalCode} ${address.city}${address.province ? ` (${address.province})` : ''}`, address.country].filter(Boolean).join(', ') : '—' },
        ]}
      />
      {!company.seller.ready && <CheckList label={t('settings.company.missing')} items={company.seller.problems.map((problem, index) => ({ id: `${problem.path}-${index}`, ok: false, words: t(missingKey(problem.path)) }))} />}
      {adminHref ? (
        <Button size="sm" asChild>
          <Link href={adminHref}>{t('settings.company.change')}</Link>
        </Button>
      ) : (
        <p className="fw-fin-hint">{t('settings.company.byAdmin')}</p>
      )}
    </Card>
  )
}

function BankCard({ model, actions }: { model: FinanceSettingsModel; actions?: FinanceSettingsActions }) {
  const t = useT('finance')
  const locale = useLocale()
  const part = model.bank
  const bank = part?.value?.bank ?? null
  const [accountHolder, setAccountHolder] = useState(model.draft?.accountHolder ?? bank?.accountHolder ?? '')
  const [iban, setIban] = useState(model.draft?.iban ?? (bank ? ibanGroups(bank.iban) : ''))
  const [bic, setBic] = useState(model.draft?.bic ?? bank?.bic ?? '')
  const [bankName, setBankName] = useState(model.draft?.bankName ?? bank?.bankName ?? '')
  if (part === null)
    return (
      <Card padded className="fw-fin-card">
        <h2 className="fw-fin-h2">{t('bank.title')}</h2>
        <p className="fw-fin-hint">{t('bank.noRight')}</p>
      </Card>
    )
  if (!part.value) return <PartState problem={part.problem} label={t('bank.title')} onRetry={() => actions?.onRetryBank?.()} />
  const problem = ibanProblem(iban)
  const empty = iban.trim() === '' && accountHolder.trim() === ''
  const held = model.busy ? t('held.busy') : problem ? t(problem) : !empty && (iban.trim() === '' || accountHolder.trim() === '') ? t('bank.problem.both') : null
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{t('bank.title')}</h2>
        {!model.editingBank && (
          <Button size="sm" heldReason={model.can.manageBank ? null : t('held.noBank')} onClick={() => actions?.onEditBank?.(true)}>
            {t('bank.edit')}
          </Button>
        )}
      </div>
      <p className="fw-fin-hint">{t('bank.explain')}</p>
      {model.editingBank ? (
        <form
          className="fw-fin-stack-tight"
          onSubmit={(event) => {
            event.preventDefault()
            if (!held) actions?.onSaveBank?.({ accountHolder, iban, bic, bankName })
          }}
        >
          {model.bankProblem && <Banner tone="danger" title={t(model.bankProblem.key, model.bankProblem.params)} />}
          <Field label={t('bank.holder')}>
            <Input value={accountHolder} onChange={(event) => setAccountHolder(event.target.value)} maxLength={200} autoComplete="off" />
          </Field>
          <Field label={t('bank.iban')} error={problem ? t(problem) : undefined}>
            <Input value={iban} onChange={(event) => setIban(event.target.value)} maxLength={60} autoComplete="off" />
          </Field>
          <div className="fw-fin-two">
            <Field label={t('bank.bic')}>
              <Input value={bic} onChange={(event) => setBic(event.target.value)} maxLength={20} autoComplete="off" />
            </Field>
            <Field label={t('bank.name')}>
              <Input value={bankName} onChange={(event) => setBankName(event.target.value)} maxLength={200} autoComplete="off" />
            </Field>
          </div>
          <p className="fw-fin-hint">{t('bank.stepUp')}</p>
          <span className="fw-fin-actions">
            <Button size="sm" type="submit" variant="primary" heldReason={held}>
              {model.busy ? t('common.working') : t('bank.save')}
            </Button>
            <Button size="sm" onClick={() => actions?.onEditBank?.(false)}>
              {t('common.cancel')}
            </Button>
          </span>
        </form>
      ) : bank ? (
        <KeyValue
          dense
          labelCase="sentence"
          columns={2}
          items={[
            { label: t('bank.holder'), value: bank.accountHolder },
            { label: t('bank.iban'), value: <span className="fw-fin-code">{ibanGroups(bank.iban)}</span> },
            { label: t('bank.bic'), value: bank.bic ?? '—' },
            { label: t('bank.name'), value: bank.bankName ?? '—' },
            { label: t('bank.updated'), value: formatDate(part.value.updatedAt, { locale }) },
          ]}
        />
      ) : (
        <EmptyState title={t('bank.none.title')} description={t('bank.none.body')} />
      )}
    </Card>
  )
}

function SdiCard({ company, model }: { company: CompanySettings; model: FinanceSettingsModel }) {
  const t = useT('finance')
  const adminHref = OFFICE_PAGES.has('/admin/connections') && model.can.viewIntegrations ? `${model.prefix}/admin/connections` : null
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{t('settings.sdi.title')}</h2>
        <Pill tone={company.sdi.state === 'ACTIVE' ? 'success' : company.sdi.state === 'NONE' ? 'danger' : 'warning'}>{t(`settings.sdi.state.${company.sdi.state}`)}</Pill>
      </div>
      <p className="fw-fin-hint">{t('settings.sdi.explain')}</p>
      {company.sdi.accounts.length > 0 && (
        <SummaryTable
          label={t('settings.sdi.title')}
          columns={[t('settings.sdi.col.connection'), t('settings.sdi.col.mode'), t('settings.sdi.col.state')]}
          rows={company.sdi.accounts.map((account) => ({ id: account.id, cells: [account.label, t(`settings.sdi.mode.${account.mode}`), t(`settings.sdi.status.${account.status === 'PAUSED' ? 'PAUSED' : 'ACTIVE'}`)] }))}
          stackOnPhone
        />
      )}
      <p className="fw-fin-hint">{t('settings.sdi.intermediary')}</p>
      {adminHref ? (
        <Button size="sm" asChild>
          <Link href={adminHref}>{t('settings.sdi.open')}</Link>
        </Button>
      ) : (
        <p className="fw-fin-hint">{t('settings.sdi.byAdmin')}</p>
      )}
    </Card>
  )
}

function ArchiveCard({ company }: { company: CompanySettings }) {
  const t = useT('finance')
  const locale = useLocale()
  return (
    <Card padded className="fw-fin-card">
      <h2 className="fw-fin-h2">{t('settings.archive.title')}</h2>
      <p className="fw-fin-hint">{t('settings.archive.explain')}</p>
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('settings.archive.where'), value: t('settings.archive.intermediary') },
          { label: t('settings.archive.count'), value: String(company.archive.archivedSends) },
          { label: t('settings.archive.last'), value: company.archive.lastArchivedAt ? formatDateTime(company.archive.lastArchivedAt, { locale }) : t('settings.archive.never') },
        ]}
      />
    </Card>
  )
}

function SeriesCard({ company, model }: { company: CompanySettings; model: FinanceSettingsModel }) {
  const t = useT('finance')
  const href = OFFICE_PAGES.has('/admin/documents') && model.can.viewNumbering ? `${model.prefix}/admin/documents` : null
  return (
    <Card padded className="fw-fin-card">
      <h2 className="fw-fin-h2">{t('settings.series.title')}</h2>
      <SummaryTable
        label={t('settings.series.title')}
        columns={[t('settings.series.col.kind'), t('settings.series.col.next')]}
        rows={company.series.map((entry) => ({ id: entry.kind, cells: [t(`settings.series.kind.${entry.kind}`), entry.next ?? t(entry.kind === 'INVOICE' ? 'settings.series.none' : 'settings.series.usesInvoice')] }))}
      />
      {href ? (
        <Button size="sm" asChild>
          <Link href={href}>{t('settings.series.open')}</Link>
        </Button>
      ) : (
        <p className="fw-fin-hint">{t('settings.series.byAdmin')}</p>
      )}
    </Card>
  )
}

function PaymentCard() {
  const t = useT('finance')
  return (
    <Card padded className="fw-fin-card">
      <h2 className="fw-fin-h2">{t('settings.terms.title')}</h2>
      <KeyValue
        dense
        labelCase="sentence"
        items={[
          { label: t('settings.terms.method'), value: t('settings.terms.methodValue') },
          { label: t('settings.terms.due'), value: t('settings.terms.dueValue') },
          { label: t('settings.terms.iban'), value: t('settings.terms.ibanValue') },
        ]}
      />
      <p className="fw-fin-hint">{t('settings.terms.later')}</p>
    </Card>
  )
}

function WordingCard() {
  const t = useT('finance')
  return (
    <Card padded className="fw-fin-card">
      <h2 className="fw-fin-h2">{t('settings.wording.title')}</h2>
      <p className="fw-fin-hint">{t('settings.wording.explain')}</p>
      <SummaryTable
        label={t('settings.wording.title')}
        columns={[t('settings.wording.col.code'), t('settings.wording.col.meaning'), t('settings.wording.col.printed')]}
        rows={WORDING.map((entry) => ({ id: entry.key, cells: [entry.code, t(`settings.wording.case.${entry.key}`), <span key="p" className="fw-fin-code">{entry.text}</span>] }))}
        widths={['10%', '35%', '55%']}
        stackOnPhone
      />
    </Card>
  )
}

function DepositCard() {
  const t = useT('finance')
  return (
    <Card padded className="fw-fin-card">
      <h2 className="fw-fin-h2">{t('settings.deposits.title')}</h2>
      <p className="fw-fin-hint">{t('settings.deposits.explain')}</p>
      <SummaryTable
        label={t('settings.deposits.title')}
        columns={[t('settings.deposits.col.customer'), t('settings.deposits.col.document'), t('settings.deposits.col.status')]}
        rows={DEPOSIT_RULES.map((id) => ({
          id,
          cells: [t(`settings.deposits.rule.${id}.who`), t(`settings.deposits.rule.${id}.what`), <Pill key="s" tone={TAX_RULES[id].status === 'VERIFIED' ? 'success' : 'warning'}>{t(TAX_RULES[id].status === 'VERIFIED' ? 'settings.verified' : 'settings.unverified')}</Pill>],
        }))}
        stackOnPhone
      />
    </Card>
  )
}

function AccountantCard() {
  const t = useT('finance')
  return (
    <Card padded className="fw-fin-card">
      <h2 className="fw-fin-h2">{t('settings.accountant.title')}</h2>
      <p className="fw-fin-hint">{t('settings.accountant.explain')}</p>
      <ul className="fw-fin-checks" aria-label={t('settings.accountant.title')}>
        {OPEN_RULES.map((rule) => (
          <li key={rule.id} className="fw-fin-check">
            <Pill tone="warning">{t('settings.unverified')}</Pill>
            <span className="fw-fin-step-body">
              <span>{t(`settings.accountant.rule.${rule.id}`)}</span>
              <span className="fw-fin-step-time">{rule.law}</span>
            </span>
          </li>
        ))}
        {ACCOUNTANT_POINTS.map((point) => (
          <li key={point} className="fw-fin-check">
            <Pill tone="warning">{t('settings.unverified')}</Pill>
            <span className="fw-fin-step-body">{t(`settings.accountant.point.${point}`)}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
