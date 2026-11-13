'use client'

import { useEffect, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Skeleton } from '@nexus/ui/primitives'
import { RuleBuilder, ruleHeldReason } from '@nexus/ui/patterns/RuleBuilder/index'
import { Modal, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import type { ConditionBody } from '../api'
import { fieldsOf, MEANINGS, NAMESPACE, said, saveHeld, type ApprovalRulesModel, type RuleDraft } from '../model'
import { startDraft } from '../new-kind/new-kind'

export interface ApprovalRuleDialogActions {
  /** Save the pop-up's draft (a new rule is written OFF); resolves true when saved. */
  onSaveRule?: (draft: RuleDraft) => Promise<boolean>
  /** Test the draft against the kind's latest records. */
  onTestRule?: (draft: { kind: string; companyId: string | null; condition: ConditionBody; approver?: { roleId: string } | { userId: string } }) => void
  onRetryKinds?: () => void
}

/**
 * The approval rule pop-up (B-W2b-307; design admin.automation pop:rule, PLT-086, PLT-105): "When [Purchase order] has
 * [order value] [over] [5,000] … ask [Finance], signed [Approved] with a fresh code" — the kind (new rules only; it never
 * changes after), the company, RuleBuilder over the kind's facts (a money fact without its grain is listed, held), the
 * approver (an office role that decides approvals; a person the rule names stays as it is), the signature meaning and its
 * code, the order among rules of the kind, the time to decide. Test: "Would have asked for 4 of the last 50 …" with links
 * and who would approve. Save (⌘S) — a new rule is written OFF; the list's switch turns it on. Esc closes.
 */
export function ApprovalRuleDialog({ model, actions, onClose }: { model: ApprovalRulesModel; actions?: ApprovalRuleDialogActions; onClose: () => void }) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const ds = useDsWords()
  const dialog = model.dialog!
  const rule = dialog.rule
  // B-W2b-382 (XF7:06): a new rule starts with the kind its page opened it for.
  const [draft, setDraft] = useState<RuleDraft>(() => startDraft(dialog, model.companies))
  useEffect(() => {
    if (dialog.draft) setDraft(dialog.draft)
  }, [dialog.draft])
  const kinds = model.kinds.status === 'ready' ? model.kinds.data.kinds : []
  const kind = kinds.find((entry) => entry.kind === draft.kind) ?? null
  const fields = fieldsOf(kind, locale, t('rules.held.money'))
  const builderHeld = draft.condition.rows.length > 0 ? ruleHeldReason(draft.condition, fields, ds.ruleBuilder) : null
  const readOnly = !model.manage || (rule !== null && !rule.canChange)
  const held = saveHeld(draft, { manage: model.manage, offline: model.offline, busy: model.busy, rule, builderHeld })
  const roles = model.roles.status === 'ready' ? model.roles.data : []
  const meanings = model.kinds.status === 'ready' ? model.kinds.data.meanings : []
  const test = dialog.test
  const set = (next: Partial<RuleDraft>) => setDraft((current) => ({ ...current, ...next }))

  const save = () => {
    if (held) return
    void actions?.onSaveRule?.(draft).then((done) => done && onClose())
  }
  const runTest = () => {
    if (!draft.kind || builderHeld || model.offline) return
    actions?.onTestRule?.({
      kind: draft.kind,
      companyId: draft.companyId,
      condition: { combinator: draft.condition.combinator, rows: draft.condition.rows.filter((row) => row.field && row.operator).map((row) => ({ id: row.id, field: row.field!, operator: row.operator!, value: row.value === null ? null : typeof row.value === 'string' ? row.value : [...row.value] })) },
      ...(draft.approver ? { approver: draft.approver.kind === 'ROLE' ? { roleId: draft.approver.id } : { userId: draft.approver.id } } : {}),
    })
  }
  const testHeld = !draft.kind ? t('rules.held.kind') : builderHeld ? t('rules.held.condition') : model.offline ? t('rules.held.offline') : test?.status === 'loading' ? t('inbox.held.busy') : null
  const kindWord = kind ? said(kind.label, locale) : t('rules.aRequest')

  return (
    <Modal
      open
      onClose={onClose}
      title={rule ? t('rules.dialog.title', { kind: said(rule.kindLabel, locale) }) : t('rules.dialog.new')}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>{t('back')}</Button>
          {!readOnly && (
            <Button variant="primary" heldReason={held ? t(held) : null} onClick={save} aria-keyshortcuts="Meta+S">
              {t(rule ? 'rules.dialog.save' : 'rules.dialog.create')}
            </Button>
          )}
        </>
      }
    >
      <div
        className="fw-apr-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault()
            save()
          }
        }}
      >
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        {rule && !rule.canChange && <Banner tone="warning" title={t(rule.heldReason ? 'rules.held.money' : 'rules.held.cannotChange')} />}
        {!rule && <Banner tone="info" title={t('rules.dialog.writtenOff')} />}
        {model.kinds.status === 'loading' ? (
          <Skeleton height={120} />
        ) : model.kinds.status === 'error' ? (
          <Banner tone="danger" title={t('rules.kindsError')} action={<Button size="sm" onClick={() => actions?.onRetryKinds?.()}>{t('retry')}</Button>} />
        ) : (
          <>
            <div className="fw-apr-grid">
              <Field label={t('rules.dialog.kind')} required hint={rule ? t('rules.dialog.kindFixed') : undefined}>
                <Select value={draft.kind ?? ''} disabled={rule !== null || readOnly} onChange={(event) => set({ kind: event.target.value || null, condition: { combinator: 'and', rows: [] } })} aria-label={t('rules.dialog.kind')}>
                  <option value="">{t('rules.dialog.pickKind')}</option>
                  {kinds.map((entry) => (
                    <option key={entry.kind} value={entry.kind}>
                      {said(entry.label, locale)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('rules.dialog.company')} hint={rule ? t('rules.dialog.kindFixed') : t('rules.dialog.companyHint')}>
                <Select value={draft.companyId ?? ''} disabled={rule !== null || readOnly} onChange={(event) => set({ companyId: event.target.value || null })} aria-label={t('rules.dialog.company')}>
                  <option value="">{t('rules.everyCompany')}</option>
                  {model.companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('rules.dialog.name')} required>
                <Input value={draft.name} maxLength={120} readOnly={readOnly} onChange={(event) => set({ name: event.target.value })} placeholder={t('rules.dialog.namePlaceholder')} />
              </Field>
            </div>
            {draft.kind && (
              <RuleBuilder
                label={t('rules.dialog.when', { kind: kindWord.toLocaleLowerCase(locale) })}
                fields={fields}
                value={draft.condition}
                onChange={readOnly ? undefined : (condition) => set({ condition })}
                readOnly={readOnly}
                lead={t('rules.dialog.lead', { kind: kindWord.toLocaleLowerCase(locale) })}
                outcome={draft.approver ? t('rules.dialog.outcome', { approver: draft.approver.name ?? roles.find((role) => role.id === draft.approver!.id)?.name ?? '' }) : null}
                locale={locale === 'it' ? 'it-IT' : 'en-GB'}
                labels={ds.ruleBuilder}
              />
            )}
            {draft.kind && draft.condition.rows.length === 0 && <p className="fw-apr-muted">{t('rules.dialog.everyRequest')}</p>}
            <div className="fw-apr-grid">
              <Field label={t('rules.dialog.approver')} required hint={draft.approver?.kind === 'PERSON' ? t('rules.dialog.personKept') : t('rules.dialog.approverHint')}>
                {draft.approver?.kind === 'PERSON' ? (
                  <Input value={draft.approver.name ?? ''} readOnly />
                ) : (
                  <Select value={draft.approver?.id ?? ''} disabled={readOnly || model.roles.status !== 'ready'} onChange={(event) => set({ approver: event.target.value ? { kind: 'ROLE', id: event.target.value, name: roles.find((role) => role.id === event.target.value)?.name } : null })} aria-label={t('rules.dialog.approver')}>
                    <option value="">{model.roles.status === 'loading' ? t('rules.dialog.reading') : model.roles.status === 'error' ? t('rules.dialog.rolesError') : t('rules.dialog.pickRole')}</option>
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('rules.dialog.meaning')} hint={t('rules.dialog.meaningHint')}>
                <Select value={draft.meaning ?? ''} disabled={readOnly} onChange={(event) => set({ meaning: (event.target.value || null) as RuleDraft['meaning'], stepUp: event.target.value ? draft.stepUp : false })} aria-label={t('rules.dialog.meaning')}>
                  <option value="">{t('rules.dialog.noMeaning')}</option>
                  {(meanings.length > 0 ? meanings.map((entry) => entry.meaning) : MEANINGS).map((meaning) => (
                    <option key={meaning} value={meaning}>
                      {t(`meaning.${meaning}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('rules.dialog.sequence')} hint={t('rules.dialog.sequenceHint')}>
                <Input inputMode="numeric" value={draft.sequence} readOnly={readOnly} onChange={(event) => set({ sequence: event.target.value })} />
              </Field>
              <Field label={t('rules.dialog.dueHours')} hint={t('rules.dialog.dueHoursHint')}>
                <Input inputMode="numeric" value={draft.dueHours} readOnly={readOnly} onChange={(event) => set({ dueHours: event.target.value })} placeholder={t('rules.dialog.noDue')} />
              </Field>
            </div>
            <Checkbox label={t('rules.dialog.stepUp')} checked={draft.meaning !== null && draft.stepUp} disabled={readOnly || draft.meaning === null} title={draft.meaning === null ? t('rules.dialog.stepUpHeld') : undefined} onChange={(event) => set({ stepUp: event.target.checked })} />
            <p className="fw-apr-muted">{t('rules.dialog.delegationLater')}</p>
            <section className="fw-apr-test" aria-labelledby="fw-apr-test">
              <div className="fw-apr-band">
                <h3 id="fw-apr-test" className="fw-apr-h">
                  {t('rules.test.title')}
                </h3>
                <Button size="sm" heldReason={testHeld} onClick={runTest}>
                  <FlaskConical size={13} aria-hidden /> {t('rules.test.run')}
                </Button>
              </div>
              {test === null ? (
                <p className="fw-apr-muted">{t('rules.test.body')}</p>
              ) : test.status === 'loading' ? (
                <Skeleton height={40} />
              ) : test.status === 'error' ? (
                <Banner tone="danger" title={t(test.problem)} />
              ) : (
                <div className="fw-apr-cell">
                  <b>{t('rules.test.result', { asked: test.data.wouldAsk, tested: test.data.tested, kind: kindWord.toLocaleLowerCase(locale) })}</b>
                  {test.data.samples.length > 0 && (
                    <ul className="fw-apr-list">
                      {test.data.samples.map((sample) => (
                        <li key={sample.record.id}>
                          <a className="fw-apr-link" href={`${model.prefix}${recordAddress({ type: sample.record.type, id: sample.record.id, label: sample.record.label, companyId: sample.companyId, siteId: null }, OFFICE_PAGES)}`}>
                            {sample.record.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  <span className="fw-apr-sub">{test.data.approvers.length > 0 ? t('rules.test.approvers', { names: test.data.approvers.slice(0, 5).map((person) => person.name).join(', ') }) : t('rules.test.noApprovers')}</span>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </Modal>
  )
}
