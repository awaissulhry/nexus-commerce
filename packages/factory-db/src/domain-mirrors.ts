import { DOCUMENT_TYPES } from '@nexus/factory-domain/documents/model'
import { SHADE_RULES } from '@nexus/factory-domain/inventory/reservations/shade'
import { PARTY_ROLES } from '@nexus/factory-domain/parties/rules'
import { GATE_PURPOSES } from '@nexus/factory-domain/people/privacy/purposes'
import { SKILL_KINDS, SKILL_LEVELS } from '@nexus/factory-domain/people/skills/rules'
import { INTEGRATION_MODES, INTEGRATION_PROVIDERS } from '@nexus/factory-domain/ports/provider'
import { NOTICE_KINDS, NOTICE_STATUSES } from '@nexus/factory-domain/privacy/notices'
import { DPIA_STATUSES, PROCESSING_ACTIVITY_STATUSES } from '@nexus/factory-domain/privacy/records'
import { DATA_REQUEST_KINDS, DATA_REQUEST_STATUSES, DATA_SUBJECT_KINDS } from '@nexus/factory-domain/privacy/retention/requests'
import { ERASURE_METHODS, RETENTION_ACTIONS, SWEEP_MODES, SWEEP_STATUSES } from '@nexus/factory-domain/privacy/retention/retention'
import { ITEM_KINDS, ITEM_SOURCINGS, ITEM_TRACKINGS, MATERIAL_STATUSES, TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import { OPERATION_STATUSES, WORK_CENTRE_KINDS } from '@nexus/factory-domain/product/routing/operations'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { BUNDLE_CODE_MODES, FLOOR_RULE_MODES } from '@nexus/factory-domain/production/settings/floor-rules'
import { MONITORING_BASES, SCAN_SUBJECTS } from '@nexus/factory-domain/production/settings/monitoring'
import { DOCUMENT_TEMPLATE_KINDS } from '@nexus/factory-domain/templates/documents'
import {
  BundleCodeMode,
  DataRequestKind,
  DataRequestStatus,
  DataSubjectKind,
  DocumentTemplateKind,
  ErasureMethod,
  FloorRuleMode,
  IntegrationMode,
  IntegrationProvider,
  ItemKind,
  ItemSourcing,
  ItemTracking,
  MasterStatus,
  MonitoringBasis,
  PartyRole,
  PeoplePurpose,
  PrivacyDpiaStatus,
  PrivacyNoticeKind,
  PrivacyNoticeStatus,
  ProcessingActivityStatus,
  RetentionAction,
  RetentionSweepMode,
  RetentionSweepStatus,
  ScanSubject,
  ShadeRule,
  SkillKind,
  SkillLevel,
  Tannage,
  Uom,
  WorkCentreKind,
} from './generated/prisma/enums'

/**
 * The schema's enums that mirror a closed list of factory-domain, value for value (B-W2b-F60). factory-domain is pure (no
 * Prisma), so the two sides can part unseen: on 11-15 DocumentTemplateKind had six values while documents/model.ts
 * DOCUMENT_TYPES had eight, and only a factory-db PostgreSQL test, which no normal check runs, said so. Each pair here is
 * checked twice:
 *
 *   by the TYPECHECK   `mirror(…, true)` takes `true` only while both sides hold the same values; else the argument's type
 *                      names them (`{ schemaOnly: …; domainOnly: … }`), so `npm run typecheck -w @nexus/factory-db`, run by
 *                      every check, fails on the line of the pair;
 *   at run time        domain-mirrors.vitest.test.ts compares the values of MIRRORS (no database).
 *
 * A Prisma enum that mirrors a factory-domain list is added here, with the list it mirrors (a list of the API itself, such as
 * platform/files/rules.ts, keeps its own test there: this package never imports the API). Only the tests import this module.
 */

/** `true` when the schema's values and the domain's are the same; else the values each side has and the other lacks. */
export type Parted<Schema extends string, Domain extends string> = [Exclude<Schema, Domain>, Exclude<Domain, Schema>] extends [never, never]
  ? true
  : { readonly schemaOnly: Exclude<Schema, Domain>; readonly domainOnly: Exclude<Domain, Schema> }

export interface Mirror {
  /** The Prisma enum. */
  readonly schemaEnum: string
  /** The factory-domain list it mirrors (`documents/model DOCUMENT_TYPES`). */
  readonly domainList: string
  readonly schema: readonly string[]
  readonly domain: readonly string[]
}

function mirror<Schema extends string, Domain extends string>(schemaEnum: string, schema: Readonly<Record<string, Schema>>, domainList: string, domain: readonly Domain[], same: NoInfer<Parted<Schema, Domain>>): Mirror {
  void same
  return Object.freeze({ schemaEnum, domainList, schema: Object.values(schema), domain: [...domain] })
}

export const MIRRORS: readonly Mirror[] = Object.freeze([
  // B-W2b-F60: every document the code prints takes a template, in the order the screens list them.
  mirror('DocumentTemplateKind', DocumentTemplateKind, 'documents/model DOCUMENT_TYPES', DOCUMENT_TYPES, true),
  mirror('DocumentTemplateKind', DocumentTemplateKind, 'templates/documents DOCUMENT_TEMPLATE_KINDS', DOCUMENT_TEMPLATE_KINDS, true),
  // B-W2b-54: the labour consultant's role.
  mirror('PartyRole', PartyRole, 'parties/rules PARTY_ROLES', PARTY_ROLES, true),
  mirror('PrivacyNoticeKind', PrivacyNoticeKind, 'privacy/notices NOTICE_KINDS', NOTICE_KINDS, true),
  mirror('PrivacyNoticeStatus', PrivacyNoticeStatus, 'privacy/notices NOTICE_STATUSES', NOTICE_STATUSES, true),
  mirror('PrivacyDpiaStatus', PrivacyDpiaStatus, 'privacy/records DPIA_STATUSES', DPIA_STATUSES, true),
  mirror('ProcessingActivityStatus', ProcessingActivityStatus, 'privacy/records PROCESSING_ACTIVITY_STATUSES', PROCESSING_ACTIVITY_STATUSES, true),
  mirror('DataSubjectKind', DataSubjectKind, 'privacy/retention/requests DATA_SUBJECT_KINDS', DATA_SUBJECT_KINDS, true),
  mirror('DataRequestKind', DataRequestKind, 'privacy/retention/requests DATA_REQUEST_KINDS', DATA_REQUEST_KINDS, true),
  mirror('DataRequestStatus', DataRequestStatus, 'privacy/retention/requests DATA_REQUEST_STATUSES', DATA_REQUEST_STATUSES, true),
  mirror('ErasureMethod', ErasureMethod, 'privacy/retention/retention ERASURE_METHODS', ERASURE_METHODS, true),
  mirror('RetentionAction', RetentionAction, 'privacy/retention/retention RETENTION_ACTIONS', RETENTION_ACTIONS, true),
  mirror('RetentionSweepMode', RetentionSweepMode, 'privacy/retention/retention SWEEP_MODES', SWEEP_MODES, true),
  mirror('RetentionSweepStatus', RetentionSweepStatus, 'privacy/retention/retention SWEEP_STATUSES', SWEEP_STATUSES, true),
  mirror('IntegrationProvider', IntegrationProvider, 'ports/provider INTEGRATION_PROVIDERS', INTEGRATION_PROVIDERS, true),
  mirror('IntegrationMode', IntegrationMode, 'ports/provider INTEGRATION_MODES', INTEGRATION_MODES, true),
  mirror('Uom', Uom, 'product/units/units UOMS', UOMS, true),
  // W2a wave 5: FINISHED is a finished garment's item (one per SKU), never a material: the library leaves it out.
  mirror('ItemKind', ItemKind, "product/materials/rules ITEM_KINDS + 'FINISHED'", [...ITEM_KINDS, 'FINISHED'] as const, true),
  mirror('ItemSourcing', ItemSourcing, 'product/materials/rules ITEM_SOURCINGS', ITEM_SOURCINGS, true),
  mirror('ItemTracking', ItemTracking, 'product/materials/rules ITEM_TRACKINGS', ITEM_TRACKINGS, true),
  mirror('Tannage', Tannage, 'product/materials/rules TANNAGES', TANNAGES, true),
  mirror('MasterStatus', MasterStatus, 'product/materials/rules MATERIAL_STATUSES', MATERIAL_STATUSES, true),
  mirror('MasterStatus', MasterStatus, 'product/routing/operations OPERATION_STATUSES', OPERATION_STATUSES, true),
  mirror('WorkCentreKind', WorkCentreKind, 'product/routing/operations WORK_CENTRE_KINDS', WORK_CENTRE_KINDS, true),
  mirror('PeoplePurpose', PeoplePurpose, 'people/privacy/purposes GATE_PURPOSES', GATE_PURPOSES, true),
  mirror('MonitoringBasis', MonitoringBasis, 'production/settings/monitoring MONITORING_BASES', MONITORING_BASES, true),
  mirror('ScanSubject', ScanSubject, 'production/settings/monitoring SCAN_SUBJECTS', SCAN_SUBJECTS, true),
  mirror('SkillKind', SkillKind, 'people/skills/rules SKILL_KINDS', SKILL_KINDS, true),
  mirror('SkillLevel', SkillLevel, 'people/skills/rules SKILL_LEVELS', SKILL_LEVELS, true),
  mirror('ShadeRule', ShadeRule, 'inventory/reservations/shade SHADE_RULES', SHADE_RULES, true),
  mirror('FloorRuleMode', FloorRuleMode, 'production/settings/floor-rules FLOOR_RULE_MODES', FLOOR_RULE_MODES, true),
  mirror('BundleCodeMode', BundleCodeMode, 'production/settings/floor-rules BUNDLE_CODE_MODES', BUNDLE_CODE_MODES, true),
])
