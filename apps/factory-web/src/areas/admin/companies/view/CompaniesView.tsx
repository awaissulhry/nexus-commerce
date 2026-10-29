'use client'

import { useEffect, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { Building2, Search } from 'lucide-react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, ExpandToggle, Input, Pill, Select, Tag, Toggle } from '@nexus/ui/primitives'
import { useT } from '../../../../lib/i18n/provider'
import { SITE_KINDS, type CompanyWithSites, type SiteKind } from '../../shared/api'
import { adminHref, pageOf, STATUS_TONE } from '../../shared/model'
import { AdminMessages, dash, ListState, ListTable, NoticeBanner, PageHead } from '../../shared/view/parts'
import {
  addressLine,
  issueKey,
  newCompanyProblems,
  newSiteProblems,
  readiness,
  suggestCode,
  TIME_ZONES,
  treeRows,
  type CompaniesViewModel,
  type NewCompanyDraft,
  type NewSiteDraft,
  type OrgDialog,
} from '../model'

export type { CompaniesViewModel } from '../model'

export interface CompaniesActions {
  onQuery?: (query: string) => void
  onShowArchived?: (show: boolean) => void
  onToggle?: (companyId: string, expanded: boolean) => void
  onPage?: (page: number) => void
  onRetry?: () => void
  onDialog?: (dialog: OrgDialog | null, companyId?: string | null) => void
  /** Resolve true when made (the page then opens the new record). */
  onCreateCompany?: (draft: NewCompanyDraft) => Promise<boolean>
  onCreateSite?: (draft: NewSiteDraft) => Promise<boolean>
  onDismissNotice?: () => void
}

/**
 * SCR-008 — Admin › Companies & sites (design 02 admin.org; PLT-003, PLT-004): one tree of the legal companies and their
 * plants, warehouses and offices, with what each is missing, and the two short creates (New company, New site). Rows open
 * the Company or Site record. It draws ONE view model and fetches nothing (CompaniesPage.tsx reads the API).
 */
export function CompaniesView({ model, actions }: { model: CompaniesViewModel; actions?: CompaniesActions }) {
  return (
    <AdminMessages>
      <Companies model={model} actions={actions} />
    </AdminMessages>
  )
}

function Companies({ model, actions }: { model: CompaniesViewModel; actions?: CompaniesActions }) {
  const t = useT('admin')
  const [dialog, setDialog] = useState<OrgDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const open = (next: OrgDialog | null) => {
    setDialog(next)
    actions?.onDialog?.(next)
  }
  const items = model.companies.items
  const rows = items ? treeRows(items, model.query, model.collapsed, model.showArchived) : []
  const paged = pageOf(rows, model.page)
  const gap = items ? readiness(items) : null
  const href = (path: string) => adminHref(model.prefix, path)

  // c: a new company (when no field has the focus), as every list's "c" (00 §3.17).
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') || target.isContentEditable)) return
      if (!model.can.manageCompanies) return
      event.preventDefault()
      open('new-company')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const onTreeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const toggle = (event.target as HTMLElement).closest<HTMLElement>('[data-company]')
    if (!toggle || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    event.preventDefault()
    actions?.onToggle?.(toggle.dataset.company!, event.key === 'ArrowRight')
  }

  const columns = [t('org.col.name'), t('org.col.code'), t('org.col.kind'), t('org.col.vatAddress'), t('org.col.invoicing'), t('org.col.timezone'), t('org.col.structure'), t('org.col.devices'), t('org.col.status')]
  const tableRows = paged.rows.map((row) => {
    if (row.kind === 'company') {
      const { company } = row
      const active = company.sites.filter((site) => site.status === 'ACTIVE')
      const lines = active.reduce((sum, site) => sum + site.counts.lines, 0)
      const stations = active.reduce((sum, site) => sum + site.counts.stations, 0)
      const devices = active.reduce((sum, site) => sum + site.counts.devices, 0)
      return {
        id: company.id,
        cells: [
          <span key="name" className="fw-adm-cell-row">
            {model.can.viewSites && company.sites.length > 0 ? (
              <ExpandToggle
                expanded={row.expanded}
                label={t(row.expanded ? 'org.collapse' : 'org.expand', { name: company.legalName })}
                data-company={company.id}
                onClick={() => actions?.onToggle?.(company.id, !row.expanded)}
              />
            ) : null}
            <Link className="fw-adm-name" href={href(`/companies/${company.id}`)}>
              {company.legalName}
            </Link>
          </span>,
          <span key="code" className="fw-adm-code">{company.code}</span>,
          t('org.kind.COMPANY'),
          <span key="vat" className="fw-adm-cell">
            <span>{dash(company.vatNumber)}</span>
            <span className="fw-adm-hint">{dash(addressLine(company.address))}</span>
          </span>,
          company.invoicing.ready ? <Pill key="inv" tone="success">{t('org.invoicing.ready')}</Pill> : <Pill key="inv" tone="warning">{t('org.invoicing.missing', { count: company.invoicing.issues.length })}</Pill>,
          company.timezone,
          model.can.viewSites ? t('org.structure', { lines, stations }) : '—',
          model.can.viewSites ? String(devices) : '—',
          <Pill key="status" tone={STATUS_TONE[company.status] ?? 'neutral'}>{t(`status.${company.status}`)}</Pill>,
        ],
      }
    }
    const { site, company } = row
    return {
      id: site.id,
      cells: [
        <span key="name" className="fw-adm-child">
          <Link className="fw-adm-link" href={href(`/companies/${company.id}/sites/${site.id}`)}>{site.name}</Link>
        </span>,
        <span key="code" className="fw-adm-code">{site.code}</span>,
        t(`org.kind.${site.kind}`),
        <span key="address" className="fw-adm-hint">{dash(addressLine(site.address))}</span>,
        '—',
        site.timezone,
        site.kind === 'PLANT' && site.counts.stations === 0 ? <Tag key="st" tone="warning">{t('org.noStations')}</Tag> : t('org.structure', { lines: site.counts.lines, stations: site.counts.stations }),
        String(site.counts.devices),
        <Pill key="status" tone={STATUS_TONE[site.status] ?? 'neutral'}>{t(`status.${site.status}`)}</Pill>,
      ],
    }
  })

  const codes = (items ?? []).map((company) => company.code)
  const siteCodes = (items ?? []).flatMap((company) => company.sites.map((site) => site.code))
  const noCompany = !items || items.filter((company) => company.status === 'ACTIVE').length === 0

  return (
    <div className="fw-adm">
      <PageHead
        intro={t('org.intro')}
        asOf={model.asOf}
        actions={
          <>
            {model.can.viewSites && (
              <Button size="sm" onClick={() => open('new-site')} heldReason={!model.can.manageSites ? t('held.needs', { right: t('right.sites_manage') }) : noCompany ? t('org.held.noCompany') : null}>
                {t('org.newSite')}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => open('new-company')} heldReason={model.can.manageCompanies ? null : t('held.needs', { right: t('right.companies_manage') })}>
              {t('org.newCompany')}
            </Button>
          </>
        }
      />
      <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} />
      {gap?.kind === 'invoicing' && (
        <Banner
          tone="warning"
          title={t('org.gap.invoicing', { name: gap.company.legalName })}
          action={
            <Button size="sm" asChild>
              <Link href={href(`/companies/${gap.company.id}?tab=legal`)}>{t('org.gap.fix')}</Link>
            </Button>
          }
        >
          {gap.issues.map((path) => t(issueKey(path))).join(' · ')}
        </Banner>
      )}
      {gap?.kind === 'no-station' && (
        <Banner
          tone="warning"
          title={t('org.gap.noStation', { name: gap.site.name })}
          action={
            <Button size="sm" asChild>
              <Link href={href(`/companies/${gap.company.id}/sites/${gap.site.id}`)}>{t('org.gap.addStations')}</Link>
            </Button>
          }
        />
      )}

      <div className="fw-adm-toolbar">
        <span className="fw-adm-toolbar-search">
          <Input
            size="sm"
            type="search"
            fieldClassName="fw-adm-fill"
            leadingIcon={<Search size={14} aria-hidden />}
            aria-label={t('org.search')}
            placeholder={t('org.search')}
            value={model.query}
            onChange={(event) => actions?.onQuery?.(event.target.value)}
          />
        </span>
        <label className="fw-adm-toggle-row">
          <Toggle size="sm" checked={model.showArchived} onChange={(next) => actions?.onShowArchived?.(next)} aria-label={t('org.showArchived')} />
          <span className="fw-adm-hint">{t('org.showArchived')}</span>
        </label>
      </div>

      {model.companies.problem || items === null ? (
        <ListState problem={model.companies.problem} loading={items === null} onRetry={actions?.onRetry} />
      ) : items.length === 0 ? (
        <ListState
          loading={false}
          empty={{
            icon: <Building2 size={24} aria-hidden />,
            title: t('org.empty.title'),
            body: t('org.empty.body'),
            action: model.can.manageCompanies ? (
              <Button variant="primary" onClick={() => open('new-company')}>
                {t('org.newCompany')}
              </Button>
            ) : undefined,
          }}
        />
      ) : rows.length === 0 ? (
        <ListState
          loading={false}
          empty={{
            title: t('list.noMatch'),
            action: (
              <Button size="sm" onClick={() => actions?.onQuery?.('')}>
                {t('list.clearSearch')}
              </Button>
            ),
          }}
        />
      ) : (
        <div onKeyDown={onTreeKey}>
          <ListTable
            label={t('org.tableLabel')}
            columns={columns}
            rows={tableRows}
            page={paged.page}
            pageCount={paged.pageCount}
            onPage={actions?.onPage}
            widths={['22%', '8%', '8%', '18%', '12%', '10%', '10%', '6%', '8%']}
            count={t('org.count', { companies: items.filter((company) => model.showArchived || company.status === 'ACTIVE').length, sites: items.reduce((sum, company) => sum + company.sites.filter((site) => model.showArchived || site.status === 'ACTIVE').length, 0) })}
          />
        </div>
      )}

      <NewCompanyModal open={dialog === 'new-company'} taken={codes} busy={!!model.busy} problem={model.dialogProblem ?? null} onClose={() => open(null)} onCreate={(draft) => actions?.onCreateCompany?.(draft) ?? Promise.resolve(false)} />
      <NewSiteModal
        open={dialog === 'new-site'}
        companies={(items ?? []).filter((company) => company.status === 'ACTIVE')}
        companyId={model.dialogCompanyId ?? null}
        taken={siteCodes}
        busy={!!model.busy}
        problem={model.dialogProblem ?? null}
        onClose={() => open(null)}
        onCreate={(draft) => actions?.onCreateSite?.(draft) ?? Promise.resolve(false)}
      />
    </div>
  )
}

const EMPTY_COMPANY: NewCompanyDraft = { legalName: '', code: '', vatNumber: '', country: 'IT' }

export function NewCompanyModal({ open, taken, busy, problem, onClose, onCreate }: { open: boolean; taken: readonly string[]; busy: boolean; problem: string | null; onClose: () => void; onCreate: (draft: NewCompanyDraft) => Promise<boolean> }) {
  const t = useT('admin')
  const [draft, setDraft] = useState<NewCompanyDraft>(EMPTY_COMPANY)
  const [codeTouched, setCodeTouched] = useState(false)
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) {
      setDraft(EMPTY_COMPANY)
      setCodeTouched(false)
      setTried(false)
    }
  }, [open])
  const problems = newCompanyProblems(draft, taken)
  const ready = Object.keys(problems).length === 0
  const shown = (field: keyof NewCompanyDraft) => (tried && problems[field] ? t(problems[field]!) : undefined)
  const submit = async () => {
    setTried(true)
    if (ready && !busy) await onCreate({ ...draft, code: draft.code.trim().toUpperCase() })
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('org.newCompany')}
      subtitle={t('org.newCompanyHint')}
      size="md"
      busy={busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void submit()} heldReason={tried && !ready ? t('form.fixFirst', { count: Object.keys(problems).length }) : busy ? t('common.saving') : null}>
            {t('org.createCompany')}
          </Button>
        </>
      }
    >
      <form
        className="fw-adm-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit()
        }}
      >
        {problem && <Banner tone="danger" title={t(problem)} />}
        <Field label={t('org.field.legalName')} required error={shown('legalName')}>
          <Input
            autoFocus
            value={draft.legalName}
            onChange={(event) => {
              const legalName = event.target.value
              setDraft((current) => ({ ...current, legalName, code: codeTouched ? current.code : suggestCode(legalName, taken) }))
            }}
          />
        </Field>
        <Field label={t('org.field.vatNumber')} hint={t('org.field.vatHint')} error={shown('vatNumber')}>
          <Input value={draft.vatNumber} onChange={(event) => setDraft({ ...draft, vatNumber: event.target.value })} placeholder="IT00000000000" />
        </Field>
        <Field label={t('org.field.code')} hint={t('org.field.codeHint')} required error={shown('code')}>
          <Input
            className="fw-adm-code"
            value={draft.code}
            onChange={(event) => {
              setCodeTouched(true)
              setDraft({ ...draft, code: event.target.value.toUpperCase() })
            }}
          />
        </Field>
        <Field label={t('org.field.country')} error={shown('country')}>
          <Input value={draft.country} maxLength={2} onChange={(event) => setDraft({ ...draft, country: event.target.value.toUpperCase() })} />
        </Field>
        <p className="fw-adm-hint">{t('org.viesLater')}</p>
      </form>
    </Modal>
  )
}

export function NewSiteModal({
  open,
  companies,
  companyId,
  taken,
  busy,
  problem,
  onClose,
  onCreate,
}: {
  open: boolean
  companies: readonly CompanyWithSites[]
  companyId: string | null
  taken: readonly string[]
  busy: boolean
  problem: string | null
  onClose: () => void
  onCreate: (draft: NewSiteDraft) => Promise<boolean>
}) {
  const t = useT('admin')
  const first = companyId ?? companies[0]?.id ?? ''
  const blank = (id: string): NewSiteDraft => ({ companyId: id, name: '', kind: 'PLANT', code: '', timezone: companies.find((company) => company.id === id)?.timezone ?? 'Europe/Rome', line1: '', postalCode: '', city: '', province: '' })
  const [draft, setDraft] = useState<NewSiteDraft>(() => blank(first))
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) {
      setDraft(blank(first))
      setTried(false)
    }
  }, [open, first])
  const problems = newSiteProblems(draft, taken)
  const ready = Object.keys(problems).length === 0
  const shown = (field: keyof NewSiteDraft) => (tried && problems[field] ? t(problems[field]!) : undefined)
  const submit = async () => {
    setTried(true)
    if (ready && !busy) await onCreate({ ...draft, code: draft.code.trim().toUpperCase() })
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('org.newSite')}
      subtitle={t('org.newSiteHint')}
      size="md"
      busy={busy}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => void submit()} heldReason={tried && !ready ? t('form.fixFirst', { count: Object.keys(problems).length }) : busy ? t('common.saving') : null}>
            {t('org.createSite')}
          </Button>
        </>
      }
    >
      <form
        className="fw-adm-modal-body"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit()
        }}
      >
        {problem && <Banner tone="danger" title={t(problem)} />}
        <Field label={t('org.field.company')} required error={shown('companyId')}>
          <Select value={draft.companyId} onChange={(event) => setDraft({ ...draft, companyId: event.target.value, timezone: companies.find((company) => company.id === event.target.value)?.timezone ?? draft.timezone })}>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.legalName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('org.field.siteName')} required error={shown('name')}>
          <Input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value, code: draft.code || '' })} />
        </Field>
        <div className="fw-adm-form">
          <Field label={t('org.field.kind')}>
            <Select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as SiteKind })}>
              {SITE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`org.kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('org.field.code')} hint={t('org.field.siteCodeHint')} required error={shown('code')}>
            <Input className="fw-adm-code" value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('org.field.timezone')}>
            <Select value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })}>
              {[...new Set([draft.timezone, ...TIME_ZONES])].map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('org.field.line1')} error={shown('line1')}>
          <Input value={draft.line1} onChange={(event) => setDraft({ ...draft, line1: event.target.value })} />
        </Field>
        <div className="fw-adm-form">
          <Field label={t('org.field.postalCode')} error={shown('postalCode')}>
            <Input value={draft.postalCode} onChange={(event) => setDraft({ ...draft, postalCode: event.target.value })} />
          </Field>
          <Field label={t('org.field.city')} error={shown('city')}>
            <Input value={draft.city} onChange={(event) => setDraft({ ...draft, city: event.target.value })} />
          </Field>
          <Field label={t('org.field.province')}>
            <Input value={draft.province} maxLength={10} onChange={(event) => setDraft({ ...draft, province: event.target.value.toUpperCase() })} />
          </Field>
        </div>
      </form>
    </Modal>
  )
}
