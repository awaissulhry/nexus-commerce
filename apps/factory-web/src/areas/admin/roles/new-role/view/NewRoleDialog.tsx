'use client'

import { Plus } from 'lucide-react'
import { Banner, EmptyState, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { GrainChips, useRoleWords } from '../../../shared/view/parts'
import type { RoleTemplate } from '../api'
import { copyName, newRoleErrors, offeredTemplates, templateHeld, type NewRoleDraft } from '../model'
import type { StepUpModel } from '../../../shared/model'
import { FreshCode } from '../../../security/step-up/view/FreshCode'
import '../../save-role/roles-depth.css'

export interface NewRoleModel {
  /** Null while the ready-made roles are read. */
  templates: readonly RoleTemplate[] | null
  /** The read failed (a message key of `admin`). */
  readProblem: string | null
  draft: NewRoleDraft
  /** The person typed the name (picking a ready-made role no longer renames the copy). */
  named: boolean
  /** Save was tried: the problems show. */
  tried: boolean
  busy: boolean
  /** The create was refused (a message key of `admin-security-depth`). */
  problem: string | null
}

export interface NewRoleActions {
  onName?: (name: string) => void
  /** A ready-made role picked, with the copy's name these words suggest ("Planner (copy)"). */
  onPick?: (basedOn: string, suggested: string) => void
  onCreate?: () => void
  onClose?: () => void
  onRetry?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpClose?: () => void
}

/**
 * Admin › Roles › New role (SCR-012 pop:new-role, B-W2b-413; PLT-031): start from a ready-made role — cards with their plain
 * line and the money each sees; the owner's and any holding more than you are held with why — and name it; "Create copy"
 * (⌘Enter) asks a fresh code and opens the copy's Permissions tab. Fetches nothing (use-new-role.ts).
 */
export function NewRoleDialog({ model, actions, stepUp }: { model: NewRoleModel; actions?: NewRoleActions; stepUp?: StepUpModel }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <Dialog model={model} actions={actions} />
      <FreshCode model={stepUp} onSubmit={actions?.onStepUpSubmit} onClose={actions?.onStepUpClose} />
    </WithMessages>
  )
}

/** The band's "New role" (held with why without roles.manage). */
export function NewRoleButton({ canCreate, onOpen }: { canCreate: boolean; onOpen?: () => void }) {
  return (
    <WithMessages namespaces={['admin-security-depth']}>
      <NewButton canCreate={canCreate} onOpen={onOpen} />
    </WithMessages>
  )
}

function NewButton({ canCreate, onOpen }: { canCreate: boolean; onOpen?: () => void }) {
  const t = useT('admin-security-depth')
  return (
    <Button size="sm" variant="primary" heldReason={canCreate ? null : t('newRole.held.right')} onClick={() => onOpen?.()}>
      <Plus size={14} aria-hidden /> {t('newRole.button')}
    </Button>
  )
}

function Dialog({ model, actions }: { model: NewRoleModel; actions?: NewRoleActions }) {
  const t = useT('admin-security-depth')
  const ta = useT('admin')
  const words = useRoleWords()
  const templates = model.templates ? offeredTemplates(model.templates) : null
  const errors = templates ? newRoleErrors(model.draft, templates) : {}
  const ready = Object.keys(errors).length === 0
  const create = () => {
    if (!model.busy) actions?.onCreate?.()
  }
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      title={t('newRole.title')}
      subtitle={t('newRole.hint')}
      size="lg"
      busy={model.busy}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{ta('common.cancel')}</Button>
          <Button variant="primary" heldReason={model.busy ? t('newRole.held.busy') : !templates ? t('newRole.held.reading') : model.tried && !ready ? t('newRole.held.fix') : null} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('newRole.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-adm-modal-body fw-rol-new"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            create()
          }
        }}
      >
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
        <Field label={t('newRole.name')} hint={t('newRole.nameHint')} error={model.tried && errors.name ? t(errors.name) : undefined}>
          <Input value={model.draft.name} maxLength={100} onChange={(event) => actions?.onName?.(event.target.value)} autoFocus />
        </Field>
        <fieldset className="fw-rol-new-from">
          <legend className="fw-rol-new-legend">{t('newRole.from')}</legend>
          {model.tried && errors.basedOn && <p className="fw-rol-error">{t(errors.basedOn)}</p>}
          {model.readProblem ? (
            <EmptyState title={t('newRole.readFailed')} description={ta(model.readProblem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('session.retry')}</Button>} />
          ) : !templates ? (
            <div className="fw-rol-new-cards" aria-busy="true">
              <Skeleton height={72} />
              <Skeleton height={72} />
              <Skeleton height={72} />
            </div>
          ) : (
            <div className="fw-rol-new-cards" role="radiogroup" aria-label={t('newRole.from')}>
              {templates.map((template) => {
                const held = templateHeld(template)
                return (
                  <RadioCard
                    key={template.key}
                    name="new-role-from"
                    value={template.key}
                    checked={model.draft.basedOn === template.key}
                    selected={model.draft.basedOn === template.key}
                    disabled={!!held}
                    onChange={() => actions?.onPick?.(template.key, copyName(words.name(template), t('newRole.copy')))}
                    title={words.name(template)}
                    description={
                      <span className="fw-rol-new-card">
                        <span>{words.description(template) ?? ''}</span>
                        <GrainChips grains={template.grains} label={ta('grains.labelOf', { name: words.name(template) })} />
                        {held && <span className="fw-rol-held">{t(held)}</span>}
                      </span>
                    }
                  />
                )
              })}
            </div>
          )}
        </fieldset>
        <p className="fw-adm-hint">{t('newRole.after')}</p>
      </div>
    </Modal>
  )
}
