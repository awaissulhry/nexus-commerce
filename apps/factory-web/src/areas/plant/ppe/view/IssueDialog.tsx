'use client'

import { useMemo } from 'react'
import { FileSignature, HandHelping, Plus, Tablet, X } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, NumberStepper, RadioCard, Select, Spinner } from '@nexus/ui/primitives'
import { PPE_LIMITS, RECEIPT_STATEMENT, statementLanguageOf } from '@nexus/factory-domain/safety/ppe/rules'
import { Combobox, DateTimeField, FileDropzone, FileRow, Modal } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { GapRow } from '../api'
import { issueHeld, issueLineProblems, itemName, newLine, PPE_ISSUE_REASONS, SCAN_ACCEPT, scanTypeOk, signedAtHeld, unitsOf, type IssueDraft, type IssueLineDraft } from '../model'
import type { IssueState, PpePageActions, PpePageModel } from '../view-model'
import { problemText, receiptHref, useWhen, useWords } from './parts'

const MAX_SCAN = 20 * 1024 * 1024

/**
 * Issue PPE (design pop:issue; band primary `i`, a person's "Issue now" prefills it from their role's kit): the person, the items
 * (from the kit, prefilled; more from the catalogue), each with its size, quantity and why (new, a replacement, lost); then
 * how the person signs — on paper (the receipt recorded now, its signed scan uploaded with it or later from Issues) or with
 * their own badge and PIN at a floor tablet of their site (nothing is recorded here: the office never proves a PIN). The
 * lines are checked as the API checks them (factory-domain `lineProblems`). Esc closes; the focus returns to the opener.
 */
export function IssueDialog({ model, state, actions }: { model: PpePageModel; state: IssueState; actions?: PpePageActions | undefined }) {
  const t = useWords()
  const when = useWhen()
  const locale = useLocale()
  const draft = state.draft
  const people = state.people.status === 'ready' ? state.people.value : null
  const items = state.items.status === 'ready' ? state.items.value : null
  const person = people?.find((row) => row.employee.id === draft.employeeId) ?? null
  const now = new Date(model.now)
  const held = issueHeld(draft, { can: model.can, items, companyId: person?.companyId ?? null, canIssuePerson: person?.canIssue ?? false, tabletReady: model.tabletReady, busy: state.busy, now })
  const lineProblems = items && person ? issueLineProblems(draft, items, person.companyId) : []
  const set = (change: Partial<IssueDraft>, scan?: File | null) => actions?.onIssueDraft?.({ ...draft, ...change }, scan)
  const setLine = (index: number, change: Partial<IssueLineDraft>) => set({ lines: draft.lines.map((line, at) => (at === index ? { ...line, ...change } : line)) })
  const close = () => actions?.onAddress?.({ issue: null })

  const options = useMemo(
    () =>
      (people ?? []).map((row) => ({
        value: row.employee.id,
        label: [row.employee.name, row.employee.employeeCode, row.role?.name ?? t('gaps.noRole'), model.scope.allSites ? row.site.code : null].filter(Boolean).join(' · '),
      })),
    [people, t, model.scope.allSites],
  )

  if (state.recorded) {
    const receipt = state.recorded.answer.receipt
    return (
      <Modal
        open
        onClose={close}
        title={t('issue.title')}
        size="md"
        footer={
          <>
            <a className="fw-ppe-link" href={receiptHref(model.prefix, [receipt.id])} target="_blank" rel="noopener noreferrer">
              <FileSignature size={13} aria-hidden /> {t('issue.openReceipt')}
            </a>
            <span className="fw-ppe-grow" />
            <Button variant="primary" onClick={close}>
              {t('common.close')}
            </Button>
          </>
        }
      >
        <div className="fw-ppe-form">
          <Banner tone="success" title={t('issue.recorded', { name: receipt.employee.name, count: receipt.units, when: when(receipt.issuedAt) })} />
          {state.recorded.scanProblem ? (
            <Banner tone="warning" title={t('issue.scanNotTaken')}>
              {t(state.recorded.scanProblem)}
            </Banner>
          ) : (
            <p className="fw-ppe-muted">{t('issue.scanLater')}</p>
          )}
        </div>
      </Modal>
    )
  }

  const statement = RECEIPT_STATEMENT[statementLanguageOf(locale)]
  const primary = draft.method === 'tablet' ? t('issue.doneTablet') : t('issue.submit', { count: unitsOf(draft) })
  const addable = (items ?? []).filter((item) => item.status === 'ACTIVE')

  return (
    <Modal
      open
      onClose={close}
      title={t('issue.title')}
      size="xl"
      footer={
        <>
          <span className="fw-ppe-hint">{t('issue.foot')}</span>
          <span className="fw-ppe-grow" />
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onIssue?.()}>
            {state.busy ? <Spinner size={12} /> : draft.method === 'tablet' ? <Tablet size={14} aria-hidden /> : <HandHelping size={14} aria-hidden />} {primary}
          </Button>
        </>
      }
    >
      <form
        className="fw-ppe-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onIssue?.()
        }}
      >
        {state.people.status === 'error' || state.items.status === 'error' ? (
          <Banner
            tone="danger"
            title={t('issue.readFailed')}
            action={
              <Button size="sm" onClick={() => actions?.onRetryIssue?.()}>
                {t('common.retry')}
              </Button>
            }
          >
            {t(state.people.status === 'error' ? state.people.problem : state.items.status === 'error' ? state.items.problem : 'problem.read')}
          </Banner>
        ) : null}

        <Field label={t('issue.person')} required hint={t('issue.personHint')}>
          {people ? (
            <Combobox options={options} value={draft.employeeId ?? ''} placeholder={t('issue.personPlaceholder')} onChange={(value) => actions?.onIssuePerson?.(value || null)} />
          ) : state.people.status === 'loading' ? (
            <span className="fw-ppe-muted" role="status">
              <Spinner size={12} /> {t('common.reading')}
            </span>
          ) : (
            <span className="fw-ppe-muted">—</span>
          )}
        </Field>
        {person && <PersonKit person={person} locale={locale} />}

        <fieldset className="fw-ppe-fieldset">
          <legend className="fw-ppe-h3">{t('issue.items')}</legend>
          {draft.lines.length === 0 ? <p className="fw-ppe-muted">{t(person ? (person.role ? 'issue.kitComplete' : 'issue.noRoleLines') : 'issue.choosePerson')}</p> : null}
          {draft.lines.map((line, index) => {
            const item = items?.find((entry) => entry.id === line.ppeItemId) ?? null
            const problems = lineProblems.filter((entry) => entry.index === index)
            // A size not chosen yet is the button's reason (said once); a line says what it gets wrong beyond that.
            const problemAt = (field: string) => {
              const found = problems.find((entry) => entry.field === field)
              if (!found || (field === 'size' && line.size.trim() === '') || (field === 'quantity' && line.quantity === '')) return undefined
              return t(`issue.lineProblem.${field}`, { sizes: item?.sizes.join(', ') ?? '' })
            }
            const lineError = state.problem && state.problem.line === index ? problemText(t, state.problem) : null
            return (
              <div key={line.key} className="fw-ppe-line" role="group" aria-label={t('issue.lineLabel', { n: index + 1 })}>
                <Field label={t('issue.item')} error={problemAt('ppeItemId')}>
                  <Select value={line.ppeItemId} onChange={(event) => setLine(index, { ppeItemId: event.target.value, size: '' })}>
                    {!item && <option value={line.ppeItemId}>{t('issue.itemGone')}</option>}
                    {(items ?? []).filter((entry) => entry.status === 'ACTIVE' || entry.id === line.ppeItemId).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {`${itemName(entry, locale)} · ${entry.code}`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('issue.size')} error={problemAt('size')}>
                  {item && item.sizes.length > 0 ? (
                    <Select value={line.size} onChange={(event) => setLine(index, { size: event.target.value })}>
                      <option value="">{t('issue.chooseSize')}</option>
                      {item.sizes.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="fw-ppe-muted fw-ppe-field-text">{t('issues.oneSize')}</span>
                  )}
                </Field>
                <Field label={t('issue.quantity')} error={problemAt('quantity')}>
                  <NumberStepper value={line.quantity} min={1} max={PPE_LIMITS.quantity} decrementLabel={t('issue.less')} incrementLabel={t('issue.more')} onChange={(quantity) => setLine(index, { quantity })} />
                </Field>
                <Field label={t('issue.reason')}>
                  <Select value={line.reason} onChange={(event) => setLine(index, { reason: event.target.value as IssueLineDraft['reason'] })}>
                    {PPE_ISSUE_REASONS.map((reason) => (
                      <option key={reason} value={reason}>
                        {t(`reason.${reason}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button size="sm" variant="quiet" className="fw-ppe-line-remove" aria-label={t('issue.removeLine', { n: index + 1 })} onClick={() => set({ lines: draft.lines.filter((_, at) => at !== index) })}>
                  <X size={14} aria-hidden />
                </Button>
                {problemAt('line') || lineError ? <span className="fw-ppe-warn fw-ppe-line-note">{problemAt('line') ?? lineError}</span> : null}
              </div>
            )
          })}
          <span className="fw-ppe-row">
            <Plus size={14} aria-hidden />
            <Select
              size="sm"
              value=""
              aria-label={t('issue.addItem')}
              disabled={!items || draft.lines.length >= PPE_LIMITS.lines}
              onChange={(event) => {
                const item = addable.find((entry) => entry.id === event.target.value)
                if (item) set({ lines: [...draft.lines, newLine(item)] })
              }}
            >
              <option value="">{draft.lines.length >= PPE_LIMITS.lines ? t('held.tooManyLines') : t('issue.addItem')}</option>
              {addable.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`${itemName(entry, locale)} · ${entry.code}`}
                </option>
              ))}
            </Select>
          </span>
        </fieldset>

        <fieldset className="fw-ppe-fieldset">
          <legend className="fw-ppe-h3">{t('issue.signature')}</legend>
          <div className="fw-ppe-methods" role="radiogroup" aria-label={t('issue.signature')}>
            <RadioCard name="ppe-method" value="paper" checked={draft.method === 'paper'} selected={draft.method === 'paper'} title={t('issue.paper')} description={t('issue.paperHint')} onChange={() => set({ method: 'paper' })} />
            <RadioCard
              name="ppe-method"
              value="tablet"
              checked={draft.method === 'tablet'}
              selected={draft.method === 'tablet'}
              title={t('issue.tablet')}
              description={model.tabletReady ? t('issue.tabletHint') : t('held.tabletNotReady')}
              onChange={() => set({ method: 'tablet' })}
            />
          </div>
          {draft.method === 'paper' ? (
            <div className="fw-ppe-form">
              <Field label={t('issue.signedAt')} hint={t('issue.signedAtHint')} error={(() => {
                const key = signedAtHeld(draft.signedAt, now)
                return key ? t(key) : undefined
              })()}>
                <DateTimeField value={draft.signedAt} max={model.now} locale={locale} ariaLabel={t('issue.signedAt')} onChange={(signedAt) => set({ signedAt })} />
              </Field>
              {!model.can.upload ? (
                <p className="fw-ppe-muted">{t('held.upload')}</p>
              ) : draft.scan ? (
                <FileRow
                  name={draft.scan.name}
                  size={draft.scan.size}
                  status={scanTypeOk(draft.scan.type, draft.scan.name) ? t('issue.scanReady') : t('held.scanType')}
                  tone={scanTypeOk(draft.scan.type, draft.scan.name) ? 'neutral' : 'danger'}
                  onRemove={() => set({ scan: null }, null)}
                />
              ) : (
                <FileDropzone
                  accept={SCAN_ACCEPT}
                  maxBytes={MAX_SCAN}
                  hint={t('issue.scanHint')}
                  onFiles={(files) => {
                    const file = files[0]
                    if (file) set({ scan: { name: file.name, type: file.type, size: file.size } }, file)
                  }}
                />
              )}
            </div>
          ) : (
            <div className="fw-ppe-form">
              <p className="fw-ppe-muted">{t('issue.tabletSteps', { site: person?.site.name ?? t('issue.theirSite') })}</p>
              <blockquote className="fw-ppe-quote">{statement}</blockquote>
              <p className="fw-ppe-muted">{t('issue.tabletNothing')}</p>
            </div>
          )}
        </fieldset>

        {state.problem && state.problem.line === null ? <Banner tone="danger" title={problemText(t, state.problem)} /> : null}
      </form>
    </Modal>
  )
}

/** The chosen person's role and kit against what they hold (the prefill's source), in words. */
function PersonKit({ person, locale }: { person: GapRow; locale: string }) {
  const t = useWords()
  if (!person.role) return <p className="fw-ppe-muted">{t('issue.noRole')}</p>
  return (
    <div className="fw-ppe-kit" aria-label={t('issue.kitOf', { role: person.role.name })}>
      <span className="fw-ppe-muted">{t('issue.kitOf', { role: person.role.name })}</span>
      <ul className="fw-ppe-chips">
        {person.lines.map((line) => (
          <li key={line.ppeItemId} className={line.missing > 0 ? 'fw-ppe-chip is-missing' : 'fw-ppe-chip'}>
            {t('issue.kitLine', { item: itemName(line.item, locale), held: line.held, needed: line.quantity })}
            {line.replace > 0 ? ` · ${t('issue.kitReplace', { count: line.replace })}` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}

