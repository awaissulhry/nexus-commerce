'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { Banner, EmptyState, Field, Modal } from '@nexus/ui/components'
import { Button, Input, RadioCard, Skeleton, Textarea } from '@nexus/ui/primitives'
import { EVIDENCE_RULES, type EvidenceRule } from '@nexus/factory-domain/quality/lab/rules'
import { useT } from '../../../../lib/i18n/provider'
import type { Lot } from '../../../quality/_shared/lots'
import type { Read } from '../../../quality/_shared/model'
import type { LabSettings } from '../api'
import { loosens, reasonProblem, type RuleDraft } from '../model'
import { CrViMark } from './parts'

const lotHref = (prefix: string, lotId: string, query: string): string => `${prefix}/compliance/tests/${encodeURIComponent(lotId)}?${query}`

/**
 * "Record test result" from the list (design ts-record opens from the band): the lots waiting for chromium VI evidence,
 * to choose the one the report is for; the result is recorded on the lot's record (its limit, its rule, its file).
 */
export function PickLotDialog({
  open,
  rows,
  query,
  prefix,
  onQuery,
  onPick,
  onClose,
}: {
  open: boolean
  rows: Read<Lot[]>
  query: string
  prefix: string
  onQuery: (text: string) => void
  onPick: (lot: Lot) => void
  onClose: () => void
}) {
  const t = useT('lab')
  const q = useT('quality')
  const shown = useMemo(() => {
    const text = query.trim().toLowerCase()
    return (rows.value ?? []).filter((lot) => text === '' || `${lot.code} ${lot.item.code} ${lot.item.name}`.toLowerCase().includes(text))
  }, [rows.value, query])
  return (
    <Modal open={open} onClose={onClose} title={t('pick.title')} subtitle={t('pick.sub')} size="md" footer={<Button onClick={onClose}>{q('common.cancel')}</Button>}>
      <div className="fw-q-form">
        <Input size="sm" type="search" leadingIcon={<Search size={14} aria-hidden />} aria-label={t('pick.search')} placeholder={t('pick.search')} value={query} onChange={(event) => onQuery(event.target.value)} autoFocus />
        {rows.problem ? (
          <Banner tone="danger" title={q(rows.problem)} />
        ) : rows.value === null ? (
          <Skeleton height={120} />
        ) : shown.length === 0 ? (
          <EmptyState title={rows.value.length === 0 ? t('pick.none') : t('pick.noMatch')} description={t('pick.noneBody')} />
        ) : (
          <ul className="fw-q-checks" aria-label={t('pick.title')}>
            {shown.map((lot) => (
              <li key={lot.id} className="fw-lab-pick">
                <span className="fw-q-cell">
                  <Link
                    className="fw-q-name fw-q-code"
                    href={lotHref(prefix, lot.id, 'tab=results&act=result')}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
                      event.preventDefault()
                      onPick(lot)
                    }}
                  >
                    {lot.code}
                  </Link>
                  <span className="fw-q-hint">
                    {lot.item.code} · {lot.item.name}
                  </span>
                </span>
                <CrViMark lot={lot} withValue={false} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

/**
 * The chromium VI evidence rule (Owner question Q14; design ts-rule, compliance.settings rm-cr6): a supplier report that
 * covers the article and the period counts (the default), or a lab report for every lot. Tightening saves at once;
 * loosening asks for the reason here and then a fresh code (the step-up dialog opens on the API's answer).
 */
export function RuleDialog({
  open,
  settings,
  draft,
  busy,
  problem,
  onDraft,
  onSave,
  onClose,
}: {
  open: boolean
  settings: LabSettings | null
  draft: RuleDraft | null
  busy: boolean
  problem: string | null
  onDraft: (draft: RuleDraft) => void
  onSave: () => void
  onClose: () => void
}) {
  const t = useT('lab')
  const q = useT('quality')
  if (!settings) return null
  const current = settings.crViEvidenceRule
  const value: RuleDraft = draft ?? { rule: current, reason: '' }
  const loosening = loosens(current, value.rule)
  const reasonKey = loosening ? reasonProblem(value.reason) : null
  const held = value.rule === current ? t('rule.unchanged') : reasonKey ? t(reasonKey) : null
  const choose = (rule: EvidenceRule) => onDraft({ ...value, rule })
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('rule.dialogTitle')}
      subtitle={t(`rule.source.${settings.source}`)}
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {q('common.cancel')}
          </Button>
          <Button variant="primary" onClick={onSave} heldReason={busy ? q('common.loading') : held}>
            {loosening ? t('rule.saveLoosen') : t('rule.save')}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        {problem && <Banner tone="danger" title={t(problem)} />}
        <div className="fw-q-choices" role="radiogroup" aria-label={t('rule.dialogTitle')}>
          {EVIDENCE_RULES.map((rule) => (
            <RadioCard
              key={rule}
              name="crvi-rule"
              value={rule}
              checked={value.rule === rule}
              selected={value.rule === rule}
              onChange={() => choose(rule)}
              title={`${t(`rule.option.${rule}`)}${rule === current ? ` · ${t('rule.inForce')}` : ''}`}
              description={t(`rule.optionHint.${rule}`)}
            />
          ))}
        </div>
        <p className="fw-q-hint">{t('rule.limitNote', { limit: '3' })}</p>
        {loosening && (
          <>
            <Banner tone="warning" title={t('rule.loosenTitle')}>
              {t('rule.loosenBody')}
            </Banner>
            <Field label={t('rule.reason')} required hint={t('rule.reasonHint')} error={value.reason.trim() !== '' && reasonKey ? t(reasonKey) : undefined}>
              <Textarea value={value.reason} onChange={(event) => onDraft({ ...value, reason: event.target.value })} rows={3} />
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
