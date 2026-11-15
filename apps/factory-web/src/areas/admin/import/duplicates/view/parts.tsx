'use client'

import type { ReactNode } from 'react'
import { Banner } from '@nexus/ui/components'
import { Pill, Tag } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { DuplicateCandidate, DuplicateReasonFound } from '../api'
import { likelihoodTone, NAMESPACE, openHref, reasonWords, statusKey } from '../model'
import '../duplicates.css'

/**
 * The shared parts of likely duplicates (B-W2b-427): the reasons as tags in words, a record as a real link (code · name,
 * its status), and the warning on create (design customers.new, materials.new "Duplicate warning"). Each brings its own
 * catalogue, so it shows in the customer, supplier and material dialogs too.
 */

export function DupMessages({ children }: { children?: ReactNode }) {
  return <WithMessages namespaces={[NAMESPACE]}>{children}</WithMessages>
}

/** Why two records look alike, as tags ("Same VAT number", "Similar name (91%)", "Same e-mail domain rossi.example"). */
export function ReasonTags({ reasons }: { reasons: readonly DuplicateReasonFound[] }) {
  return (
    <DupMessages>
      <ReasonTagsInner reasons={reasons} />
    </DupMessages>
  )
}

function ReasonTagsInner({ reasons }: { reasons: readonly DuplicateReasonFound[] }) {
  const t = useT(NAMESPACE)
  return (
    <span className="fw-dup-reasons">
      {reasons.map((reason) => {
        const words = reasonWords(reason)
        return (
          <Tag key={`${reason.code}-${reason.detail ?? ''}`} tone={reason.code === 'SIMILAR_NAME' || reason.code === 'SAME_EMAIL_DOMAIN' || reason.code === 'SAME_WEBSITE' ? 'info' : 'warning'}>
            {t(words.key, words.params)}
          </Tag>
        )
      })}
    </span>
  )
}

/** A record as a real link (⌘-click opens a new tab), with its status in words. */
export function RecordLink({ prefix, record, newTab }: { prefix: string; record: Pick<DuplicateCandidate, 'recordType' | 'id' | 'code' | 'name' | 'companyId' | 'status'>; newTab?: boolean }) {
  const t = useT(NAMESPACE)
  return (
    <span className="fw-dup-record">
      <a className="fw-dup-link" href={openHref(prefix, record)} {...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        <span className="fw-dup-code">{record.code}</span> <span className="fw-dup-name">{record.name}</span>
      </a>
      {record.status !== 'ACTIVE' && (
        <Pill tone={record.status === 'ARCHIVED' ? 'neutral' : record.status === 'BLOCKED' ? 'danger' : 'info'}>
          {t(statusKey(record.status))}
        </Pill>
      )}
    </span>
  )
}

export interface DuplicateWarningProps {
  readonly candidates: readonly DuplicateCandidate[] | null
  readonly prefix: string
  /** PARTY: one record per business partner (a VAT number another party holds refuses the create). */
  readonly recordType: 'PARTY' | 'MATERIAL'
}

/**
 * The warning on create: the records the new one looks like, each with its reasons and a link (a new tab, so the draft
 * stays), and what to do. Nothing while there is no candidate. A same VAT number or codice fiscale of a party is said
 * as what it is: the create will be refused.
 */
export function DuplicateWarning(props: DuplicateWarningProps) {
  if (!props.candidates || props.candidates.length === 0) return null
  return (
    <DupMessages>
      <DuplicateWarningInner {...props} candidates={props.candidates} />
    </DupMessages>
  )
}

function DuplicateWarningInner({ candidates, prefix, recordType }: DuplicateWarningProps & { candidates: readonly DuplicateCandidate[] }) {
  const t = useT(NAMESPACE)
  const taxTaken = recordType === 'PARTY' && candidates.some((candidate) => candidate.reasons.some((reason) => reason.code === 'SAME_VAT_NUMBER' || reason.code === 'SAME_FISCAL_CODE'))
  const strong = candidates.some((candidate) => candidate.likelihood === 'HIGH')
  return (
    <Banner tone={taxTaken ? 'danger' : likelihoodTone(strong ? 'HIGH' : 'MEDIUM')} title={t(taxTaken ? 'dup.create.taxTaken' : 'dup.create.title', { count: candidates.length })}>
      <ul className="fw-dup-list" aria-label={t('dup.create.listLabel')}>
        {candidates.map((candidate) => (
          <li key={candidate.id}>
            <RecordLink prefix={prefix} record={candidate} newTab />
            <ReasonTagsInner reasons={candidate.reasons} />
          </li>
        ))}
      </ul>
      <p className="fw-dup-hint">{t(taxTaken ? 'dup.create.taxTakenHint' : recordType === 'PARTY' ? 'dup.create.hintParty' : 'dup.create.hintMaterial')}</p>
    </Banner>
  )
}
