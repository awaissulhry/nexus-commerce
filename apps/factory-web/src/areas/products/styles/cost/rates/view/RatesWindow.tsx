'use client'

import { Info } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, Skeleton, Toggle } from '@nexus/ui/primitives'
import type { Department } from '../../../../../../lib/department/model'
import { DeptChip } from '../../../../../../lib/department/view/DeptChip'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../../lib/i18n/provider'
import { WindowShell } from '../../../../../../lib/window-shell/view/WindowShell'
import type { Words } from '../../now/model'
import type { LeatherBasis } from '../api'
import type { RateDraft } from '../model'
import '../../now/cost.css'

/**
 * owb-pd5b step 5.4 (S4; design plan § 5zh "The factory's rates"; prototype cost.js costModal) — ONE window for every product: the cost of
 * one minute of work in each department (the department's own rate wins over its kind's; the kind's is shown as the fallback) and its
 * planned efficiency, the overhead on the materials and the work, the leathers against the reference (their yield; kept in Finance ›
 * Costing), and the company switch "One person may keep a cost" (with a reason; only for the person who may change the costing
 * settings). Read only without that right (Close only). What is typed stays when Save is refused; each refused field says why.
 */

export interface RateRowModel {
  readonly departmentId: string
  readonly dept: Department
  /** The rate the window counts with now (typed, the department's own, its kind's, none). */
  readonly preview: { readonly cpm: string | null; readonly eff: string | null; readonly from: 'TYPED' | 'DEPARTMENT' | 'KIND' | 'NONE' }
  /** Its kind's rate, the fallback (null: none). */
  readonly kind: { readonly cpm: string | null; readonly eff: string } | null
  readonly draft: RateDraft
}

export interface RatesWindowModel {
  readonly state: 'reading' | 'failed' | 'ready'
  readonly problem: string | null
  /** costing.rates.manage: the fields and the switch. */
  readonly change: boolean
  readonly rows: readonly RateRowModel[]
  readonly overhead: string
  readonly oneKeeper: boolean
  /** The switch as it is saved (a change asks for a reason). */
  readonly oneKeeperSaved: boolean
  readonly reason: string
  readonly leathers: readonly LeatherBasis[]
  /** Refused fields, by field key (`cpm.<id>`, `eff.<id>`, `overhead`, `reason`). */
  readonly problems: Readonly<Record<string, Words>>
  readonly held: Words | null
  readonly busy: boolean
  readonly saveProblem: Words | null
  readonly money: (amount: string | null | undefined) => string
}

export interface RatesWindowActions {
  readonly onCpm: (departmentId: string, text: string) => void
  readonly onEff: (departmentId: string, text: string) => void
  readonly onOverhead: (text: string) => void
  readonly onOneKeeper: (on: boolean) => void
  readonly onReason: (text: string) => void
  readonly onSave: () => void
  readonly onClose: () => void
  readonly onRetry: () => void
}

export function RatesWindow({ model, actions }: { model: RatesWindowModel; actions: RatesWindowActions }) {
  const t = useT('products-cost')
  const say = (words: Words) => t(words.key, words.params)
  const problem = (key: string) => (model.problems[key] ? say(model.problems[key]!) : undefined)
  const fromWords = (row: RateRowModel) =>
    row.preview.from === 'DEPARTMENT'
      ? t('rates.from.department')
      : row.kind
        ? t('rates.from.kind', { amount: row.kind.cpm === null ? '—' : model.money(row.kind.cpm), eff: Number(row.kind.eff) })
        : t('rates.from.none')
  return (
    <WindowShell
      open
      onClose={actions.onClose}
      size="xl"
      title={t('rates.title')}
      subtitle={t('rates.subtitle')}
      act={model.change && model.state === 'ready' ? { words: t('rates.save'), onAct: actions.onSave, held: model.held ? say(model.held) : null, busy: model.busy } : null}
    >
      <div className="fw-ct-rates">
        {model.state === 'reading' && <Skeleton height={160} />}
        {model.state === 'failed' && (
          <Banner
            tone="danger"
            title={t('rates.failed')}
            action={
              <Button size="sm" onClick={actions.onRetry}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(model.problem ?? 'problem.unavailable')}
          </Banner>
        )}
        {model.state === 'ready' && (
          <>
            <p className="fw-ct-note">
              <Info size={14} aria-hidden /> {t('rates.moves')}
            </p>
            {!model.change && <p className="fw-ct-hint">{t('rates.readOnly')}</p>}

            <section aria-labelledby="fw-ct-rates-dept">
              <h3 id="fw-ct-rates-dept" className="fw-ct-hint">
                {t('rates.perMinute')}
              </h3>
              {model.rows.length === 0 && <p className="fw-ct-hint">{t('rates.noDepartments')}</p>}
              {model.rows.map((row) => (
                <div key={row.departmentId} className="fw-ct-rate">
                  <DeptChip dept={row.dept} />
                  {model.change ? (
                    <>
                      <Field label={t('rates.cpm')} error={problem(`cpm.${row.departmentId}`)}>
                        <Input size="sm" inputMode="decimal" prefix="€" value={row.draft.cpm} placeholder={row.preview.cpm === null ? '' : String(Number(row.preview.cpm))} aria-label={t('rates.cpmOf', { name: row.dept.shortName })} onChange={(event) => actions.onCpm(row.departmentId, event.target.value)} />
                      </Field>
                      <Field label={t('rates.eff')} error={problem(`eff.${row.departmentId}`)}>
                        <Input size="sm" inputMode="decimal" suffix="%" value={row.draft.eff} placeholder={row.preview.eff === null ? '' : String(Number(row.preview.eff))} aria-label={t('rates.effOf', { name: row.dept.shortName })} onChange={(event) => actions.onEff(row.departmentId, event.target.value)} />
                      </Field>
                    </>
                  ) : (
                    <>
                      <span className="fw-ct-num">{row.preview.cpm === null ? '—' : t('rates.perMinuteIs', { amount: model.money(row.preview.cpm) })}</span>
                      <span className="fw-ct-num">{row.preview.eff === null ? '—' : t('rates.effIs', { pct: Number(row.preview.eff) })}</span>
                    </>
                  )}
                  <span className="fw-ct-hint">{fromWords(row)}</span>
                </div>
              ))}
            </section>

            <div className="fw-ct-three">
              {model.change ? (
                <Field label={t('rates.overhead')} hint={t('rates.overheadHint')} error={problem('overhead')}>
                  <Input inputMode="decimal" suffix="%" value={model.overhead} onChange={(event) => actions.onOverhead(event.target.value)} />
                </Field>
              ) : (
                <p className="fw-ct-hint">{model.overhead ? t('rates.overheadIs', { pct: model.overhead }) : t('rates.noOverhead')}</p>
              )}
              <section aria-labelledby="fw-ct-rates-leather">
                <h3 id="fw-ct-rates-leather" className="fw-ct-hint">
                  {t('rates.leathers')}
                </h3>
                {model.leathers.length === 0 ? (
                  <p className="fw-ct-hint">{t('rates.noLeathers')}</p>
                ) : (
                  <ul className="fw-ct-list">
                    {model.leathers.map((leather) => (
                      <li key={leather.id}>
                        <b>{leather.item.code}</b> {leather.item.name} · {t('rates.yield', { pct: Number(leather.expectedYieldPct) })}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="fw-ct-hint">{t('rates.leathersWhere')}</p>
              </section>
            </div>

            {model.change && (
              <section aria-labelledby="fw-ct-rates-keeper" className="fw-ct-body">
                <label className="fw-ct-name">
                  <Toggle size="sm" checked={model.oneKeeper} onChange={actions.onOneKeeper} />
                  <span id="fw-ct-rates-keeper">
                    <b>{t('rates.oneKeeper')}</b>
                  </span>
                </label>
                <p className="fw-ct-hint">{t(model.oneKeeper ? 'rates.oneKeeperOn' : 'rates.oneKeeperOff')}</p>
                {model.oneKeeper !== model.oneKeeperSaved && (
                  <Field label={t('rates.reason')} required error={problem('reason')}>
                    <Textarea value={model.reason} rows={2} maxLength={200} onChange={(event) => actions.onReason(event.target.value)} />
                  </Field>
                )}
              </section>
            )}
            {model.saveProblem && <Banner tone="danger" title={say(model.saveProblem)} />}
          </>
        )}
      </div>
    </WindowShell>
  )
}
