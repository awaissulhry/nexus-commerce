'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowRight, CircleCheck, CircleX } from 'lucide-react'
import { Banner, Card, Field, KeyValue, SummaryTable } from '@nexus/ui/components'
import { EditModeBar } from '@nexus/ui/patterns'
import { Button, Input, Pill, Select, Tag, Textarea, Toggle } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { StylePatch, StyleView } from '../../api'
import { PpeFields, settlePpe, type PpeValue } from '../../forms'
import { complianceAfterRelease, draftOf, issueTab, issueWords, nextRevisionNumber, releasedOf, REVISION_TONE, revisionInView, startRevisionHeld, STATUS_TONE } from '../../model'
import type { StyleRecordActions, StyleRecordViewModel } from '../record-model'

const PRODUCT_TYPES: StyleView['productType'][] = ['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER']

interface Identity {
  code: string
  name: string
  productType: StyleView['productType']
  season: string
  brandPartyId: string | null
  description: string
  mtmAllowed: boolean
  ppe: PpeValue
}

const identityOf = (style: StyleView): Identity => ({
  code: style.code,
  name: style.name,
  productType: style.productType,
  season: style.season ?? '',
  brandPartyId: style.brand?.id ?? null,
  description: style.description ?? '',
  mtmAllowed: style.mtmAllowed,
  ppe: { ppeCategory: style.ppeCategory, ppeStandard: style.ppeStandard, ppeClass: style.ppeClass },
})

/** What changed, as the API's PATCH body (only the fields that differ). */
export function identityPatch(style: StyleView, draft: Identity): StylePatch {
  const patch: StylePatch = {}
  const text = (value: string) => (value.trim() === '' ? null : value.trim())
  if (draft.code.trim().toUpperCase() !== style.code) patch.code = draft.code.trim().toUpperCase()
  if (draft.name.trim() !== style.name) patch.name = draft.name.trim()
  if (draft.productType !== style.productType) patch.productType = draft.productType
  if (text(draft.season) !== style.season) patch.season = text(draft.season)
  if (draft.brandPartyId !== (style.brand?.id ?? null)) patch.brandPartyId = draft.brandPartyId
  if (text(draft.description) !== style.description) patch.description = text(draft.description)
  if (draft.mtmAllowed !== style.mtmAllowed) patch.mtmAllowed = draft.mtmAllowed
  if (draft.ppe.ppeCategory !== style.ppeCategory || draft.ppe.ppeStandard !== style.ppeStandard || draft.ppe.ppeClass !== style.ppeClass) {
    patch.ppeCategory = draft.ppe.ppeCategory
    patch.ppeStandard = draft.ppe.ppeStandard
    patch.ppeClass = draft.ppe.ppeClass
  }
  return patch
}

/**
 * SCR-041 Overview: what the style is (identity, explicit save with ⌘S), and beside it its state, the release check,
 * the certificate coverage, the revisions and who made it — every line a link to the tab that explains it.
 */
export function OverviewTab({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  return (
    <div className="fw-st-split">
      <div className="fw-st-col">
        <IdentityCard style={style} model={model} actions={actions} />
        <WarningsCard style={style} model={model} />
      </div>
      <aside className="fw-st-side" aria-label={t('side.label')}>
        <StateCard style={style} model={model} />
        <ReleaseCheckCard style={style} model={model} actions={actions} />
        <CoverageCard style={style} model={model} />
        <RevisionsCard style={style} model={model} actions={actions} />
      </aside>
    </div>
  )
}

function IdentityCard({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const base = useMemo(() => identityOf(style), [style])
  const seeded = model.identityDraft ? { ...base, ...applyDesignDraft(base, model.identityDraft) } : base
  const [draft, setDraft] = useState<Identity>(seeded)
  const [saving, setSaving] = useState(false)
  // A new read of the style starts the form again — unless the person has unsaved changes in it (they stay; after a
  // save they equal the new read anyway).
  const lastBase = useRef(base)
  useEffect(() => {
    setDraft((current) => (sameIdentity(current, lastBase.current) ? base : current))
    lastBase.current = base
  }, [base])
  const editable = model.can.manage && style.status !== 'ARCHIVED'
  const codeFrozen = style.matrix.generated
  const patch = identityPatch(style, draft)
  const count = Object.keys(patch).filter((key) => key !== 'ppeStandard' && key !== 'ppeClass').length
  const held = draft.name.trim() === '' ? t('identity.held.name') : !/^[A-Z0-9](?:[A-Z0-9._-]{0,22}[A-Z0-9])?$/.test(draft.code.trim().toUpperCase()) ? t('identity.held.code') : saving ? t('held.busy') : null
  const set = <K extends keyof Identity>(field: K, value: Identity[K]) => setDraft((current) => ({ ...current, [field]: value }))
  const save = async () => {
    if (held || count === 0) return
    setSaving(true)
    await actions?.onSaveIdentity?.(patch)
    setSaving(false)
  }
  const brandName = style.brand ? style.brand.name : t('identity.ownCollection')

  if (!editable) {
    return (
      <Card header={t('identity.title')} description={style.status === 'ARCHIVED' ? t('identity.readArchived') : t('identity.readOnly')}>
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: t('identity.code'), value: style.code },
            { label: t('identity.name'), value: style.name },
            { label: t('identity.type'), value: t(`productType.${style.productType}`) },
            { label: t('identity.season'), value: style.season ?? '—' },
            { label: t('identity.brand'), value: brandName },
            { label: t('identity.mtm'), value: t(style.mtmAllowed ? 'common.yes' : 'common.no') },
            { label: t('identity.ppe'), value: <PpeFields value={base.ppe} productType={style.productType} onChange={() => undefined} readOnly /> },
            { label: t('identity.tracking'), value: t(`tracking.${style.tracking}`) },
            { label: t('identity.description'), value: style.description ?? '—' },
          ]}
        />
      </Card>
    )
  }

  return (
    <Card header={t('identity.title')} description={t('identity.intro')}>
      <div className="fw-st-form">
        <div className="fw-st-form-grid">
          <Field label={t('identity.code')} required hint={codeFrozen ? t('identity.codeFrozen') : t('identity.codeHint')}>
            {codeFrozen ? <p className="fw-st-static">{style.code}</p> : <Input value={draft.code} maxLength={24} onChange={(event) => set('code', event.target.value.toUpperCase())} />}
          </Field>
          <Field label={t('identity.name')} required>
            <Input value={draft.name} maxLength={200} onChange={(event) => set('name', event.target.value)} />
          </Field>
          <Field label={t('identity.type')}>
            <Select
              value={draft.productType}
              onChange={(event) => {
                const productType = event.target.value as StyleView['productType']
                setDraft((current) => ({ ...current, productType, ppe: settlePpe(current.ppe, productType) }))
              }}
            >
              {PRODUCT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`productType.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('identity.season')} hint={t('identity.seasonHint')}>
            <Input value={draft.season} maxLength={20} onChange={(event) => set('season', event.target.value)} />
          </Field>
          <Field label={t('identity.brand')} hint={t('identity.brandHint')}>
            {model.libraries.brands ? (
              <Select value={draft.brandPartyId ?? ''} onChange={(event) => set('brandPartyId', event.target.value || null)}>
                <option value="">{t('identity.ownCollection')}</option>
                {model.libraries.brands.map((brand) => (
                  <option key={brand.id} value={brand.id}>
                    {brand.tradeName ?? brand.legalName} · {brand.code}
                  </option>
                ))}
                {style.brand && !model.libraries.brands.some((brand) => brand.id === style.brand?.id) && <option value={style.brand.id}>{style.brand.name}</option>}
              </Select>
            ) : (
              <p className="fw-st-static">{brandName}</p>
            )}
          </Field>
          <Field label={t('identity.mtm')} hint={t('identity.mtmHint')}>
            <span className="fw-st-inline">
              <Toggle checked={draft.mtmAllowed} onChange={(next) => set('mtmAllowed', next)} aria-label={t('identity.mtm')} />
              {t(draft.mtmAllowed ? 'common.yes' : 'common.no')}
            </span>
          </Field>
        </div>
        <PpeFields value={draft.ppe} productType={draft.productType} onChange={(ppe) => set('ppe', ppe)} />
        <KeyValue dense labelCase="sentence" items={[{ label: t('identity.tracking'), value: t(`tracking.${draft.ppe.ppeCategory === 'NOT_PPE' ? 'NONE' : 'LOT'}`) }]} />
        <Field label={t('identity.description')} hint={t('identity.descriptionHint')}>
          <Textarea value={draft.description} rows={3} maxLength={4000} onChange={(event) => set('description', event.target.value)} />
        </Field>
      </div>
      {count > 0 && (
        <EditModeBar
          count={count}
          message={t('identity.unsaved', { count })}
          onDiscard={() => setDraft(base)}
          onApply={() => void save()}
          applyLabel={t('identity.save')}
          applyHeldReason={held}
          busy={saving}
          saveShortcut
        />
      )}
    </Card>
  )
}

const sameIdentity = (a: Identity, b: Identity) => JSON.stringify(a) === JSON.stringify(b)

function applyDesignDraft(base: Identity, patch: StylePatch): Partial<Identity> {
  return {
    ...(patch.name !== undefined ? { name: patch.name ?? '' } : {}),
    ...(patch.season !== undefined ? { season: patch.season ?? '' } : {}),
    ...(patch.ppeCategory !== undefined ? { ppe: { ppeCategory: patch.ppeCategory, ppeStandard: patch.ppeStandard ?? null, ppeClass: patch.ppeClass ?? null } } : { ppe: base.ppe }),
  }
}

function WarningsCard({ style, model }: { style: StyleView; model: StyleRecordViewModel }) {
  const t = useT('products')
  if (style.warnings.length === 0) return null
  const href = (code: string) => `${model.prefix}/products/styles/${style.id}?tab=${['NO_PPE_STANDARD', 'NO_PPE_CLASS', 'NO_MEASUREMENT_TEMPLATE'].includes(code) ? 'overview' : 'variants'}`
  return (
    <Banner tone="warning" title={t('warning.title', { count: style.warnings.length })}>
      <ul className="fw-st-list">
        {style.warnings.map((warning) => (
          <li key={warning.code}>
            {t(`warning.${warning.code}`)}{' '}
            {!['NO_PPE_STANDARD', 'NO_PPE_CLASS', 'NO_MEASUREMENT_TEMPLATE'].includes(warning.code) && (
              <Link className="fw-st-link" href={href(warning.code)}>
                {t('warning.fix')}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Banner>
  )
}

function StateCard({ style, model }: { style: StyleView; model: StyleRecordViewModel }) {
  const t = useT('products')
  const locale = useLocale()
  return (
    <Card header={t('side.state')}>
      <div className="fw-st-stack">
        <span className="fw-st-inline">
          <Pill tone={STATUS_TONE[style.status]}>{t(`status.${style.status}`)}</Pill>
          <span className="fw-st-hint">{t(`statusMeans.${style.status}`)}</span>
        </span>
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('side.skus'), value: t('side.skusValue', { skus: style.skuCount, colourways: style.colourwayCount }) },
            { label: t('side.range'), value: style.sizes.length ? `${style.sizes.join(' · ')}${style.baseSize ? ` (${t('range.baseMark')} ${style.baseSize})` : ''}` : '—' },
            { label: t('side.created'), value: formatDate(style.createdAt, { locale }) },
            { label: t('side.updated'), value: formatDateTime(style.updatedAt, { locale }) },
          ]}
        />
        {model.can.thread && (
          <Link className="fw-st-link" href={`${model.prefix}/products/styles/${style.id}?tab=activity`}>
            {t('side.activity')} <ArrowRight size={12} aria-hidden />
          </Link>
        )}
      </div>
    </Card>
  )
}

function ReleaseCheckCard({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const revision = revisionInView(style.revisions, model.revisionId)
  const draft = draftOf(style.revisions)
  const released = releasedOf(style.revisions)
  const bom = model.bom.status === 'ready' ? model.bom.value : null
  const routing = model.routing.status === 'ready' ? model.routing.value : null
  const compliance = model.compliance.status === 'ready' ? model.compliance.value : null
  const after = complianceAfterRelease(compliance)
  const tabHref = (tab: string) => `${model.prefix}/products/styles/${style.id}?tab=${tab}${model.revisionId ? `&rev=${model.revisionId}` : ''}`
  let body
  if (!revision) body = <p className="fw-st-hint">{t('check.noRevision')}</p>
  else if (!model.can.bomView) body = <p className="fw-st-hint">{t('check.noBomView')}</p>
  else if (revision.status !== 'DRAFT') body = <p className="fw-st-hint">{t(revision.status === 'RELEASED' ? 'check.released' : 'check.obsolete', { revision: revision.revision })}</p>
  else if (model.bom.status === 'error') body = <p className="fw-st-hint">{t(model.bom.problem)}</p>
  else if (!bom) body = <p className="fw-st-hint">{t('check.checking')}</p>
  else if (bom.issues.length === 0)
    body = (
      <p className="fw-st-inline fw-st-ok">
        <CircleCheck size={14} aria-hidden /> {t('check.ready', { revision: revision.revision })}
      </p>
    )
  else
    body = (
      <ul className="fw-st-checklist">
        {bom.issues.slice(0, 4).map((issue, index) => {
          const words = issueWords(issue, bom, routing)
          return (
            <li key={`${issue.code}-${index}`} className="fw-st-check is-blocked">
              <CircleX size={14} aria-hidden />
              <span>{t(words.key, words.params)}</span>
              <Link className="fw-st-link" href={tabHref(issueTab(issue))}>
                {t('check.showMe')}
              </Link>
            </li>
          )
        })}
        {bom.issues.length > 4 && <li className="fw-st-hint">{t('check.more', { count: bom.issues.length - 4 })}</li>}
      </ul>
    )
  return (
    <Card
      header={t('side.release')}
      headerAction={
        revision?.status === 'DRAFT' ? (
          <Button size="sm" variant="quiet" onClick={() => actions?.onDialog?.({ kind: 'release' })} aria-keyshortcuts="r">
            {t('check.open')}
          </Button>
        ) : undefined
      }
    >
      <div className="fw-st-stack">
        {body}
        {revision?.status === 'DRAFT' && after.length > 0 && (
          <p className="fw-st-hint">
            {t('check.complianceAfter', { count: after.length })}{' '}
            <Link className="fw-st-link" href={tabHref('compliance')}>
              {t('check.seeCompliance')}
            </Link>
          </p>
        )}
        {draft && released && <p className="fw-st-hint">{t('check.inUse', { released: released.revision, draft: draft.revision })}</p>}
      </div>
    </Card>
  )
}

function CoverageCard({ style, model }: { style: StyleView; model: StyleRecordViewModel }) {
  const t = useT('products')
  if (!model.can.complianceView) return null
  const compliance = model.compliance.status === 'ready' ? model.compliance.value : null
  const href = `${model.prefix}/products/styles/${style.id}?tab=compliance`
  let body
  if (model.compliance.status === 'error') body = <p className="fw-st-hint">{t(model.compliance.problem)}</p>
  else if (!compliance) body = <p className="fw-st-hint">{t('check.checking')}</p>
  else if (!compliance.coverage.required) body = <p className="fw-st-hint">{t(style.ppeCategory === 'NOT_PPE' ? 'coverage.notPpe' : 'coverage.notRequired')}</p>
  else {
    const counts = compliance.coverage.counts
    body = (
      <div className="fw-st-stack">
        <span className="fw-st-inline">
          <Tag tone="success">{t('coverage.covered', { count: counts.covered })}</Tag>
          {counts.expiringSoon > 0 && <Tag tone="warning">{t('coverage.expiring', { count: counts.expiringSoon })}</Tag>}
          {counts.notCovered + counts.expired + counts.suspended > 0 && <Tag tone="danger">{t('coverage.notCoveredCount', { count: counts.notCovered + counts.expired + counts.suspended })}</Tag>}
        </span>
        <span className="fw-st-hint">{t('coverage.ofOffered', { count: counts.offered })}</span>
      </div>
    )
  }
  return (
    <Card
      header={t('side.coverage')}
      headerAction={
        <Link className="fw-st-link" href={href}>
          {t('side.open')}
        </Link>
      }
    >
      {body}
    </Card>
  )
}

function RevisionsCard({ style, model, actions }: { style: StyleView; model: StyleRecordViewModel; actions?: StyleRecordActions }) {
  const t = useT('products')
  const locale = useLocale()
  const startHeld = startRevisionHeld(style, model.can)
  const next = nextRevisionNumber(style.revisions)
  const draft = draftOf(style.revisions)
  const rows = [...style.revisions].sort((a, b) => b.revision - a.revision)
  return (
    <Card
      header={t('side.revisions')}
      headerAction={
        <Button size="sm" variant="quiet" heldReason={startHeld ? t(startHeld, { revision: draft?.revision ?? next }) : null} onClick={() => actions?.onDialog?.({ kind: 'startRevision' })}>
          {t('action.startRevision', { revision: next })}
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="fw-st-hint">{t('revisions.none')}</p>
      ) : (
        <SummaryTable
          label={t('side.revisions')}
          columns={[t('revisions.col.revision'), t('revisions.col.status'), t('revisions.col.when')]}
          widths={['28%', '36%', undefined]}
          rows={rows.map((revision) => ({
            id: revision.id,
            cells: [
              <button key="r" type="button" className="fw-st-linkbtn" aria-current={revision.id === model.revisionId ? 'true' : undefined} onClick={() => actions?.onRevision?.(revision.id)}>
                {t('revisions.rev', { revision: revision.revision })}
              </button>,
              <Pill key="s" tone={REVISION_TONE[revision.status]}>
                {t(`revisionStatus.${revision.status}`)}
              </Pill>,
              revision.releasedAt ? formatDate(revision.releasedAt, { locale }) : formatDate(revision.createdAt, { locale }),
            ],
          }))}
        />
      )}
    </Card>
  )
}
