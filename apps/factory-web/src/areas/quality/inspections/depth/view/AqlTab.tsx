'use client'

import { Banner, EmptyState, Field, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Button, Radio, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { AqlSummary } from '../../../_shared/aql/AqlSummary'
import { Facts, Section } from '../../../_shared/parts'
import type { Read } from '../../../_shared/model'
import type { AqlResult, InspectionAql, ProfilePick, Sheet } from '../api'
import { useDepthT } from '../parts'
import type { ProfileDraft } from '../use-final-depth'

export interface AqlTabModel {
  readonly aql: Read<InspectionAql> | null
  /** The sheet of an inspection on a plan: the counter from the bench (inspected, the stop rule). */
  readonly sheet: Read<Sheet> | null
  /** Why Change profile is held before anything else (no right, not the viewer's), a key of `inspections-depth`, or null. */
  readonly changeHeld: string | null
  readonly profiles: Read<readonly ProfilePick[]> | null
  readonly profileDraft: ProfileDraft | null
  readonly profileBusy: boolean
  readonly profileProblem: string | null
}

export interface AqlTabActions {
  onRetry?: () => void
  onOpenProfile?: () => void
  onProfileDraft?: (draft: ProfileDraft | null) => void
  onSaveProfile?: () => void
}

const STATE_TONE = { ok: 'success', limit: 'warning', reject: 'danger' } as const

/**
 * Inspection › Sample & AQL (design rec:Inspection/aql, QHS-020, QHS-021; read only: the counts come from the bench). How
 * the sample was chosen — the derivation in one sentence and the class table (B-W2b-104's AqlSummary from GET
 * /quality/aql/inspections/:id, never worked out a second time here) — then the result now per class (found against accept
 * and reject, in words: "Major: 3 found, accept up to 3 — passes. One more rejects the lot."), the progress ("38 of 50
 * inspected") and the stop rule in force; the AQL profile and where it comes from (style › customer › company default), and
 * Change profile: held once counting starts, a fixed sample takes none, another profile than the chain's needs the reason.
 * A W1 inspection shows its typed plan.
 */
export function AqlTab({ model, actions }: { model: AqlTabModel; actions?: AqlTabActions }) {
  const td = useDepthT()
  const t = useT('quality')
  const locale = useLocale()
  const read = model.aql
  if (!read || (read.value === null && !read.problem)) {
    return (
      <div className="fw-q-stack">
        <Section id="aql" title={td('aql.heading')}>
          <Skeleton width="100%" height={160} />
        </Section>
      </div>
    )
  }
  if (read.problem || !read.value) {
    return (
      <Section id="aql" title={td('aql.heading')}>
        <EmptyState
          title={td('aql.failed')}
          description={t(read.problem ?? 'problem.unknown')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Section>
    )
  }
  const aql = read.value
  const counter = model.sheet?.value?.counter ?? null
  const progress = counter ? { inspected: counter.inspected, sampleSize: counter.sampleSize } : aql.result.progress
  const percent = progress && progress.sampleSize > 0 ? Math.min(100, Math.round((progress.inspected / progress.sampleSize) * 100)) : null
  const changeHeld =
    model.changeHeld ?? (aql.fixedSample ? 'aql.held.fixed' : aql.frozen ? 'aql.held.frozen' : aql.inspection.status !== 'OPEN' ? 'aql.held.signed' : !aql.mayApply ? 'aql.held.mayNot' : null)
  const source = aql.profile ? td('aql.profile.named', { code: aql.profile.code, name: aql.profile.name }) : aql.fixedSample ? td('aql.profile.fixed') : td('aql.profile.typed')
  const chainWords = locale.startsWith('it') ? aql.chain.sourceWords.it : aql.chain.sourceWords.en
  const draft = model.profileDraft
  const otherHeld = draft?.profileId && draft.reason.trim().length < 3 ? td('aql.change.reasonNeeded') : null
  return (
    <div className="fw-q-stack">
      <div className="fw-qd-two">
        <Section id="aql" title={td('aql.heading')} sub={td('aql.readOnly')}>
          {aql.plan ? (
            <AqlSummary plan={aql.plan} source={source} title={td('aql.derivation')} headingLevel={4} />
          ) : (
            <>
              <p className="fw-q-hint">{aql.fixedSample ? td('aql.fixedWords', { sample: aql.inspection.sampleSize, lot: aql.inspection.lotSize }) : td('aql.typedWords')}</p>
              <Facts
                items={[
                  { label: t('plan.lot'), value: aql.inspection.lotSize },
                  { label: t('plan.sample'), value: aql.inspection.sampleSize },
                  { label: t('plan.level'), value: aql.inspection.inspectionLevel },
                  { label: t('plan.aqlMajor'), value: t('plan.aqlAccept', { aql: aql.inspection.aqlMajor, accept: aql.inspection.acceptMajor }) },
                  { label: t('plan.aqlMinor'), value: t('plan.aqlAccept', { aql: aql.inspection.aqlMinor, accept: aql.inspection.acceptMinor }) },
                ]}
              />
            </>
          )}
        </Section>
        <Section id="aql-now" title={td('aql.now')} sub={td(`aql.verdict.${aql.result.verdict}`)}>
          {progress && (
            <div className="fw-qd-progress">
              <span>{td('aql.progress', { inspected: progress.inspected, sample: progress.sampleSize })}</span>
              <ProgressBar ariaLabel={td('aql.progress', { inspected: progress.inspected, sample: progress.sampleSize })} value={percent} tone={progress.inspected >= progress.sampleSize ? 'complete' : 'partial'} />
            </div>
          )}
          <AqlResultTable result={aql.result} />
          {counter && <p className="fw-q-hint">{td(counter.stop.stop ? 'aql.stop.on' : 'aql.stop.off', { source: td(`aql.stop.source.${counter.stop.source}`) })}</p>}
          <p className="fw-q-hint">{td('aql.bench')}</p>
        </Section>
      </div>
      <Section
        id="aql-profile"
        title={td('aql.profile.heading')}
        sub={source}
        actions={
          <Button size="sm" onClick={() => actions?.onOpenProfile?.()} heldReason={changeHeld ? td(changeHeld) : null}>
            {td('aql.change.open')}
          </Button>
        }
      >
        <Facts
          items={[
            { label: td('aql.profile.inForce'), value: aql.profile ? `${aql.profile.code} · ${aql.profile.name}` : '—' },
            { label: td('aql.profile.appliesNow'), value: aql.chain.profile ? `${aql.chain.profile.code} · ${aql.chain.profile.name}` : td('aql.profile.noneNow') },
            { label: td('aql.profile.from'), value: chainWords },
            { label: td('aql.profile.letter'), value: aql.inspection.codeLetter ?? '—' },
          ]}
        />
        {aql.chain.steps.length > 0 && (
          <ol className="fw-q-lines fw-qd-chain" aria-label={td('aql.profile.chain')}>
            {aql.chain.steps.map((step, index) => (
              <li key={`${step.source}-${index}`}>
                {td(`aql.source.${step.source}`)} {step.profileCode ? <span className="fw-q-code">{step.profileCode}</span> : <span className="fw-q-hint">{td('aql.profile.stepNone')}</span>}
              </li>
            ))}
          </ol>
        )}
        {aql.matchesProfile === false && <Banner tone="warning" title={td('aql.profile.differs')} />}
      </Section>

      <Modal
        open={draft !== null}
        onClose={() => actions?.onProfileDraft?.(null)}
        title={td('aql.change.title')}
        subtitle={td('aql.change.subtitle')}
        footer={
          <>
            <span className="grow" />
            <Button onClick={() => actions?.onProfileDraft?.(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => actions?.onSaveProfile?.()} heldReason={model.profileBusy ? t('common.working') : otherHeld}>
              {td('aql.change.apply')}
            </Button>
          </>
        }
      >
        {draft && (
          <div className="fw-q-form">
            <fieldset className="fw-q-choices">
              <legend>
                <strong>{td('aql.change.which')}</strong>
              </legend>
              <Radio name="aql-profile" checked={draft.profileId === null} onChange={() => actions?.onProfileDraft?.({ profileId: null, reason: '' })} label={td('aql.change.chain', { profile: aql.chain.profile ? `${aql.chain.profile.code} · ${aql.chain.profile.name}` : td('aql.profile.noneNow') })} />
              <Radio
                name="aql-profile"
                checked={draft.profileId !== null}
                disabled={!model.profiles}
                onChange={() => actions?.onProfileDraft?.({ profileId: model.profiles?.value?.[0]?.id ?? '', reason: draft.reason })}
                label={model.profiles ? td('aql.change.other') : td('aql.change.otherHeld')}
              />
            </fieldset>
            {draft.profileId !== null && (
              <>
                <Field label={td('aql.change.profile')}>
                  {model.profiles?.problem ? (
                    <p className="fw-q-hint">{t(model.profiles.problem)}</p>
                  ) : (
                    <Select size="sm" aria-label={td('aql.change.profile')} value={draft.profileId} onChange={(event) => actions?.onProfileDraft?.({ ...draft, profileId: event.target.value })}>
                      {(model.profiles?.value ?? []).map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {td('aql.change.option', { code: profile.code, name: profile.name, level: profile.levelText, major: profile.aqlMajor, minor: profile.aqlMinor })}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={td('aql.change.reason')} hint={td('aql.change.reasonHint')} required>
                  <Textarea rows={2} value={draft.reason} onChange={(event) => actions?.onProfileDraft?.({ ...draft, reason: event.target.value })} />
                </Field>
              </>
            )}
            <p className="fw-q-hint">{td('aql.change.after')}</p>
            {model.profileProblem && <Banner tone="danger" title={td(model.profileProblem.startsWith('aql.') ? model.profileProblem : 'aql.profile.refused')}>{model.profileProblem.startsWith('aql.') ? null : t(model.profileProblem)}</Banner>}
          </div>
        )}
      </Modal>
    </div>
  )
}

/** The result now per class: found against accept and reject, the verdict as a word, and one sentence per class. */
export function AqlResultTable({ result }: { result: Pick<AqlResult, 'classes'> }) {
  const td = useDepthT()
  const ta = useT('quality-aql')
  const className = (klass: string) => ta(`class.${klass}`)
  return (
    <>
      <SummaryTable
        label={td('aql.now')}
        columns={[td('aql.col.class'), td('aql.col.aql'), td('aql.col.accept'), td('aql.col.reject'), td('aql.col.found'), td('aql.col.verdict')]}
        rows={result.classes.map((entry) => ({
          id: entry.defectClass,
          cells: [
            className(entry.defectClass),
            entry.aql,
            entry.accept,
            entry.reject,
            entry.found,
            <Tag key="v" tone={STATE_TONE[entry.state]}>
              {td(`aql.state.${entry.state}`)}
            </Tag>,
          ],
        }))}
        align={[undefined, 'right', 'right', 'right', 'right']}
        stackOnPhone
      />
      <ul className="fw-q-lines">
        {result.classes.map((entry) => (
          <li key={entry.defectClass}>{td(`aql.line.${entry.state}`, { klass: className(entry.defectClass), found: entry.found, accept: entry.accept, reject: entry.reject })}</li>
        ))}
      </ul>
    </>
  )
}
