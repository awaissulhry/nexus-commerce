'use client'

import { useState } from 'react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Input, Pill, Select, Skeleton } from '@nexus/ui/primitives'
import { PROPERTY_SUGGESTIONS, PROTECTOR_LEVELS, shapeOf } from '@nexus/factory-domain/product/materials-depth/rules'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { ReadField } from '../../../library/parts'
import { useDepthWords } from '../../approval/words'
import {
  keysOf,
  propertiesBodyOf,
  propertiesChanged,
  propertiesDraft,
  propertiesInvalid,
  type MaterialDepthActions,
  type MaterialDepthModel,
  type MaterialDepthView,
  type PropertyKey,
  type PropertyShape,
} from '../../approval/depth-model'

const NS = 'products-materials-depth'
const FINDING_TONE = { NOT_OFFICIAL: 'warning', TRADE_MARK: 'warning', NOT_TEXTILE: 'danger', UNKNOWN: 'warning' } as const

/**
 * SCR-048 Properties & grades › Properties by kind, the W2b part (B-W2b-238; PRD-029, PRD-033; design material.props.kind):
 * a textile's weight g/m², width and construction, a protector's standard, type, EN 1621 level and size, a trim's material,
 * finish, size and nickel free — only the fields of its kind, saved together (Discard / Save properties, held with the reason:
 * a number it cannot take, offline, a write running). Beside them, the composition's fibres as the label reads them (Reg. (EU)
 * 1007/2011 Annex I): each typed name with its official one in Italian and English, or what to change. A person without
 * product.materials.manage, or an archived material, reads them as text. A kind without typed properties and without
 * fibres shows nothing here (leather keeps W1's fields above). It fetches nothing.
 */
export function KindPropertiesCard({ kind, model, actions, archived }: { kind: string; model: MaterialDepthModel; actions?: MaterialDepthActions; archived: boolean }) {
  const t = useT(NS)
  const words = useDepthWords()
  const read = model.depth
  if (read.status === 'idle') return null
  if (read.status === 'loading')
    return shapeOf(kind) ? (
      <Card header={t('properties.title')} aria-busy="true">
        <div className="fw-lib-form-grid" role="status" aria-label={t('loading')}>
          <Skeleton height={40} />
          <Skeleton height={40} />
          <Skeleton height={40} />
        </div>
      </Card>
    ) : null
  if (read.status === 'error')
    return (
      <Card header={t('properties.title')}>
        <Banner tone="danger" title={t('properties.failed')} action={<Button size="sm" onClick={() => actions?.onRetryDepth?.()}>{t('retry')}</Button>}>
          {words(read.problem)}
        </Banner>
      </Card>
    )
  const depth = read.value
  const shape = depth.properties.shape
  if (!shape && depth.fibres.length === 0) return null
  return (
    <div className="fw-lib-pair">
      {shape && <TypedCard key={`${depth.material.id}-${depth.material.version}`} shape={shape} depth={depth} model={model} actions={actions} archived={archived} />}
      {depth.fibres.length > 0 && <FibresCard depth={depth} />}
    </div>
  )
}

function TypedCard({ shape, depth, model, actions, archived }: { shape: PropertyShape; depth: MaterialDepthView; model: MaterialDepthModel; actions?: MaterialDepthActions; archived: boolean }) {
  const t = useT(NS)
  const words = useDepthWords()
  const locale = useLocale()
  const base = propertiesDraft(depth, locale)
  const [draft, setDraft] = useState<Record<string, string>>(model.propertiesDraft ?? base)
  const editable = model.can.manage && !archived
  const invalid = propertiesInvalid(shape, draft)
  const changed = propertiesChanged(shape, base, draft)
  const held = changed === 0 ? t('properties.held.unchanged') : invalid.length > 0 ? t('properties.held.number') : model.offline ? t('wait.offline') : model.busy ? t('wait.busy') : null
  const refused = (key: string) => (model.refused?.paths.some((path) => path === `properties/${key}`) ? t('properties.refused') : undefined)
  const errorOf = (key: PropertyKey) => (invalid.includes(key) ? t('properties.badNumber') : refused(key))
  const set = (key: string, value: string) => setDraft((now) => ({ ...now, [key]: value }))
  const notice = model.notice?.key.startsWith('properties.') || (model.notice?.tone === 'danger' && model.refused?.paths.some((path) => path.startsWith('properties'))) ? model.notice : null

  if (!editable)
    return (
      <Card header={t('properties.title')} description={archived ? t('properties.readOnlyArchived') : t('properties.viewOnly')}>
        <div className="fw-lib-form-grid">
          {keysOf(shape).map((key) => (
            <ReadField key={key} label={t(`properties.field.${key}`)} value={valueText(key, depth.properties.values?.[key], t, locale)} />
          ))}
        </div>
      </Card>
    )

  return (
    <Card header={t('properties.title')} description={t(`properties.intro.${shape}`)}>
      <div className="fw-lib-stack">
        {notice && (
          <Banner tone={notice.tone} title={words(notice.key, notice.params)} action={<Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>{t('dismiss')}</Button>}>
            {notice.tone === 'danger' && model.refused && model.refused.messages.length > 0 ? (
              <ul className="fw-lib-list">
                {model.refused.messages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
          </Banner>
        )}
        <div className="fw-lib-form-grid">
          {keysOf(shape).map((key) => {
            const id = `fw-md-${key}-${depth.material.id}`
            if (key === 'level')
              return (
                <Field key={key} label={t('properties.field.level')} hint={t('properties.hint.level')} error={refused(key)}>
                  <Select value={draft[key] ?? ''} onChange={(event) => set(key, event.target.value)}>
                    <option value="">{t('properties.none')}</option>
                    {PROTECTOR_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {t('properties.level', { level })}
                      </option>
                    ))}
                  </Select>
                </Field>
              )
            if (key === 'nickelFree')
              return (
                <Field key={key} label={t('properties.field.nickelFree')} hint={t('properties.hint.nickelFree')} error={refused(key)}>
                  <Select value={draft[key] ?? ''} onChange={(event) => set(key, event.target.value)}>
                    <option value="">{t('properties.notSaid')}</option>
                    <option value="yes">{t('yes')}</option>
                    <option value="no">{t('no')}</option>
                  </Select>
                </Field>
              )
            const suggestions = PROPERTY_SUGGESTIONS[key]
            const decimal = key === 'weightGsm' || key === 'widthCm'
            return (
              <div key={key}>
                <Field label={t(`properties.field.${key}`)} hint={t(`properties.hint.${key}`)} error={errorOf(key)}>
                  <Input value={draft[key] ?? ''} inputMode={decimal ? 'decimal' : undefined} maxLength={decimal ? 20 : 100} list={suggestions ? `${id}-list` : undefined} onChange={(event) => set(key, event.target.value)} />
                </Field>
                {suggestions && (
                  <datalist id={`${id}-list`}>
                    {suggestions.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                )}
              </div>
            )
          })}
        </div>
        <div className="fw-lib-actions">
          <Button size="sm" variant="quiet" heldReason={changed === 0 ? t('properties.held.unchanged') : null} onClick={() => setDraft(base)}>
            {t('discard')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => void actions?.onSaveProperties?.(propertiesBodyOf(shape, draft))}>
            {t('properties.save')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function valueText(key: PropertyKey, value: string | boolean | undefined, t: (key: string, params?: Record<string, string | number>) => string, locale: 'it' | 'en'): string | null {
  if (value === undefined) return null
  if (typeof value === 'boolean') return t(value ? 'yes' : 'no')
  if (key === 'weightGsm') return t('properties.gsm', { value: locale === 'it' ? value.replace('.', ',') : value })
  if (key === 'widthCm') return t('properties.cm', { value: locale === 'it' ? value.replace('.', ',') : value })
  if (key === 'level') return t('properties.level', { level: value })
  return value
}

/** The composition as the label reads it: each typed fibre, its official name (it, en) or what to change. */
function FibresCard({ depth }: { depth: MaterialDepthView }) {
  const t = useT(NS)
  const locale = useLocale()
  const problems = depth.fibres.filter((fibre) => fibre.finding !== null).length
  return (
    <Card header={t('fibres.title')} description={problems === 0 ? t('fibres.allOfficial') : t('fibres.problems', { count: problems })}>
      <ul className="fw-lib-list">
        {depth.fibres.map((fibre) => (
          <li key={fibre.fibre}>
            <span className="fw-lib-inline">
              <b>
                {locale === 'it' ? fibre.percent.replace('.', ',') : fibre.percent} % {fibre.fibre}
              </b>
              {fibre.finding ? <Pill tone={FINDING_TONE[fibre.finding]}>{t(`fibres.finding.${fibre.finding}`)}</Pill> : <Pill tone="success">{t('fibres.official')}</Pill>}
            </span>
            <span className="fw-lib-sub">
              {fibre.official
                ? t('fibres.names', { it: fibre.official.it ?? t('fibres.noItalian'), en: fibre.official.en ?? fibre.annexFibre ?? '' })
                : t(fibre.finding === 'NOT_TEXTILE' ? 'fibres.notTextile' : 'fibres.unknown')}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
