'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { Copy } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import type { PreferencesValue } from '@nexus/ui/patterns'
import { Button, Input, RadioCard, SegmentedControl, Select } from '@nexus/ui/primitives'
import { JobProgress, Modal, PreferencesModal } from '../../lib/i18n/ds-parts'
import { EXPORT_LIMITS } from '@nexus/factory-domain/views/exports'
import type { ViewAudience } from '@nexus/factory-domain/views/rules'
import { VIEW_LIMITS, type Density, type ViewState } from '@nexus/factory-domain/views/state'
import { formatDate, formatNumber, formatTime } from '../../lib/i18n/format'
import { useLocale, useT } from '../../lib/i18n/provider'
import { failureKey, isActiveJob, layoutOfPreferences, preferenceColumnsOf, preferencesOf, sizeText, termCount, type ToolColumn } from './model'
import type { ExportJob, RoleRef, SavedView, ToolsProblem, ViewDraft, ViewsAnswer, WorkingLayout } from './transport'

/**
 * The list tools' pop-ups (B-W2a-23; design shell.lists pop:customise, pop:save-view, pop:export-job), each a DS
 * dialog: Customise = the ONE Customise dialog (PreferencesModal) with the density beside the columns; Save view =
 * Modal + RadioCard + a CopyField (a read-only field with Copy, composed here: the DS has none); the export job =
 * Modal + JobProgress. Words from `lists` (tools.*). Held, never hidden: a choice the person may not make says why.
 */

export const DENSITY_CHOICES: readonly Density[] = ['compact', 'cozy', 'spacious']

/** CopyField (new, composed from DS parts): the link in a read-only field, then Copy. */
export function CopyField({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  const t = useT('lists')
  return (
    <div className="fw-lt-copy">
      <Field label={label}>
        <Input size="sm" readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
      </Field>
      <Button size="sm" onClick={onCopy}>
        <Copy size={13} aria-hidden /> {t('tools.save.copy')}
      </Button>
    </div>
  )
}

export interface SaveViewDialogProps {
  /** null: a new view of what is on screen; a view: rename or share it. */
  view: SavedView | null
  answer: ViewsAnswer
  /** What the screen shows now (a new view keeps it; an edit keeps the view's own unless Update). */
  state: ViewState
  busy: boolean
  problem: ToolsProblem | null
  link: string | null
  onCopy: (link: string) => void
  onSave: (draft: ViewDraft) => void
  onClose: () => void
}

/** Save view (design pop:save-view): name, who sees it, what it keeps; Copy link once it exists. ⌘Enter saves. */
export function SaveViewDialog({ view, answer, state, busy, problem, link, onCopy, onSave, onClose }: SaveViewDialogProps) {
  const t = useT('lists')
  const [name, setName] = useState(view?.name ?? '')
  const [audience, setAudience] = useState<ViewAudience | 'DEFAULT'>(view ? (view.roleDefault ? 'DEFAULT' : view.audience) : 'ONLY_ME')
  const heldRoles: readonly RoleRef[] = answer.roles
  const anyRoles: readonly RoleRef[] = answer.allRoles.length > 0 ? answer.allRoles : answer.roles
  const [roleId, setRoleId] = useState<string>(view?.roleId ?? heldRoles[0]?.id ?? anyRoles[0]?.id ?? '')
  const [touched, setTouched] = useState(false)
  const kept = view ? view.state : state
  const trimmed = name.trim()
  const nameError = touched && trimmed === '' ? t('tools.save.nameNeeded') : trimmed.length > VIEW_LIMITS.name ? t('tools.save.nameLong', { max: VIEW_LIMITS.name }) : null
  const manage = answer.can.manage
  const rolesFor = audience === 'DEFAULT' || manage ? anyRoles : heldRoles
  const roleHeld = (audience === 'ROLE' || audience === 'DEFAULT') && rolesFor.length === 0 ? t('tools.save.noRole') : null
  const submitHeld = busy ? t('tools.save.saving') : trimmed === '' ? t('tools.save.nameNeeded') : roleHeld
  const submit = () => {
    setTouched(true)
    if (submitHeld) return
    const role = audience === 'ROLE' || audience === 'DEFAULT' ? roleId || null : null
    onSave({ name: trimmed, audience: audience === 'DEFAULT' ? 'ROLE' : audience, roleId: role, roleDefault: audience === 'DEFAULT', state: kept })
  }
  const option = (value: ViewAudience | 'DEFAULT', title: string, description: string, held: string | null) => (
    <RadioCard
      name="fw-lt-audience"
      value={value}
      checked={audience === value}
      selected={audience === value}
      disabled={held !== null}
      onChange={() => setAudience(value)}
      title={title}
      description={held ?? description}
    />
  )
  const shown = kept.columns ? kept.columns.hidden.length : 0
  return (
    <Modal
      open
      onClose={onClose}
      title={view ? t('tools.save.editTitle') : t('tools.save.title')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('tools.save.cancel')}</Button>
          <Button variant="primary" onClick={submit} heldReason={submitHeld}>
            {view ? t('tools.save.saveChanges') : t('tools.save.submit')}
          </Button>
        </>
      }
    >
      <div
        className="fw-lt-form"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
      >
        {problem && <Banner tone="danger" title={t(`tools.problem.${problem}`)} />}
        <Field label={t('tools.save.name')} error={nameError} required>
          <Input size="sm" value={name} maxLength={VIEW_LIMITS.name} autoFocus placeholder={t('tools.save.namePlaceholder')} onChange={(event) => setName(event.target.value)} onBlur={() => setTouched(true)} />
        </Field>
        <fieldset className="fw-lt-fieldset">
          <legend>{t('tools.save.who')}</legend>
          {option('ONLY_ME', t('tools.save.onlyMe'), t('tools.save.onlyMeHint'), answer.can.save ? null : t('tools.held.save'))}
          {option('ROLE', t('tools.save.role'), t('tools.save.roleHint'), !answer.can.save ? t('tools.held.save') : heldRoles.length === 0 && !manage ? t('tools.save.noRole') : null)}
          {option('EVERYONE', t('tools.save.everyone'), t('tools.save.everyoneHint'), manage ? null : t('tools.held.manage'))}
          {option('DEFAULT', t('tools.save.default'), t('tools.save.defaultHint'), manage ? null : t('tools.held.manage'))}
          {(audience === 'ROLE' || audience === 'DEFAULT') && rolesFor.length > 0 && (
            <Field label={t('tools.save.rolePick')}>
              <Select size="sm" value={roleId} onChange={(event) => setRoleId(event.target.value)}>
                {rolesFor.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </fieldset>
        <div className="fw-lt-keeps">
          <p className="fw-lt-keeps-title">{t('tools.save.keeps')}</p>
          <ul>
            <li>{termCount(kept) === 0 ? t('tools.save.keepsNoFilter') : t('tools.save.keepsFilters', { count: termCount(kept) })}</li>
            <li>{kept.columns ? t('tools.save.keepsColumns', { count: shown }) : t('tools.save.keepsBuiltColumns')}</li>
            <li>{t('tools.save.keepsDensity', { density: t(`tools.density.${kept.density ?? 'cozy'}`) })}</li>
          </ul>
        </div>
        {link && <CopyField label={t('tools.save.link')} value={link} onCopy={() => onCopy(link)} />}
      </div>
    </Modal>
  )
}

/** Remove a view: its reach said before the click. */
export function RemoveViewDialog({ view, busy, problem, onRemove, onClose }: { view: SavedView; busy: boolean; problem: ToolsProblem | null; onRemove: () => void; onClose: () => void }) {
  const t = useT('lists')
  return (
    <Modal
      open
      onClose={onClose}
      title={t('tools.removeDialog.title', { name: view.name })}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('tools.save.cancel')}</Button>
          <Button variant="danger" onClick={onRemove} heldReason={busy ? t('tools.save.saving') : null}>
            {t('tools.removeDialog.confirm')}
          </Button>
        </>
      }
    >
      {problem && <Banner tone="danger" title={t(`tools.problem.${problem}`)} />}
      <p className="fw-lt-text">{view.audience === 'ONLY_ME' ? t('tools.removeDialog.mine') : t('tools.removeDialog.shared')}</p>
    </Modal>
  )
}

/** Customise columns (design pop:customise): the DS's one Customise dialog; the density beside the columns. */
export function CustomiseDialog({ tools, layout, onApply, onClose }: { tools: readonly ToolColumn[]; layout: WorkingLayout; onApply: (next: WorkingLayout) => void; onClose: () => void }) {
  const t = useT('lists')
  const [density, setDensity] = useState<Density>(layout.density ?? 'cozy')
  const value = useMemo(() => preferencesOf(tools, layout.columns), [tools, layout.columns])
  const columns = useMemo(() => preferenceColumnsOf(tools), [tools])
  const slot = (
    <fieldset className="fw-lt-fieldset">
      <legend>{t('tools.customise.density')}</legend>
      <SegmentedControl
        size="sm"
        ariaLabel={t('tools.customise.density')}
        value={density}
        onChange={(next) => setDensity(next as Density)}
        options={DENSITY_CHOICES.map((choice) => ({ value: choice, label: t(`tools.density.${choice}`) }))}
      />
    </fieldset>
  )
  return (
    <PreferencesModal
      open
      onClose={onClose}
      value={value}
      onConfirm={(next: PreferencesValue) => {
        onApply({ ...layout, columns: layoutOfPreferences(tools, next), density: density === 'cozy' ? undefined : density })
        onClose()
      }}
      allColumns={columns}
      defaultVisible={tools.map((column) => column.id)}
      pageSizeChoices={[]}
      sortFieldOptions={[]}
      showSticky={false}
      title={t('tools.customise.title')}
      listLabel={t('tools.customise.list')}
      listHint={t('tools.customise.hint')}
      workspaceSlot={slot}
      confirmLabel={t('tools.customise.apply')}
    />
  )
}

export interface ExportJobDialogProps {
  job: ExportJob
  problem: ToolsProblem | null
  onDownload: () => void
  onAgain: () => void
  onClose: () => void
}

/** The export job (design pop:export-job): its progress, the columns left out by rights, then the file. Esc closes; the job goes on. */
export function ExportJobDialog({ job, problem, onDownload, onAgain, onClose }: ExportJobDialogProps) {
  const t = useT('lists')
  const locale = useLocale()
  const active = isActiveJob(job.status)
  const [startedAt] = useState(() => (job.startedAt ? Date.parse(job.startedAt) : Date.now()))
  const title = active ? t('tools.job.title', { title: job.title }) : job.status === 'DONE' ? t('tools.job.ready') : job.status === 'FAILED' ? t('tools.job.failed') : t('tools.job.expired')
  let body: ReactNode
  if (active) {
    body = (
      <JobProgress
        label={t('tools.job.label', { title: job.title, format: t(`tools.format.${job.format}`) })}
        value={job.rowCount === null ? undefined : job.rowsDone}
        max={job.rowCount ?? undefined}
        detail={job.status === 'QUEUED' ? t('tools.job.waiting') : job.rowCount === null ? t('tools.job.rows', { count: job.rowsDone, rows: formatNumber(job.rowsDone, locale) }) : t('tools.job.rowsOf', { rows: formatNumber(job.rowsDone, locale), total: formatNumber(job.rowCount, locale) })}
        startedAt={startedAt}
        note={t('tools.job.note', { days: EXPORT_LIMITS.keepDays })}
      />
    )
  } else if (job.status === 'DONE' && job.file) {
    body = (
      <dl className="fw-lt-file">
        <dt>{t('tools.job.fileName')}</dt>
        <dd>{job.file.name}</dd>
        <dt>{t('tools.job.fileSize')}</dt>
        <dd>{t('tools.job.fileRows', { count: job.rowCount ?? 0, rows: formatNumber(job.rowCount ?? 0, locale), size: sizeText(job.file.sizeBytes, locale === 'en' ? 'en' : 'it') })}</dd>
        {job.expiresAt && (
          <>
            <dt>{t('tools.job.kept')}</dt>
            <dd>{t('tools.job.keptUntil', { date: formatDate(job.expiresAt, { locale }), time: formatTime(job.expiresAt, { locale }) })}</dd>
          </>
        )}
      </dl>
    )
  } else if (job.status === 'FAILED') {
    body = <Banner tone="danger" title={t(failureKey(job.failureReason))} />
  } else {
    body = <p className="fw-lt-text">{t('tools.job.expiredBody', { days: EXPORT_LIMITS.keepDays })}</p>
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      subtitle={job.selected ? t('tools.job.selected', { count: job.selected }) : job.viewName ? t('tools.job.fromView', { name: job.viewName }) : undefined}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('tools.job.close')}</Button>
          {job.status === 'DONE' && job.file && (
            <Button variant="primary" onClick={onDownload}>
              {t('tools.job.download')}
            </Button>
          )}
          {(job.status === 'FAILED' || job.status === 'EXPIRED') && (
            <Button variant="primary" onClick={onAgain}>
              {t('tools.job.again')}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-lt-form">
        {problem && <Banner tone="danger" title={t(`tools.problem.${problem}`)} />}
        {body}
        {job.omitted.length > 0 && <Banner tone="info" title={t('tools.job.omitted', { columns: job.omitted.map((column) => column.label).join(', ') })} />}
      </div>
    </Modal>
  )
}
