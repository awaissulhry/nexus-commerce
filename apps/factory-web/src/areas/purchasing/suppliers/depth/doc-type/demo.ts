import type { PickerReason } from '../../../../_shared/reasons/api'
import type { Vault } from '../api'
import type { DocTypeModel } from './use-doc-type'

/**
 * Made-up document types for SCR-057's `w2b-382-*` cases (B-W2b-382): the standard SUPPLIER_DOCUMENT_TYPE codes with words in
 * Italian and English (the list's own), a vault whose chromium VI report is typed and whose LWG audit is not. Design-only.
 */
const reason = (n: number, code: string, labelIt: string, labelEn: string): PickerReason => ({ id: `0190f0e2-3821-7000-8000-${String(n).padStart(12, '0')}`, list: 'SUPPLIER_DOCUMENT_TYPE', code, labelIt, labelEn, labelI18n: {}, icon: null, colour: null, needsDetail: false, sortOrder: n })

export const DOC_TYPES: readonly PickerReason[] = [
  reason(1, 'DURC', 'DURC (regolarità contributiva)', 'DURC (social contributions)'),
  reason(2, 'LWG_AUDIT', 'Audit LWG', 'LWG audit'),
  reason(3, 'ISO_9001', 'Certificato ISO 9001', 'ISO 9001 certificate'),
  reason(4, 'REACH_DECLARATION', 'Dichiarazione REACH', 'REACH declaration'),
  reason(5, 'CR_VI_TEST_REPORT', 'Rapporto di prova cromo VI', 'Chromium VI test report'),
  reason(6, 'AZO_TEST_REPORT', 'Rapporto di prova coloranti azoici', 'Azo dyes test report'),
]

/** The vault with its first report typed as a chromium VI test report; the others not said. */
export const typedVault = (vault: Vault): Vault => ({ ...vault, documents: vault.documents.map((doc, index) => (index === 0 ? { ...doc, documentTypeCode: 'CR_VI_TEST_REPORT' } : { ...doc, documentTypeCode: null })) })

export const docTypeModel = (over: Partial<DocTypeModel> = {}): DocTypeModel => ({ types: DOC_TYPES, mayType: true, offline: false, dialog: null, done: null, ...over })
