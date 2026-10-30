'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, Circle, CircleAlert, CircleDashed, Clock, ListChecks, Loader } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Modal } from '@nexus/ui/components'
import { Button, Pill, Select, Skeleton, Textarea } from '@nexus/ui/primitives'
import { formatDateTime, formatNumber } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { useWords } from '../../../kit/parts'
import type { FirstLoadStepView, StepState } from '../api'
import {
  differenceWords,
  doneCount,
  doneHeld,
  doneWords,
  importHeld,
  importLink,
  nothingHeld,
  reasonProblem,
  reconciliationWords,
  STATE_TONE,
  stateKey,
  stepName,
  stepNumber,
  stepWhat,
  type FirstLoadModel,
  type Words,
} from '../model'

/**
 * "First load, in order" (design 02 admin.import sec:guided; B-W2a-41, PLT-185) — FirstLoadChecklist, the area's
 * stand-in for the design's new DS part SetupChecklist with an action per step (admin/shared's SetupChecklist has one
 * link per step and no reconciliation; DS gap): the five steps in order, each with its state from the API, its
 * reconciliation (the sheet against what is loaded now; opening stock's quantities per unit and, only with the cost
 * grain, its value), the differences in words, and "Import the sheet", "Done" and "Nothing to load", each held with its
 * reason. Fetches nothing (ImportPage.tsx reads the API).
 */

export interface FirstLoadActions {
  onCompany?: (companyId: string) => void
  onRetry?: () => void
  /** Opens the confirm of "Done" (nothing false) or "Nothing to load" (nothing true) for a step. */
  onAsk?: (step: FirstLoadStepView['step'], nothing: boolean) => void
  onReason?: (reason: string) => void
  onCancel?: () => void
  onConfirm?: () => void
  onDismissNotice?: () => void
}

const ICON: Readonly<Record<StepState, typeof CheckCircle2>> = { done: CheckCircle2, ready: Circle, mismatch: CircleAlert, running: Loader, todo: CircleAlert, waiting: Clock, held: CircleDashed }
const STEP_CLASS: Readonly<Record<StepState, string>> = { done: 'done', ready: 'waiting', mismatch: 'blocked', running: 'waiting', todo: 'needs', waiting: 'unknown', held: 'unknown' }

function useMoney() {
  const locale = useLocale()
  return (minor: number, currency: string) => formatNumber(minor / 100, locale, { style: 'currency', currency })
}

function Said({ children }: { children: ReactNode }) {
  return <q className="fw-adm-imp-said">{children}</q>
}

export interface FirstLoadSectionProps {
  model: FirstLoadModel
  companies: ReadonlyArray<{ id: string; name: string }>
  /** `/w/<company>/admin/import`. */
  base: string
  actions?: FirstLoadActions
}

export function FirstLoadSection({ model, companies, base, actions }: FirstLoadSectionProps) {
  const t = useT('admin-import')
  const words = useWords('admin-import')
  const steps = model.steps
  return (
    <section className="fw-adm-imp-section" aria-labelledby="imp-first">
      <div className="fw-adm-imp-first-head">
        <h2 id="imp-first" className="fw-adm-imp-h2">
          {t('imp.first.title')}
        </h2>
        {steps && <Pill tone={model.complete ? 'success' : 'neutral'}>{t('imp.first.progress', { done: doneCount(steps), total: steps.length })}</Pill>}
      </div>
      <p className="fw-adm-hint">{t('imp.first.intro')}</p>
      {companies.length > 1 && (
        <div className="fw-adm-imp-first-company">
          <Field label={t('imp.first.company')}>
            <Select value={model.companyId} onChange={(event) => actions?.onCompany?.(event.target.value)}>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={words(model.notice.key, model.notice.params)}
          action={
            actions?.onDismissNotice ? (
              <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>
                {t('imp.first.dismiss')}
              </Button>
            ) : undefined
          }
        />
      )}
      {model.problem ? (
        <Card padded>
          <EmptyState
            icon={<ListChecks size={24} aria-hidden />}
            title={t('imp.first.failedTitle')}
            description={words(model.problem)}
            action={
              <Button size="sm" onClick={() => actions?.onRetry?.()}>
                {t('imp.first.retry')}
              </Button>
            }
          />
        </Card>
      ) : steps === null ? (
        <Card padded aria-busy="true">
          <div className="fw-adm-imp-first-skeleton" role="status" aria-label={t('imp.first.loading')}>
            {[0, 1, 2, 3, 4].map((index) => (
              <Skeleton key={index} height={44} />
            ))}
          </div>
        </Card>
      ) : (
        <FirstLoadChecklist steps={steps} base={base} busy={model.busy} actions={actions} />
      )}
      <FirstLoadConfirm model={model} actions={actions} />
    </section>
  )
}

/** The steps in order, each with its facts and its actions. */
export function FirstLoadChecklist({ steps, base, busy, actions }: { steps: readonly FirstLoadStepView[]; base: string; busy: boolean; actions?: FirstLoadActions }) {
  const t = useT('admin-import')
  const locale = useLocale()
  const money = useMoney()
  const say = (words: Words) => t(words.key, words.params)
  const when = (iso: string) => formatDateTime(iso, { locale })
  return (
    <Card padded className="fw-adm-checklist">
      <ol className="fw-adm-steps">
        {steps.map((step) => {
          const Icon = ICON[step.state]
          const name = t(stepName(step.step))
          const held = { import: importHeld(step), done: doneHeld(step), nothing: nothingHeld(step) }
          const link = importLink(step)
          const done = doneWords(step, when)
          const differences = differenceWords(step, money)
          return (
            <li key={step.step} className={`fw-adm-step is-${STEP_CLASS[step.state]}`}>
              <span className="fw-adm-step-icon" aria-hidden>
                <Icon size={18} />
              </span>
              <span className="fw-adm-step-body">
                <span className="fw-adm-step-line">
                  <span className="fw-adm-step-name">
                    <span className="fw-adm-sr">{t('imp.first.number', { n: stepNumber(step.step) })} </span>
                    {name}
                  </span>
                  <Pill tone={STATE_TONE[step.state]}>{t(stateKey(step.state))}</Pill>
                </span>
                <span className="fw-adm-step-detail">{t(stepWhat(step.step))}</span>
                {step.reconciliation && (
                  <span className="fw-adm-imp-first-rec">
                    {reconciliationWords(step.step, step.reconciliation, money).map((line, index) => (
                      <span key={`${line.key}-${index}`} className="fw-adm-step-detail">
                        {say(line)}
                      </span>
                    ))}
                    {step.matches !== null && <span className={`fw-adm-step-meta ${step.matches ? 'is-ok' : 'is-off'}`}>{t(step.matches ? 'imp.first.rec.matches' : 'imp.first.rec.differs')}</span>}
                  </span>
                )}
                {step.job && <span className="fw-adm-step-meta">{t('imp.first.job', { file: step.job.fileName, when: step.job.appliedAt ? when(step.job.appliedAt) : '—' })}</span>}
                {differences.length > 0 && (
                  <ul className="fw-adm-imp-first-diffs" aria-label={t('imp.first.diffLabel')}>
                    {differences.map((item, index) => (
                      <li key={index}>{'said' in item ? <Said>{item.said}</Said> : say(item)}</li>
                    ))}
                  </ul>
                )}
                {done && <span className={`fw-adm-step-meta ${step.done?.stillMatches === false ? 'is-off' : 'is-ok'}`}>{say(done)}</span>}
              </span>
              <span className="fw-adm-step-go fw-adm-imp-first-go">
                {step.state !== 'done' && (
                  held.import || step.importerKey === null ? (
                    <Button size="sm" heldReason={say(held.import ?? { key: 'imp.first.held.noImporter' })}>
                      {t('imp.first.import')}
                      <span className="fw-adm-sr"> {name}</span>
                    </Button>
                  ) : (
                    <Button size="sm" variant={step.state === 'todo' ? 'primary' : 'secondary'} asChild>
                      <Link href={`${base}?importer=${encodeURIComponent(step.importerKey ?? '')}`}>
                        {t('imp.first.import')}
                        <span className="fw-adm-sr"> {name}</span>
                      </Link>
                    </Button>
                  )
                )}
                {link && (
                  <Button size="sm" variant="quiet" asChild>
                    <Link href={`${base}?job=${encodeURIComponent(link)}`}>
                      {t(step.runningJobId ? 'imp.first.openRunning' : 'imp.first.openImport')}
                      <span className="fw-adm-sr"> {name}</span>
                    </Link>
                  </Button>
                )}
                {step.state !== 'done' && step.importerKey !== null && (
                  <Button size="sm" variant={step.state === 'ready' ? 'primary' : 'secondary'} heldReason={held.done ? say(held.done) : busy ? t('imp.first.busy') : null} onClick={() => actions?.onAsk?.(step.step, false)}>
                    {t('imp.first.markDone')}
                    <span className="fw-adm-sr"> {name}</span>
                  </Button>
                )}
                {step.state !== 'done' && (
                  <Button size="sm" variant={step.importerKey === null ? 'secondary' : 'quiet'} heldReason={held.nothing ? say(held.nothing) : busy ? t('imp.first.busy') : null} onClick={() => actions?.onAsk?.(step.step, true)}>
                    {t('imp.first.nothing')}
                    <span className="fw-adm-sr"> {name}</span>
                  </Button>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

interface ConfirmParts {
  title: string
  body: ReactNode
  footer: ReactNode
}

function useConfirmParts(model: FirstLoadModel, actions?: FirstLoadActions): ConfirmParts | null {
  const t = useT('admin-import')
  const locale = useLocale()
  const money = useMoney()
  const confirm = model.confirm
  const step = confirm ? (model.steps ?? []).find((item) => item.step === confirm.step) : undefined
  if (!confirm || !step) return null
  const name = t(stepName(step.step))
  const problem = confirm.nothing ? reasonProblem(confirm.reason) : null
  const lines = step.reconciliation && !confirm.nothing ? reconciliationWords(step.step, step.reconciliation, money) : []
  return {
    title: t(confirm.nothing ? 'imp.first.confirm.nothingTitle' : 'imp.first.confirm.doneTitle', { step: name }),
    body: (
      <div className="fw-adm-modal-body">
        <p className="fw-adm-intro">{t(confirm.nothing ? 'imp.first.confirm.nothingBody' : 'imp.first.confirm.doneBody')}</p>
        {lines.length > 0 && (
          <ul className="fw-adm-imp-first-diffs is-plain">
            {lines.map((line, index) => (
              <li key={`${line.key}-${index}`}>{t(line.key, line.params)}</li>
            ))}
          </ul>
        )}
        {step.job && !confirm.nothing && <p className="fw-adm-hint">{t('imp.first.job', { file: step.job.fileName, when: step.job.appliedAt ? formatDateTime(step.job.appliedAt, { locale }) : '—' })}</p>}
        {confirm.nothing && (
          <Field label={t('imp.first.confirm.reason')} required hint={t('imp.first.confirm.reasonHint')} error={confirm.reason !== '' && problem ? t(problem) : undefined}>
            <Textarea value={confirm.reason} rows={3} maxLength={500} onChange={(event) => actions?.onReason?.(event.target.value)} />
          </Field>
        )}
      </div>
    ),
    footer: (
      <>
        <Button onClick={() => actions?.onCancel?.()}>{t('imp.first.confirm.keep')}</Button>
        <Button variant="primary" heldReason={problem ? t(problem) : model.busy ? t('imp.first.busy') : null} onClick={() => actions?.onConfirm?.()}>
          {t(confirm.nothing ? 'imp.first.confirm.nothingGo' : 'imp.first.confirm.doneGo')}
        </Button>
      </>
    ),
  }
}

/** The confirm of "Done" (what matched) or "Nothing to load" (a reason). */
export function FirstLoadConfirm({ model, actions }: { model: FirstLoadModel; actions?: FirstLoadActions }) {
  const parts = useConfirmParts(model, actions)
  if (!parts) return null
  return (
    <Modal open onClose={() => actions?.onCancel?.()} title={parts.title} size="md" busy={model.busy} footer={parts.footer}>
      {parts.body}
    </Modal>
  )
}

/** The same confirm drawn in place (the DS Modal opens only in a browser: the design index and the tests draw this). */
export function FirstLoadConfirmInline({ model, actions }: { model: FirstLoadModel; actions?: FirstLoadActions }) {
  const parts = useConfirmParts(model, actions)
  if (!parts) return null
  return (
    <section aria-label={parts.title}>
      <h2>{parts.title}</h2>
      {parts.body}
      <div>{parts.footer}</div>
    </section>
  )
}
