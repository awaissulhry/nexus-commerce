'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Radio, Select } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { PartyFile, Requirement, Requirements, StyleOption } from '../api'
import { endReasonProblem, KINDS, requirementProblems, STAGES, type DepthCan, type Read, type RequirementDialog, type RequirementDraft } from '../model'
import { useSay } from './parts'
import { MultiSelect } from '../../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/**
 * Customer › Requirements (B-W2b-324; SAL-014; design sales.customers record customer.requirements, customer.req.rules): the
 * windows of a requirement — Add (a Modal), Replace (the old one ended and the new one written in one step) and End with a
 * reason. F-CT-503 (ct-w2 W2.1): the card went — the Terms tab's Requirements section draws the rules (record/view/terms). Fetches
 * nothing.
 */

export interface RequirementsModel {
  readonly read: Read<Requirements>
  readonly can: DepthCan
  readonly status: string
  readonly dialog: RequirementDialog | null
  readonly styles: Read<readonly StyleOption[]> | null
  readonly files: Read<readonly PartyFile[]> | null
  readonly companies: readonly { readonly id: string; readonly name: string }[]
  /** F-CT-503: what the style search asks the server (the provider's state; one search per typed pause). */
  readonly styleQuery?: string | undefined
}

export interface RequirementsActions {
  onAdd?: () => void
  onReplace?: (row: Requirement) => void
  onEnd?: (row: Requirement) => void
  onDraft?: (dialog: RequirementDialog) => void
  onConfirm?: () => void
  onClose?: () => void
  onRetry?: () => void
  /** F-CT-503: a style search typed (the provider searches after a pause). */
  onStyleSearch?: (q: string) => void
}

/**
 * F-CT-503 (customer Terms & requirements, ct-w2 W2.1; 13-backend §3): EXPORTED — the Requirements section of the Terms tab opens these
 * windows in place (Add requirement · Replace with a new version… · End…), the depth provider's ONE state. Inside, the style picker
 * searches on the server (our own styles and THIS customer's, S1) and the words say where a rule really shows (Z12).
 */
export function RequirementWindows({ model, actions }: { model: RequirementsModel; actions?: RequirementsActions | undefined }) {
  const { t, say } = useSay()
  const ct = useT('customer-terms') // F-CT-503: the tab's new words
  const dialog = model.dialog
  if (!dialog) return null
  if (dialog.kind === 'end') {
    const problem = dialog.tried ? endReasonProblem(dialog.reason) : null
    return (
      <Modal
        open
        onClose={() => actions?.onClose?.()}
        title={t('req.endTitle', { kind: t(`kind.${dialog.target.kind}`) })}
        footer={
          <>
            <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
            <Button variant="primary" onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('dialog.saving') : problem ? say(problem) : null}>
              {t('req.endConfirm')}
            </Button>
          </>
        }
      >
        <div className="fw-cdp-stack">
          <p>{dialog.target.words}</p>
          <Field label={t('req.endReason')} required hint={t('req.endReasonHint')} error={problem ? say(problem) : undefined}>
            <Textarea rows={2} value={dialog.reason} onChange={(event) => actions?.onDraft?.({ ...dialog, reason: event.target.value })} />
          </Field>
          {dialog.failed ? <Banner tone="danger" title={t(dialog.failed)} /> : null}
        </div>
      </Modal>
    )
  }
  const draft = dialog.draft
  const problems = dialog.tried ? requirementProblems(draft) : {}
  const count = Object.keys(requirementProblems(draft)).length
  const set = (next: Partial<RequirementDraft>) => actions?.onDraft?.({ ...dialog, draft: { ...draft, ...next } })
  const styles = model.styles?.status === 'ready' ? model.styles.value : []
  const styleOptions = [...draft.styles.filter((style) => !styles.some((option) => option.id === style.id)).map((style) => ({ id: style.id, code: style.code, name: '' })), ...styles]
  // F-CT-503 (Z36): a style saved before the wall that is not ours or this customer's has no code here: it is never named.
  const styleLabel = (style: { readonly code: string; readonly name: string }) => (style.code === '' ? ct('ct.req.styleGone') : style.name ? `${style.code} · ${style.name}` : style.code)
  const files = model.files?.status === 'ready' ? model.files.value : []
  const stylesHeld = !model.can.styles ? t('held.styles') : model.styles?.status === 'error' ? t('req.stylesFailed') : null
  return (
    <Modal
      open
      size="lg"
      onClose={() => actions?.onClose?.()}
      title={dialog.kind === 'add' ? t('req.addTitle') : t('req.replaceTitle', { kind: t(`kind.${dialog.target!.kind}`) })}
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{t('dialog.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onConfirm?.()} heldReason={dialog.busy ? t('dialog.saving') : dialog.tried && count > 0 ? t('dialog.fixFirst', { count }) : null}>
            {dialog.kind === 'add' ? t('req.addConfirm') : t('req.replaceConfirm')}
          </Button>
        </>
      }
    >
      <div className="fw-cdp-stack">
        {dialog.kind === 'replace' && <Banner tone="info" title={t('req.replaceNote')} />}
        <div className="fw-cdp-two">
          <Field label={t('req.field.company')} hint={t('req.field.companyHint')}>
            <Select value={draft.companyId ?? ''} onChange={(event) => set({ companyId: event.target.value === '' ? null : event.target.value })}>
              {model.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
              <option value="">{t('hold.everyCompany')}</option>
            </Select>
          </Field>
          <Field label={t('req.field.kind')} required>
            <Select value={draft.kind} onChange={(event) => set({ kind: event.target.value as RequirementDraft['kind'] })}>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('req.field.rule')} required hint={t('req.field.ruleHint')} error={problems.words ? say(problems.words) : undefined}>
          <Textarea rows={3} value={draft.words} onChange={(event) => set({ words: event.target.value })} />
        </Field>
        <fieldset className="fw-cdp-fieldset">
          <legend className="fw-cdp-subtitle">{t('req.field.shownOn')}</legend>
          <div className="fw-cdp-checks">
            {STAGES.map((stage) => (
              <Checkbox
                key={stage}
                label={t(`stage.${stage}`)}
                checked={draft.appliesAt.includes(stage)}
                onChange={(event) => set({ appliesAt: event.target.checked ? [...draft.appliesAt, stage] : draft.appliesAt.filter((one) => one !== stage) })}
              />
            ))}
          </div>
          {problems.appliesAt ? <p className="fw-cdp-error">{say(problems.appliesAt)}</p> : <p className="fw-cdp-hint">{t('req.field.shownOnHint')}</p>}
        </fieldset>
        <fieldset className="fw-cdp-fieldset">
          <legend className="fw-cdp-subtitle">{t('req.field.appliesTo')}</legend>
          <div className="fw-cdp-checks">
            <Radio name="req-applies" label={t('req.allOrders')} checked={draft.everyStyle} onChange={() => set({ everyStyle: true })} />
            <Radio name="req-applies" label={t('req.someStyles')} checked={!draft.everyStyle} disabled={stylesHeld !== null && draft.styles.length === 0} onChange={() => set({ everyStyle: false })} />
          </div>
          {stylesHeld && draft.styles.length === 0 ? <p className="fw-cdp-hint">{stylesHeld}</p> : null}
          {!draft.everyStyle && (
            <>
              {/* F-CT-503 (S1): the search goes to the server — this customer's styles and our own only; the DS MultiSelect lists its answer. */}
              <Field label={ct('ct.req.searchStyles')} hint={ct('ct.req.searchStylesHint')}>
                <Input type="search" value={model.styleQuery ?? ''} autoComplete="off" placeholder={t('req.field.stylesSearch')} onChange={(event) => actions?.onStyleSearch?.(event.target.value)} />
              </Field>
              <Field label={t('req.field.styles')} error={problems.styles ? say(problems.styles) : undefined}>
                <MultiSelect
                  ariaLabel={t('req.field.styles')}
                  placeholder={model.styles?.status === 'loading' ? t('read.loading') : t('req.field.stylesPick')}
                  options={styleOptions.map((style) => ({ value: style.id, label: styleLabel(style) }))}
                  value={draft.styles.map((style) => style.id)}
                  onChange={(next) => set({ styles: next.map((id) => ({ id, code: styleOptions.find((style) => style.id === id)?.code ?? '' })) })}
                  width="auto"
                />
              </Field>
            </>
          )}
        </fieldset>
        <Field label={t('req.field.attachment')} hint={model.can.files ? t('req.field.attachmentHint') : t('held.files')}>
          <Select value={draft.fileId ?? ''} disabled={!model.can.files} onChange={(event) => set({ fileId: event.target.value === '' ? null : event.target.value })}>
            <option value="">{t('req.field.noAttachment')}</option>
            {files.map((file) => (
              <option key={file.id} value={file.id}>
                {file.name}
              </option>
            ))}
          </Select>
        </Field>
        {dialog.kind === 'replace' && (
          <Field label={t('req.field.reason')} hint={t('req.field.reasonHint')} error={problems.reason ? say(problems.reason) : undefined}>
            <Textarea rows={2} value={draft.reason} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        )}
        {dialog.failed ? <Banner tone="danger" title={t(dialog.failed)} /> : null}
      </div>
    </Modal>
  )
}
