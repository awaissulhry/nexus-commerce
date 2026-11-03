import type { FactoryClient } from '@nexus/factory-db'
import type { AlertAudience, AlertChannel, QualityAlertEvent } from '@nexus/factory-domain/quality/rules/alerts'
import type { CommandTx } from '../../../core/command'

/** The storage shapes of the quality rules (B-W2b-118): QualityAlertRule rows and the firing's audit action. */

export type Db = FactoryClient | CommandTx

export const RULE_COLUMNS = {
  id: true,
  companyId: true,
  event: true,
  audience: true,
  roleId: true,
  withinMinutes: true,
  daysBefore: true,
  channels: true,
  enabled: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const

export interface RuleRow {
  readonly id: string
  readonly companyId: string | null
  readonly event: QualityAlertEvent
  readonly audience: AlertAudience
  readonly roleId: string | null
  readonly withinMinutes: number
  readonly daysBefore: readonly number[]
  readonly channels: readonly AlertChannel[]
  readonly enabled: boolean
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** The audit action of one firing, on the rule's trail (its `after.key` makes the firing once). */
export const FIRED_ACTION = 'quality.alertFired'
