import { CLAIMS_VIEW } from '@nexus/factory-domain/compliance/claims/permissions'
import { CLAIM_KINDS, CLAIM_SCOPES, CLAIM_STATES, type ClaimKind, type ClaimScope, type ClaimState } from '@nexus/factory-domain/compliance/claims/rules'
import { listClaims } from '../../../modules/compliance/claims/reads'
import type { ClaimView } from '../../../modules/compliance/claims/store'
import { defineExportSource } from '../source'

/**
 * Compliance › Sustainability › Sourcing & claims (`/compliance/sourcing`, the claims grid of SCR-215; B-W2b-264; design
 * "Export ▾ (This view (CSV))"): the claims as the list shows them, through the module's own read (compliance.certificates.view
 * over their companies). The address is the list's: `?state=current|all|DRAFT|APPROVED|BLOCKED|RETIRED`, `?kind=`, `?scope=`,
 * `?q=`. The words per language in one column (`it: …; en: …`); the evidence by file name; no money.
 */

type Query = { readonly state?: 'current' | 'all' | ClaimState; readonly kind?: ClaimKind; readonly scope?: ClaimScope; readonly q?: string }

export const complianceClaims = defineExportSource<Query, ClaimView>({
  listKey: 'compliance.sourcing',
  permission: CLAIMS_VIEW,
  query(address) {
    const state = address.get('state') ?? ''
    const kind = address.get('kind') ?? ''
    const scope = address.get('scope') ?? ''
    const q = (address.get('q') ?? '').trim()
    return {
      ...(state === 'current' || state === 'all' || (CLAIM_STATES as readonly string[]).includes(state) ? { state: state as Query['state'] } : {}),
      ...((CLAIM_KINDS as readonly string[]).includes(kind) ? { kind: kind as ClaimKind } : {}),
      ...((CLAIM_SCOPES as readonly string[]).includes(scope) ? { scope: scope as ClaimScope } : {}),
      ...(q && q.length <= 80 ? { q } : {}),
    }
  },
  async read(caller, query) {
    const answer = await listClaims(caller, query)
    return { rows: answer.claims, next: null }
  },
  columns: {
    code: { value: (row) => row.code },
    kind: { value: (row, words) => words(`kind.${row.kind}`) },
    wording: { value: (row) => Object.entries(row.wording).map(([language, text]) => `${language}: ${text}`).join('; ') },
    scope: { value: (row, words) => (row.style ? `${row.style.code} · ${row.style.name}` : row.material ? `${row.material.code} · ${row.material.name}` : words('scope.COMPANY')) },
    evidence: { value: (row) => row.evidence.map((file) => file.name).join('; ') },
    validUntil: { value: (row) => row.validUntil },
    approver: { value: (row) => row.approvedBy?.name ?? null },
    state: { value: (row, words) => words(`state.${row.state}`) },
    uses: { value: (row, words) => row.uses.kinds.map((kind) => words(`use.${kind}`)).join(', ') },
  },
  words: {
    it: {
      'kind.RECYCLED_CONTENT': 'Contenuto riciclato',
      'kind.ORGANIC_CONTENT': 'Contenuto biologico',
      'kind.BIO_BASED': 'Origine biologica',
      'kind.RESPONSIBLE_SOURCING': 'Approvvigionamento responsabile',
      'kind.SUBSTANCE_FREE': 'Senza una sostanza',
      'kind.DURABILITY': 'Durata',
      'kind.REPAIRABILITY': 'Riparabilità',
      'kind.CARBON': 'Clima',
      'kind.SOCIAL': 'Sociale',
      'kind.CERTIFICATION_LABEL': 'Marchio di certificazione',
      'kind.OTHER': 'Altro',
      'scope.COMPANY': "Tutta l'azienda",
      'state.DRAFT': 'Bozza',
      'state.APPROVED': 'Approvata',
      'state.BLOCKED': 'Bloccata: prove scadute',
      'state.RETIRED': 'Ritirata',
      'use.LABEL': 'Etichette',
      'use.STYLE': 'Modelli',
      'use.CATALOGUE': 'Catalogo',
      'use.WEB_SHOP': 'Negozio online',
      'use.OTHER': 'Altro',
    },
    en: {
      'kind.RECYCLED_CONTENT': 'Recycled content',
      'kind.ORGANIC_CONTENT': 'Organic content',
      'kind.BIO_BASED': 'Bio-based',
      'kind.RESPONSIBLE_SOURCING': 'Responsible sourcing',
      'kind.SUBSTANCE_FREE': 'Free of a substance',
      'kind.DURABILITY': 'Durability',
      'kind.REPAIRABILITY': 'Repairability',
      'kind.CARBON': 'Climate',
      'kind.SOCIAL': 'Social',
      'kind.CERTIFICATION_LABEL': 'Certification label',
      'kind.OTHER': 'Other',
      'scope.COMPANY': 'The whole company',
      'state.DRAFT': 'Draft',
      'state.APPROVED': 'Approved',
      'state.BLOCKED': 'Blocked: evidence expired',
      'state.RETIRED': 'Retired',
      'use.LABEL': 'Labels',
      'use.STYLE': 'Styles',
      'use.CATALOGUE': 'Catalogue',
      'use.WEB_SHOP': 'Web shop',
      'use.OTHER': 'Other',
    },
  },
})
