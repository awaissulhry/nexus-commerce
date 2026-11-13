'use client'

import { Percent } from 'lucide-react'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Spinner, Tag } from '@nexus/ui/primitives'
import { StepUpModal } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { percent } from '../../../quotes/model'
import type { MarginFloors } from '../api'
import { floorsChanged, floorsHeld, lowers, rowOf, type FloorWords } from '../model'
import '../../../quotes/record/price-depth/price-depth.css'

const NS = 'sales-prices-depth'

export interface FloorsModel {
  scope: 'company' | 'group'
  /** "DEMO" — the company of the scope (company scope). */
  companyCode: string | null
  floors: { status: 'loading' } | { status: 'error'; problem: FloorWords } | { status: 'ready'; value: MarginFloors }
  /** money.margin: the floors are the margin grain (absent without it). */
  margin: boolean
  /** sales.settings.manage. */
  manage: boolean
  /** The floors being typed (null: read). */
  edit: Record<string, string> | null
  saving: boolean
  problem: FloorWords | null
  notice: { words: FloorWords; tone: 'success' | 'danger' | 'info' } | null
  stepUp: { open: boolean; busy: boolean; problem: string | null }
}

export interface FloorsActions {
  onEdit?: (open: boolean) => void
  onDraft?: (roleKey: string, text: string) => void
  onSave?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

/**
 * Sales settings › Quote approval rules › Margin floor % per role (B-W2b-343; design sales.settings, SAL-189; B-W2b-330's
 * API): each office role's own floor for the quotes its people make (a version is held to the lowest floor of its maker's
 * roles; a role without one keeps the company floor), the floors in force and where they come from (this company's or the
 * group's), edited explicitly (Save / Discard) on the scope's own settings row. Lowering a floor lets more quotes through
 * without an approval: it asks a fresh code (the DS step-up). Read only without sales.settings.manage; nothing drawn
 * without the margin grain but the reason.
 */
export function FloorsView({ model, actions }: { model: FloorsModel; actions?: FloorsActions }) {
  return (
    <WithMessages namespaces={[NS]}>
      <Floors model={model} actions={actions} />
    </WithMessages>
  )
}

function Floors({ model, actions }: { model: FloorsModel; actions?: FloorsActions }) {
  const t = useT(NS)
  const locale = useLocale()
  const say = (words: FloorWords | null) => (words ? t(words.key, words.params) : '')
  const head = (
    <div className="fw-qpd-head">
      <h2 className="fw-q-h3" id="margin-floors">
        {t('floors.title')}
      </h2>
      <p className="fw-q-hint">{t('floors.sub')}</p>
    </div>
  )
  if (!model.margin) {
    return (
      <Card padded>
        <section aria-labelledby="margin-floors">
          {head}
          <p className="fw-q-hint">{t('floors.noMargin')}</p>
        </section>
      </Card>
    )
  }
  const floors = model.floors.status === 'ready' ? model.floors.value : null
  const row = floors ? rowOf(floors, model.scope) : null
  const inForce = floors?.inForce.floors ?? {}
  const company = floors?.inForce.companyFloorPct
  const editing = model.edit !== null
  const held = !model.manage ? t('floors.held.manage') : !row ? t(model.scope === 'company' ? 'floors.held.noRowCompany' : 'floors.held.noRowGroup') : null
  const saveHeld = floors && model.edit ? (floorsHeld(model.edit, floors.roles) ? say(floorsHeld(model.edit, floors.roles)) : !floorsChanged(model.edit, floors, model.scope) ? t('floors.held.same') : model.saving ? t('common.working') : null) : null
  const lowering = floors && model.edit ? lowers(model.edit, floors, model.scope) : false
  return (
    <Card padded>
      <section aria-labelledby="margin-floors" className="fw-qpd-stack">
        <div className="fw-qpd-margin">
          {head}
          {!editing && (
            <Button size="sm" heldReason={held} onClick={() => actions?.onEdit?.(true)}>
              <Percent size={13} aria-hidden /> {t('floors.edit')}
            </Button>
          )}
        </div>
        {model.notice && (
          <Banner
            tone={model.notice.tone}
            title={say(model.notice.words)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {t('common.dismiss')}
              </Button>
            }
          />
        )}
        {model.floors.status === 'loading' ? (
          <p className="fw-q-hint" role="status">
            <Spinner size={12} /> {t('common.loading')}
          </p>
        ) : model.floors.status === 'error' ? (
          <EmptyState
            title={t('floors.failed')}
            description={say(model.floors.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : floors && floors.roles.length === 0 ? (
          <p className="fw-q-hint">{t('floors.noRoles')}</p>
        ) : floors ? (
          <>
            <p className="fw-q-hint">
              {t(floors.inForce.from === 'COMPANY' ? 'floors.fromCompany' : floors.inForce.from === 'TENANT' ? 'floors.fromGroup' : 'floors.fromNone', { floor: percent(company ?? null, locale), code: model.companyCode ?? '' })}
            </p>
            {editing ? (
              <form
                className="fw-qpd-dialog"
                aria-label={t('floors.title')}
                onSubmit={(event) => {
                  event.preventDefault()
                  if (!saveHeld) actions?.onSave?.()
                }}
              >
                <div className="fw-qpd-fields">
                  {floors.roles.map((role) => (
                    <Field key={role.key} label={role.name} hint={t('floors.fieldHint', { floor: percent(company ?? null, locale) })}>
                      <Input inputMode="decimal" value={model.edit![role.key] ?? ''} onChange={(event) => actions?.onDraft?.(role.key, event.target.value)} aria-label={t('floors.fieldOf', { role: role.name })} />
                    </Field>
                  ))}
                </div>
                {lowering && <Banner tone="warning" title={t('floors.lowers')} />}
                {model.problem && <Banner tone="danger" title={say(model.problem)} />}
                <div className="fw-qpd-actions">
                  <Button size="sm" type="button" onClick={() => actions?.onEdit?.(false)}>
                    {t('floors.discard')}
                  </Button>
                  <Button size="sm" type="submit" variant="primary" heldReason={saveHeld}>
                    {model.saving ? <Spinner size={12} /> : null} {t('floors.save')}
                  </Button>
                </div>
              </form>
            ) : (
              <SummaryTable
                label={t('floors.title')}
                columns={[t('floors.col.role'), t('floors.col.own'), t('floors.col.inForce')]}
                align={[undefined, 'right', 'right']}
                // B-W2b-382 (XF7:04): at phone width each role is a block, so the "Company floor 20.0%" tag stays on its card.
                stackOnPhone
                rows={floors.roles.map((role) => {
                  const own = row?.floors?.[role.key]
                  const force = inForce[role.key]
                  return {
                    id: role.key,
                    cells: [role.name, own !== undefined ? percent(own, locale) : '—', force !== undefined ? percent(force, locale) : <Tag key="c" tone="neutral">{t('floors.companyFloor', { floor: percent(company ?? null, locale) })}</Tag>],
                  }
                })}
              />
            )}
            {held && !editing && model.manage && <p className="fw-q-hint">{held}</p>}
          </>
        ) : null}
      </section>
      <StepUpModal
        open={model.stepUp.open}
        title={t('floors.stepUpTitle')}
        sentence={t('floors.stepUpSentence')}
        busy={model.stepUp.busy}
        error={model.stepUp.problem ? t(model.stepUp.problem) : null}
        onSubmit={(code) => actions?.onStepUpSubmit?.(code)}
        onClose={() => actions?.onStepUpCancel?.()}
        confirmLabel={t('floors.stepUpConfirm')}
      />
    </Card>
  )
}
