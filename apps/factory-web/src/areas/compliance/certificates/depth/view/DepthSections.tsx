'use client'

import Link from 'next/link'
import { CircleAlert, CircleCheck } from 'lucide-react'
import { Banner, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { dash, Section } from '../../../../quality/_shared/parts'
import type { CertCan } from '../../model'
import { StatusPill, useDay } from '../../view/parts'
import type { CertificateSummary, Depth } from '../api'
import { supplierVerb, writeHeld, type DepthModel } from '../model'
import type { DepthActions } from '../use-depth'
import { DepthMessages, PpeLaw, useDepthT, useLevelWords, useSpanText } from './parts'

const recordHref = (prefix: string, certificateId: string) => `${prefix}/compliance/certificates/${encodeURIComponent(certificateId)}`

/**
 * The W2b parts of the certificate's Coverage tab (B-W2b-255): the five-year check of its dates (PRD-282, Annex V 6.1),
 * the performance levels in the standard's vocabulary (PRD-290: an EN 13594 glove's level and KP with its marking; EN
 * 1621 zones), and the own-brand part (PRD-287: a brand's certificate on the factory's base, whether the base holds; the
 * brand certificates resting on the factory's). Each shown only where it applies; a failed read says so in words.
 */
export function DepthSections(props: { model: DepthModel; can: CertCan; prefix: string; actions?: DepthActions }) {
  return (
    <DepthMessages>
      <Sections {...props} />
    </DepthMessages>
  )
}

function Sections({ model, can, prefix, actions }: { model: DepthModel; can: CertCan; prefix: string; actions?: DepthActions }) {
  const d = useDepthT()
  const q = useT('quality')
  if (model.depth.problem)
    return (
      <Banner tone="danger" title={d('depth.failed')} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{q('common.retry')}</Button>}>
        <p className="fw-q-hint">{q(model.depth.problem)}</p>
      </Banner>
    )
  const depth = model.depth.value
  if (!depth)
    return (
      <p className="fw-q-loading">
        <Spinner size={12} /> {q('common.loading')}
      </p>
    )
  const showOwn = depth.ownBrand.brandHeld || depth.ownBrand.base || depth.ownBrand.restingOnThis.length > 0
  return (
    <div className="fw-cd-grid">
      <ValiditySection depth={depth} />
      {depth.levels.family && <LevelsSection depth={depth} can={can} actions={actions} />}
      {showOwn && <OwnBrandSection depth={depth} can={can} prefix={prefix} actions={actions} />}
    </div>
  )
}

function ValiditySection({ depth }: { depth: Depth }) {
  const d = useDepthT()
  const day = useDay()
  const spanText = useSpanText()
  const { validity } = depth
  return (
    <Section title={d('five.title')} sub={d('five.intro')}>
      {validity.state === 'OK' ? (
        <span className="fw-cd-scope fw-cd-scope-listed">
          <CircleCheck size={14} aria-hidden /> {d('five.ok', { span: spanText(validity.span!), years: validity.maxYears })}
        </span>
      ) : validity.state === 'TOO_LONG' ? (
        <span className="fw-cd-scope fw-cd-scope-not_listed">
          <CircleAlert size={14} aria-hidden /> {d('five.tooLong', { span: spanText(validity.span!), years: validity.maxYears })}
        </span>
      ) : (
        <p className="fw-q-hint">{d('five.incomplete')}</p>
      )}
      {validity.latest && <p className="fw-q-hint">{d('five.latest', { date: day(validity.latest) })}</p>}
      <span className="fw-cd-row">
        <PpeLaw point="Annex V 6.1" plainKey="law.annexV" />
      </span>
    </Section>
  )
}

function LevelsSection({ depth, can, actions }: { depth: Depth; can: CertCan; actions?: DepthActions }) {
  const d = useDepthT()
  const words = useLevelWords()
  const held = writeHeld(depth, can, 'levels')
  const values = depth.levels.values
  const ordered = depth.levels.properties.filter((property) => values && property.key in values)
  return (
    <Section
      title={d(`levels.title.${depth.levels.family}`)}
      sub={d(`levels.intro.${depth.levels.family}`)}
      actions={
        <Button size="sm" variant={values ? 'secondary' : 'primary'} heldReason={held ? d(held) : null} onClick={() => actions?.onDialog?.({ kind: 'levels' })}>
          {d(values ? 'levels.edit' : 'levels.add')}
        </Button>
      }
    >
      {!values ? (
        <p className="fw-q-hint">{d('levels.none')}</p>
      ) : (
        <div className="fw-cd-stack">
          <KeyValue labelCase="sentence" items={ordered.map((property) => ({ label: words.property(property.key), value: words.value(property.key, values[property.key]!) }))} />
          {depth.levels.marking && (
            <p>
              {d('levels.marking')} <span className="fw-cd-marking">{depth.levels.marking}</span>
            </p>
          )}
          {depth.levels.problems.length > 0 && (
            <Banner tone="warning" title={d('levels.stale')}>
              <ul className="fw-cd-lines fw-ce-data">
                {depth.levels.problems.map((problem) => (
                  <li key={problem.path + problem.message}>{problem.message}</li>
                ))}
              </ul>
            </Banner>
          )}
        </div>
      )}
      {depth.levels.family === 'EN13594' && <p className="fw-q-hint">{d('levels.gloveSwitch')}</p>}
    </Section>
  )
}

function SummaryRows({ rows, prefix, label }: { rows: readonly CertificateSummary[]; prefix: string; label: string }) {
  const t = useT('certificates')
  const day = useDay()
  return (
    <SummaryTable
      label={label}
      stackOnPhone
      columns={[t('csv.number'), t('csv.standard'), t('list.col.valid'), t('list.col.status')]}
      rows={rows.map((row) => ({
        id: row.id,
        cells: [
          <Link key="n" className="fw-q-link fw-q-code" href={recordHref(prefix, row.id)}>
            {row.number}
          </Link>,
          row.standard,
          t('list.validRange', { from: day(row.validFrom), to: day(row.validTo) }),
          <StatusPill key="s" status={row.status} />,
        ],
      }))}
    />
  )
}

function OwnBrandSection({ depth, can, prefix, actions }: { depth: Depth; can: CertCan; prefix: string; actions?: DepthActions }) {
  const d = useDepthT()
  const day = useDay()
  const own = depth.ownBrand
  const held = writeHeld(depth, can, 'base')
  return (
    <Section
      title={d('own.title')}
      sub={d(own.brandHeld ? 'own.introBrand' : 'own.introFactory')}
      actions={
        own.brandHeld ? (
          <Button size="sm" variant={own.base ? 'secondary' : 'primary'} heldReason={held ? d(held) : null} onClick={() => actions?.onDialog?.({ kind: 'base' })}>
            {d(own.base ? 'own.change' : 'own.pick')}
          </Button>
        ) : undefined
      }
    >
      {own.brandHeld && !own.base && (
        <Banner tone="warning" title={d('own.noBase')}>
          <p className="fw-q-hint">{d('own.noBaseHint')}</p>
        </Banner>
      )}
      {own.base && own.standing && (
        <div className="fw-cd-stack">
          <KeyValue
            labelCase="sentence"
            items={[
              {
                label: d('own.base'),
                value: (
                  <Link className="fw-q-link fw-q-code" href={recordHref(prefix, own.base.id)}>
                    {own.base.number}
                  </Link>
                ),
                hint: own.base.standard,
              },
              { label: d('own.baseValid'), value: d('own.range', { from: day(own.base.validFrom), to: day(own.base.validTo) }) },
            ]}
          />
          {own.standing.state === 'HOLDS' ? (
            <span className="fw-cd-scope fw-cd-scope-listed">
              <CircleCheck size={14} aria-hidden /> {d('own.holds', { number: own.base.number })}
            </span>
          ) : (
            <Banner tone="danger" title={d(`own.standing.${own.standing.state}`, { number: own.base.number, date: day(own.standing.validTo), from: day(own.standing.validFrom) })}>
              <p className="fw-q-hint">{d('own.gateRefuses')}</p>
            </Banner>
          )}
          {own.outlivesBaseDays > 0 && <p className="fw-q-hint">{d('own.outlives', { count: own.outlivesBaseDays, date: day(own.base.validTo) })}</p>}
          {own.sameStandard === false && <p className="fw-q-hint">{d('own.otherStandard', { base: own.base.standard })}</p>}
        </div>
      )}
      {own.restingOnThis.length > 0 && (
        <div className="fw-cd-stack">
          <h3 className="fw-ce-h3">{d('own.resting', { count: own.restingOnThis.length })}</h3>
          <SummaryRows rows={own.restingOnThis} prefix={prefix} label={d('own.resting', { count: own.restingOnThis.length })} />
        </div>
      )}
      <span className="fw-cd-row">
        <PpeLaw point="art. 10, recital 19" plainKey="law.ownBrand" />
      </span>
    </Section>
  )
}

/**
 * The parts a certificate covers, with their supplier part numbers (design cov-grid "Items covered (protector or
 * material): list with supplier part numbers", QHS-106): item, the supplier it is bought from and that supplier's article
 * code, the note, End coverage (W1's). Name the supplier once; its article code may be corrected.
 */
export function BoughtInSection(props: { model: DepthModel; can: CertCan; prefix: string; actions?: DepthActions; onEnd?: (coverageId: string) => void; endHeld?: string | null }) {
  return (
    <DepthMessages>
      <BoughtIn {...props} />
    </DepthMessages>
  )
}

function BoughtIn({ model, can, prefix, actions, onEnd, endHeld }: { model: DepthModel; can: CertCan; prefix: string; actions?: DepthActions; onEnd?: (coverageId: string) => void; endHeld?: string | null }) {
  const d = useDepthT()
  const t = useT('certificates')
  const parts = model.depth.value?.boughtIn ?? []
  if (parts.length === 0) return null
  const manageHeld = !can.manage ? d('held.manage') : !can.parties ? d('supplier.held.parties') : null
  return (
    <div className="fw-ce-items">
      <h3 className="fw-ce-h3">{t('coverage.items')}</h3>
      <p className="fw-q-hint">{d('parts.intro')}</p>
      <SummaryTable
        label={t('coverage.items')}
        stackOnPhone
        columns={[t('coverage.col.item'), d('parts.col.supplier'), d('parts.col.article'), t('coverage.col.note'), '']}
        rows={parts.map((part) => ({
          id: part.coverageId,
          cells: [
            part.item ? (
              <span key="i" className="fw-q-cell">
                {can.materials ? (
                  <Link className="fw-q-link fw-q-code" href={`${prefix}/products/materials/${encodeURIComponent(part.item.id)}`}>
                    {part.item.code}
                  </Link>
                ) : (
                  <span className="fw-q-code">{part.item.code}</span>
                )}
                <span className="nds-summary-sub">{part.item.name}</span>
              </span>
            ) : (
              '—'
            ),
            part.supplier ? part.supplier.name : <span key="s" className="fw-q-hint">{d('parts.noSupplier')}</span>,
            <span key="a" className="fw-q-code">{dash(part.supplierArticleCode)}</span>,
            dash(part.note),
            <span key="b" className="fw-cd-row">
              <Button size="sm" variant="quiet" heldReason={manageHeld} onClick={() => actions?.onDialog?.({ kind: 'supplier', coverageId: part.coverageId })}>
                {d(`parts.${supplierVerb(part)}`)}
              </Button>
              <Button size="sm" variant="quiet" heldReason={endHeld ?? null} onClick={() => onEnd?.(part.coverageId)}>
                {t('coverage.end')}
              </Button>
            </span>,
          ],
        }))}
      />
    </div>
  )
}
