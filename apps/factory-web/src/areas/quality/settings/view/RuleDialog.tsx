'use client'

import { useEffect } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Kbd, RadioCard, Select, Toggle } from '@nexus/ui/primitives'
import { EVENT_FACTS } from '@nexus/factory-domain/quality/rules/alerts'
import type { Loosening } from '@nexus/factory-domain/quality/rules/duties'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { draftSentence, EVENTS, reasonHeld, ruleProblems, withEvent, type WaitUnit } from '../model'
import type { RulesActions, RulesModel } from './RulesView'

/** ⌘↵ inside a dialog runs its primary while it is not held. */
function useSubmitKey(open: boolean, held: boolean, run: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        run()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

/**
 * The alert rule (design qs-alerts "Add rule (when, who, channel: in-app / e-mail)"): what it watches and whose it is
 * (both fixed once added), who it tells (the record's owner, a role, both — a certificate names nobody), how fast (at once,
 * after a wait, or days before the date), the e-mail beside the bell, on or off, and the rule as one sentence as it is typed.
 * Problems at their fields (factory-domain's checks); Save held with the first one. A reader sees the same, read only.
 */
export function RuleDialog({ model, actions }: { model: RulesModel; actions?: RulesActions }) {
  const t = useT('quality-rules')
  const locale = useLocale()
  const dialog = model.ruleDialog
  const alerts = model.alerts.value
  const draft = dialog?.draft ?? null
  const problems = draft ? ruleProblems(draft) : {}
  const mayManage = !!alerts?.mayManage && model.live !== 'offline'
  const firstProblem = Object.values(problems)[0] ?? null
  const held = !mayManage ? (alerts ? (model.live === 'offline' ? 'held.offline' : 'held.noAlertRight') : 'held.reading') : model.busy === 'alerts' ? 'held.busy' : firstProblem
  useSubmitKey(!!dialog, !!held, () => actions?.onRuleSave?.())
  if (!dialog || !draft || !alerts) return null
  const editing = draft.id !== null
  const facts = EVENT_FACTS[draft.event]
  const set = (patch: Partial<typeof draft>) => actions?.onRuleDraft?.({ ...draft, ...patch })
  const shown = dialog.shown
  const at = (field: string) => (shown && problems[field] ? t(problems[field]!) : undefined)
  const companies = alerts.places.companies
  const defaultRole = alerts.roles.find((role) => role.key === 'quality_inspector')?.id ?? alerts.roles[0]?.id ?? null
  return (
    <Modal
      open
      onClose={() => actions?.onRuleClose?.()}
      size="lg"
      title={editing ? t('ruleDialog.titleEdit') : t('ruleDialog.titleNew')}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={() => actions?.onRuleClose?.()}>
            {mayManage ? t('common.cancel') : t('common.close')}
          </Button>
          {mayManage && (
            <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onRuleSave?.()}>
              {editing ? t('ruleDialog.save') : t('ruleDialog.add')} <Kbd>⌘↵</Kbd>
            </Button>
          )}
        </span>
      }
    >
      <div className="fw-qr-stack">
        <fieldset className="fw-qr-dialog-grid" disabled={!mayManage}>
          <Field label={t('ruleDialog.event')} hint={editing ? t('ruleDialog.fixed') : undefined}>
            <Select size="sm" value={draft.event} disabled={editing} onChange={(event) => actions?.onRuleDraft?.(withEvent(draft, event.target.value as typeof draft.event, defaultRole))}>
              {EVENTS.map((event) => (
                <option key={event} value={event}>
                  {t(`event.${event}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('ruleDialog.where')} hint={editing ? t('ruleDialog.fixed') : undefined} error={at('companyId')}>
            <Select size="sm" value={draft.companyId ?? ''} disabled={editing} onChange={(event) => set({ companyId: event.target.value || null })}>
              {(alerts.places.everywhere || draft.companyId === null) && <option value="">{t('alerts.everyCompany')}</option>}
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.code} · {company.name}
                </option>
              ))}
            </Select>
          </Field>
        </fieldset>
        <fieldset className="fw-qr-choices" disabled={!mayManage}>
          <legend className="fw-qr-question">{t('ruleDialog.who')}</legend>
          {facts.owner !== null && (
            <RadioCard name="qr-audience" checked={draft.audience === 'OWNER'} selected={draft.audience === 'OWNER'} onChange={() => set({ audience: 'OWNER', roleId: null })} title={t('ruleDialog.owner', { owner: locale === 'it' ? facts.owner.it : facts.owner.en })} />
          )}
          <RadioCard name="qr-audience" checked={draft.audience === 'ROLE'} selected={draft.audience === 'ROLE'} onChange={() => set({ audience: 'ROLE', roleId: draft.roleId ?? defaultRole })} title={t('ruleDialog.role')} />
          {facts.owner !== null && (
            <RadioCard name="qr-audience" checked={draft.audience === 'OWNER_AND_ROLE'} selected={draft.audience === 'OWNER_AND_ROLE'} onChange={() => set({ audience: 'OWNER_AND_ROLE', roleId: draft.roleId ?? defaultRole })} title={t('ruleDialog.both')} />
          )}
          {facts.owner === null && <p className="fw-qr-hint">{t('ruleDialog.nobodyNamed')}</p>}
          {at('audience') && <p className="fw-qr-problem">{at('audience')}</p>}
        </fieldset>
        {draft.audience !== 'OWNER' && (
          <Field label={t('ruleDialog.roleLabel')} error={at('roleId')}>
            <Select size="sm" value={draft.roleId ?? ''} disabled={!mayManage} onChange={(event) => set({ roleId: event.target.value || null })}>
              <option value="">{t('ruleDialog.pickRole')}</option>
              {alerts.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {facts.timing === 'DAYS' ? (
          <Field label={t('ruleDialog.days')} hint={t('ruleDialog.daysHint')} error={at('days')}>
            <Input size="sm" value={draft.days} disabled={!mayManage} onChange={(event) => set({ days: event.target.value })} inputMode="numeric" />
          </Field>
        ) : (
          <Field label={t(facts.timing === 'EVENT' ? 'ruleDialog.waitEvent' : facts.timing === 'ESCALATION' ? 'ruleDialog.waitCapa' : 'ruleDialog.wait')} hint={t(facts.timing === 'EVENT' ? 'ruleDialog.waitEventHint' : 'ruleDialog.waitHint')} error={at('wait')}>
            <div className="fw-qr-row">
              <Input size="sm" className="fw-qr-wait" value={draft.wait} disabled={!mayManage} inputMode="numeric" aria-label={t('ruleDialog.waitNumber')} onChange={(event) => set({ wait: event.target.value })} />
              <Select size="sm" value={draft.unit} disabled={!mayManage} aria-label={t('ruleDialog.waitUnit')} onChange={(event) => set({ unit: event.target.value as WaitUnit })}>
                {(['minutes', 'hours', 'days'] as const).map((unit) => (
                  <option key={unit} value={unit}>
                    {t(`unit.${unit}`)}
                  </option>
                ))}
              </Select>
            </div>
          </Field>
        )}
        <div className="fw-qr-row">
          <Checkbox label={t('ruleDialog.bell')} checked disabled title={t('ruleDialog.bellAlways')} />
          <Checkbox label={t('ruleDialog.email')} checked={draft.email} disabled={!mayManage || facts.timing === 'ESCALATION'} onChange={(event) => set({ email: event.target.checked })} />
          <span className="fw-qr-row">
            <Toggle size="sm" checked={draft.enabled} disabled={!mayManage} aria-label={t('ruleDialog.enabled')} onChange={(next) => set({ enabled: next })} />
            <span>{t(draft.enabled ? 'alerts.on' : 'alerts.off')}</span>
          </span>
        </div>
        <p className="fw-qr-hint">{t(facts.timing === 'ESCALATION' ? 'ruleDialog.capaHow' : 'ruleDialog.emailHow')}</p>
        <Banner tone="info" title={t('ruleDialog.sentence')}>
          {draftSentence(draft, alerts.roles, locale)}
        </Banner>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
      </div>
    </Modal>
  )
}

/**
 * Confirm a looser rule (design qs-loosen: "ActionConfirm in words + StepUpModal code"): each loosening said from now on,
 * the reason (kept on the audit row), then Apply asks the fresh code. Composed with the DS Modal (the DS ActionConfirm
 * reviews a bulk change's impact list, which a rule's change does not have).
 */
export function LoosenDialog({ open, codes, removed, reason, busy, onReason, onConfirm, onClose }: { open: boolean; codes: readonly Loosening[]; removed: number; reason: string; busy: boolean; onReason: (reason: string) => void; onConfirm: () => void; onClose: () => void }) {
  const t = useT('quality-rules')
  const held = busy ? 'held.busy' : reasonHeld(reason)
  useSubmitKey(open, !!held, onConfirm)
  if (!open) return null
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('loosen.title')}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={onConfirm}>
            {t('loosen.apply')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-qr-stack">
        <ul className="fw-qr-lines is-strong">
          {codes.map((code) => (
            <li key={code}>{t(`loosen.code.${code}`, { count: removed })}</li>
          ))}
        </ul>
        <Field label={t('loosen.reason')} hint={t('loosen.reasonHint')} required>
          <Textarea rows={3} value={reason} autoFocus onChange={(event) => onReason(event.target.value)} />
        </Field>
        <p className="fw-qr-hint">{t('loosen.codeHint')}</p>
      </div>
    </Modal>
  )
}

export function RemoveDialog({ open, count, busy, onConfirm, onClose }: { open: boolean; count: number; busy: boolean; onConfirm: () => void; onClose: () => void }) {
  const t = useT('quality-rules')
  if (!open) return null
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={t('remove.title', { count })}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" heldReason={busy ? t('held.busy') : null} onClick={onConfirm}>
            {t('remove.confirm', { count })}
          </Button>
        </span>
      }
    >
      <p>{t('remove.body', { count })}</p>
    </Modal>
  )
}

export function KeysDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT('quality-rules')
  if (!open) return null
  const keys: [string, string][] = [
    ['⌘S', t('keys.save')],
    ['c', t('keys.add')],
    ['⌘↵', t('keys.dialog')],
    ['Esc', t('keys.close')],
  ]
  return (
    <Modal open onClose={onClose} size="sm" title={t('keys.title')}>
      <dl className="fw-qr-keys">
        {keys.map(([key, does]) => (
          <div key={key}>
            <dt>
              <Kbd>{key}</Kbd>
            </dt>
            <dd>{does}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
