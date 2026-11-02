'use client'

import { useMemo } from 'react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { Button, Checkbox, Input, Pill, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, EditModeBar, Modal, Textarea, ActionConfirm } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import { GUARANTEED_BASES, INCENTIVE_KINDS, OWN_FAULT_PAYS, PAID_TIME_RATES, TEAM_SPLITS } from '@nexus/factory-domain/people/schemes/rules'
import { actionHeld, dayText, rateText, reasonHeld, schemeHeld } from '../model'
import type { PieceActions, PieceDialog, PieceModel } from '../view-model'
import { ReadBlock, said, Section, usePieceWords } from './parts'

const STATE_TONE = { DRAFT: 'neutral', TO_COME: 'info', IN_FORCE: 'success', ENDING: 'warning', ENDED: 'neutral' } as const

/**
 * Scheme (design sec:scheme, MES-253, 257–259, 264): how pay is computed for the company or a line. A scheme in force is never
 * edited: a change is a new draft from it, and a change says the pay periods it touches. Words carry no figure; the guaranteed
 * and trainee rates need the pay grain.
 */
export function SchemeSection({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const locale = useLocale()
  const list = model.schemes.status === 'ready' ? model.schemes.value : null
  const detail = model.scheme?.status === 'ready' ? model.scheme.value : null
  const scheme = detail?.scheme
  const payShown = list?.payShown ?? model.can.pay
  const edit = model.schemeEdit
  const hidden = t('scheme.hiddenRate')
  const kv = useMemo(() => {
    if (!scheme) return []
    const money = (value: string | null | undefined) => (payShown ? (rateText(value, scheme.currency, locale) ?? t('scheme.notGiven')) : hidden)
    return [
      { label: t('scheme.kind'), value: t(`kind.${scheme.kind}`) },
      ...(scheme.kind === 'STANDARD_MINUTE_BONUS' ? [{ label: t('scheme.threshold'), value: `${scheme.efficiencyThresholdPct ?? '—'}%` }] : []),
      { label: t('scheme.basis'), value: t(`basisG.${scheme.guaranteedBasis}`) },
      { label: t('scheme.guaranteed'), value: money(scheme.guaranteedHourlyRate) },
      { label: t('scheme.trainee'), value: money(scheme.traineeHourlyRate) },
      ...(scheme.teamSplit ? [{ label: t('scheme.split'), value: t(`split.${scheme.teamSplit}`) }] : []),
      { label: t('scheme.rework'), value: t(`own.${scheme.reworkOwnFault}`, { pct: scheme.ownFaultRatePct ?? '' }) },
      { label: t('scheme.scrap'), value: t(`own.${scheme.scrapOwnFault}`, { pct: scheme.ownFaultRatePct ?? '' }) },
      { label: t('scheme.others'), value: t(`paid.${scheme.othersFaultPay}`) },
      { label: t('scheme.waiting'), value: t(`paid.${scheme.waitingPay}`) },
      { label: t('scheme.clocked'), value: t(scheme.payOnlyWhileClockedIn ? 'scheme.clockedOn' : 'scheme.clockedOff') },
      { label: t('scheme.days'), value: `${dayText(scheme.validFrom, locale)} – ${dayText(scheme.validTo, locale) ?? t('rates.open')}` },
    ]
  }, [scheme, payShown, hidden, t, locale])
  const canEdit = detail?.canManage ?? model.can.manage
  return (
    <Section
      id="scheme"
      title={t('scheme.title')}
      hint={t('scheme.hint')}
      actions={
        canEdit && !edit ? (
          <Button size="sm" variant="secondary" onClick={() => actions?.onNewScheme(false)}>
            {t('scheme.new')}
          </Button>
        ) : undefined
      }
    >
      {edit ? (
        <SchemeForm model={model} actions={actions} />
      ) : (
        <ReadBlock read={model.schemes} onRetry={actions?.onRetry}>
          {(page) =>
            page.schemes.length === 0 ? (
              <p className="fw-pr8-hint">{t('scheme.none')}</p>
            ) : (
              <Card padded>
                <div className="fw-pr8-stack">
                  <div className="fw-pr8-row">
                    <Select aria-label={t('scheme.pick')} value={model.schemeId ?? ''} onChange={(event) => actions?.onPickScheme(event.target.value)}>
                      {page.schemes.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name} · {row.line ? row.line.code : t('scheme.company')}
                        </option>
                      ))}
                    </Select>
                    {scheme && (
                      <Pill tone={STATE_TONE[scheme.state]} dot>
                        {t(`schemeState.${scheme.state}`)}
                      </Pill>
                    )}
                  </div>
                  <ReadBlock read={model.scheme} onRetry={actions?.onRetry}>
                    {() => (
                      <>
                        <KeyValue columns={3} items={kv} />
                        {detail && detail.periods.length > 0 && (
                          <p className="fw-pr8-hint">
                            {t('scheme.periods')}{' '}
                            {detail.periods.map((row) => `${row.month}: ${t(`effect.${row.effect}`)}`).join(' · ')}
                          </p>
                        )}
                        {detail && detail.switches.length > 0 && <p className="fw-pr8-hint">{t('scheme.switches', { sites: detail.switches.map((row) => row.site.code).join(', ') })}</p>}
                        {detail?.followedBy && <p className="fw-pr8-hint">{t('scheme.followedBy', { name: detail.followedBy.name, day: dayText(detail.followedBy.validFrom, locale) ?? '' })}</p>}
                        {detail?.canManage && (
                          <div className="fw-pr8-row">
                            {detail.actions.edit.allowed ? (
                              <Button size="sm" onClick={() => actions?.onEditScheme()}>
                                {t('scheme.edit')}
                              </Button>
                            ) : (
                              <Button size="sm" onClick={() => actions?.onNewScheme(true)}>
                                {t('scheme.fromThis')}
                              </Button>
                            )}
                            {scheme?.status === 'DRAFT' && (
                              <Button size="sm" variant="primary" heldReason={said(t, actionHeld(detail.actions.activate)) || null} onClick={() => actions?.onActivateScheme()}>
                                {t('scheme.start')}
                              </Button>
                            )}
                            {scheme?.status === 'ACTIVE' && (
                              <Button size="sm" variant="quiet" heldReason={said(t, actionHeld(detail.actions.end)) || null} onClick={() => actions?.onEndScheme()}>
                                {t('scheme.end')}
                              </Button>
                            )}
                            {detail.actions.delete.allowed && (
                              <Button size="sm" variant="quiet" onClick={() => actions?.onDeleteScheme()}>
                                {t('scheme.delete')}
                              </Button>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </ReadBlock>
                </div>
              </Card>
            )
          }
        </ReadBlock>
      )}
      {model.dialog?.kind === 'endScheme' && <EndDialog dialog={model.dialog} model={model} actions={actions} />}
      {model.dialog?.kind === 'deleteScheme' && (
        <ActionConfirm
          impact={{ level: 'confirm', reach: 'local', title: t('scheme.deleteTitle'), confirmLabel: t('scheme.delete'), consequences: [t('scheme.deleteBody')], reversal: { verb: t('scheme.deleteBack'), fidelity: 'none' }, ...(model.dialog.problem ? { refusal: { reason: said(t, model.dialog.problem) } } : {}) }}
          onConfirm={() => actions?.onDeleteSchemeSave()}
          onCancel={() => actions?.onCloseDialog()}
        />
      )}
    </Section>
  )
}

function SchemeForm({ model, actions }: { model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  const edit = model.schemeEdit!
  const { draft } = edit
  const held = schemeHeld(draft, model.today)
  const set = actions?.onSchemeDraft
  const paySelect = (value: string, onChange: (value: never) => void, label: string) => (
    <Field label={label}>
      <Select value={value} onChange={(event) => onChange(event.target.value as never)}>
        {PAID_TIME_RATES.map((rate) => (
          <option key={rate} value={rate}>
            {t(`paid.${rate}`)}
          </option>
        ))}
      </Select>
    </Field>
  )
  const ownSelect = (value: string, onChange: (value: never) => void, label: string) => (
    <Field label={label}>
      <Select value={value} onChange={(event) => onChange(event.target.value as never)}>
        {OWN_FAULT_PAYS.map((pay) => (
          <option key={pay} value={pay}>
            {t(`own.${pay}`, { pct: draft.ownFaultRatePct || '…' })}
          </option>
        ))}
      </Select>
    </Field>
  )
  return (
    <Card padded>
      <div className="fw-pr8-stack">
        {edit.problem && <Banner tone="danger" title={said(t, edit.problem)} />}
        <div className="fw-pr8-grid">
          <Field label={t('scheme.name')} required>
            <Input value={draft.name} onChange={(event) => set?.({ name: event.target.value })} />
          </Field>
          {edit.id === null && (
            <Field label={t('record.line')}>
              <Select value={draft.lineId ?? ''} onChange={(event) => set?.({ lineId: event.target.value || null })}>
                <option value="">{t('scheme.company')}</option>
                {model.lines.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.code} · {row.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('scheme.firstDay')} required>
            <DateField value={draft.validFrom} min={model.today} onChange={(value) => set?.({ validFrom: value })} />
          </Field>
        </div>
        <div className="fw-pr8-grid" role="radiogroup" aria-label={t('scheme.kind')}>
          {INCENTIVE_KINDS.map((kind) => (
            <RadioCard key={kind} name="scheme-kind" title={t(`kind.${kind}`)} description={t(`kindHint.${kind}`)} checked={draft.kind === kind} selected={draft.kind === kind} onChange={() => set?.({ kind, teamSplit: kind === 'TEAM_INCENTIVE' ? (draft.teamSplit ?? 'HOURS_PRESENT') : null })} />
          ))}
        </div>
        <div className="fw-pr8-grid">
          {draft.kind === 'STANDARD_MINUTE_BONUS' && (
            <Field label={t('scheme.threshold')} required>
              <Input value={draft.efficiencyThresholdPct} inputMode="decimal" onChange={(event) => set?.({ efficiencyThresholdPct: event.target.value })} />
            </Field>
          )}
          {draft.kind === 'TEAM_INCENTIVE' && (
            <Field label={t('scheme.split')} required>
              <Select value={draft.teamSplit ?? ''} onChange={(event) => set?.({ teamSplit: event.target.value as typeof draft.teamSplit })}>
                {TEAM_SPLITS.map((split) => (
                  <option key={split} value={split}>
                    {t(`split.${split}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('scheme.basis')}>
            <Select value={draft.guaranteedBasis} onChange={(event) => set?.({ guaranteedBasis: event.target.value as typeof draft.guaranteedBasis })}>
              {GUARANTEED_BASES.map((basis) => (
                <option key={basis} value={basis}>
                  {t(`basisG.${basis}`)}
                </option>
              ))}
            </Select>
          </Field>
          {model.can.pay ? (
            <>
              <Field label={t('scheme.guaranteed')}>
                <Input value={draft.guaranteedHourlyRate} inputMode="decimal" onChange={(event) => set?.({ guaranteedHourlyRate: event.target.value })} />
              </Field>
              <Field label={t('scheme.trainee')}>
                <Input value={draft.traineeHourlyRate} inputMode="decimal" onChange={(event) => set?.({ traineeHourlyRate: event.target.value })} />
              </Field>
            </>
          ) : (
            <p className="fw-pr8-hint">{t('scheme.noRates')}</p>
          )}
          {ownSelect(draft.reworkOwnFault, (value) => set?.({ reworkOwnFault: value }), t('scheme.rework'))}
          {ownSelect(draft.scrapOwnFault, (value) => set?.({ scrapOwnFault: value }), t('scheme.scrap'))}
          {(draft.reworkOwnFault === 'REDUCED_RATE' || draft.scrapOwnFault === 'REDUCED_RATE') && (
            <Field label={t('scheme.reduced')} required>
              <Input value={draft.ownFaultRatePct} inputMode="decimal" onChange={(event) => set?.({ ownFaultRatePct: event.target.value })} />
            </Field>
          )}
          {paySelect(draft.othersFaultPay, (value) => set?.({ othersFaultPay: value }), t('scheme.others'))}
          {paySelect(draft.waitingPay, (value) => set?.({ waitingPay: value }), t('scheme.waiting'))}
        </div>
        <Checkbox label={t('scheme.clocked')} checked={draft.payOnlyWhileClockedIn} onChange={(event) => set?.({ payOnlyWhileClockedIn: event.target.checked })} />
        <Field label={t('scheme.note')}>
          <Textarea value={draft.note} rows={2} onChange={(event) => set?.({ note: event.target.value })} />
        </Field>
        <EditModeBar message={t(edit.id ? 'scheme.editing' : 'scheme.newDraft')} count={1} busy={edit.busy} saveShortcut applyLabel={t('scheme.save')} applyHeldReason={held ? said(t, held) : null} onDiscard={() => actions?.onSchemeDiscard()} onApply={() => actions?.onSchemeSave()} />
      </div>
    </Card>
  )
}

function EndDialog({ dialog, model, actions }: { dialog: Extract<PieceDialog, { kind: 'endScheme' }>; model: PieceModel; actions?: PieceActions | undefined }) {
  const t = usePieceWords()
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog()}
      title={t('scheme.endTitle')}
      footer={
        <>
          <Button variant="quiet" onClick={() => actions?.onCloseDialog()}>
            {t('common.keep')}
          </Button>
          <Button variant="danger" heldReason={dialog.busy ? t('common.working') : !dialog.lastDay ? t('scheme.endHeld') : reasonHeld(dialog.reason) ? t('common.reasonHeld') : null} onClick={() => actions?.onEndSchemeSave()}>
            {t('scheme.end')}
          </Button>
        </>
      }
    >
      <div className="fw-pr8-stack">
        {dialog.problem && <Banner tone="danger" title={said(t, dialog.problem)} />}
        <Field label={t('scheme.lastDay')} required>
          <DateField value={dialog.lastDay} min={model.today} onChange={(value) => actions?.onEndSchemeDraft({ lastDay: value })} />
        </Field>
        <Field label={t('common.why')} required>
          <Textarea value={dialog.reason} rows={2} onChange={(event) => actions?.onEndSchemeDraft({ reason: event.target.value })} />
        </Field>
      </div>
    </Modal>
  )
}
