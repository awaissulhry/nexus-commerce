import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { inShellAs, TRAINING_ROLES } from '../../fixtures'
import { demoPdf, DEMO_RECORD } from '../_demo'
import { CertificateView, type CertificateModel } from './view/CertificateView'

/**
 * SCR-160-certificate — Certificate (PDF) (design people.skills tab:certificate, from a course cell or a record row), made-up
 * data: the register's record in Italian or English with the provider's own file, a record with no provider file, being made,
 * a failed read, no right.
 */

interface CertificateCase {
  permissions: readonly string[]
  model: CertificateModel
}

const model = (over: Partial<CertificateModel> = {}, permissions: readonly string[] = TRAINING_ROLES.hrSafety): CertificateCase => ({
  permissions,
  model: { allowed: true, language: 'it', person: 'Davide Modello', record: DEMO_RECORD, pdf: demoPdf('Registro formazione DEMO'), problem: null, opening: null, ...over },
})

function CertificateDesign({ model: value }: { model: CertificateCase }) {
  return inShellAs('/people/skills/certificate', createElement(CertificateView, { model: value.model }), value.permissions)
}

export const designScreen = defineDesignScreen<CertificateCase>({
  screen: 'SCR-160-certificate',
  title: 'Skills & training: certificate (PDF)',
  view: CertificateDesign,
  cases: [
    { id: 'record', label: 'The record as the register keeps it, with the provider certificate', model: model(), note: 'Made now, stored nowhere; Italiano | English; Print. The provider file opens as it is.' },
    { id: 'english', label: 'In English', model: model({ language: 'en', pdf: demoPdf('Training record DEMO') }) },
    { id: 'no-provider', label: 'No provider file on the record', model: model({ record: { ...DEMO_RECORD, certificates: [] } }) },
    { id: 'opening', label: 'Opening the provider file', model: model({ opening: DEMO_RECORD.certificates[0]!.id }) },
    { id: 'alone', label: 'Opened without the person (the record only)', model: model({ person: null, record: null }) },
    { id: 'loading', label: 'Being made', model: model({ pdf: null }) },
    { id: 'error', label: 'The record could not be read', model: model({ pdf: null, problem: 'problem.unavailable' }) },
    { id: 'company-legal', label: 'Refused: the company lacks its legal data for the letterhead (said with where to add it)', model: model({ pdf: null, problem: 'problem.companyLegal' }) },
    { id: 'no-permission', label: 'Sales: no safety.view', model: model({ allowed: false, record: null, pdf: null, person: null }, []) },
  ],
})
