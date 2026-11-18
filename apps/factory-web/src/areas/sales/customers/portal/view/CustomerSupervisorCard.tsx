'use client'

import { useEffect, useState } from 'react'
import { UserCog } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { Combobox, EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { useLiveBus } from '../../../../../shell/live/use-live'
import { WithMessages } from '../../../../../record-panels/i18n'
import { SUPERVISOR_NS } from '../../../../_shared/production-supervisor/model'
import { changeCount, limitsDraftOf, limitsProblems, slotChoices, supervisorHeld, supervisorMove, type LimitsDraft, type SupervisorActions, type SupervisorModel } from '../limits/model'
import { useCustomerSupervisor } from '../limits/use-limits'
import { NoticeLine, PortalAccessMessages, usePortalT } from './parts'
import type { PortalNotice } from '../model'

/**
 * F-SA-272 (sales page plan N5, pick P10': "Supervisor + backup move to Overview", the production lane's yes; 11-customer-page §4 S2;
 * it speaks the portal-access words, so it lives beside the limits card):
 * "Who looks after <customer>" on the customer's Overview — the supervisor and backup block moved here from Portal settings ›
 * Production limits (same code), on a card of its own with its own Apply (PUT /production/brands/:id/supervisor; the limits Apply
 * no longer carries it). Office only: never in the portal or the preview, and the customer is never told who (R-41). Read with
 * partners.view (the customer's production read holds the names); changed with production.brand.manage, else held in words.
 */
export function CustomerSupervisorCard({ model, actions, name, notice, onDismissNotice }: { model: SupervisorModel; actions?: SupervisorActions | undefined; name: string; notice?: PortalNotice | null; onDismissNotice?: () => void }) {
  return (
    <PortalAccessMessages>
      <WithMessages namespaces={[SUPERVISOR_NS]}>
        <SupervisorCard model={model} actions={actions} name={name} notice={notice ?? null} onDismissNotice={onDismissNotice} />
      </WithMessages>
    </PortalAccessMessages>
  )
}

/** The page's part: the card's reads and its Apply (portal/limits/use-limits.ts useCustomerSupervisor), live on its supervisor's change. */
export function CustomerSupervisor({ partyId, name }: { partyId: string; name: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const enabled = session.permissions.includes('partners.view')
  const [notice, setNotice] = useState<PortalNotice | null>(null)
  const supervisor = useCustomerSupervisor({ api, partyId, enabled, supervise: session.permissions.includes('production.brand.manage'), onNotice: setNotice })
  useLiveBus({ onChange: supervisor.onLive }, enabled)
  if (!supervisor.model) return null
  return <CustomerSupervisorCard model={supervisor.model} actions={supervisor.actions} name={name} notice={notice} onDismissNotice={() => setNotice(null)} />
}

function SupervisorCard({ model, actions, name, notice, onDismissNotice }: { model: SupervisorModel; actions?: SupervisorActions | undefined; name: string; notice: PortalNotice | null; onDismissNotice?: (() => void) | undefined }) {
  const t = usePortalT()
  const ts = useT(SUPERVISOR_NS)
  const read = model.read
  const [draft, setDraft] = useState<LimitsDraft | null>(model.draft ?? (read ? limitsDraftOf(read.production) : null))
  // A save (or someone else's change) moves the version: the card starts again from what is stored.
  useEffect(() => setDraft(model.draft ?? (read ? limitsDraftOf(read.production) : null)), [read?.production.version, read?.party.id])
  if (model.state === 'error' && !read)
    return (
      <Card padded>
        <Banner
          tone="danger"
          title={t(model.problem ?? 'failed.title')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  if (!read || !draft)
    return (
      <Card padded>
        <Skeleton height={96} />
      </Card>
    )
  const saved = read.production
  const heldReason = supervisorHeld(model.supervise, model.pick)
  const held = heldReason ? (heldReason.ns === 'production-supervisor' ? ts(heldReason.key) : t(heldReason.key)) : null
  const move = supervisorMove(saved, draft, model.pick)
  const count = changeCount(saved, draft)
  const problems = limitsProblems(draft)
  const apply = () => {
    if (count === 0 || Object.keys(problems).length > 0 || model.busy) return
    void actions?.onApply?.(draft)
  }
  return (
    <Card padded>
      <div className="fw-pa">
        <NoticeLine notice={notice} onDismiss={onDismissNotice} />
        {model.saveProblem && (
          <Banner
            tone="danger"
            title={model.saveProblem.ns === 'production-supervisor' ? ts(model.saveProblem.key) : t(model.saveProblem.key)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissProblem?.()}>
                {t('common.dismiss')}
              </Button>
            }
          />
        )}
        <SupervisorBlock model={model} draft={draft} name={name} held={held} move={move} onDraft={(patch) => setDraft((current) => (current ? { ...current, ...patch } : current))} actions={actions} />
        {count > 0 && (
          <EditModeBar
            count={count}
            message={t('limits.unsaved', { count })}
            applyLabel={t('limits.apply')}
            busy={model.busy}
            applyHeldReason={Object.keys(problems).length > 0 ? t('settings.fixFirst') : null}
            onDiscard={() => setDraft(limitsDraftOf(saved))}
            onApply={apply}
          />
        )}
      </div>
    </Card>
  )
}

/** Who looks after the customer here — office only (R-41, R-53): the supervisor and the backup, from the people who may take it. */
function SupervisorBlock({ model, draft, name, held, move, onDraft, actions }: { model: SupervisorModel; draft: LimitsDraft; name: string; held: string | null; move: { key: string; count: number } | null; onDraft: (patch: Partial<LimitsDraft>) => void; actions?: SupervisorActions | undefined }) {
  const t = usePortalT()
  const ts = useT(SUPERVISOR_NS)
  const saved = model.read!.production
  const pick = model.pick
  const supervisors = slotChoices(pick, saved.supervisor, null)
  const backups = slotChoices(pick, saved.backup, draft.supervisorId)
  const problems = limitsProblems(draft)
  const label = (entry: { value: string; label: string; listed: boolean }) => (entry.listed ? entry.label : t('limits.supervisor.notListed', { name: entry.label }))
  const editable = held === null && pick.status === 'ready'
  const person = (slot: { readonly name: string; readonly active: boolean } | null) =>
    slot ? (
      <span className="fw-pa-cell">
        <span>{slot.name}</span>
        {!slot.active && <Tag tone="warning">{ts('fact.inactive')}</Tag>}
      </span>
    ) : (
      <span className="fw-pa-hint">{t('limits.supervisor.none')}</span>
    )
  return (
    <fieldset className="fw-pa-fieldset fw-pa-lim-office">
      <legend className="fw-pa-legend">
        <span className="fw-pa-cell">
          <UserCog size={14} aria-hidden /> {t('limits.supervisor.title', { name })} <Tag tone="info">{t('limits.supervisor.officeOnly')}</Tag>
        </span>
      </legend>
      <p className="fw-pa-hint">{t('limits.supervisor.intro')}</p>
      {held && <p className="fw-pa-hint">{held}</p>}
      {pick.status === 'loading' && model.supervise && (
        <div role="status" aria-label={ts('dialog.reading')}>
          <Skeleton height={40} />
        </div>
      )}
      {pick.status === 'error' && (
        <Banner
          tone="danger"
          title={t(pick.key)}
          action={
            <Button size="sm" onClick={() => actions?.onRetryPick?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {pick.status === 'ready' && pick.people.length === 0 && <p className="fw-pa-hint">{ts('dialog.nobody')}</p>}
      <div className="fw-pa-lim-two">
        <Field label={t('limits.supervisor.label')}>
          {editable ? (
            <Combobox options={[{ value: '', label: t('limits.supervisor.none') }, ...supervisors.map((entry) => ({ value: entry.value, label: label(entry) }))]} value={draft.supervisorId ?? ''} placeholder={ts('dialog.search')} onChange={(value) => onDraft({ supervisorId: value || null, ...(value ? {} : { backupId: null }) })} />
          ) : (
            person(saved.supervisor)
          )}
        </Field>
        <Field label={t('limits.supervisor.backup')} hint={t('limits.supervisor.backupHint')} error={problems.backup ? t(problems.backup) : undefined}>
          {editable && draft.supervisorId !== null ? (
            <Combobox options={[{ value: '', label: t('limits.supervisor.none') }, ...backups.map((entry) => ({ value: entry.value, label: label(entry) }))]} value={draft.backupId ?? ''} placeholder={ts('dialog.search')} onChange={(value) => onDraft({ backupId: value || null })} />
          ) : editable ? (
            <span className="fw-pa-hint">{t('limits.supervisor.backupAlone')}</span>
          ) : (
            person(saved.backup)
          )}
        </Field>
      </div>
      {move && (
        <p className="fw-pa-strong" role="status">
          {t(move.key, { count: move.count })}
        </p>
      )}
      {pick.status === 'ready' && !pick.complete && <p className="fw-pa-hint">{ts('dialog.partial')}</p>}
      <p className="fw-pa-hint">{ts('dialog.hint')}</p>
    </fieldset>
  )
}

