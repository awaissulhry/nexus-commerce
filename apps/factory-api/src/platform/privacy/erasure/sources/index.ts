import type { DataSubjectKind } from '@nexus/factory-domain/privacy/retention/requests'
import { ownRecords } from './own'
import { accountRecords, contactRecords, personalValues, workRecords } from './records'
import { history, mails, messages } from './shared'
import type { PersonSource } from './type'

/**
 * Every source of a person's data (B-W2b-405; PLT-202, PLT-203): ONE LINE PER SOURCE (a step that keeps personal data in a new
 * table adds its source here, with what the package shows and what an erasure does). The person's own record comes first.
 */
export const PERSON_SOURCES: readonly PersonSource[] = [
  ownRecords,
  contactRecords,
  personalValues,
  workRecords,
  accountRecords,
  messages,
  mails,
  history,
]

export const sourcesFor = (kind: DataSubjectKind): readonly PersonSource[] => PERSON_SOURCES.filter((source) => source.kinds.includes(kind))
