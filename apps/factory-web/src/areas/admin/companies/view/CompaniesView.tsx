'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Building2, CalendarDays, MoreHorizontal } from 'lucide-react'
import { Banner, Field, Menu } from '@nexus/ui/components'
import { Button, Input, Select, Toggle } from '@nexus/ui/primitives'
import { Modal } from '../../../../lib/i18n/ds-parts'
import { useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { ListFrame } from '../../../../list-frame/ListFrame'
import type { ListKey } from '../../../../list-frame/model'
import { SITE_KINDS, type CompanyWithSites, type SiteKind } from '../../shared/api'
import { adminHref, shownOf } from '../../shared/model'
import { FrameState, ListKeysHelp, ListSearch, NoticeBanner, PageHead } from '../../shared/view/parts'
import {
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
  type TreeRow,
} from '../model'
import { orgColumns, treeRowId } from './columns'

export type { CompaniesViewModel } from '../model'

export interface CompaniesActions {
  onQuery?: (query: string) => void
  onShowArchived?: (show: boolean) => void
  onToggle?: (companyId: string, expanded: boolean) => void
  /** "Show 50 more". */
  onMore?: () => void
  onRetry?: () => void
  /** Enter on a row: open its record. */
  onOpen?: (href: string) => void
  onDialog?: (dialog: OrgDialog | null, companyId?: string | null) => void
  /** Resolve true when made (the page then opens the new record). */
  onCreateCompany?: (draft: NewCompanyDraft) => Promise<boolean>
  onCreateSite?: (draft: NewSiteDraft) => Promise<boolean>
  onDismissNotice?: () => void
}

/**
 * SCR-008 — Admin › Companies & sites (design 02 admin.org; PLT-003, PLT-004): one tree of the legal companies and their
 * plants, warehouses and offices, with what each is missing, in the Office list frame (read-only: no bulk action
 * applies to companies), and the two short creates (New company, New site). Rows open the Company or Site record. It
 * draws ONE view model and fetches nothing (CompaniesPage.tsx reads the API).
 */
export function CompaniesView({ model, actions }: { model: CompaniesViewModel; actions?: CompaniesActions }) {
  return (
    // AdminMessages' catalogues and, for "Holidays for all sites" (B-W2a-59), `admin-calendars`.
    <WithMessages namespaces={['admin', 'records', 'admin-calendars']}>
      <Companies model={model} actions={actions} />
    </WithMessages>
  )
}

function Companies({ model, actions }: { model: CompaniesViewModel; actions?: CompaniesActions }) {
  const t = useT('admin')
  const tc = useT('admin-calendars')
  const [dialog, setDialog] = useState<OrgDialog | null>(model.dialog ?? null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog])
  const [help, setHelp] = useState(false)
  const open = (next: OrgDialog | null) => {
    setDialog(next)
    actions?.onDialog?.(next)
  }
  const items = model.companies.items
  const rows = items ? treeRows(items, model.query, model.collapsed, model.showArchived) : []
  const shown = shownOf(rows, model.pages)
  const gap = items ? readiness(items) : null
  const href = (path: string) => adminHref(model.prefix, path)
  const onToggle = actions?.onToggle
  const columns = useMemo(() => orgColumns({ t, prefix: model.prefix, viewSites: model.can.viewSites, onToggle }), [t, model.prefix, model.can.viewSites, onToggle])

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

  const codes = (items ?? []).map((company) => company.code)
  const siteCodes = (items ?? []).flatMap((company) => company.sites.map((site) => site.code))
  const noCompany = !items || items.filter((company) => company.status === 'ACTIVE').length === 0
  const own: ListKey[] = [...(model.can.manageCompanies ? [{ keys: ['c'], does: t('org.newCompany') }] : []), ...(model.can.viewSites ? [{ keys: ['←', '→'], does: t('org.keys.fold') }] : [])]
  const state = model.companies.problem ? (
    <FrameState problem={model.companies.problem} onRetry={actions?.onRetry} />
  ) : items && items.length === 0 ? (
    <FrameState
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
  ) : items && rows.length === 0 ? (
    <FrameState noMatch={{ onClear: () => actions?.onQuery?.(''), clearLabel: t('list.clearSearch') }} />
  ) : undefined

  return (
    <div className="fw-adm">
      <PageHead
        intro={t('org.intro')}
        asOf={model.asOf}
        actions={
          <>
            {/* B-W2a-59 (design admin.org page.h more): the company's working days and holidays, which every site inherits. */}
            {model.can.viewCalendars && model.currentCompanyId && (
              <Menu
                align="right"
                label={<MoreHorizontal size={16} aria-hidden />}
                triggerProps={{ 'aria-label': tc('acal.more'), title: tc('acal.more'), className: 'nds-btn sm' }}
                items={[{ id: 'holidays', label: tc('acal.holidaysAll'), description: tc('acal.holidaysAllHint'), icon: <CalendarDays size={14} aria-hidden />, href: `${href(`/companies/${model.currentCompanyId}`)}?tab=calendars` }]}
              />
            )}
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

      <ListFrame<TreeRow>
        label={t('org.tableLabel')}
        rows={items === null ? null : shown.rows}
        rowId={treeRowId}
        columns={columns}
        count={
          items
            ? t('org.count', {
                companies: items.filter((company) => model.showArchived || company.status === 'ACTIVE').length,
                sites: items.reduce((sum, company) => sum + company.sites.filter((site) => model.showArchived || site.status === 'ACTIVE').length, 0),
              })
            : '—'
        }
        search={<ListSearch label={t('org.search')} value={model.query} onChange={actions?.onQuery} />}
        tools={
          <label className="fw-adm-toggle-row">
            <Toggle size="sm" checked={model.showArchived} onChange={(next) => actions?.onShowArchived?.(next)} aria-label={t('org.showArchived')} />
            <span className="fw-adm-hint">{t('org.showArchived')}</span>
          </label>
        }
        more={shown.more > 0 ? { label: t('list.more', { count: shown.more }), onMore: () => actions?.onMore?.() } : null}
        keys={own}
        onHelp={() => setHelp(true)}
        onOpen={(row) => actions?.onOpen?.(row.kind === 'company' ? href(`/companies/${row.company.id}`) : href(`/companies/${row.company.id}/sites/${row.site.id}`))}
        state={state}
      />

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
      <ListKeysHelp open={help} onClose={() => setHelp(false)} keys={own} selection={false} />
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
