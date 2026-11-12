'use client'

import { useMemo, useRef } from 'react'
import { AlertTriangle, CheckCircle2, CircleDashed, FileCheck2, Paperclip, Plus } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { type ColDef, type ICellRendererParams } from '@nexus/ui/grid'
import { Button, Input, RadioCard, Select, Tag } from '@nexus/ui/primitives'
import { Modal, StepUpModal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ListFrame } from '../../../../../list-frame/ListFrame'
import { valueOf } from '../../model'
import type { RulesMarketsModel } from '../../view-model'
import { SectionFailed, SectionHead, SectionLoading } from '../../view/parts'
import type { Approval, Template } from '../api'
import { approvalsOf, kindFilterOf, languagesOffered, PPE_NAMESPACE, PPE_TEXT_KINDS, recordHeld, STATE_TONE, templateKeyOf, templateOf, templatesShown, withdrawHeld, type RecordDraft } from '../model'
import type { TemplatesActions, TemplatesState } from '../use-ppe-texts'
import '../ppe-texts.css'

type Words = ReturnType<typeof useT>

/** The template in words: what generates the texts, and which one ("annex-ix · version 1", "SEED-LBL-JKT-02 · revision 1"). */
export function templateTitle(w: Words, template: Pick<Template, 'templateKind' | 'templateKey' | 'templateVersion' | 'label'>): { title: string; detail: string } {
  if (template.templateKind === 'LABEL_WARNING') return { title: w('ppe.template.labelTitle', { code: template.templateKey }), detail: w('ppe.template.labelDetail', { revision: template.templateVersion, name: template.label?.name ?? '' }) }
  return { title: w(`ppe.template.${template.templateKind}`), detail: w('ppe.template.generatorDetail', { key: template.templateKey, version: template.templateVersion }) }
}

const languageList = (codes: readonly string[]): string => (codes.length > 0 ? codes.map((code) => code.toUpperCase()).join(', ') : '—')

function StateMark({ state }: { state: Template['state'] }) {
  const w = useT(PPE_NAMESPACE)
  const Icon = state === 'APPROVED' ? CheckCircle2 : state === 'WITHDRAWN' ? AlertTriangle : CircleDashed
  return (
    <Tag tone={STATE_TONE[state]}>
      <Icon size={13} aria-hidden /> {w(`ppe.state.${state}`)}
    </Tag>
  )
}

/**
 * Compliance › Rules & markets › Templates (SCR-262 tab `templates`; B-W2b-288, FU2:01; GATE-PPE-TEXTS — the Owner's answer to
 * W2b-4 question 2: a PPE consultant checks the generated texts once, per template). The templates that generate PPE texts (the
 * declaration of conformity, the user information, each PPE garment label's class warnings) on the ONE list frame, each with
 * whether a consultant's yes is in force and in which languages; a template's window lists its approvals (the consultant, the
 * languages, whose texts, the file, who recorded it) with Withdraw (a reason); "Record a consultant's yes" takes the
 * consultant's file and asks a fresh code. Nothing here issues a text: a generated text of an approved template may leave
 * draft (the database's rule), any other stays a draft. No selection: no action applies to many templates.
 */
export function TemplatesTab({ model, state, actions, onAddress, onHelp }: { model: RulesMarketsModel; state: TemplatesState | undefined; actions?: TemplatesActions | undefined; onAddress?: ((change: Partial<RulesMarketsModel['address']>) => void) | undefined; onHelp: () => void }) {
  const w = useT(PPE_NAMESPACE)
  const { address } = model
  const answer = state ? valueOf(state.read) : null
  const kind = kindFilterOf(address.kind)
  const rows = useMemo(() => templatesShown(answer, { q: address.q, kind }), [answer, address.q, kind])
  const mayRecord = !!answer && (answer.mayRecord.company || answer.mayRecord.everyCompany)
  const offline = model.live === 'offline'
  const recordHeldWhy = !model.can.ppeTextsManage || (answer && !mayRecord) ? w('ppe.held.manage') : offline ? w('ppe.held.offline') : null
  const latest = useRef(onAddress)
  latest.current = onAddress

  const columns = useMemo<ColDef<Template>[]>(
    () => [
      {
        colId: 'template',
        headerName: w('ppe.col.template'),
        minWidth: 240,
        flex: 1.8,
        autoHeight: true,
        valueGetter: (params) => (params.data ? templateTitle(w, params.data).title : ''),
        cellRenderer: ({ data }: ICellRendererParams<Template>) => {
          if (!data) return null
          const words = templateTitle(w, data)
          return (
            <span className="fw-rm-cell">
              <span>{words.title}</span>
              <span className="fw-rm-muted">{words.detail}</span>
            </span>
          )
        },
      },
      { colId: 'kind', headerName: w('ppe.col.kind'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data ? w(`ppe.kind.${params.data.templateKind}`) : '') },
      {
        colId: 'whose',
        headerName: w('ppe.col.whose'),
        minWidth: 140,
        flex: 0.8,
        valueGetter: (params) => (params.data ? (params.data.label ? (params.data.label.companyId ? w('ppe.whose.company') : w('ppe.whose.every')) : w('ppe.whose.generator')) : ''),
      },
      { colId: 'languages', headerName: w('ppe.col.languages'), minWidth: 150, flex: 0.9, valueGetter: (params) => (params.data ? languageList(params.data.liveLanguages) : '') },
      {
        colId: 'state',
        headerName: w('ppe.col.state'),
        minWidth: 170,
        flex: 1,
        valueGetter: (params) => (params.data ? w(`ppe.state.${params.data.state}`) : ''),
        cellRenderer: ({ data }: ICellRendererParams<Template>) => (data ? <StateMark state={data.state} /> : null),
      },
      { colId: 'approvals', headerName: w('ppe.col.approvals'), minWidth: 120, flex: 0.6, valueGetter: (params) => (params.data ? w('ppe.approvals.count', { count: params.data.approvals }) : '') },
    ],
    [w],
  )

  const filtered = !!(address.q || kind)
  const filters = (
    <Select size="sm" value={kind ?? ''} aria-label={w('ppe.filter.kind')} onChange={(event) => onAddress?.({ kind: event.target.value || null })}>
      <option value="">{w('ppe.filter.allKinds')}</option>
      {PPE_TEXT_KINDS.map((entry) => (
        <option key={entry} value={entry}>
          {w(`ppe.kind.${entry}`)}
        </option>
      ))}
    </Select>
  )

  return (
    <>
      <section className="fw-rm-section" aria-labelledby="fw-ppt-templates">
        <SectionHead id="fw-ppt-templates" title={w('ppe.title')} note={w('ppe.note')}>
          <Button size="sm" variant="primary" aria-keyshortcuts="c" heldReason={recordHeldWhy} onClick={() => onAddress?.({ add: true })}>
            <Plus size={14} aria-hidden /> {w('ppe.record.open')}
          </Button>
        </SectionHead>
        <Banner tone="info" title={w('ppe.gate.title')}>
          <p className="fw-ppt-p">{w('ppe.gate.body')}</p>
        </Banner>
        {state?.notice && (
          <Banner
            tone={state.notice.tone}
            title={w(state.notice.key, state.notice.params)}
            action={
              <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
                {w('ppe.common.close')}
              </Button>
            }
          />
        )}
        {!state || state.read.status === 'loading' ? (
          <SectionLoading rows={5} />
        ) : state.read.status === 'error' ? (
          <SectionFailed title={w('ppe.failed')} problem={state.read.problem} onRetry={actions?.onRetry} />
        ) : (
          <ListFrame<Template>
            label={w('ppe.title')}
            title={w('ppe.title')}
            listKey="compliance.settings.templates"
            rows={rows}
            rowId={templateKeyOf}
            columns={columns}
            count={w('ppe.count', { count: rows?.length ?? 0 })}
            search={<Input size="sm" type="search" value={address.q} placeholder={w('ppe.search')} aria-label={w('ppe.search')} onChange={(event) => onAddress?.({ q: event.target.value })} />}
            tools={filters}
            keys={[{ keys: ['c'], does: w('ppe.keys.record') }]}
            onHelp={onHelp}
            onOpen={(row) => latest.current?.({ open: templateKeyOf(row) })}
            state={
              rows && rows.length === 0 ? (
                filtered ? (
                  <EmptyState
                    icon={<FileCheck2 size={22} aria-hidden />}
                    title={w('ppe.noneFiltered')}
                    action={
                      <Button size="sm" onClick={() => onAddress?.({ q: '', kind: null })}>
                        {w('ppe.common.clearFilters')}
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState icon={<FileCheck2 size={22} aria-hidden />} title={w('ppe.emptyTitle')} description={w('ppe.empty')} />
                )
              ) : undefined
            }
            cards={{ fields: { template: { role: 'title' }, state: { role: 'aside' }, languages: { role: 'subtitle' } } }}
          />
        )}
      </section>
      {state && answer && address.open && !address.add && <TemplateWindow model={model} state={state} actions={actions} onAddress={onAddress} recordHeldWhy={recordHeldWhy} />}
      {state?.record && answer && <RecordDialog model={model} state={state} actions={actions} onAddress={onAddress} />}
      {state?.stepUp.open && <PpeStepUp state={state} actions={actions} />}
    </>
  )
}

/** The DS step-up dialog: what the code allows (recording a yes opens generated texts), the shared quality words for the rest. */
function PpeStepUp({ state, actions }: { state: TemplatesState; actions?: TemplatesActions | undefined }) {
  const w = useT(PPE_NAMESPACE)
  const q = useT('quality')
  return (
    <StepUpModal
      open
      title={q('stepUp.title')}
      sentence={w(state.stepUp.sentence)}
      busy={state.stepUp.busy}
      error={state.stepUp.problem ? q(state.stepUp.problem) : null}
      onSubmit={(code) => actions?.onStepUp?.(code)}
      onClose={() => actions?.onStepUpCancel?.()}
      confirmLabel={w('ppe.stepUp.confirm')}
    />
  )
}

/** One template's window: what its yes allows now, the label it is about, and every approval with its file and Withdraw. */
function TemplateWindow({ model, state, actions, onAddress, recordHeldWhy }: { model: RulesMarketsModel; state: TemplatesState; actions?: TemplatesActions | undefined; onAddress?: ((change: Partial<RulesMarketsModel['address']>) => void) | undefined; recordHeldWhy: string | null }) {
  const w = useT(PPE_NAMESPACE)
  const locale = useLocale()
  const answer = valueOf(state.read)
  const template = templateOf(answer, model.address.open)
  const close = () => onAddress?.({ open: null })
  if (!template) {
    return (
      <Modal open onClose={close} title={w('ppe.window.title')} size="md">
        <EmptyState title={w('ppe.window.notFound')} />
      </Modal>
    )
  }
  const words = templateTitle(w, template)
  const approvals = approvalsOf(answer, template)
  const when = (at: string) => formatDateTime(at, { locale })
  return (
    <Modal
      open
      onClose={close}
      title={words.title}
      subtitle={words.detail}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{w('ppe.common.close')}</Button>
          <Button variant="primary" heldReason={recordHeldWhy} onClick={() => onAddress?.({ add: true })}>
            {w('ppe.record.open')}
          </Button>
        </>
      }
    >
      <div className="fw-ppt-window">
        <Banner tone={template.state === 'APPROVED' ? 'success' : 'info'} title={template.state === 'APPROVED' ? w('ppe.window.approved', { languages: languageList(template.liveLanguages) }) : w('ppe.window.waiting')}>
          <p className="fw-ppt-p">{w(`ppe.window.what.${template.templateKind}`)}</p>
        </Banner>
        {template.label && (
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: w('ppe.label.code'), value: template.label.code, hint: w('ppe.label.revision', { revision: template.label.revision }) },
              { label: w('ppe.label.name'), value: template.label.name },
              { label: w('ppe.label.languages'), value: languageList(template.label.languages) },
              { label: w('ppe.label.whose'), value: template.label.companyId ? w('ppe.whose.company') : w('ppe.whose.every') },
            ]}
          />
        )}
        <h3 className="fw-ppt-h">{w('ppe.window.approvals', { count: approvals.length })}</h3>
        {approvals.length === 0 ? (
          <p className="fw-rm-muted">{w('ppe.window.none')}</p>
        ) : (
          <ul className="fw-ppt-approvals">
            {approvals.map((approval) => (
              <ApprovalItem key={approval.id} approval={approval} model={model} state={state} actions={actions} when={when} />
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

function ApprovalItem({ approval, model, state, actions, when }: { approval: Approval; model: RulesMarketsModel; state: TemplatesState; actions?: TemplatesActions | undefined; when: (at: string) => string }) {
  const w = useT(PPE_NAMESPACE)
  const offline = model.live === 'offline'
  const withdrawing = state.withdraw?.approvalId === approval.id ? state.withdraw : null
  const startHeld = !approval.live ? w('ppe.held.withdrawn') : !approval.mayWithdraw ? w('ppe.held.manage') : offline ? w('ppe.held.offline') : null
  const saveHeld = withdrawing ? withdrawHeld(approval, withdrawing.reason, { offline, busy: withdrawing.writing.busy }) : null
  return (
    <li className="fw-ppt-approval">
      <span className="fw-ppt-approval-head">
        <Tag tone={approval.live ? 'success' : 'warning'}>{approval.live ? w('ppe.approval.live') : w('ppe.approval.withdrawn')}</Tag>
        <span className="fw-rm-muted">{approval.companyId === null ? w('ppe.whose.every') : approval.companyId === model.companyId ? w('ppe.whose.thisCompany', { company: model.companyName }) : w('ppe.whose.otherCompany')}</span>
      </span>
      <KeyValue
        columns={2}
        labelCase="sentence"
        items={[
          { label: w('ppe.approval.languages'), value: languageList(approval.languages) },
          { label: w('ppe.approval.checkedBy'), value: approval.checkedBy },
          { label: w('ppe.approval.recorded'), value: when(approval.recordedAt), hint: approval.recordedBy?.name ?? '' },
          ...(approval.withdrawnAt ? [{ label: w('ppe.approval.withdrawnAt'), value: when(approval.withdrawnAt), hint: approval.withdrawnBy?.name ?? '' }, { label: w('ppe.approval.reason'), value: approval.withdrawReason ?? '' }] : []),
        ]}
      />
      <span className="fw-rm-row">
        {approval.evidence && (
          <Button size="sm" heldReason={model.can.filesRead ? (approval.evidence.status === 'AVAILABLE' ? null : w('ppe.held.fileState')) : w('ppe.held.filesRead')} onClick={() => actions?.onOpenFile?.(approval.evidence!.id)}>
            <Paperclip size={13} aria-hidden /> {w('ppe.approval.file', { name: approval.evidence.originalName })}
          </Button>
        )}
        {!withdrawing && approval.live && (
          <Button size="sm" heldReason={startHeld} onClick={() => actions?.onWithdrawStart?.(approval.id)}>
            {w('ppe.withdraw.open')}
          </Button>
        )}
      </span>
      {withdrawing && (
        <div className="fw-ppt-withdraw">
          <Field label={w('ppe.withdraw.reason')} hint={w('ppe.withdraw.hint')} required>
            <Textarea value={withdrawing.reason} rows={2} maxLength={2000} onChange={(event) => actions?.onWithdrawReason?.(event.target.value)} />
          </Field>
          {withdrawing.writing.problem && <Banner tone="danger" title={w(withdrawing.writing.problem.key)} />}
          <span className="fw-rm-row">
            <Button size="sm" onClick={() => actions?.onWithdrawCancel?.()}>
              {w('ppe.common.cancel')}
            </Button>
            <Button size="sm" variant="danger" heldReason={saveHeld ? w(saveHeld) : null} onClick={() => actions?.onWithdrawSave?.()}>
              {w('ppe.withdraw.save')}
            </Button>
          </span>
        </div>
      )}
    </li>
  )
}

/** "Record a consultant's yes": the template, whose texts, the languages checked, the consultant, the consultant's file. */
function RecordDialog({ model, state, actions, onAddress }: { model: RulesMarketsModel; state: TemplatesState; actions?: TemplatesActions | undefined; onAddress?: ((change: Partial<RulesMarketsModel['address']>) => void) | undefined }) {
  const w = useT(PPE_NAMESPACE)
  const answer = valueOf(state.read)!
  const record = state.record!
  const draft = record.draft
  const input = useRef<HTMLInputElement>(null)
  const set = (next: Partial<RecordDraft>) => actions?.onRecordDraft?.({ ...draft, ...next })
  const template = templateOf(answer, draft.template)
  const held = recordHeld(draft, { mayCompany: answer.mayRecord.company, mayEvery: answer.mayRecord.everyCompany, offline: model.live === 'offline', busy: record.writing.busy, companyId: model.companyId })
  const close = () => onAddress?.({ add: false })
  const offered = languagesOffered(template)
  return (
    <Modal
      open
      onClose={close}
      title={w('ppe.record.title')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{w('ppe.common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? w(held) : null} onClick={() => actions?.onRecordSave?.()}>
            {record.writing.busy ? w('ppe.record.saving') : w('ppe.record.save')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form-grid">
        <div className="fw-rm-span">
          <Banner tone="info" title={w('ppe.record.gateTitle')}>
            <p className="fw-ppt-p">{w('ppe.record.gateBody')}</p>
          </Banner>
        </div>
        <div className="fw-rm-span">
          <Field label={w('ppe.field.template')} required>
            <Select size="sm" value={draft.template ?? ''} onChange={(event) => set({ template: event.target.value || null })}>
              <option value="">{w('ppe.common.choose')}</option>
              {answer.templates.map((entry) => {
                const words = templateTitle(w, entry)
                return (
                  <option key={templateKeyOf(entry)} value={templateKeyOf(entry)}>
                    {`${words.title} · ${words.detail}`}
                  </option>
                )
              })}
            </Select>
          </Field>
        </div>
        <fieldset className="fw-rm-choices fw-rm-span">
          <legend className="fw-rm-question">{w('ppe.field.whose')}</legend>
          <div className="fw-rm-radios">
            <RadioCard
              variant="row"
              name="fw-ppt-scope"
              checked={draft.scope === 'company'}
              selected={draft.scope === 'company'}
              disabled={!answer.mayRecord.company || !model.companyId}
              onChange={() => set({ scope: 'company' })}
              title={w('ppe.whose.thisCompany', { company: model.companyName })}
              description={answer.mayRecord.company ? w('ppe.whose.thisCompanyWhat') : w('ppe.held.company')}
            />
            <RadioCard
              variant="row"
              name="fw-ppt-scope"
              checked={draft.scope === 'all'}
              selected={draft.scope === 'all'}
              disabled={!answer.mayRecord.everyCompany}
              onChange={() => set({ scope: 'all' })}
              title={w('ppe.whose.every')}
              description={answer.mayRecord.everyCompany ? w('ppe.whose.everyWhat') : w('ppe.held.everyCompany')}
            />
          </div>
        </fieldset>
        <Field label={w('ppe.field.languages')} hint={offered.length > 0 ? w('ppe.field.languagesLabel', { languages: languageList(offered) }) : w('ppe.field.languagesHint')} required>
          <Input size="sm" value={draft.languages} placeholder="it, en" maxLength={120} onChange={(event) => set({ languages: event.target.value })} />
        </Field>
        <Field label={w('ppe.field.checkedBy')} hint={w('ppe.field.checkedByHint')} required>
          <Input size="sm" value={draft.checkedBy} maxLength={300} onChange={(event) => set({ checkedBy: event.target.value })} />
        </Field>
        <div className="fw-rm-span fw-ppt-file">
          <span className="fw-ppt-file-label">{w('ppe.field.file')}</span>
          <span className="fw-rm-row">
            <Button size="sm" onClick={() => input.current?.click()}>
              <Paperclip size={14} aria-hidden /> {draft.fileName ? w('ppe.file.change') : w('ppe.file.choose')}
            </Button>
            <span className={draft.fileName ? 'fw-ppt-file-name' : 'fw-rm-muted'}>{draft.fileName ?? w('ppe.file.none')}</span>
          </span>
          <span className="fw-rm-muted">{w('ppe.file.hint')}</span>
          <input
            ref={input}
            type="file"
            hidden
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) set({ file, fileName: file.name })
              event.target.value = ''
            }}
          />
        </div>
        {record.writing.problem && (
          <div className="fw-rm-span">
            <Banner tone="danger" title={w(record.writing.problem.key)} />
          </div>
        )}
      </div>
    </Modal>
  )
}
