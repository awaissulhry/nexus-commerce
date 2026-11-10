'use client'

import Link from 'next/link'
import { RefreshCw, Send } from 'lucide-react'
import { Banner, Card, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Input, Pill, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { Textarea, useDsWords } from '../../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Notice, Read } from '../../../../../quality/_shared/model'
import { DEPTH_NAMESPACE, DepthMessages } from '../../../substances/frame/parts'
import type { MaterialEvaluation, ProfileRecord } from '../../api'
import { gapKeys, PARAMETER_TONE, tannageKey, profileChanges, profileDraftProblems, STATE_TONE, stateOf, toAsk, VERDICT_TONE, verdictGroups, whyKey, type ProfileDraft, type ProfilesCan } from '../../model'

export interface ProfileCardModel {
  readonly prefix: string
  readonly itemId: string
  readonly can: ProfilesCan
  readonly online: boolean
  readonly profile: Read<ProfileRecord>
  /** What the evaluator says per rule now; null when it is not read (no right). */
  readonly evaluation: Read<MaterialEvaluation> | null
  readonly draft: ProfileDraft | null
  readonly busy: boolean
  readonly notice: Notice | null
}

export interface ProfileCardActions {
  onRetry?: () => void
  onEdit?: (draft: ProfileDraft | null) => void
  onSave?: () => void
  onEvaluate?: () => void
  onDismissNotice?: () => void
}

/**
 * The material's compliance profile (B-W2b-267, SCR-048-profile; design compliance.tests sec:ts-profiles "Row → the material
 * record's Compliance tab"), a card on the material record's Compliance tab: the evaluator's state and what keeps it from
 * complete in our words; composition, tannage (leather), origin and note with their confirmations (one save; the evaluator
 * runs in the same command); the rules that apply with each verdict, its law (LawRef) and what proves it; the declarations
 * needed, present, asked, missing (→ Request declarations); EN ISO 13688 innocuousness for a PPE material; the SVHC answer
 * against the newest Candidate List; the lab results and the requests that ask about it. Fetches nothing.
 */
export function ProfileCardView({ model, actions }: { model: ProfileCardModel; actions?: ProfileCardActions }) {
  return (
    <DepthMessages>
      <Body model={model} actions={actions} />
    </DepthMessages>
  )
}

function Body({ model, actions }: { model: ProfileCardModel; actions?: ProfileCardActions }) {
  const t = useT(DEPTH_NAMESPACE)
  const q = useT('quality')
  const locale = useLocale()
  const ds = useDsWords()
  const header = t('card.title')
  const profile = model.profile.value
  if (model.profile.problem)
    return (
      <Card header={header}>
        <Banner tone="warning" title={t('card.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{q('common.retry')}</Button>}>
          {q(model.profile.problem)}
        </Banner>
      </Card>
    )
  if (!profile)
    return (
      <Card header={header} aria-busy="true">
        <div className="fw-q-stack" role="status" aria-label={q('common.loading')}>
          <Skeleton height={18} width="60%" />
          <Skeleton height={18} width="40%" />
        </div>
      </Card>
    )
  const state = stateOf(profile)
  const gaps = gapKeys(profile)
  const editable = model.can.edit && profile.mayEdit
  const editHeld = !editable ? t('held.substances') : !model.online ? t('held.offline') : null
  const draft = model.draft
  const problems = draft ? profileDraftProblems(draft) : {}
  const changes = draft ? profileChanges(profile, draft) : {}
  const saveHeld = Object.values(problems)[0] ? t(Object.values(problems)[0]!) : Object.keys(changes).length === 0 ? t('card.nothingChanged') : model.busy ? q('common.loading') : null
  const missing = toAsk(profile)
  const askHref = `${model.prefix}/compliance/tests?view=declarations&ask=1&items=${encodeURIComponent(profile.material.id)}${missing.length > 0 ? `&kinds=${missing.join(',')}` : ''}`
  const groups = verdictGroups(model.evaluation?.value ?? null)
  const svhc = model.evaluation?.value?.svhc ?? null
  const verdictRows = [...groups.failed, ...groups.missing, ...groups.met, ...groups.notApplicable]

  return (
    <Card
      header={header}
      description={t('card.description')}
      headerAction={
        <span className="fw-q-actions">
          <Pill tone={STATE_TONE[state]} dot>{t(`state.${state}`)}</Pill>
          <Button size="sm" heldReason={editHeld ?? (model.busy ? q('common.loading') : null)} onClick={() => actions?.onEvaluate?.()}>
            <RefreshCw size={14} aria-hidden /> {t('card.evaluate')}
          </Button>
        </span>
      }
    >
      <div className="fw-q-stack" id="material-profile">
        {model.notice && <Banner tone={model.notice.tone} title={t(model.notice.key, model.notice.params as Record<string, string | number> | undefined)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>{q('common.dismiss')}</Button>} />}
        <p className="fw-q-hint">{profile.evaluatedAt ? t('card.evaluatedAt', { at: formatDateTime(profile.evaluatedAt, { locale }) }) : t('card.neverEvaluated')}</p>
        {state !== 'COMPLETE' && gaps.length > 0 && (
          <ul className="fw-q-lines" aria-label={t('card.gaps')}>
            {gaps.map((gap) => (
              <li key={gap.key}>{t(gap.key, gap.params)}</li>
            ))}
          </ul>
        )}

        <h3 className="fw-mt-h">{t('card.facts')}</h3>
        {draft ? (
          <div className="fw-mt-panel">
            <div className="fw-mt-form">
              <Field label={t('card.composition')} hint={profile.composition ?? t('card.noComposition')}>
                <span className="fw-q-cell-row">
                  <Toggle checked={draft.compositionConfirmed} onChange={(next) => actions?.onEdit?.({ ...draft, compositionConfirmed: next })} aria-label={t('card.compositionConfirmed')} />
                  <span>{t('card.compositionConfirmed')}</span>
                </span>
              </Field>
              {profile.tannageConfirmed !== null && (
                <Field label={t('card.tannage')} hint={tannageKey(profile.tannage) ? t(tannageKey(profile.tannage)!) : (profile.tannage ?? t('card.noTannage'))}>
                  <span className="fw-q-cell-row">
                    <Toggle checked={draft.tannageConfirmed === true} onChange={(next) => actions?.onEdit?.({ ...draft, tannageConfirmed: next })} aria-label={t('card.tannageConfirmed')} />
                    <span>{t('card.tannageConfirmed')}</span>
                  </span>
                </Field>
              )}
              <Field label={t('card.origin')} hint={t('card.originHint')} error={problems.originCountry ? t(problems.originCountry) : undefined}>
                <Input size="sm" value={draft.originCountry} maxLength={2} onChange={(event) => actions?.onEdit?.({ ...draft, originCountry: event.target.value.toUpperCase() })} aria-label={t('card.origin')} />
              </Field>
            </div>
            <Field label={t('card.note')} error={problems.note ? t(problems.note) : undefined}>
              <Textarea rows={2} value={draft.note} maxLength={1000} onChange={(event) => actions?.onEdit?.({ ...draft, note: event.target.value })} />
            </Field>
            <p className="fw-q-hint">{t('card.saveEvaluates')}</p>
            <div className="fw-q-actions">
              <Button size="sm" onClick={() => actions?.onEdit?.(null)}>{q('common.close')}</Button>
              <Button size="sm" variant="primary" heldReason={saveHeld} onClick={() => actions?.onSave?.()}>{t('card.save')}</Button>
            </div>
          </div>
        ) : (
          <>
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={[
                { label: t('card.composition'), value: profile.composition ?? '—', hint: profile.compositionConfirmed ? t('card.confirmedBy', { name: profile.compositionConfirmedBy?.name ?? '—', at: profile.compositionConfirmedAt ? formatDate(profile.compositionConfirmedAt, { locale }) : '—' }) : t('profile.notConfirmed') },
                ...(profile.tannageConfirmed !== null ? [{ label: t('card.tannage'), value: tannageKey(profile.tannage) ? t(tannageKey(profile.tannage)!) : (profile.tannage ?? '—'), hint: profile.tannageConfirmed ? t('card.confirmedBy', { name: profile.tannageConfirmedBy?.name ?? '—', at: profile.tannageConfirmedAt ? formatDate(profile.tannageConfirmedAt, { locale }) : '—' }) : t('profile.notConfirmed') }] : []),
                { label: t('card.origin'), value: profile.originCountry ?? '—' },
                { label: t('card.supplier'), value: profile.supplier ? `${profile.supplier.code} · ${profile.supplier.name}` : t('profile.noSupplier') },
                ...(profile.note ? [{ label: t('card.note'), value: profile.note }] : []),
              ]}
            />
            <div className="fw-q-actions">
              <Button size="sm" heldReason={editHeld} onClick={() => actions?.onEdit?.({ compositionConfirmed: profile.compositionConfirmed, tannageConfirmed: profile.tannageConfirmed, originCountry: profile.originCountry ?? '', note: profile.note ?? '' })}>
                {t('card.edit')}
              </Button>
            </div>
          </>
        )}

        <h3 className="fw-mt-h">{t('card.rules')}</h3>
        {model.evaluation === null ? (
          <p className="fw-q-hint">{t('card.rulesHidden')}</p>
        ) : model.evaluation.problem ? (
          <Banner tone="warning" title={t('card.rulesFailed')}>{q(model.evaluation.problem)}</Banner>
        ) : model.evaluation.value === null ? (
          <Skeleton height={60} />
        ) : verdictRows.length === 0 ? (
          <p className="fw-q-hint">{t('card.noRules')}</p>
        ) : (
          <SummaryTable
            label={t('card.rules')}
            stackOnPhone
            columns={[t('card.col.rule'), t('card.col.law'), t('card.col.verdict'), t('card.col.proof')]}
            rows={verdictRows.map((rule) => ({
              id: rule.ruleId,
              cells: [
                <span key="r" className="fw-q-cell">
                  <span className="fw-q-code">{rule.key}</span>
                  <span className="fw-q-hint">{t(`ruleCode.${rule.code}`)}</span>
                </span>,
                <LawRef key="l" law={rule.legalReference} plain={t(`ruleCodeWhat.${rule.code}`)} labels={ds.lawRef} />,
                <Pill key="v" tone={VERDICT_TONE[rule.status]} dot>{t(`verdict.${rule.status}`)}</Pill>,
                <span key="p" className="fw-q-hint">
                  {rule.status === 'NOT_APPLICABLE'
                    ? t(whyKey(rule.why))
                    : rule.status === 'MET'
                      ? t(rule.metBy === 'TEST' ? 'card.metByTest' : 'card.metByDeclaration')
                      : rule.asked
                        ? t('card.asked', { number: rule.asked.number, due: formatDate(rule.asked.dueOn, { locale }) })
                        : t(rule.needs.test && rule.needs.declaration ? 'card.needsEither' : rule.needs.test ? 'card.needsTest' : 'card.needsDeclaration', { test: rule.needs.test ? t(`test.${rule.needs.test}`) : '', kind: rule.needs.declaration ? t(`kind.${rule.needs.declaration}`) : '' })}
                </span>,
              ],
            }))}
          />
        )}

        <h3 className="fw-mt-h">{t('card.declarations')}</h3>
        <div className="fw-mt-tags">
          {profile.declarations.needed.length === 0 && <span className="fw-q-hint">{t('profile.noneNeeded')}</span>}
          {profile.declarations.present.map((kind) => <Tag key={`p-${kind}`} tone="success">{t('profile.present', { kind: t(`kindShort.${kind}`) })}</Tag>)}
          {profile.declarations.missing.map((kind) => <Tag key={`m-${kind}`} tone={profile.declarations.asked.includes(kind) ? 'info' : 'warning'}>{t(profile.declarations.asked.includes(kind) ? 'profile.asked' : 'profile.missing', { kind: t(`kindShort.${kind}`) })}</Tag>)}
          {profile.testsNeeded.map((test) => <Tag key={`t-${test}`} tone="neutral">{t('card.testNeeded', { test: t(`test.${test}`) })}</Tag>)}
        </div>
        {model.can.ask && missing.length > 0 && (
          <div className="fw-q-actions">
            <Link className="fw-mt-link" href={askHref}>
              <Send size={14} aria-hidden /> {t('card.askMissing', { count: missing.length })}
            </Link>
          </div>
        )}
        {profile.declarationRequests.length > 0 && (
          <SummaryTable
            label={t('card.requests')}
            stackOnPhone
            columns={[t('decl.col.number'), t('decl.col.kind'), t('card.col.party'), t('decl.col.due'), t('decl.col.validTo')]}
            rows={profile.declarationRequests.map((request) => ({
              id: request.requestId,
              cells: [
                <Link key="n" className="fw-q-code" href={`${model.prefix}/compliance/tests?view=declarations&open=${encodeURIComponent(request.requestId)}`}>{request.number}</Link>,
                t(`kind.${request.kind}`),
                request.party.code,
                formatDate(request.dueOn, { locale }),
                request.validTo ? formatDate(request.validTo, { locale }) : '—',
              ],
            }))}
          />
        )}

        {profile.innocuousnessDetail.required && (
          <>
            <h3 className="fw-mt-h">{t('card.innocuousness')}</h3>
            <p className="fw-q-hint">{t('card.innocuousnessWhy', { styles: profile.innocuousnessDetail.ppeStyles.join(', ') || '—' })}</p>
            <SummaryTable
              label={t('card.innocuousness')}
              stackOnPhone
              columns={[t('card.col.parameter'), t('card.col.status'), t('card.col.evidence')]}
              rows={profile.innocuousnessDetail.parameters.map((entry) => ({
                id: entry.parameter,
                cells: [
                  t(`parameter.${entry.parameter}`),
                  <Tag key="s" tone={PARAMETER_TONE[entry.status]}>{t(`parameterStatus.${entry.status}`)}</Tag>,
                  entry.result ? t('card.resultOn', { verdict: t(`labVerdict.${entry.result.verdict}`), day: formatDate(entry.result.testedOn, { locale }) }) : entry.files.length > 0 ? t('card.files', { count: entry.files.length }) : '—',
                ],
              }))}
            />
          </>
        )}

        {svhc && (
          <>
            <h3 className="fw-mt-h">{t('card.svhc')}</h3>
            <p>
              {t(svhc.aboveThreshold === null ? 'card.svhcUnknown' : svhc.aboveThreshold ? 'card.svhcAbove' : 'card.svhcNone', { count: svhc.substances.length })}{' '}
              {svhc.listVersion && <span className="fw-q-hint">{t(svhc.current ? 'card.svhcCurrent' : 'card.svhcOld', { day: formatDate(svhc.listVersion.publishedOn, { locale }), grew: svhc.grewBy ?? 0 })}</span>}
            </p>
            {svhc.substances.length > 0 && <p className="fw-q-hint">{svhc.substances.map((substance) => `${substance.name}${substance.casNumber ? ` (${substance.casNumber})` : ''}`).join('; ')}</p>}
          </>
        )}

        {profile.labResults.length > 0 && (
          <>
            <h3 className="fw-mt-h">{t('card.results')}</h3>
            <SummaryTable
              label={t('card.results')}
              stackOnPhone
              columns={[t('card.col.lot'), t('card.col.test'), t('card.col.result'), t('card.col.tested')]}
              rows={profile.labResults.slice(0, 10).map((result) => ({
                id: result.resultId,
                cells: [
                  result.lot.code,
                  t(`test.${result.test}`),
                  <span key="v" className="fw-q-cell-row">
                    <Tag tone={result.verdict === 'PASS' ? 'success' : 'danger'}>{t(`labVerdict.${result.verdict === 'PASS' ? 'PASS' : 'FAIL'}`)}</Tag>
                    <span className="fw-q-hint">{result.belowDetectionLimit ? t('card.notDetected') : `${result.value ?? '—'} / ${result.limit} ${result.unit}`}</span>
                    {!result.current && <span className="fw-q-hint">{t('card.superseded')}</span>}
                  </span>,
                  formatDate(result.testedOn, { locale }),
                ],
              }))}
            />
          </>
        )}
      </div>
    </Card>
  )
}
