'use client'

import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Card, Disclosure, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, SegmentedControl, Select, Tag, Toggle } from '@nexus/ui/primitives'
import { ANIMAL_ORIGIN_PHRASES, CARE_SYMBOLS, type LabelField } from '@nexus/factory-domain/compliance/labels/rules'
import { useT } from '../../../../../lib/i18n/provider'
import type { LabelDetail, LabelIssue } from '../../api'
import { CARE_KINDS, careChoices, careOfKind, familyOf, isPpeLabel, mmWords, moveField, optionalFields, partSum, printedOrder, setCare, toggleField, type LabelDraft, type PartDraft } from '../../model'
import { LanguagesField } from '../../view/NewLabelDialog'

/**
 * The builder's form (design lb-builder, W1 parts): what the label says, typed once for the sewn-in label — its name and
 * languages, the legal maker and an importer, the fibre composition per part and the animal-origin phrase in every
 * language it prints, the ISO 3758 care symbols (one per kind) with an optional text, and the layout: the preset, the
 * printed fields in their order, the date of manufacture, the notified-body number of a category III garment, and the
 * label's size. Every change redraws the preview at once; Save sends what changed. Each section is an anchor the rule
 * checks point to. A label out of DRAFT, or a person without the right, sees the same content as text.
 */
export function Builder({ detail, draft, problems, onDraft }: { detail: LabelDetail; draft: LabelDraft; problems: readonly LabelIssue[]; onDraft: (draft: LabelDraft) => void }) {
  const t = useT('labels')
  const set = (patch: Partial<LabelDraft>) => onDraft({ ...draft, ...patch })
  const ppe = isPpeLabel(detail)
  const families = new Set(problems.map((issue) => familyOf(issue.path)))
  const errorOf = (family: string, paths: readonly string[]): string | undefined =>
    problems.some((issue) => paths.some((path) => issue.path === path || issue.path.startsWith(`${path}/`))) ? t(`problem.${family}`) : undefined
  const order = printedOrder(draft, ppe)
  const cat3 = detail.style?.ppeCategory === 'CATEGORY_III'

  const setPart = (index: number, part: PartDraft) => set({ composition: draft.composition.map((entry, at) => (at === index ? part : entry)) })

  return (
    <div className="fw-lb-form">
      <Card padded>
        <section className="fw-q-section" id="lb-sec-general" aria-labelledby="lb-h-general">
          <SectionHead id="lb-h-general" title={t('section.general')} sub={t('section.generalSub')} />
          <div className="fw-q-form-two">
            <Field label={t('field.name.label')} required error={errorOf('name', ['name'])}>
              <Input value={draft.name} maxLength={120} onChange={(event) => set({ name: event.target.value })} />
            </Field>
          </div>
          <LanguagesField value={draft.languages} onChange={(languages) => set({ languages })} />
          {families.has('languages') && <p className="fw-lb-error">{t('problem.languages')}</p>}
        </section>
      </Card>

      <Card padded>
        <section className="fw-q-section" id="lb-sec-maker" aria-labelledby="lb-h-maker">
          <SectionHead id="lb-h-maker" title={t('section.maker')} sub={detail.makerPartyId ? t('section.makerBrand') : t('section.makerCompany')} />
          <div className="fw-q-form-two">
            <Field label={t('field.makerName')} required error={errorOf('maker', ['makerName', 'makerPartyId'])}>
              <Input value={draft.makerName} maxLength={120} onChange={(event) => set({ makerName: event.target.value })} />
            </Field>
            <Field label={t('field.makerAddress')} required hint={t('field.makerAddressHint')} error={errorOf('maker', ['makerAddress'])}>
              <Input value={draft.makerAddress} maxLength={300} onChange={(event) => set({ makerAddress: event.target.value })} />
            </Field>
            <Field label={t('field.importerName')} hint={t('field.importerHint')} error={errorOf('importer', ['importerName'])}>
              <Input value={draft.importerName} maxLength={120} onChange={(event) => set({ importerName: event.target.value })} />
            </Field>
            <Field label={t('field.importerAddress')} error={errorOf('importer', ['importerAddress'])}>
              <Input value={draft.importerAddress} maxLength={300} onChange={(event) => set({ importerAddress: event.target.value })} />
            </Field>
          </div>
        </section>
      </Card>

      <Card padded>
        <section className="fw-q-section" id="lb-sec-composition" aria-labelledby="lb-h-composition">
          <SectionHead
            id="lb-h-composition"
            title={t('section.composition')}
            sub={t('section.compositionSub')}
            actions={
              <Button size="sm" onClick={() => set({ composition: [...draft.composition, { part: '', fibres: [{ fibre: '', percent: '' }] }] })} heldReason={draft.composition.length >= 8 ? t('held.maxParts') : null}>
                <Plus size={14} aria-hidden /> {t('field.addPart')}
              </Button>
            }
          />
          {draft.composition.length === 0 && <p className="fw-q-hint">{t('field.noComposition')}</p>}
          {draft.composition.map((part, index) => {
            const sum = partSum(part)
            const wrong = problems.some((issue) => issue.path.startsWith(`composition/${index}`))
            return (
              <fieldset key={index} className="fw-lb-part">
                <legend className="fw-lb-part-head">
                  <span>{t('field.part', { n: index + 1 })}</span>
                  <Tag tone={sum === 100 ? 'success' : 'warning'}>{sum === null ? t('field.sumUnknown') : t('field.sum', { sum: String(sum) })}</Tag>
                </legend>
                <Field label={t('field.partName')} hint={t('field.partNameHint')} error={wrong ? t('problem.composition') : undefined}>
                  <Input size="sm" value={part.part} maxLength={40} onChange={(event) => setPart(index, { ...part, part: event.target.value })} />
                </Field>
                {part.fibres.map((fibre, at) => (
                  <div key={at} className="fw-lb-fibre">
                    <Field label={t('field.fibre')}>
                      <Input size="sm" value={fibre.fibre} maxLength={40} onChange={(event) => setPart(index, { ...part, fibres: part.fibres.map((entry, k) => (k === at ? { ...entry, fibre: event.target.value } : entry)) })} />
                    </Field>
                    <Field label={t('field.percent')}>
                      <Input size="sm" inputMode="decimal" value={fibre.percent} maxLength={8} onChange={(event) => setPart(index, { ...part, fibres: part.fibres.map((entry, k) => (k === at ? { ...entry, percent: event.target.value } : entry)) })} />
                    </Field>
                    <Button size="sm" variant="quiet" aria-label={t('field.removeFibre', { n: at + 1 })} onClick={() => setPart(index, { ...part, fibres: part.fibres.filter((_, k) => k !== at) })}>
                      <Trash2 size={14} aria-hidden />
                    </Button>
                  </div>
                ))}
                <span className="fw-q-actions">
                  <Button size="sm" onClick={() => setPart(index, { ...part, fibres: [...part.fibres, { fibre: '', percent: '' }] })} heldReason={part.fibres.length >= 8 ? t('held.maxFibres') : null}>
                    <Plus size={14} aria-hidden /> {t('field.addFibre')}
                  </Button>
                  <Button size="sm" variant="danger-outline" onClick={() => set({ composition: draft.composition.filter((_, at) => at !== index) })}>
                    {t('field.removePart')}
                  </Button>
                </span>
              </fieldset>
            )
          })}
          <div className="fw-lb-toggle">
            <Toggle checked={draft.animalOriginPhrase} onChange={(next) => set({ animalOriginPhrase: next })} aria-label={t('field.animalOrigin')} />
            <span className="fw-q-cell">
              <span>{t('field.animalOrigin')}</span>
              <span className="fw-q-hint">{t('field.animalOriginHint')}</span>
            </span>
          </div>
          {draft.animalOriginPhrase && (
            <div className="fw-q-form-two">
              {draft.languages.map((language) => (
                <Field
                  key={language}
                  label={t('field.animalOriginIn', { language })}
                  hint={ANIMAL_ORIGIN_PHRASES[language] ? t('field.animalOriginOfficial') : t('field.animalOriginType')}
                  error={problems.some((issue) => issue.path === `layout/texts/animalOrigin/${language}`) ? t('problem.animalOrigin') : undefined}
                >
                  <Input size="sm" lang={language} value={draft.animalOriginTexts[language] ?? ''} placeholder={ANIMAL_ORIGIN_PHRASES[language] ?? ''} maxLength={120} onChange={(event) => set({ animalOriginTexts: { ...draft.animalOriginTexts, [language]: event.target.value } })} />
                </Field>
              ))}
            </div>
          )}
        </section>
      </Card>

      <Card padded>
        <section className="fw-q-section" id="lb-sec-care" aria-labelledby="lb-h-care">
          <SectionHead id="lb-h-care" title={t('section.care')} sub={t('section.careSub')} />
          <div className="fw-lb-care">
            {CARE_KINDS.map((kind) => {
              const current = careOfKind(draft, kind)
              return (
                <Field key={kind} label={t(`careKind.${kind}`)}>
                  <Select size="sm" value={current?.symbol ?? ''} onChange={(event) => set({ care: setCare(draft, kind, event.target.value || null) })}>
                    <option value="">{t('field.careNone')}</option>
                    {careChoices(kind).map((choice) => (
                      <option key={choice.code} value={choice.code}>
                        {t(`care.${choice.code}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )
            })}
          </div>
          {draft.care.length > 0 && (
            <Disclosure summary={t('field.careTexts', { count: draft.care.filter((entry) => Object.values(entry.text).some((text) => text.trim() !== '')).length })} open={problems.some((issue) => /^care\/\d+\/text/.test(issue.path)) || undefined}>
              <p className="fw-q-hint">{t('field.careTextHint')}</p>
              <div className="fw-lb-caretexts">
                {draft.care.map((entry, index) => (
                  <fieldset key={entry.symbol} className="fw-lb-part">
                    <legend className="fw-lb-part-head">
                      <span>{CARE_SYMBOLS[entry.symbol] ? t(`care.${entry.symbol}`) : entry.symbol}</span>
                    </legend>
                    <div className="fw-q-form-two">
                      {draft.languages.map((language) => (
                        <Field key={language} label={t('field.careTextIn', { language })} error={problems.some((issue) => issue.path === `care/${index}/text/${language}`) ? t('problem.care') : undefined}>
                          <Input size="sm" lang={language} value={entry.text[language] ?? ''} maxLength={80} onChange={(event) => set({ care: draft.care.map((other, at) => (at === index ? { ...other, text: { ...other.text, [language]: event.target.value } } : other)) })} />
                        </Field>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
            </Disclosure>
          )}
        </section>
      </Card>

      <Card padded>
        <section className="fw-q-section" id="lb-sec-layout" aria-labelledby="lb-h-layout">
          <SectionHead id="lb-h-layout" title={t('section.layout')} sub={t('section.layoutSub')} />
          <div className="fw-q-form-two">
            <Field label={t('field.preset')} hint={t(`presetHint.${draft.preset}`)}>
              <SegmentedControl ariaLabel={t('field.preset')} size="sm" value={draft.preset} onChange={(value) => set({ preset: value as LabelDraft['preset'] })} options={[{ value: 'STANDARD', label: t('preset.STANDARD') }, { value: 'COMPACT', label: t('preset.COMPACT') }]} />
            </Field>
            <Field label={t('field.manufactureDate')} hint={t('field.manufactureDateHint')}>
              <Select size="sm" value={draft.manufactureDate} onChange={(event) => set({ manufactureDate: event.target.value as LabelDraft['manufactureDate'] })}>
                {(['QUARTER', 'MONTH', 'NONE'] as const).map((format) => (
                  <option key={format} value={format}>
                    {t(`dateFormat.${format}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('field.width')} hint={t('new.widthHint')} error={errorOf('size', ['widthMm'])}>
              <Input size="sm" inputMode="decimal" value={draft.widthMm} onChange={(event) => set({ widthMm: event.target.value })} />
            </Field>
            <Field label={t('field.height')} hint={t('new.heightHint')} error={errorOf('size', ['heightMm'])}>
              <Input size="sm" inputMode="decimal" value={draft.heightMm} onChange={(event) => set({ heightMm: event.target.value })} />
            </Field>
            {(cat3 || draft.notifiedBodyNumber !== '') && (
              <Field label={t('field.notifiedBody')} hint={t(cat3 ? 'field.notifiedBodyHint' : 'field.notifiedBodyNotCat3')} error={errorOf('notifiedBody', ['layout/notifiedBodyNumber'])}>
                <Input size="sm" inputMode="numeric" value={draft.notifiedBodyNumber} maxLength={4} onChange={(event) => set({ notifiedBodyNumber: event.target.value.replace(/\D/g, '') })} />
              </Field>
            )}
          </div>
          <h3 className="fw-lb-h3">{t('field.order')}</h3>
          <p className="fw-q-hint">{t('field.orderHint')}</p>
          <ol className="fw-lb-order" aria-label={t('field.order')}>
            {order.map((field, index) => (
              <li
                key={field}
                className="fw-lb-order-row"
                tabIndex={0}
                aria-label={t('field.orderRow', { n: index + 1, field: t(`field.name.${field}`) })}
                onKeyDown={(event) => {
                  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
                  event.preventDefault()
                  set({ fields: moveField(draft, ppe, field, event.key === 'ArrowUp' ? -1 : 1) })
                }}
              >
                <span className="fw-lb-order-n">{index + 1}</span>
                <span className="fw-lb-order-name">{t(`field.name.${field}`)}</span>
                <span className="fw-q-actions">
                  <Button size="sm" variant="quiet" aria-label={t('field.moveUp', { field: t(`field.name.${field}`) })} heldReason={index === 0 ? t('held.first') : null} onClick={() => set({ fields: moveField(draft, ppe, field, -1) })}>
                    <ArrowUp size={14} aria-hidden />
                  </Button>
                  <Button size="sm" variant="quiet" aria-label={t('field.moveDown', { field: t(`field.name.${field}`) })} heldReason={index === order.length - 1 ? t('held.last') : null} onClick={() => set({ fields: moveField(draft, ppe, field, 1) })}>
                    <ArrowDown size={14} aria-hidden />
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          <div className="fw-lb-optional">
            {optionalFields(ppe).map((field: LabelField) => (
              <span key={field} className="fw-lb-toggle">
                <Toggle checked={draft.fields.includes(field)} onChange={(next) => set({ fields: toggleField(draft, field, next) })} aria-label={t(`optional.${field}`)} />
                <span>{t(`optional.${field}`)}</span>
              </span>
            ))}
          </div>
        </section>
      </Card>
    </div>
  )
}

function SectionHead({ id, title, sub, actions }: { id: string; title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="fw-q-section-head">
      <div className="fw-q-section-title">
        <h2 id={id}>{title}</h2>
        {sub && <p className="fw-q-hint">{sub}</p>}
      </div>
      {actions && <div className="fw-q-actions">{actions}</div>}
    </div>
  )
}

/** The same content as text (a label out of DRAFT, or no right to change it): never greyed inputs. */
export function ContentFacts({ detail }: { detail: LabelDetail }) {
  const t = useT('labels')
  const ppe = isPpeLabel(detail)
  const order = printedOrder(
    {
      name: detail.name,
      languages: detail.languages,
      makerName: detail.makerName,
      makerAddress: detail.makerAddress,
      importerName: detail.importerName ?? '',
      importerAddress: detail.importerAddress ?? '',
      composition: detail.composition,
      animalOriginPhrase: detail.animalOriginPhrase,
      animalOriginTexts: detail.layout.texts.animalOrigin,
      care: detail.care.map((entry) => ({ symbol: entry.symbol, text: entry.text ?? {} })),
      preset: detail.layout.preset,
      fields: detail.layout.fields,
      manufactureDate: detail.layout.manufactureDate,
      notifiedBodyNumber: detail.layout.notifiedBodyNumber ?? '',
      widthMm: detail.widthMm,
      heightMm: detail.heightMm,
    },
    ppe,
  )
  return (
    <div className="fw-lb-form">
      <Card padded>
        <section className="fw-q-section" id="lb-sec-general" aria-labelledby="lb-h-general-ro">
          <SectionHead id="lb-h-general-ro" title={t('section.content')} />
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('field.name.label'), value: detail.name },
              { label: t('field.languages'), value: detail.languages.join(', ') || '—' },
              { label: t('field.makerName'), value: detail.makerName || '—', hint: detail.makerAddress },
              { label: t('field.importerName'), value: detail.importerName ?? t('field.noImporter'), hint: detail.importerAddress ?? undefined },
              {
                label: t('section.composition'),
                value: detail.composition.length === 0 ? t('field.noComposition') : detail.composition.map((part) => `${part.part}: ${part.fibres.map((fibre) => `${fibre.percent}% ${fibre.fibre}`).join(', ')}`).join(' · '),
              },
              { label: t('field.animalOrigin'), value: detail.animalOriginPhrase ? t('field.yes') : t('field.no') },
              { label: t('section.care'), value: detail.care.length === 0 ? t('field.careNone') : detail.care.map((entry) => (CARE_SYMBOLS[entry.symbol] ? t(`care.${entry.symbol}`) : entry.symbol)).join(' · ') },
              { label: t('field.preset'), value: t(`preset.${detail.layout.preset}`), hint: t(`dateFormat.${detail.layout.manufactureDate}`) },
              { label: t('field.size'), value: t('list.size', { width: mmWords(detail.widthMm), height: mmWords(detail.heightMm) }) },
              ...(detail.layout.notifiedBodyNumber ? [{ label: t('field.notifiedBody'), value: detail.layout.notifiedBodyNumber }] : []),
              { label: t('field.order'), value: order.map((field) => t(`field.name.${field}`)).join(' · ') },
            ]}
          />
        </section>
      </Card>
    </div>
  )
}
