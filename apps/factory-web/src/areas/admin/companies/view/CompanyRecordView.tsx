'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { MapPin } from 'lucide-react'
import { Banner, Card, Field, KeyValue, Tabs, type TabItem } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { EditModeBar, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import type { Company, Site } from '../../shared/api'
import { adminHref, STATUS_TONE } from '../../shared/model'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { dash, FrameState, ListKeysHelp, NoticeBanner, RecordProblem } from '../../shared/view/parts'
import { WithMessages } from '../../../../record-panels/i18n'
// ---- B-TH-269: the company on RecordFrame (the band in the shell's row, the docked thread — notes only —, one notice) ----
import { RecordFrame } from '../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../_shared/record-frame/RecordNotices'
import {
  addressLine,
  changedFields,
  companyDraft,
  companyProblems,
  DEFAULT_FIELDS,
  issueKey,
  LEGAL_FIELDS,
  REGIMES,
  TIME_ZONES,
  type CompanyDraft,
  type CompanyRecordModel,
} from '../model'
import { companySiteColumns } from './columns'

export type { CompanyRecordModel } from '../model'

export interface CompanyRecordActions {
  /** Resolve true when saved. */
  onSave?: (before: CompanyDraft, after: CompanyDraft, fields: ReadonlyArray<keyof CompanyDraft>) => Promise<boolean>
  onArchive?: (archive: boolean) => void
  onArchiveConfirm?: () => Promise<boolean>
  onNewSite?: () => void
  /** Enter on a site's row: open the Site record. */
  onOpen?: (href: string) => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

/**
 * SCR-008 — the Company record (design 02 admin.org "Record: Company"), on RecordFrame (B-TH-269; the rule of picture 38, the tabs of
 * 08-tabs O-ADM-CO): the band in the shell's band row (‹ Companies, "<code> <legal name>", ONE state pill, the trade name and whether
 * it can issue invoices, New site — held with why —; the Thread button ⌘J, the frame's; ⋯ its Keyboard line), the docked thread
 * beside every tab (notes only: an admin record has no party, W03; Activity's tools in its "⋯", R-ACT) and the tabs 5 → 4: Legal &
 * tax (what every document and invoice prints, c.c. art. 2250; what SDI needs), its Sites, its Defaults, and Calendars (B-W2a-59:
 * working days and holidays, passed in as `calendars` — its own container —, shown with calendars.view). Forms save with the DS
 * EditModeBar (⌘S, Discard, Apply held with its reason); a person without companies.manage reads the data as text. Every banner in
 * the ONE notice of the body column. Fetches nothing (CompanyRecord.tsx reads the API).
 */
// B-TH-269: `thread` the docked thread (the office's OfficeRecordThread, or a design case's), `printThread` what the print view shows.
export function CompanyRecordView({ model, actions, thread, printThread, calendars }: { model: CompanyRecordModel; actions?: CompanyRecordActions; thread?: ReactNode; printThread?: ReactNode; calendars?: ReactNode }) {
  return (
    // AdminMessages' catalogues and, for the Calendars tab's label (B-W2a-59), the tab's own.
    <WithMessages namespaces={['admin', 'records', 'admin-calendars']}>
      <CompanyRecord model={model} actions={actions} thread={thread} printThread={printThread} calendars={calendars} />
    </WithMessages>
  )
}

function CompanyRecord({ model, actions, thread, printThread, calendars }: { model: CompanyRecordModel; actions?: CompanyRecordActions; thread?: ReactNode; printThread?: ReactNode; calendars?: ReactNode }) {
  const t = useT('admin')
  const tc = useT('admin-calendars')
  const href = (path: string) => adminHref(model.prefix, path)
  const back = { href: href('/companies'), label: t('nav.companies') }
  const company = model.company
  const frame = { recordType: 'Company', personId: model.personId ?? null, threadLabel: t('record.dockLabel') }
  const backLink = <Link href={back.href}>{back.label}</Link>

  // Not found, no right, a failed read, loading: the band and its state inside the frame, no thread yet.
  if (!company) {
    return (
      <RecordFrame {...frame} thread={null} band={{ back: backLink, title: model.problem ? t('nav.companies') : <Skeleton width={260} height={22} />, moreLabel: t('common.more') }}>
        {model.problem ? (
          <RecordProblem
            problem={model.problem}
            onRetry={actions?.onRetry}
            back={
              <Button size="sm" asChild>
                <Link href={back.href}>{t('record.backTo', { name: back.label })}</Link>
              </Button>
            }
          />
        ) : (
          <div className="fw-adm" aria-busy="true">
            <Skeleton height={28} width="60%" />
            <Skeleton height={220} />
          </div>
        )}
      </RecordFrame>
    )
  }

  const tabs: TabItem[] = [
    { id: 'legal', label: t('company.tab.legal') },
    { id: 'sites', label: t('company.tab.sites'), count: model.sites.items ? model.sites.items.length : null },
    { id: 'defaults', label: t('company.tab.defaults') },
    ...(model.can.viewCalendars ? [{ id: 'calendars', label: tc('acal.tab') }] : []),
  ].map((tab) => ({ ...tab, href: `${href(`/companies/${company.id}`)}?tab=${tab.id}` }))
  const archived = company.status === 'ARCHIVED'
  return (
    <>
      <RecordFrame
        {...frame}
        thread={thread ?? null}
        printThread={printThread}
        band={{
          back: backLink,
          title: (
            <>
              <span className="fw-adm-code">{company.code}</span> {company.legalName}
            </>
          ),
          status: <Pill tone={STATUS_TONE[company.status] ?? 'neutral'}>{t(`status.${company.status}`)}</Pill>,
          meta: (
            <span className="fw-adm-tags">
              {company.tradeName && <span>{company.tradeName}</span>}
              {company.invoicing.ready ? <Tag tone="success">{t('org.invoicing.ready')}</Tag> : <Tag tone="warning">{t('org.invoicing.missing', { count: company.invoicing.issues.length })}</Tag>}
            </span>
          ),
          primary: model.can.viewSites ? (
            <Button size="sm" onClick={() => actions?.onNewSite?.()} heldReason={!model.can.manageSites ? t('held.needs', { right: t('right.sites_manage') }) : archived ? t('company.held.archived') : null}>
              {t('org.newSite')}
            </Button>
          ) : undefined,
          moreLabel: t('common.moreFor', { name: company.legalName }),
        }}
      >
        <div className="fw-adm">
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabs} active={model.tab} size="sm" overflow="scroll" />
          {/* B-TH-269: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
          <RecordNotices>
            {model.notice && <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />}
            {archived && <Banner tone="info" title={t('company.archivedBanner')} />}
            {!model.can.manageCompanies && !archived && <Banner tone="info" title={t('record.readOnly')} />}
          </RecordNotices>
          {model.tab === 'legal' && <LegalTab model={model} company={company} actions={actions} />}
          {model.tab === 'sites' && <SitesTab model={model} company={company} actions={actions} />}
          {model.tab === 'defaults' && <DefaultsTab model={model} company={company} actions={actions} />}
          {model.tab === 'calendars' && model.can.viewCalendars && calendars}
        </div>
      </RecordFrame>
      <ArchiveConfirm model={model} company={company} actions={actions} />
    </>
  )
}

/** The form's draft: the record's values, reset when the record changes (a save, someone else's change). */
function useDraft(company: Company, initial: CompanyDraft | null | undefined) {
  const read = useMemo(() => companyDraft(company), [company])
  const [draft, setDraft] = useState<CompanyDraft>(initial ?? read)
  useEffect(() => setDraft(initial ?? read), [read, initial])
  return { read, draft, setDraft }
}

function LegalTab({ model, company, actions }: { model: CompanyRecordModel; company: Company; actions?: CompanyRecordActions }) {
  const t = useT('admin')
  const { read, draft, setDraft } = useDraft(company, model.draft)
  const editable = model.can.manageCompanies && company.status === 'ACTIVE'
  const changed = changedFields(read, draft, LEGAL_FIELDS)
  const problems = { ...companyProblems(draft), ...(model.fieldProblems ?? {}) }
  const problemCount = LEGAL_FIELDS.filter((field) => problems[field]).length
  const set = <K extends keyof CompanyDraft>(field: K, value: CompanyDraft[K]) => setDraft((current) => ({ ...current, [field]: value }))
  const error = (field: keyof CompanyDraft) => (problems[field] && (changed.includes(field) || model.fieldProblems?.[field]) ? t(problems[field]!) : undefined)
  const text = (field: keyof CompanyDraft, label: string, extra: { hint?: string; wide?: boolean; mono?: boolean; placeholder?: string; id?: string } = {}) => (
    <Field label={label} hint={extra.hint} error={error(field)} className={extra.wide ? 'fw-adm-form-wide' : undefined}>
      <Input id={extra.id ?? `company-${field}`} className={extra.mono ? 'fw-adm-code' : undefined} value={String(draft[field])} placeholder={extra.placeholder} onChange={(event) => set(field, event.target.value as never)} />
    </Field>
  )

  if (!editable) {
    return (
      <div className="fw-adm-stack">
        <Card header={t('company.legal.identity')} headingLevel={2} padded>
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('org.field.legalName'), value: company.legalName },
              { label: t('company.field.tradeName'), value: dash(company.tradeName) },
              { label: t('org.field.vatNumber'), value: dash(company.vatNumber) },
              { label: t('company.field.fiscalCode'), value: dash(company.fiscalCode) },
              { label: t('company.field.regimeFiscale'), value: company.regimeFiscale ? t(`company.regime.${company.regimeFiscale}`) : '—' },
              { label: t('company.field.rea'), value: company.reaOffice && company.reaNumber ? `${company.reaOffice} ${company.reaNumber}` : '—' },
              { label: t('company.field.shareCapital'), value: dash(company.shareCapital) },
              { label: t('company.field.soleShareholder'), value: t(company.soleShareholder ? 'common.yes' : 'common.no') },
              { label: t('company.field.inLiquidation'), value: t(company.inLiquidation ? 'common.yes' : 'common.no') },
              { label: t('company.field.address'), value: dash(addressLine(company.address)) },
            ]}
          />
        </Card>
        <Card header={t('company.legal.invoicing')} headingLevel={2} padded>
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('company.field.pec'), value: dash(company.pec) },
              { label: t('company.field.sdi'), value: dash(company.sdiReceiverCode) },
              { label: t('org.field.country'), value: company.country },
              { label: t('company.field.currency'), value: company.currency },
            ]}
          />
          <Readiness company={company} />
        </Card>
        <Card header={t('company.legal.look')} headingLevel={2} padded>
          <KeyValue labelCase="sentence" items={[{ label: t('company.field.footer'), value: dash(company.documentFooter) }]} />
        </Card>
      </div>
    )
  }

  return (
    <form
      className="fw-adm-stack"
      onSubmit={(event) => {
        event.preventDefault()
      }}
    >
      <Card header={t('company.legal.identity')} description={t('company.legal.identityHint')} headingLevel={2} padded>
        <div className="fw-adm-form">
          {text('legalName', t('org.field.legalName'), { wide: true })}
          {text('tradeName', t('company.field.tradeName'))}
          {text('vatNumber', t('org.field.vatNumber'), { placeholder: 'IT00000000000' })}
          {text('fiscalCode', t('company.field.fiscalCode'))}
          <Field label={t('company.field.regimeFiscale')} error={error('regimeFiscale')}>
            <Select id="company-regimeFiscale" value={draft.regimeFiscale} onChange={(event) => set('regimeFiscale', event.target.value)}>
              <option value="">{t('company.regime.none')}</option>
              {REGIMES.map((regime) => (
                <option key={regime} value={regime}>
                  {t(`company.regime.${regime}`)}
                </option>
              ))}
            </Select>
          </Field>
          {text('reaOffice', t('company.field.reaOffice'), { placeholder: 'MI' })}
          {text('reaNumber', t('company.field.reaNumber'))}
          {text('shareCapital', t('company.field.shareCapital'), { hint: t('company.field.shareCapitalHint'), placeholder: '10000.00' })}
          <div className="fw-adm-toggles fw-adm-form-wide">
            <label className="fw-adm-toggle-row">
              <span>{t('company.field.soleShareholder')}</span>
              <Toggle checked={draft.soleShareholder} onChange={(next) => set('soleShareholder', next)} aria-label={t('company.field.soleShareholder')} />
            </label>
            <label className="fw-adm-toggle-row">
              <span>{t('company.field.inLiquidation')}</span>
              <Toggle checked={draft.inLiquidation} onChange={(next) => set('inLiquidation', next)} aria-label={t('company.field.inLiquidation')} />
            </label>
          </div>
          {text('line1', t('org.field.line1'), { wide: true, id: 'company-address' })}
          {text('line2', t('company.field.line2'), { wide: true })}
          {text('postalCode', t('org.field.postalCode'))}
          {text('city', t('org.field.city'))}
          {text('province', t('org.field.province'))}
          {text('addressCountry', t('org.field.country'))}
        </div>
      </Card>
      <Card header={t('company.legal.invoicing')} description={t('company.legal.invoicingHint')} headingLevel={2} padded>
        <div className="fw-adm-form">
          {text('pec', t('company.field.pec'), { placeholder: 'nome@pec.example.com' })}
          {text('sdiReceiverCode', t('company.field.sdi'), { mono: true, placeholder: 'ABC1234', hint: t('company.field.sdiHint') })}
          <Field label={t('company.field.currency')} hint={t('company.field.currencyHint')}>
            <Input value={company.currency} readOnly />
          </Field>
        </div>
        <Readiness company={company} />
      </Card>
      <Card header={t('company.legal.look')} description={t('company.legal.lookHint')} headingLevel={2} padded>
        <Field label={t('company.field.footer')} error={error('documentFooter')}>
          <Textarea id="company-documentFooter" rows={3} limit={1000} value={draft.documentFooter} onChange={(event) => set('documentFooter', event.target.value)} />
        </Field>
        <p className="fw-adm-hint">{t('company.legal.logoLater')}</p>
      </Card>
      <ArchiveCard actions={actions} />
      {changed.length > 0 && (
        <EditModeBar
          count={changed.length}
          message={t('form.unsaved', { count: changed.length })}
          applyLabel={t('common.save')}
          busy={model.busy}
          saveShortcut
          applyHeldReason={problemCount > 0 ? t('form.fixFirst', { count: problemCount }) : null}
          onDiscard={() => setDraft(read)}
          onApply={() => void actions?.onSave?.(read, draft, LEGAL_FIELDS)}
        />
      )}
    </form>
  )
}

/** What still stops invoicing, each with a link to its field (GuardList's idea, as a list of links). */
function Readiness({ company }: { company: Company }) {
  const t = useT('admin')
  if (company.invoicing.ready) return <Banner tone="success" title={t('company.ready')} />
  const target: Record<string, string> = { vatNumber: 'company-vatNumber', regimeFiscale: 'company-regimeFiscale', address: 'company-address', pec: 'company-pec' }
  return (
    <Banner tone="warning" title={t('company.notReady', { count: company.invoicing.issues.length })}>
      <ul className="fw-adm-guards">
        {company.invoicing.issues.map((issue) => {
          const field = issue.path.replace(/^company\//, '')
          return (
            <li key={issue.path}>
              <a href={`#${target[field] ?? 'company-legalName'}`}>{t(issueKey(issue.path))}</a>
            </li>
          )
        })}
      </ul>
    </Banner>
  )
}

function ArchiveCard({ actions }: { actions?: CompanyRecordActions }) {
  const t = useT('admin')
  return (
    <Card header={t('record.dangerZone')} headingLevel={2} padded>
      <div className="fw-adm-danger-row">
        <div>
          <strong>{t('company.archive.title')}</strong>
          <span className="fw-adm-hint">{t('company.archive.body')}</span>
        </div>
        <Button variant="danger-outline" size="sm" onClick={() => actions?.onArchive?.(true)}>
          {t('company.archive.action')}
        </Button>
      </div>
    </Card>
  )
}

function ArchiveConfirm({ model, company, actions }: { model: CompanyRecordModel; company: Company; actions?: CompanyRecordActions }) {
  const t = useT('admin')
  const sites = (model.sites.items ?? []).filter((site) => site.status === 'ACTIVE').length
  return (
    <Modal
      open={!!model.archiving}
      onClose={() => actions?.onArchive?.(false)}
      title={t('company.archive.confirmTitle', { name: company.legalName })}
      size="sm"
      busy={model.busy}
      footer={
        <>
          <Button onClick={() => actions?.onArchive?.(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" heldReason={sites > 0 ? t('company.archive.held', { count: sites }) : null} onClick={() => void actions?.onArchiveConfirm?.()}>
            {t('company.archive.action')}
          </Button>
        </>
      }
    >
      <div className="fw-adm-modal-body">
        <p className="fw-adm-intro">{t('company.archive.confirmBody')}</p>
        {sites > 0 && <Banner tone="warning" title={t('company.archive.inUse', { count: sites })} />}
      </div>
    </Modal>
  )
}

function SitesTab({ model, company, actions }: { model: CompanyRecordModel; company: Company; actions?: CompanyRecordActions }) {
  const t = useT('admin')
  const [help, setHelp] = useState(false)
  const items = model.sites.items
  const columns = useMemo(() => companySiteColumns({ t, prefix: model.prefix, companyId: company.id }), [t, model.prefix, company.id])
  if (!model.can.viewSites) return <Banner tone="info" title={t('held.needs', { right: t('right.sites_view') })} />
  const state = model.sites.problem ? (
    <FrameState problem={model.sites.problem} onRetry={actions?.onRetry} />
  ) : items && items.length === 0 ? (
    <FrameState
      empty={{
        icon: <MapPin size={24} aria-hidden />,
        title: t('company.sites.empty'),
        action: model.can.manageSites ? (
          <Button variant="primary" onClick={() => actions?.onNewSite?.()}>
            {t('org.newSite')}
          </Button>
        ) : undefined,
      }}
    />
  ) : undefined
  return (
    <>
      <ListFrame<Site>
        label={t('company.sites.label', { name: company.legalName })}
        rows={items}
        rowId={(site) => site.id}
        columns={columns}
        count={items ? t('company.sites.count', { count: items.length }) : '—'}
        onOpen={(site) => actions?.onOpen?.(adminHref(model.prefix, `/companies/${company.id}/sites/${site.id}`))}
        onHelp={() => setHelp(true)}
        state={state}
      />
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={[]} selection={false} />
    </>
  )
}

function DefaultsTab({ model, company, actions }: { model: CompanyRecordModel; company: Company; actions?: CompanyRecordActions }) {
  const t = useT('admin')
  const { read, draft, setDraft } = useDraft(company, model.draft)
  const editable = model.can.manageCompanies && company.status === 'ACTIVE'
  const changed = changedFields(read, draft, DEFAULT_FIELDS)
  const months = Array.from({ length: 12 }, (_, index) => String(index + 1))
  if (!editable) {
    return (
      <Card header={t('company.defaults.title')} headingLevel={2} padded>
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('company.field.currency'), value: company.currency },
            { label: t('company.field.locale'), value: t(`common.language.${company.locale}`) },
            { label: t('company.field.fiscalYear'), value: t(`common.month.${company.fiscalYearStartMonth}`) },
            { label: t('org.field.timezone'), value: company.timezone },
          ]}
        />
      </Card>
    )
  }
  return (
    <div className="fw-adm-stack">
      <Card header={t('company.defaults.title')} description={t('company.defaults.hint')} headingLevel={2} padded>
        <div className="fw-adm-form">
          <Field label={t('company.field.currency')} hint={t('company.field.currencyHint')}>
            <Input value={company.currency} readOnly />
          </Field>
          <Field label={t('company.field.locale')} hint={t('company.field.localeHint')}>
            <Select value={draft.locale} onChange={(event) => setDraft({ ...draft, locale: event.target.value })}>
              {['it', 'en'].map((locale) => (
                <option key={locale} value={locale}>
                  {t(`common.language.${locale}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('company.field.fiscalYear')}>
            <Select value={draft.fiscalYearStartMonth} onChange={(event) => setDraft({ ...draft, fiscalYearStartMonth: event.target.value })}>
              {months.map((month) => (
                <option key={month} value={month}>
                  {t(`common.month.${month}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('org.field.timezone')} hint={t('company.field.timezoneHint')}>
            <Select value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>
              {[...new Set([draft.timezone, ...TIME_ZONES])].map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="fw-adm-hint">{t('company.defaults.later')}</p>
      </Card>
      {changed.length > 0 && (
        <EditModeBar
          count={changed.length}
          message={t('form.unsaved', { count: changed.length })}
          applyLabel={t('common.save')}
          busy={model.busy}
          saveShortcut
          onDiscard={() => setDraft(read)}
          onApply={() => void actions?.onSave?.(read, draft, DEFAULT_FIELDS)}
        />
      )}
    </div>
  )
}
