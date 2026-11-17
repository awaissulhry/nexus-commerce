'use client'

import { useEffect, useState } from 'react'
import { ExternalLink, Sparkles, UserCog } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, CheckboxCard, NumberStepper, RadioCard, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { Combobox, EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { PartnerPerson } from '../../../../admin/users/partners/api'
import { SUPERVISOR_NS } from '../../../../_shared/production-supervisor/model'
import {
  approverChoices,
  changeCount,
  LEVELS,
  limitsDraftOf,
  limitsHeld,
  limitsProblems,
  LIMITS_ANCHOR,
  openAsksOf,
  PRODUCTION_ASK_KINDS,
  productionPreviewHeld,
  seesNow,
  slotChoices,
  supervisorHeld,
  supervisorMove,
  URGENT_MAX,
  urgencyNote,
  withPreset,
  type LimitsActions,
  type LimitsDraft,
  type LimitsModel,
} from '../limits/model'
import { FreezeBlock, FreezeDialogView } from './LimitsFreeze'
import { heldWords, usePortalT } from './parts'

/**
 * F-PR-07 — the per-customer limits card on Customer › Portal access (06-tree §C, 09-design (g), 17-web-r2 §1.7): what the customer
 * sees (four levels, Status only by default), what it may do (Urgent orders with "At most n urgent at once" and the rule in words;
 * switched off, the marks kept but not used; the production asks), who answers on its side (anyone with the Production role, or one
 * named person, for PP, size set, TOP, fabric and trims), whether overrides need a second person, the freeze points (the company's
 * beside its own), and — OFFICE ONLY, never in the portal or the preview, drawn while the portal is off — who looks after it here:
 * the production supervisor and backup (their own route, production.brand.manage; a new one says before Apply how many orders move).
 * The preset "Production partner" fills the draft; "Open My production as …" previews the saved limits; Apply asks a fresh code.
 * Fetches nothing (the container is portal/limits/use-limits.ts).
 */
export function LimitsCard(props: { model: LimitsModel; partyName: string; portalOn: boolean; people: readonly PartnerPerson[]; can: { readonly preview: boolean }; previewing: boolean; actions?: LimitsActions }) {
  return (
    <WithMessages namespaces={[SUPERVISOR_NS]}>
      <LimitsBody {...props} />
    </WithMessages>
  )
}

function LimitsBody({ model, partyName, portalOn, people, can, previewing, actions }: { model: LimitsModel; partyName: string; portalOn: boolean; people: readonly PartnerPerson[]; can: { readonly preview: boolean }; previewing: boolean; actions?: LimitsActions }) {
  const t = usePortalT()
  if (model.state === 'error' || (!model.read && model.problem))
    return (
      <Card padded>
        <section id={LIMITS_ANCHOR} aria-labelledby="fw-pa-lim-title">
          <h2 id="fw-pa-lim-title" className="fw-pa-h2">
            {t('limits.title')}
          </h2>
          <EmptyState
            title={t('limits.readFailed')}
            description={model.problem ? t(model.problem) : undefined}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('common.retry')}
              </Button>
            }
          />
        </section>
      </Card>
    )
  if (!model.read)
    return (
      <Card padded>
        <div className="fw-pa-stack" aria-busy="true" aria-label={t('limits.loading')}>
          <Skeleton height={24} width="30%" />
          <Skeleton height={96} />
          <Skeleton height={160} />
        </div>
      </Card>
    )
  return <LimitsForm model={model} partyName={partyName} portalOn={portalOn} people={people} can={can} previewing={previewing} actions={actions} />
}

function LimitsForm({ model, partyName, portalOn, people, can, previewing, actions }: { model: LimitsModel; partyName: string; portalOn: boolean; people: readonly PartnerPerson[]; can: { readonly preview: boolean }; previewing: boolean; actions?: LimitsActions }) {
  const t = usePortalT()
  const ts = useT(SUPERVISOR_NS)
  const locale = useLocale()
  const read = model.read!
  const saved = read.production
  const [draft, setDraft] = useState<LimitsDraft>(model.draft ?? limitsDraftOf(saved))
  // A save (or someone else's change) moves the version: the card starts again from what is stored.
  useEffect(() => setDraft(model.draft ?? limitsDraftOf(saved)), [saved.version, read.party.id])
  // The preset stays named only while the draft still holds what it set (limits/model presetHolds).
  const set = (patch: Partial<LimitsDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const name = read.party.name || partyName
  const held = heldWords(t, limitsHeld(read))
  const supHeldReason = supervisorHeld(model.supervise, model.pick)
  const supHeld = supHeldReason ? (supHeldReason.ns === 'production-supervisor' ? ts(supHeldReason.key) : t(supHeldReason.key)) : null
  const count = changeCount(saved, draft)
  const problems = limitsProblems(draft)
  const dirty = count > 0
  const previewHeldReason = heldWords(t, productionPreviewHeld(can, dirty)) ?? (previewing ? t('preview.opening') : null)
  const note = urgencyNote(saved, draft)
  const move = supervisorMove(saved, draft, model.pick)
  const approvers = approverChoices(people, saved)
  const word = (words: { readonly it: string; readonly en: string } | null | undefined) => (words ? (locale === 'en' ? words.en : words.it) : null)
  const apply = () => {
    if (!dirty || Object.keys(problems).length > 0 || model.busy) return
    void actions?.onApply?.(draft)
  }
  const open = openAsksOf(draft)
  return (
    <Card padded>
      <section id={LIMITS_ANCHOR} className="fw-pa-lim" aria-labelledby="fw-pa-lim-title">
        <div className="fw-pa-head">
          <div className="fw-pa-head-text">
            <h2 id="fw-pa-lim-title" className="fw-pa-h2">
              {t('limits.title')}
            </h2>
            <p className="fw-pa-hint">{t('limits.intro', { name })}</p>
          </div>
          <div className="fw-pa-actions">
            <Button size="sm" heldReason={held} onClick={() => setDraft((current) => withPreset(current))} aria-describedby="fw-pa-lim-preset-hint">
              <Sparkles size={14} aria-hidden /> {t('limits.preset')}
            </Button>
            <Button size="sm" heldReason={previewHeldReason} onClick={() => actions?.onPreviewProduction?.()}>
              <ExternalLink size={14} aria-hidden /> {t('limits.previewOpen', { name })}
            </Button>
          </div>
        </div>
        <p id="fw-pa-lim-preset-hint" className="fw-pa-hint">
          {draft.preset ? t('limits.presetFilled') : t('limits.presetHint')}
        </p>
        <div className="fw-pa-stack">
          {!portalOn && <Banner tone="info" title={t('limits.portalOff')} />}
          {saved.productionRoleWords && <Banner tone="warning" title={word(saved.productionRoleWords)} />}
          {held && <p className="fw-pa-hint">{held}</p>}
          {model.saveProblem && (
            <Banner
              tone="danger"
              title={model.saveProblem.ns === 'production-supervisor' ? ts(model.saveProblem.key) : t(model.saveProblem.key)}
              action={
                <Button size="sm" variant="quiet" onClick={() => actions?.onDismissProblem?.()}>
                  {t('common.dismiss')}
                </Button>
              }
            >
              {model.saveProblem.limitsSaved ? t('limits.limitsSavedNotSupervisor') : null}
            </Banner>
          )}

          <fieldset className="fw-pa-fieldset">
            <legend className="fw-pa-legend">{t('limits.sees.title', { name })}</legend>
            <div className="fw-pa-lim-levels">
              {LEVELS.map((level) => (
                <RadioCard
                  key={level}
                  name="fw-pa-lim-level"
                  value={level}
                  checked={draft.level === level}
                  selected={draft.level === level}
                  disabled={held !== null}
                  onChange={() => set({ level })}
                  title={t(`limits.level.${level}`)}
                  description={t(`limits.levelLine.${level}`)}
                />
              ))}
            </div>
            <p className="fw-pa-lim-marks">
              <span className="fw-pa-hint">{t('limits.sees.always')}</span>
              {seesNow(draft.level).map((entry) => (
                <Tag key={entry.section} tone={entry.shared ? 'success' : 'neutral'}>
                  {t(entry.shared ? 'limits.sees.shown' : 'limits.sees.hidden', { what: t(`limits.section.${entry.section}`) })}
                </Tag>
              ))}
            </p>
          </fieldset>

          <div className="fw-pa-lim-two">
            <fieldset className="fw-pa-fieldset">
              <legend className="fw-pa-legend">{t('limits.mayDo.title', { name })}</legend>
              <div className="fw-pa-switch">
                <Toggle checked={draft.urgencyOn} onChange={(next) => set({ urgencyOn: next })} disabled={held !== null} aria-label={t('limits.urgency.label')} aria-describedby="fw-pa-lim-urgency-hint" />
                <div className="fw-pa-switch-text">
                  <span className="fw-pa-strong">{t('limits.urgency.label')}</span>
                  <span id="fw-pa-lim-urgency-hint" className="fw-pa-hint">
                    {draft.urgencyOn ? t('limits.urgency.rule') : t('limits.urgency.offHint')}
                  </span>
                </div>
              </div>
              {draft.urgencyOn && (
                <Field label={t('limits.urgency.max')} hint={t('limits.urgency.maxHint', { max: draft.urgentMax, now: saved.urgency.now })} error={problems.urgentMax ? t(problems.urgentMax) : undefined}>
                  <NumberStepper value={draft.urgentMax} min={URGENT_MAX.min} max={URGENT_MAX.max} disabled={held !== null} onChange={(next) => set({ urgentMax: next })} decrementLabel={t('limits.urgency.less')} incrementLabel={t('limits.urgency.more')} />
                </Field>
              )}
              {note && <Banner tone={draft.urgencyOn ? 'warning' : 'info'} title={word(note)} />}
              <div className="fw-pa-lim-asks" role="group" aria-label={t('limits.asks.title')}>
                <span className="fw-pa-strong">{t('limits.asks.title')}</span>
                {PRODUCTION_ASK_KINDS.map((kind) => {
                  const on = draft.askKinds.includes(kind)
                  return (
                    <CheckboxCard
                      key={kind}
                      variant="row"
                      checked={on}
                      selected={on}
                      disabled={held !== null}
                      onChange={(event) => set({ askKinds: event.target.checked ? [...draft.askKinds, kind] : draft.askKinds.filter((entry) => entry !== kind) })}
                      title={t(`limits.ask.${kind}`)}
                      description={t(`limits.askLine.${kind}`)}
                    />
                  )
                })}
                <p className="fw-pa-hint">{t('limits.asks.rules')}</p>
                <p className="fw-pa-hint">{open.length > 0 ? t('limits.asks.open', { list: open.map((kind) => t(`limits.ask.${kind}`)).join(', ') }) : t('limits.asks.openNone')}</p>
              </div>
            </fieldset>

            <div className="fw-pa-stack">
              <fieldset className="fw-pa-fieldset">
                <legend className="fw-pa-legend">{t('limits.approver.title')}</legend>
                {(['ANYONE', 'NAMED'] as const).map((mode) => (
                  <RadioCard
                    key={mode}
                    variant="row"
                    name="fw-pa-lim-approver"
                    value={mode}
                    checked={draft.approverMode === mode}
                    selected={draft.approverMode === mode}
                    disabled={held !== null || (mode === 'NAMED' && approvers.length === 0)}
                    onChange={() => set({ approverMode: mode, approverId: mode === 'NAMED' ? (draft.approverId ?? approvers.find((entry) => entry.active)?.value ?? null) : null })}
                    title={t(`limits.approver.${mode}`)}
                    description={t(`limits.approverLine.${mode}`)}
                  />
                ))}
                {draft.approverMode === 'NAMED' && (
                  <Field label={t('limits.approver.person')} error={problems.approver ? t(problems.approver) : undefined}>
                    {held === null ? (
                      <Combobox options={approvers.map((entry) => ({ value: entry.value, label: entry.active ? entry.label : `${entry.label} · ${t('limits.approver.inactive')}` }))} value={draft.approverId ?? ''} placeholder={t('limits.approver.search')} onChange={(value) => set({ approverId: value || null })} />
                    ) : (
                      <span>{saved.approver?.name ?? t('limits.approver.ANYONE')}</span>
                    )}
                  </Field>
                )}
                {saved.approver && !saved.approver.active && <Tag tone="warning">{t('limits.approver.inactiveSaved', { name: saved.approver.name })}</Tag>}
                {approvers.length === 0 && <p className="fw-pa-hint">{t('limits.approver.none')}</p>}
                <p className="fw-pa-hint">{t('limits.approver.covers')}</p>
              </fieldset>

              <fieldset className="fw-pa-fieldset">
                <legend className="fw-pa-legend">{t('limits.fourEyes.title')}</legend>
                <div className="fw-pa-switch">
                  <Toggle checked={draft.fourEyes} onChange={(next) => set({ fourEyes: next })} disabled={held !== null} aria-label={t('limits.fourEyes.label')} aria-describedby="fw-pa-lim-foureyes-hint" />
                  <div className="fw-pa-switch-text">
                    <span className="fw-pa-strong">{t('limits.fourEyes.label')}</span>
                    <span id="fw-pa-lim-foureyes-hint" className="fw-pa-hint">
                      {t(draft.fourEyes ? 'limits.fourEyes.onHint' : 'limits.fourEyes.offHint', { name })}
                    </span>
                  </div>
                </div>
              </fieldset>
            </div>
          </div>

          <FreezeBlock model={model} partyName={name} actions={actions} />

          <SupervisorBlock model={model} draft={draft} name={name} held={supHeld} move={move} onDraft={set} actions={actions} />
        </div>
        {dirty && (
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
      </section>
      <FreezeDialogView model={model} partyName={name} actions={actions} />
    </Card>
  )
}

/** Who looks after the customer here — office only (R-41, R-53): the supervisor and the backup, from the people who may take it. */
function SupervisorBlock({ model, draft, name, held, move, onDraft, actions }: { model: LimitsModel; draft: LimitsDraft; name: string; held: string | null; move: { key: string; count: number } | null; onDraft: (patch: Partial<LimitsDraft>) => void; actions?: LimitsActions }) {
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

