'use client'

import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Radio, RadioCard, Spinner } from '@nexus/ui/primitives'
import { Modal } from '../../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { settingDraftOf, settingsSaveHeld, settingBodiesOf, type SettingDraft } from '../../../../operations/depth/model'
import { SettingsEditor, SettingsList } from '../../../../operations/depth/view/SettingsEditor'
import { minutesText } from '../../../model'
import type { RoutingDepth, StepDepth } from '../api'
import {
  checkpointChoices,
  draftRunMinutes,
  everyCell,
  optionChoicesOf,
  rowsOf,
  sameVariants,
  timesBodyOf,
  timesDraftOf,
  timesProblems,
  timesSaveHeld,
  variantParts,
  variantsBodyOf,
  variantsDraftOf,
  type DepthRow,
  type RoutingDepthActions,
  type RoutingDepthModel,
  type StepTimes,
  type TimesDraft,
  type TimesField,
  type VariantsDraft,
} from '../model'

/**
 * The Routing tab's depth pop-ups (B-W2b-235): a step's Times (where its run comes from — the library's approved version,
 * its own basic time and allowances, or typed —, set-up, wait and move per work order, the extra minutes per size with the
 * minutes in that size), Only for (sizes, colourways, options it runs for: the design's operation drawer part; also for
 * several steps at once), Quality checkpoint (a cutting, in-line or end-of-line plan of the style's company, or none),
 * Machine settings (the list, or a copy of the library's) and Copy settings from the library for several steps. Each is an
 * explicit save; on a released revision each is drawn as text with why. They fetch nothing (a picker's read is asked).
 */
export function DepthDialogs({ model, actions, held }: { model: RoutingDepthModel; actions?: RoutingDepthActions; held: string | null }) {
  const dialog = model.dialog
  const depth = model.depth.status === 'ready' ? model.depth.value : null
  const times = model.times.status === 'ready' ? model.times.value : null
  if (!dialog || !depth || !times) return null
  const rows = rowsOf(depth, times)
  const row = (stepId: string) => rows.find((entry) => entry.stepId === stepId) ?? null
  switch (dialog.kind) {
    case 'times': {
      const step = row(dialog.stepId)
      return step?.times ? <TimesDialog key={dialog.stepId} row={step} step={step.times} depth={depth} model={model} actions={actions} held={held} /> : null
    }
    case 'variants': {
      const steps = dialog.stepIds.map(row).filter((entry): entry is DepthRow => entry?.depth !== null && entry !== null)
      return steps.length > 0 ? <VariantsDialog key={dialog.stepIds.join(',')} steps={steps} depth={depth} model={model} actions={actions} held={held} /> : null
    }
    case 'checkpoint': {
      const step = row(dialog.stepId)
      return step?.depth ? <CheckpointDialog key={dialog.stepId} row={step} step={step.depth} depth={depth} model={model} actions={actions} held={held} /> : null
    }
    case 'settings': {
      const step = row(dialog.stepId)
      return step?.depth ? <SettingsDialog key={dialog.stepId} row={step} step={step.depth} model={model} actions={actions} held={held} /> : null
    }
    case 'copyLibrary':
      return <CopyDialog steps={dialog.stepIds.map(row).filter((entry): entry is DepthRow => entry !== null)} model={model} actions={actions} held={held} />
    default:
      return null
  }
}

const label = (row: Pick<DepthRow, 'seq' | 'code'>) => `${row.seq} · ${row.code}`

function Footer({ onClose, onSave, saveLabel, heldReason, readOnly }: { onClose: () => void; onSave: () => void; saveLabel: string; heldReason: string | null; readOnly: boolean }) {
  const tp = useT('products')
  return readOnly ? (
    <Button onClick={onClose}>{tp('common.close')}</Button>
  ) : (
    <>
      <Button onClick={onClose}>{tp('common.back')}</Button>
      <Button variant="primary" heldReason={heldReason} onClick={onSave} aria-keyshortcuts="Meta+Enter Control+Enter">
        {saveLabel}
      </Button>
    </>
  )
}

const saveKeys = (save: () => void) => (event: React.KeyboardEvent) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault()
    save()
  }
}

// ---- Times -------------------------------------------------------------------------------------------------------------------

function TimesDialog({ row, step, depth, model, actions, held }: { row: DepthRow; step: StepTimes; depth: RoutingDepth; model: RoutingDepthModel; actions?: RoutingDepthActions; held: string | null }) {
  const t = useT('products-operations-depth')
  const locale = useLocale()
  const sizes = depth.sizes.map((size) => size.code)
  const [draft, setDraft] = useState<TimesDraft>(() => timesDraftOf(step, sizes, locale))
  const [tried, setTried] = useState(false)
  const set = (patch: Partial<TimesDraft>) => setDraft((current) => ({ ...current, ...patch }))
  const problems = timesProblems(draft, step)
  const saveHeld = held ? t(held) : model.offline ? t('offline.held') : timesSaveHeld(draft, step, sizes, model.busy) ? t(timesSaveHeld(draft, step, sizes, model.busy)!) : null
  const show = (field: TimesField) => (tried && problems[field] ? t(problems[field]!) : undefined)
  const close = () => actions?.onDialog?.(null)
  const save = () => {
    setTried(true)
    const body = timesBodyOf(draft, step, sizes)
    if (saveHeld || !body) return
    void actions?.onTimes?.(row.stepId, body)
  }
  const run = draftRunMinutes(draft, step)
  const readOnly = held !== null
  const text = (value: string | null) => (value === null ? '—' : t('min', { minutes: minutesText(value, locale) }))

  return (
    <Modal open onClose={close} size="lg" title={t('times.title', { step: label(row) })} subtitle={row.name} footer={<Footer onClose={close} onSave={save} saveLabel={t('times.save')} heldReason={saveHeld} readOnly={readOnly} />}>
      <div className="fw-rtd-stack" onKeyDown={saveKeys(save)}>
        {readOnly ? (
          <>
            <Banner tone="info" title={t(held!)} />
            <KeyValue
              dense
              labelCase="sentence"
              columns={2}
              items={[
                { label: t('times.run'), value: `${text(step.run.standardMinutes)} · ${t(`runSource.${step.run.from}`)}` },
                { label: t('times.setup'), value: text(step.setupMinutes) },
                { label: t('times.wait'), value: text(step.waitMinutes) },
                { label: t('times.move'), value: text(step.moveMinutes) },
                ...step.sizeTimes.map((entry) => ({ label: t('times.inSize', { size: depth.sizes.find((size) => size.code === entry.size)?.label ?? entry.size }), value: `${text(entry.minutes)} (${t('times.extraOf', { extra: minutesText(entry.extraMinutes, locale) })})` })),
              ]}
            />
          </>
        ) : (
          <>
            <fieldset className="fw-rtd-fieldset">
              <legend className="fw-rtd-legend">{t('times.runFrom')}</legend>
              <div className="fw-rtd-choices" role="radiogroup" aria-label={t('times.runFrom')}>
                <RadioCard
                  name="fw-rtd-run"
                  value="VERSION"
                  checked={draft.run === 'VERSION'}
                  selected={draft.run === 'VERSION'}
                  disabled={step.run.from !== 'VERSION' && (!step.library.governed || step.library.inForceVersionId === null)}
                  onChange={() => set({ run: 'VERSION' })}
                  title={t('runSource.VERSION')}
                  description={
                    step.library.inForceVersionId !== null
                      ? t('times.versionHint', { number: step.library.inForceNumber ?? '—', minutes: minutesText(step.library.standardMinutes, locale) })
                      : step.run.from === 'VERSION'
                        ? t('times.versionKept', { number: step.run.timeVersion?.number ?? '—', minutes: minutesText(step.run.standardMinutes, locale) })
                        : t(step.library.governed ? 'times.problem.notInForce' : 'times.problem.noVersion')
                  }
                />
                <RadioCard name="fw-rtd-run" value="ALLOWANCES" checked={draft.run === 'ALLOWANCES'} selected={draft.run === 'ALLOWANCES'} onChange={() => set({ run: 'ALLOWANCES' })} title={t('runSource.ALLOWANCES')} description={t('times.allowancesHint')} />
                <RadioCard name="fw-rtd-run" value="TYPED" checked={draft.run === 'TYPED'} selected={draft.run === 'TYPED'} onChange={() => set({ run: 'TYPED' })} title={t('runSource.TYPED')} description={t('times.typedHint')} />
              </div>
              {show('run') && <p className="fw-rtd-sub fw-rtd-danger">{show('run')}</p>}
            </fieldset>
            {draft.run === 'TYPED' && (
              <div className="fw-rtd-form">
                <Field label={t('times.smv')} required error={show('typed')}>
                  <Input inputMode="decimal" value={draft.typed} suffix={t('minUnit')} onChange={(event) => set({ typed: event.target.value })} />
                </Field>
              </div>
            )}
            {draft.run === 'ALLOWANCES' && (
              <div className="fw-rtd-form">
                <Field label={t('propose.basic')} required error={show('basic')}>
                  <Input inputMode="decimal" value={draft.basic} suffix={t('minUnit')} onChange={(event) => set({ basic: event.target.value })} />
                </Field>
                <Field label={t('propose.personal')} error={show('personal')}>
                  <Input inputMode="decimal" value={draft.personal} suffix="%" onChange={(event) => set({ personal: event.target.value })} />
                </Field>
                <Field label={t('propose.fatigue')} error={show('fatigue')}>
                  <Input inputMode="decimal" value={draft.fatigue} suffix="%" onChange={(event) => set({ fatigue: event.target.value })} />
                </Field>
                <Field label={t('propose.delay')} error={show('delay')}>
                  <Input inputMode="decimal" value={draft.delay} suffix="%" onChange={(event) => set({ delay: event.target.value })} />
                </Field>
              </div>
            )}
            <p className="fw-rtd-sum" aria-live="polite">
              {t('times.runIs')} <b>{run === null ? '—' : t('min', { minutes: minutesText(run, locale) })}</b>
            </p>
            <div className="fw-rtd-form">
              <Field label={t('times.setup')} hint={t('times.sideHint')} error={show('setup')}>
                <Input inputMode="decimal" value={draft.setup} suffix={t('minUnit')} onChange={(event) => set({ setup: event.target.value })} />
              </Field>
              <Field label={t('times.wait')} error={show('wait')}>
                <Input inputMode="decimal" value={draft.wait} suffix={t('minUnit')} onChange={(event) => set({ wait: event.target.value })} />
              </Field>
              <Field label={t('times.move')} error={show('move')}>
                <Input inputMode="decimal" value={draft.move} suffix={t('minUnit')} onChange={(event) => set({ move: event.target.value })} />
              </Field>
            </div>
            {depth.sizes.length > 0 && (
              <fieldset className="fw-rtd-fieldset">
                <legend className="fw-rtd-legend">{t('times.extras')}</legend>
                <p className="fw-rtd-sub">{t('times.extrasHint')}</p>
                <div className="fw-rtd-sizes">
                  {depth.sizes.map((size) => {
                    const extra = draft.extras[size.code] ?? ''
                    const inSize = run !== null && extra.trim() !== '' && !Number.isNaN(Number(extra.replace(',', '.'))) ? String(Number(run) + Number(extra.replace(',', '.'))) : run
                    return (
                      <Field key={size.code} label={size.label} hint={inSize === null ? undefined : t('times.inSizeHint', { minutes: minutesText(inSize, locale) })} error={show(`size:${size.code}`)}>
                        <Input inputMode="decimal" value={extra} placeholder="0" onChange={(event) => set({ extras: { ...draft.extras, [size.code]: event.target.value } })} />
                      </Field>
                    )
                  })}
                </div>
              </fieldset>
            )}
            {step.library.differs && <p className="fw-rtd-sub fw-rtd-warn">{t('times.libraryDiffers', { minutes: minutesText(step.library.standardMinutes, locale) })}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}

// ---- Only for sizes, colours or options ----------------------------------------------------------------------------------------

function VariantsDialog({ steps, depth, model, actions, held }: { steps: DepthRow[]; depth: RoutingDepth; model: RoutingDepthModel; actions?: RoutingDepthActions; held: string | null }) {
  const t = useT('products-operations-depth')
  const locale = useLocale()
  const first = steps[0]!.depth!
  const start = variantsDraftOf(first)
  const [draft, setDraft] = useState<VariantsDraft>(start)
  const load = useRef(actions?.onLoadOptions)
  load.current = actions?.onLoadOptions
  useEffect(() => {
    if (depth.options.available) load.current?.()
  }, [depth.options.available])
  const options = model.options === null || model.options === 'failed' ? [] : optionChoicesOf(model.options, locale)
  const body = variantsBodyOf(draft, depth, options)
  const several = steps.length > 1
  const same = !several && sameVariants(body, start)
  const saveHeld = held ? t(held) : model.offline ? t('offline.held') : same ? t('variants.held.same') : model.busy ? t('held.busy') : null
  const close = () => actions?.onDialog?.(null)
  const save = () => {
    if (saveHeld) return
    void actions?.onVariants?.(
      steps.map((row) => row.stepId),
      body,
    )
  }
  const toggle = (list: keyof VariantsDraft, value: string) => setDraft((current) => ({ ...current, [list]: current[list].includes(value) ? current[list].filter((entry) => entry !== value) : [...current[list], value] }))
  const parts = variantParts(body, depth, options)
  const words = everyCell(body) ? t('variants.every') : [parts.sizes.length ? t('variants.sizes', { list: parts.sizes.join(', ') }) : null, parts.colourways.length ? t('variants.colourways', { list: parts.colourways.join(', ') }) : null, parts.options.length ? t('variants.options', { list: parts.options.join(', ') }) : null].filter(Boolean).join(' · ')
  const readOnly = held !== null
  const title = several ? t('variants.titleMany', { count: steps.length }) : t('variants.title', { step: label(steps[0]!) })

  return (
    <Modal open onClose={close} size="lg" title={title} subtitle={several ? steps.map(label).join(', ') : steps[0]!.name} footer={<Footer onClose={close} onSave={save} saveLabel={several ? t('variants.saveMany', { count: steps.length }) : t('variants.save')} heldReason={saveHeld} readOnly={readOnly} />}>
      <div className="fw-rtd-stack" onKeyDown={saveKeys(save)}>
        <p className="fw-rtd-sub">{t('variants.intro')}</p>
        {readOnly && <Banner tone="info" title={t(held!)} />}
        <fieldset className="fw-rtd-fieldset">
          <legend className="fw-rtd-legend">{t('variants.sizesLabel')}</legend>
          <div className="fw-rtd-checks">
            {depth.sizes.map((size) => (
              <Checkbox key={size.code} label={size.label} checked={draft.sizes.includes(size.code)} disabled={readOnly} onChange={() => toggle('sizes', size.code)} />
            ))}
          </div>
        </fieldset>
        <fieldset className="fw-rtd-fieldset">
          <legend className="fw-rtd-legend">{t('variants.colourwaysLabel')}</legend>
          {depth.colourways.length === 0 ? (
            <p className="fw-rtd-sub">{t('variants.noColourways')}</p>
          ) : (
            <div className="fw-rtd-checks">
              {depth.colourways.map((colourway) => (
                <Checkbox key={colourway.id} label={`${colourway.code} · ${colourway.name}`} checked={draft.colourwayIds.includes(colourway.id)} disabled={readOnly} onChange={() => toggle('colourwayIds', colourway.id)} />
              ))}
            </div>
          )}
        </fieldset>
        <fieldset className="fw-rtd-fieldset">
          <legend className="fw-rtd-legend">{t('variants.optionsLabel')}</legend>
          {!depth.options.available ? (
            <p className="fw-rtd-sub">{depth.options.words[locale]}</p>
          ) : model.options === null ? (
            <p className="fw-rtd-sub" role="status">
              <Spinner size={14} /> {t('variants.optionsLoading')}
            </p>
          ) : model.options === 'failed' ? (
            <p className="fw-rtd-sub fw-rtd-warn">{t('variants.optionsFailed')}</p>
          ) : (
            <div className="fw-rtd-checks">
              {options.map((option) => (
                <Checkbox key={option.id} label={option.label} checked={draft.optionValueIds.includes(option.id)} disabled={readOnly} onChange={() => toggle('optionValueIds', option.id)} />
              ))}
            </div>
          )}
        </fieldset>
        <p className="fw-rtd-sum" aria-live="polite">
          {t('variants.result')} <b>{words}</b>
        </p>
        <p className="fw-rtd-sub">{t('variants.workOrders')}</p>
        {several && <p className="fw-rtd-sub fw-rtd-warn">{t('variants.manyReplace', { count: steps.length })}</p>}
      </div>
    </Modal>
  )
}

// ---- Quality checkpoint ---------------------------------------------------------------------------------------------------------

function CheckpointDialog({ row, step, depth, model, actions, held }: { row: DepthRow; step: StepDepth; depth: RoutingDepth; model: RoutingDepthModel; actions?: RoutingDepthActions; held: string | null }) {
  const t = useT('products-operations-depth')
  const locale = useLocale()
  const [planId, setPlanId] = useState<string | null>(step.checkpoint?.plan.id ?? null)
  const load = useRef(actions?.onLoadPlans)
  load.current = actions?.onLoadPlans
  const readOnly = held !== null
  useEffect(() => {
    if (!readOnly) load.current?.()
  }, [readOnly])
  const plans = Array.isArray(model.plans) ? checkpointChoices(model.plans, depth.style.companyId) : []
  const same = planId === (step.checkpoint?.plan.id ?? null)
  const saveHeld = held ? t(held) : model.offline ? t('offline.held') : same ? t('checkpoint.held.same') : model.busy ? t('held.busy') : null
  const close = () => actions?.onDialog?.(null)
  const save = () => {
    if (saveHeld) return
    void actions?.onCheckpoint?.(row.stepId, planId)
  }
  const current = step.checkpoint
  return (
    <Modal open onClose={close} size="md" title={t('checkpoint.title', { step: label(row) })} subtitle={row.name} footer={<Footer onClose={close} onSave={save} saveLabel={t('checkpoint.save')} heldReason={saveHeld} readOnly={readOnly} />}>
      <div className="fw-rtd-stack" onKeyDown={saveKeys(save)}>
        <p className="fw-rtd-sub">{t('checkpoint.intro')}</p>
        {current && (
          <Banner tone={current.warning ? 'warning' : 'info'} title={t('checkpoint.current', { code: current.plan.code, name: current.plan.name })}>
            <p className="fw-rtd-sub">{current.does[locale]}</p>
            {current.warning && <p className="fw-rtd-sub">{current.warning[locale]}</p>}
          </Banner>
        )}
        {readOnly ? (
          <Banner tone="info" title={t(held!)} />
        ) : model.plans === null ? (
          <p className="fw-rtd-sub" role="status">
            <Spinner size={14} /> {t('checkpoint.loading')}
          </p>
        ) : model.plans === 'forbidden' ? (
          <Banner tone="info" title={t('checkpoint.noPlansRight')} />
        ) : model.plans === 'failed' ? (
          <Banner tone="danger" title={t('checkpoint.failed')} action={<Button size="sm" onClick={() => actions?.onLoadPlans?.()}>{t('retry')}</Button>} />
        ) : (
          <div className="fw-rtd-radios" role="radiogroup" aria-label={t('checkpoint.pick')}>
            <Radio name="fw-rtd-plan" value="" checked={planId === null} onChange={() => setPlanId(null)} label={t('checkpoint.none')} />
            {plans.map((plan) => (
              <Radio
                key={plan.id}
                name="fw-rtd-plan"
                value={plan.id}
                checked={planId === plan.id}
                onChange={() => setPlanId(plan.id)}
                label={`${plan.code} · ${plan.name} — ${t(`stage.${plan.stage}`)}${plan.approved ? '' : ` (${t('checkpoint.notApproved')})`}`}
              />
            ))}
            {plans.length === 0 && <p className="fw-rtd-sub">{t('checkpoint.noneYet')}</p>}
          </div>
        )}
        <p className="fw-rtd-sub">{t('checkpoint.rule')}</p>
      </div>
    </Modal>
  )
}

// ---- Machine settings ------------------------------------------------------------------------------------------------------------

function SettingsDialog({ row, step, model, actions, held }: { row: DepthRow; step: StepDepth; model: RoutingDepthModel; actions?: RoutingDepthActions; held: string | null }) {
  const t = useT('products-operations-depth')
  const locale = useLocale()
  const [drafts, setDrafts] = useState<SettingDraft[]>(() => step.settings.map((setting) => settingDraftOf(setting, locale)))
  const [tried, setTried] = useState(false)
  const load = useRef(actions?.onLoadClasses)
  load.current = actions?.onLoadClasses
  const readOnly = held !== null
  useEffect(() => {
    if (!readOnly) load.current?.()
  }, [readOnly])
  const saveHeldKey = settingsSaveHeld(drafts, step.settings, model.busy)
  const saveHeld = held ? t(held) : model.offline ? t('offline.held') : saveHeldKey ? t(saveHeldKey) : null
  const close = () => actions?.onDialog?.(null)
  const save = () => {
    setTried(true)
    if (saveHeld) return
    void actions?.onSettings?.(row.stepId, { settings: settingBodiesOf(drafts) })
  }
  const copyHeld = step.librarySettings === 0 ? t('bulk.held.noLibrary') : model.busy ? t('held.busy') : null
  return (
    <Modal open onClose={close} size="lg" title={t('stepSettings.title', { step: label(row) })} subtitle={row.name} footer={<Footer onClose={close} onSave={save} saveLabel={t('settings.save')} heldReason={saveHeld} readOnly={readOnly} />}>
      <div className="fw-rtd-stack" onKeyDown={saveKeys(save)}>
        {readOnly ? (
          <>
            <Banner tone="info" title={t(held!)} />
            <SettingsList settings={step.settings} />
          </>
        ) : (
          <>
            <div className="fw-rtd-row">
              <p className="fw-rtd-sub fw-rtd-grow">{step.librarySettings > 0 ? t('stepSettings.library', { count: step.librarySettings }) : t('stepSettings.noLibrary')}</p>
              <Button size="sm" heldReason={copyHeld} onClick={() => void actions?.onSettings?.(row.stepId, { fromLibrary: true })}>
                <Copy size={13} aria-hidden /> {t('stepSettings.copy')}
              </Button>
            </div>
            <SettingsEditor drafts={drafts} onDrafts={setDrafts} classes={model.classes} current={step.settings} shown={tried} idPrefix={`step-${row.stepId}`} />
          </>
        )}
      </div>
    </Modal>
  )
}

// ---- Copy settings from the library (several steps) ----------------------------------------------------------------------------

function CopyDialog({ steps, model, actions, held }: { steps: DepthRow[]; model: RoutingDepthModel; actions?: RoutingDepthActions; held: string | null }) {
  const t = useT('products-operations-depth')
  const withLibrary = steps.filter((row) => (row.depth?.librarySettings ?? 0) > 0)
  const saveHeld = held ? t(held) : model.offline ? t('offline.held') : withLibrary.length === 0 ? t('bulk.held.noLibrary') : model.busy ? t('held.busy') : null
  const close = () => actions?.onDialog?.(null)
  const save = () => {
    if (saveHeld) return
    void actions?.onCopyLibrary?.(withLibrary.map((row) => row.stepId))
  }
  return (
    <Modal open onClose={close} size="md" title={t('copy.title', { count: withLibrary.length })} footer={<Footer onClose={close} onSave={save} saveLabel={t('bulk.copy', { count: withLibrary.length })} heldReason={saveHeld} readOnly={false} />}>
      <div className="fw-rtd-stack" onKeyDown={saveKeys(save)}>
        <p className="fw-rtd-sub">{t('copy.intro')}</p>
        <ul className="fw-rtd-list">
          {steps.map((row) => (
            <li key={row.stepId}>
              <b>{label(row)}</b> {row.name} — {(row.depth?.librarySettings ?? 0) > 0 ? t('copy.replaces', { from: row.depth?.settings.length ?? 0, to: row.depth?.librarySettings ?? 0 }) : t('copy.skipped')}
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  )
}
