import { COVERAGE_KINDS, type CoverageKind } from '@nexus/factory-domain/compliance/declarations/coverage'
import { DECLARATIONS_VIEW } from '@nexus/factory-domain/compliance/declarations/permissions'
import { listDeclarations, type DeclarationRowView } from '../../../modules/compliance/declarations/read'
import { defineExportSource } from '../source'

/**
 * Compliance › Declarations & instructions (`/compliance/declarations`, the declarations grid of SCR-052; B-W2b-268 on B-W2b-257's
 * read; design "Export ▾ (This view (CSV))"): every DoC and user-information leaflet as the list shows them, through the module's
 * own read (compliance.certificates.view over their companies). The address is the list's: `?kind=`, `?status=`, `?origin=`,
 * `?language=`, `?q=`. No money; a person's name only as the signatory a declaration prints.
 */

const STATUSES = ['DRAFT', 'ISSUED', 'SUPERSEDED', 'WITHDRAWN'] as const
const ORIGINS = ['SIGNED', 'GENERATED'] as const
type Query = { readonly kind?: CoverageKind; readonly status?: (typeof STATUSES)[number]; readonly origin?: (typeof ORIGINS)[number]; readonly language?: string; readonly q?: string }

export const complianceDeclarations = defineExportSource<Query, DeclarationRowView>({
  listKey: 'compliance.declarations',
  permission: DECLARATIONS_VIEW,
  query(address) {
    const kind = address.get('kind') ?? ''
    const status = address.get('status') ?? ''
    const origin = address.get('origin') ?? ''
    const language = address.get('language') ?? ''
    const q = (address.get('q') ?? '').trim()
    return {
      ...((COVERAGE_KINDS as readonly string[]).includes(kind) ? { kind: kind as CoverageKind } : {}),
      ...((STATUSES as readonly string[]).includes(status) ? { status: status as Query['status'] } : {}),
      ...((ORIGINS as readonly string[]).includes(origin) ? { origin: origin as Query['origin'] } : {}),
      ...(/^[a-z]{2,3}$/.test(language) ? { language } : {}),
      ...(q && q.length <= 100 ? { q } : {}),
    }
  },
  async read(caller, query) {
    const answer = await listDeclarations(caller, query)
    return { rows: answer.declarations, next: null }
  },
  columns: {
    style: { value: (row) => `${row.style.code} · ${row.style.name}` },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    language: { value: (row) => row.language.toUpperCase() },
    number: { value: (row) => row.number },
    revision: { value: (row) => row.revision },
    status: { value: (row, words) => words(`status.${row.status}`) },
    origin: { value: (row, words) => words(`origin.${row.origin}`) },
    translation: { value: (row, words) => (row.translationStatus ? words(`translation.${row.translationStatus}`) : null) },
    certificate: { value: (row) => row.certificate?.number ?? null },
    maker: { value: (row) => row.maker.name },
    standards: { value: (row) => row.standards.join(', ') },
    signedBy: { value: (row) => [row.signedByName, row.signedPlace, row.signedOn].filter(Boolean).join(' · ') || null },
    batches: { value: (row) => row.batches },
    public: { value: (row, words) => words(row.kind === 'DECLARATION_OF_CONFORMITY' && row.origin === 'SIGNED' && row.status === 'ISSUED' ? 'public.live' : 'public.not') },
    markets: { value: (row) => row.marketsNeeding.join(', ') },
  },
  words: {
    it: {
      'kind.DECLARATION_OF_CONFORMITY': 'Dichiarazione UE di conformità',
      'kind.USER_INFORMATION': "Istruzioni per l'uso",
      'status.DRAFT': 'Bozza',
      'status.ISSUED': 'Emessa',
      'status.SUPERSEDED': 'Sostituita',
      'status.WITHDRAWN': 'Ritirata',
      'origin.SIGNED': 'Firmata (caricata)',
      'origin.GENERATED': 'Generata (bozza fino alla verifica)',
      'translation.DRAFT': 'Da verificare',
      'translation.IN_TRANSLATION': 'In traduzione',
      'translation.CHECKED': 'Verificata',
      'public.live': 'Pubblicata',
      'public.not': 'Non sulla pagina pubblica',
    },
    en: {
      'kind.DECLARATION_OF_CONFORMITY': 'EU declaration of conformity',
      'kind.USER_INFORMATION': 'User information',
      'status.DRAFT': 'Draft',
      'status.ISSUED': 'Issued',
      'status.SUPERSEDED': 'Superseded',
      'status.WITHDRAWN': 'Withdrawn',
      'origin.SIGNED': 'Signed (uploaded)',
      'origin.GENERATED': 'Generated (draft until checked)',
      'translation.DRAFT': 'Ready to check',
      'translation.IN_TRANSLATION': 'In translation',
      'translation.CHECKED': 'Checked',
      'public.live': 'Published',
      'public.not': 'Not on the public page',
    },
  },
})
