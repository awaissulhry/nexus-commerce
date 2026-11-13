'use client'

import { MoreHorizontal, Plus } from 'lucide-react'
import { Banner, EmptyState, Field, Menu, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Radio, Select, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea, Timeline } from '../../../../../lib/i18n/ds-parts'
import type { PartyFile, Requirement, Requirements, StyleOption } from '../api'
import { endReasonProblem, KINDS, requirementProblems, shownOnKeys, STAGES, valueOf, writeHeld, type DepthCan, type Read, type RequirementDialog, type RequirementDraft } from '../model'
import { DepthCard, ReadOr, useSay } from './parts'
import { MultiSelect } from '../../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

/**
 * Customer › Requirements (B-W2b-324; SAL-014; design sales.customers record customer.requirements, customer.req.rules):
 * the rules in force (packing, labelling, documents, the routing guide), each with what it applies to (all orders or some
 * styles), where people will see it (the quote, the order, the pick & pack screen, the shipping checklist, the invoice) and
 * its attachment; Add rule (a Modal), Replace (the old one ended and the new one written in one step) and End with a
 * reason; the ended rules below, with who ended them and why. Fetches nothing.
 */

export interface RequirementsModel {
  readonly read: Read<Requirements>
  readonly can: DepthCan
  readonly status: string
  readonly dialog: RequirementDialog | null
  readonly styles: Read<readonly StyleOption[]> | null
  readonly files: Read<readonly PartyFile[]> | null
  readonly companies: readonly { readonly id: string; readonly name: string }[]
}

export interface RequirementsActions {
  onAdd?: () => void
  onReplace?: (row: Requirement) => void
  onEnd?: (row: Requirement) => void
  onDraft?: (dialog: RequirementDialog) => void
  onConfirm?: () => void
  onClose?: () => void
  onRetry?: () => void
}

export function RequirementsTab({ model, actions }: { model: RequirementsModel; actions?: RequirementsActions }) {
  const { t, day, when } = useSay()
  const read = valueOf(model.read)
  const held = writeHeld(model.can, 'manage', model.status)
  const add = (
    <Button size="sm" variant="primary" onClick={() => actions?.onAdd?.()} heldReason={held ? t(held) : null}>
      <Plus size={14} aria-hidden /> {t('req.add')}
    </Button>
  )
  return (
    <div className="fw-cdp-stack">
      <DepthCard title={t('req.title')} hint={t('req.hint')} action={add}>
        <ReadOr status={model.read.status} problem={model.read.status === 'error' ? model.read.problem : undefined} title={t('req.title')} onRetry={actions?.onRetry} rows={4}>
          {read && read.inForce.length === 0 ? (
            <EmptyState title={t('req.empty')} description={t('req.emptyBody')} action={add} />
          ) : read ? (
            <SummaryTable
              label={t('req.title')}
              stackOnPhone
              density="roomy"
              columns={[t('req.col.rule'), t('req.col.appliesTo'), t('req.col.shownOn'), t('req.col.attachment'), t('req.col.written'), '']}
              widths={['32%', '15%', '18%', '13%', '15%', '7%']}
              rows={read.inForce.map((row) => ({
                id: row.id,
                cells: [
                  <span key="r" className="fw-cdp-cell">
                    <span className="fw-cdp-tags">
                      <Tag>{t(`kind.${row.kind}`)}</Tag>
                      <span className="fw-cdp-hint">{row.companyCode ?? t('hold.everyCompany')}</span>
                    </span>
                    <span>{row.words}</span>
                  </span>,
                  row.everyStyle ? t('req.allOrders') : row.styles.map((style) => style.code).join(', '),
                  shownOnKeys(row.appliesAt)
                    .map((key) => t(key))
                    .join(' · '),
                  row.file ? row.file.fileName : '—',
                  <span key="w" className="fw-cdp-hint">
                    {row.createdBy ? t('req.writtenBy', { by: row.createdBy, date: day(row.createdAt) }) : day(row.createdAt)}
                  </span>,
                  <Menu
                    key="m"
                    align="right"
                    label={<MoreHorizontal size={16} aria-hidden />}
                    triggerProps={{ 'aria-label': t('req.menu', { kind: t(`kind.${row.kind}`) }) }}
                    items={[
                      { id: 'replace', label: t('req.replace'), onSelect: () => actions?.onReplace?.(row), disabled: held !== null, description: held ? t(held) : t('req.replaceHint') },
                      { id: 'end', label: t('req.end'), onSelect: () => actions?.onEnd?.(row), disabled: held !== null, description: held ? t(held) : undefined },
                    ]}
                  />,
                ],
              }))}
            />
          ) : null}
        </ReadOr>
      </DepthCard>
      {read && (
        <DepthCard title={t('req.history')} hint={t('req.historyHint')}>
          {read.ended.length === 0 ? (
            <p className="fw-cdp-hint">{t('req.noHistory')}</p>
          ) : (
            <Timeline
              label={t('req.history')}
              steps={read.ended.map((row) => ({
                key: row.id,
                tone: 'neutral',
                at: row.endedAt,
                label: t('req.endedLine', { kind: t(`kind.${row.kind}`), by: row.endedBy ?? t('hold.system') }),
                detail: `${row.words} · ${row.endReason ?? ''}${row.endedAt ? ` · ${when(row.endedAt)}` : ''}`,
              }))}
            />
          )}
        </DepthCard>
      )}
      <RequirementDialogView model={model} actions={actions} />
    </div>
  )
}

function RequirementDialogView({ model, actions }: { model: RequirementsModel; actions?: RequirementsActions | undefined }) {
  const { t, say } = useSay()
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
            <Field label={t('req.field.styles')} error={problems.styles ? say(problems.styles) : undefined}>
              <MultiSelect
                searchable
                ariaLabel={t('req.field.styles')}
                placeholder={model.styles?.status === 'loading' ? t('read.loading') : t('req.field.stylesPick')}
                searchPlaceholder={t('req.field.stylesSearch')}
                options={styleOptions.map((style) => ({ value: style.id, label: style.name ? `${style.code} · ${style.name}` : style.code }))}
                value={draft.styles.map((style) => style.id)}
                onChange={(next) => set({ styles: next.map((id) => ({ id, code: styleOptions.find((style) => style.id === id)?.code ?? '' })) })}
                width="auto"
              />
            </Field>
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
