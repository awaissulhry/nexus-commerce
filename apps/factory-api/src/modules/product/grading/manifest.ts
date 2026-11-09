import { defineManifest } from '../../../core/manifest'

/**
 * The grade rules' routes (B-W2b-224; design products.sizes "Grade rules", the Grade rule pop-up, the size scale's Grade
 * rules tab, products.styles "Apply grade rule"). Office only. The library as the size scales (product.styles.view |
 * manage); grading a style's spec as its spec (product.bom.view to preview, product.bom.manage to apply). Each handler
 * checks the record's company with can() (`record`).
 */
const libraryView = { audiences: ['office'], permission: 'product.styles.view', scope: 'record' } as const
const libraryManage = { audiences: ['office'], permission: 'product.styles.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /product/grade-rules': libraryView,
  'POST /product/grade-rules': libraryManage,
  'GET /product/grade-rules/:ruleId': libraryView,
  'PATCH /product/grade-rules/:ruleId': libraryManage,
  'PUT /product/grade-rules/:ruleId/steps': libraryManage,
  // The list's selection (Owner rule 2026-10-29): several rules archived or restored.
  'POST /product/grade-rules/status': libraryManage,
  'GET /product/size-scales/:scaleId/grade-rules': libraryView,
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/grade/preview': { audiences: ['office'], permission: 'product.bom.view', scope: 'record' },
  'POST /product/styles/:styleId/revisions/:revisionId/measurement-spec/grade': { audiences: ['office'], permission: 'product.bom.manage', scope: 'record' },
})
