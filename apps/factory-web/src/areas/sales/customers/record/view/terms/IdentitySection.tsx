'use client'

import type { ReactElement, ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Eye, Hourglass, Pencil, Plus, RefreshCw } from 'lucide-react'
import { Button, Tag } from '@nexus/ui/primitives'
import { Fold } from '../../../../orders/record/money/view/parts'
import { BalancedFacts } from './CommercialSection' // ct-fx3 G-W06: the facts balanced by their count
import { RESULT_TONE } from '../../../../../parties/_shared/model' // the record's own tones of a VIES result
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, Quiet, Section } from '../../../../orders/record/view/production/Kit'
import type { DatedIdentityRow, IdentityFact, ViesRowModel } from '../../terms/identity'
import { kitProblemOf, said, termsKitId, type Say } from '../../terms/model'
import type { TermsTabActions, TermsTabModel } from '../../terms/tab'
import { menuOf, useTermsSay } from './say'
import { SectionAnswer } from './TermsAnswer' // ct-fx3 G-W09

/**
 * F-CT-517 (customer page › TERMS & REQUIREMENTS tab, lane ct-; 10-design §5.4; 18-lead-settles D2, Z3, Z7, Z21, Z22, Z23) — section 4,
 * Tax identity & e-invoice (#party-identity): the identity in force as Money's facts (the codice fiscale of a person only for those who
 * may change customers, said once; the e-invoice as ONE fact, the fiscal drawer a warning), then — for an EU business outside Italy —
 * the VIES row UNDER the facts (Z21): no answer is never "not valid", the proof and its days left, what VIES gave, Check again, every
 * check folded (the 50 newest, "Show 50 more"). The earlier and later identities folded. Head: Correct… · New identity from a date… ·
 * ⋯ · ⓘ — the record's own identity window; Check again the record's own act. Draws its model; reads nothing.
 */

export function IdentitySection({ model, actions }: { model: TermsTabModel; actions?: TermsTabActions | undefined }): ReactElement {
  const say = useTermsSay()
  const id = model.identity
  const title = say(said('ct.id.title'))
  const marked = new Set(model.marked)
  const buttons = [
    ...(id.correct.shown
      ? [
          <Button key="correct" size="sm" heldReason={id.correct.held ? say(id.correct.held) : null} onClick={() => actions?.onCorrectIdentity?.()}>
            <Pencil size={14} aria-hidden /> {say(said('parties:identity.correct'))}
          </Button>,
        ]
      : []),
    ...(id.add.shown
      ? [
          <Button key="new" size="sm" heldReason={id.add.held ? say(id.add.held) : null} onClick={() => actions?.onNewIdentity?.()}>
            <Plus size={14} aria-hidden /> {say(said(id.none ? 'parties:identity.addFirst' : 'parties:identity.newFromDate'))}
          </Button>,
        ]
      : []),
  ]
  const more = menuOf([
    [
      id.vies && id.vies.checks.length > 0 ? { id: 'checks', label: say(id.vies.checksOpen ? said('ct.id.hideChecks') : said('ct.id.checksMenu')), onSelect: () => actions?.onFold?.('checks', !id.vies!.checksOpen) } : null,
      id.earlier.length > 0 ? { id: 'earlier', label: say(id.earlierOpen ? said('ct.id.hideEarlier') : said('ct.id.earlierMenu', { params: { count: id.earlier.length } })), onSelect: () => actions?.onFold?.('earlier', !id.earlierOpen) } : null,
    ],
    [{ id: 'link', label: say(said('ct.copyLink', { params: { section: title } })), onSelect: () => actions?.onCopyLink?.('party-identity') }],
  ])
  const head = {
    id: termsKitId('party-identity'),
    title,
    buttons,
    more: <LineMenuButton label={say(said('ct.more', { params: { section: title } }))} items={more} />,
    info: (
      <>
        <p>{say(said('ct.id.info.what'))}</p>
        <p>{say(said('ct.id.info.vies'))}</p>
        <p>{say(said('ct.id.info.person'))}</p>
        <p>{say(said('ct.keys'))}</p>
      </>
    ),
  }
  if (id.none)
    return (
      <Section {...head} answer={<SectionAnswer marked={marked.has('party-identity')}>{say(id.answer)}</SectionAnswer>}>
        {null}
      </Section>
    )
  return (
    <Section {...head} answer={<SectionAnswer marked={marked.has('party-identity')}>{say(id.answer)}</SectionAnswer>}>
      <div className="fw-ctr-idw">
        <div className="fw-ctr-id">
          <BalancedFacts facts={id.facts.map((fact) => ({ key: fact.key, label: say(fact.label), value: <FactValue fact={fact} marked={fact.anchor ? marked.has(fact.anchor) : false} say={say} /> }))} />
          {id.earlier.length > 0 ? (
            <>
              <div className="fw-ctr-foldw">
                <Fold open={id.earlierOpen} onToggle={() => actions?.onFold?.('earlier', !id.earlierOpen)} label={say(said('ct.id.earlier', { params: { count: id.earlier.length } }))} />
              </div>
              {id.earlierOpen ? <DatedList rows={id.earlier} label={said('ct.id.earlierList')} say={say} /> : null}
            </>
          ) : null}
          {id.later.length > 0 ? (
            <>
              <div className="fw-ctr-foldw">
                <Fold open={id.laterOpen} onToggle={() => actions?.onFold?.('later', !id.laterOpen)} label={say(said('ct.id.later', { params: { count: id.later.length }, days: { date: id.laterFrom ?? '' } }))} />
              </div>
              {id.laterOpen ? <DatedList rows={id.later} label={said('ct.id.laterList')} say={say} /> : null}
            </>
          ) : null}
          {id.viesNotNeeded ? (
            <Quiet>
              <CheckCircle2 size={14} aria-hidden /> {say(id.viesNotNeeded)}
            </Quiet>
          ) : null}
          {id.vies ? <ViesRow vies={id.vies} marked={marked.has(id.vies.anchor)} say={say} actions={actions} /> : null}
        </div>
      </div>
      <p className="fw-ctr-foot">
        <Eye size={13} aria-hidden />
        <span>{say(id.foot)}</span>
      </p>
    </Section>
  )
}

function FactValue({ fact, marked, say }: { fact: IdentityFact; marked: boolean; say: Say }) {
  const words = say(fact.value)
  // ct-fx3 G-W11: a code inside the words is monospace on its own ("By SDI code ‹FAKE001›"), the sentence keeps the text face.
  const at = fact.code ? words.indexOf(fact.code) : -1
  const value: ReactNode = fact.warning ? (
    <span className="fw-ctr-warn">
      <CircleAlert size={13} aria-hidden /> {words}
    </span>
  ) : at >= 0 ? (
    <span>
      {words.slice(0, at)}
      <span className="fw-ctr-mono">{fact.code}</span>
      {words.slice(at + fact.code!.length)}
    </span>
  ) : (
    <span className={fact.none ? 'fw-ctr-none' : fact.mono ? 'fw-ctr-mono' : undefined}>{words}</span>
  )
  return (
    <span className={`fw-ctr-val${marked ? ' is-mark' : ''}`} id={fact.anchor}>
      {value}
      {(fact.subs ?? []).map((sub, at) => (
        <span key={at} className="fw-ctr-sub">
          {say(sub)}
        </span>
      ))}
    </span>
  )
}

function ViesRow({ vies, marked, say, actions }: { vies: ViesRowModel; marked: boolean; say: Say; actions?: TermsTabActions | undefined }) {
  return (
    <div className={`fw-ctr-vies${marked ? ' is-mark' : ''}`} id={vies.anchor}>
      <div className="fw-ctr-vh">
        <h3 className="fw-pt-h3">{say(said('parties:vies.title'))}</h3>
        {vies.checkAgain.shown ? (
          <Button size="sm" heldReason={vies.checkAgain.held ? say(vies.checkAgain.held) : null} onClick={() => actions?.onCheckVies?.()}>
            <RefreshCw size={14} aria-hidden /> {say(said('parties:vies.checkAgain'))}
          </Button>
        ) : null}
      </div>
      {vies.noAnswer ? (
        <p className="fw-ctr-vl">
          <Tag tone="warning">{say(said('parties:vies.result.ERROR'))}</Tag>
          <span>{say(said('ct.id.noAnswer', { days: { date: vies.noAnswer.at }, words: { why: said('parties:vies.noAnswer') } }))}</span>
        </p>
      ) : null}
      {vies.proof ? (
        <p className="fw-ctr-vl">
          <Tag tone={RESULT_TONE[vies.proof.result]}>{say(said(`parties:vies.result.${vies.proof.result}`))}</Tag>
          <span>{say(said(vies.proof.stillCounts ? 'ct.id.proofStill' : 'ct.id.checked', { days: { date: vies.proof.at } }))}</span>
          {vies.until ? (
            vies.until.warning ? (
              <Tag tone="warning">
                <Hourglass size={12} aria-hidden /> {say(said('ct.id.until', { days: { date: vies.until.date }, params: { count: vies.until.days } }))}
              </Tag>
            ) : (
              <span>{say(said('ct.id.until', { days: { date: vies.until.date }, params: { count: vies.until.days } }))}</span>
            )
          ) : null}
        </p>
      ) : (
        <p className="fw-ctr-vl">
          <span>{say(said('parties:vies.notYet'))}</span>
        </p>
      )}
      {vies.facts.length > 0 ? <BalancedFacts facts={vies.facts.map((fact) => ({ key: fact.key, label: say(fact.label), value: <FactValue fact={fact} marked={false} say={say} /> }))} /> : null}
      {vies.checksProblem ? (
        <PartFailed part={say(said('ct.id.checksPart'))} problem={kitProblemOf(vies.checksProblem)} onRetry={actions?.onRetryChecks /* ct-fx3 G-W08 */} />
      ) : vies.checks.length > 0 ? (
        <>
          <div className="fw-ctr-foldw">
            <Fold open={vies.checksOpen} onToggle={() => actions?.onFold?.('checks', !vies.checksOpen)} label={say(said(vies.more ? 'ct.id.checksNewest' : 'ct.id.checks', { params: { count: vies.checks.length } }))} />
          </div>
          {vies.checksOpen ? (
            <>
              <div className="fw-ctr-ls" role="list" aria-label={say(said('parties:vies.history'))}>
                <div className="fw-ctr-hd is-v" aria-hidden>
                  <div>{say(said('parties:vies.checkedAt'))}</div>
                  <div>{say(said('parties:vies.resultLabel'))}</div>
                  <div>{say(said('parties:vies.consultation'))}</div>
                  <div>{say(said('parties:vies.number'))}</div>
                </div>
                {vies.checks.map((check) => (
                  <div key={check.id} className="fw-ctr-row is-v" role="listitem">
                    <div>
                      <span>{say(said('ct.day', { days: { date: check.at } }))}</span>
                    </div>
                    <div>
                      <Tag tone={RESULT_TONE[check.result]}>{say(said(`parties:vies.result.${check.result}`))}</Tag>
                    </div>
                    <div>
                      <span className="fw-ctr-mono">{check.consultation ?? '—'}</span>
                    </div>
                    <div>
                      <span className="fw-ctr-mono">{check.number}</span>
                    </div>
                  </div>
                ))}
              </div>
              {vies.more ? (
                <Button size="sm" variant="quiet" className="fw-ctr-more" onClick={() => actions?.onMoreChecks?.()}>
                  {say(said('ct.id.moreChecks'))}
                </Button>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function DatedList({ rows, label, say }: { rows: readonly DatedIdentityRow[]; label: ReturnType<typeof said>; say: Say }) {
  return (
    <div className="fw-ctr-ls" role="list" aria-label={say(label)}>
      {rows.map((row) => (
        <div key={row.id} className="fw-ctr-row is-e" role="listitem">
          <div>
            <span>
              <b>{say(row.when)}</b> · {say(row.mode)}
            </span>
            {row.subs.length > 0 ? <span className="fw-ctr-sub">{row.subs.map(say).join(' · ')}</span> : null}
          </div>
        </div>
      ))}
    </div>
  )
}
