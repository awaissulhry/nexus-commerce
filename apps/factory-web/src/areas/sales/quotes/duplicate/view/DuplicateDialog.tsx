'use client'

import { useEffect, useRef, useState } from 'react'
import { Banner, Field, KeyValue } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { droppedWords, warningWords } from '../../model'
import { duplicateHeld, type DuplicateActions, type DuplicateModel } from '../model'

/**
 * Duplicate a quote (design sales.quotes "Duplicate (W2a)", SAL-155): the version to copy, for the same customer or
 * another one (a customer search), then Duplicate; the answer says what the copy left out (made-to-measure, a size or a
 * colourway no longer offered) and any warning in this screen's words, with Open the new quote. Fetches nothing.
 */
export function DuplicateDialog({ model, canManage, actions }: { model: DuplicateModel; canManage: boolean; actions?: DuplicateActions }) {
  const t = useT('sales')
  const [query, setQuery] = useState(model.query)
  const typed = useRef(false)
  const search = useRef(actions?.onDuplicateSearch)
  search.current = actions?.onDuplicateSearch
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => search.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const held = duplicateHeld(model, canManage)
  const close = () => actions?.onDuplicateClose?.()
  const done = model.done
  if (done) {
    return (
      <Modal
        open
        onClose={close}
        title={t('dup.doneTitle', { number: done.number })}
        size="md"
        footer={
          <>
            <Button onClick={close}>{t('common.close')}</Button>
            <Button variant="primary" onClick={() => actions?.onDuplicateOpen?.(done.quoteId)}>
              {t('dup.open', { number: done.number })}
            </Button>
          </>
        }
      >
        <div className="fw-q-dialog">
          <p className="fw-q-hint" role="status">
            {t('dup.doneBody', { number: done.number, source: model.source.number, count: done.lines })}
          </p>
          {done.dropped.length > 0 && (
            <Banner tone="warning" title={t('dup.droppedTitle', { count: done.dropped.length })}>
              <ul className="fw-q-list">
                {done.dropped.map((item) => {
                  const words = droppedWords(item)
                  return <li key={`${item.seq}-${item.size ?? ''}`}>{t(words.key, words.params)}</li>
                })}
              </ul>
            </Banner>
          )}
          {done.warnings.map((warning) => (
            <Banner key={warning} tone="info" title={t(warningWords(warning).key)} />
          ))}
          {done.dropped.length === 0 && done.warnings.length === 0 && <Banner tone="success" title={t('dup.allCopied')} />}
        </div>
      </Modal>
    )
  }
  return (
    <Modal
      open
      onClose={close}
      title={t('dup.title', { number: model.source.number })}
      size="md"
      footer={
        <>
          <Button onClick={close}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => !held && actions?.onDuplicate?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('dup.go')}
          </Button>
        </>
      }
    >
      <div className="fw-q-dialog">
        <p className="fw-q-hint">{t('dup.body')}</p>
        {model.source.versions.length > 1 && (
          <Field label={t('dup.version')}>
            <Select value={model.versionId} onChange={(event) => actions?.onDuplicateField?.({ versionId: event.target.value })}>
              <option value="">{t('dup.versionCurrent', { revision: model.source.revision })}</option>
              {model.source.versions
                .filter((version) => version.revision !== model.source.revision)
                .map((version) => (
                  <option key={version.id} value={version.id}>
                    {t('dup.versionOther', { revision: version.revision, status: t(`status.${version.status}`) })}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <fieldset className="fw-q-radios">
          <legend className="fw-q-legend">{t('dup.for')}</legend>
          <RadioCard name="fw-q-dup-target" value="same" checked={model.target === 'same'} selected={model.target === 'same'} onChange={() => actions?.onDuplicateField?.({ target: 'same' })} title={t('dup.same', { name: model.source.partyName })} description={t('dup.sameBody')} />
          <RadioCard name="fw-q-dup-target" value="other" checked={model.target === 'other'} selected={model.target === 'other'} onChange={() => actions?.onDuplicateField?.({ target: 'other' })} title={t('dup.other')} description={t('dup.otherBody')} />
        </fieldset>
        {model.target === 'other' &&
          (model.party ? (
            <div className="fw-q-chosen-head">
              <strong>{model.party.legalName}</strong>
              <Button size="sm" variant="quiet" onClick={() => actions?.onDuplicatePick?.(null)}>
                {t('newQuote.change')}
              </Button>
            </div>
          ) : (
            <>
              <Field label={t('newQuote.customer')} hint={t('newQuote.customerHint')}>
                <Input
                  value={query}
                  type="search"
                  autoComplete="off"
                  placeholder={t('newQuote.customerPlaceholder')}
                  onChange={(event) => {
                    typed.current = true
                    setQuery(event.target.value)
                  }}
                />
              </Field>
              {model.searchProblem ? (
                <Banner tone="danger" title={t(model.searchProblem)} />
              ) : (
                <fieldset className="fw-q-choices">
                  <legend className="fw-q-legend" aria-live="polite">
                    {model.results === null ? t('newQuote.searching') : model.results.length === 0 ? t('newQuote.none') : t('newQuote.found', { count: model.results.length })}
                  </legend>
                  {model.results === null && <Spinner size={14} />}
                  {(model.results ?? [])
                    .filter((row) => row.id !== model.source.partyId)
                    .map((row) => (
                      <RadioCard
                        key={row.id}
                        variant="row"
                        name="fw-q-dup-customer"
                        value={row.id}
                        checked={false}
                        onChange={() => actions?.onDuplicatePick?.(row)}
                        title={row.legalName}
                        description={
                          <span className="fw-q-tags">
                            <span className="fw-q-hint">{[row.tradeName, row.code, row.city].filter(Boolean).join(' · ')}</span>
                            {row.status !== 'ACTIVE' && <Tag tone="danger">{t(`partyStatus.${row.status}`)}</Tag>}
                          </span>
                        }
                      />
                    ))}
                </fieldset>
              )}
            </>
          ))}
        <KeyValue dense labelCase="sentence" items={[{ label: t('dup.keeps'), value: t(model.target === 'same' ? 'dup.keepsSame' : 'dup.keepsOther') }]} />
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}
