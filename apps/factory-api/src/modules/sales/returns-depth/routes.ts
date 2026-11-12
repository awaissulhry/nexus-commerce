import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { inlineDisposition } from '../quotes/preview'
import {
  applyPolicyContract,
  arrivedLateContract,
  changeFeeRuleContract,
  changePolicyContract,
  createFeeRuleContract,
  createPolicyContract,
  creditContract,
  depthContract,
  fillGarmentsContract,
  lineGarmentsContract,
  listFeeRulesContract,
  listPoliciesContract,
  nameGarmentContract,
  papersContract,
  previewCreditContract,
  previewFeesContract,
  previewPolicyContract,
  retirePolicyContract,
  scanCodeContract,
  scanGarmentContract,
} from './contract'
import { creditWithoutReturn, previewCreditWithoutReturn } from './credit'
import { arrivedLate, depthOfId, returnDepth } from './depth'
import { changeFeeRule, createFeeRule, listFeeRules } from './fee-rules'
import { previewFees } from './fees'
import { fillGarments, lineGarments, nameGarment, scanGarment } from './garments'
import { manifest } from './manifest'
import { changePolicy, createPolicy, listPolicies, retirePolicy } from './policies'
import { applyPolicy, previewPolicy } from './policy-check'
import { rmaPapersPdf, setScanCode } from './scan'

/**
 * Returns in depth (B-W2b-341): the return policies per channel (./policies.ts) and the fee rules (./fee-rules.ts), the
 * policy check of a return (./policy-check.ts), its depth and the late arrivals (./depth.ts), the fees a decision withholds
 * (./fees.ts; the decision itself is B-W2a-43's modules/sales/returns/decide.ts), the serial and lot of each line
 * (./garments.ts), credit without the goods (./credit.ts, the approval kind CREDIT_WITHOUT_RETURN), the scan code and the
 * papers (./scan.ts, ./sheet-pdf.ts). Paths beside W2a's /sales/returns routes (static segments come first).
 */

const pdf = (fileName: string) => ({ 'content-type': 'application/pdf', 'content-disposition': inlineDisposition(fileName), 'cache-control': 'no-store' })

export default defineRoutes('sales.returns-depth', manifest, async (app) => {
  app.get('/sales/returns/policies', { schema: listPoliciesContract }, async (request) => listPolicies(request, request.query))
  app.post('/sales/returns/policies', { schema: createPolicyContract }, async (request, reply) => reply.code(201).send(await createPolicy(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/sales/returns/policies/:policyId', { schema: changePolicyContract }, async (request) => changePolicy(request, request.params.policyId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/returns/policies/:policyId/retire', { schema: retirePolicyContract }, async (request) => retirePolicy(request, request.params.policyId, request.body, idempotencyKeyFrom(request)))

  app.get('/sales/returns/fee-rules', { schema: listFeeRulesContract }, async (request) => listFeeRules(request, request.query))
  app.post('/sales/returns/fee-rules', { schema: createFeeRuleContract }, async (request, reply) => reply.code(201).send(await createFeeRule(request, request.body, idempotencyKeyFrom(request))))
  app.patch('/sales/returns/fee-rules/:ruleId', { schema: changeFeeRuleContract }, async (request) => changeFeeRule(request, request.params.ruleId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/returns/policy-check', { schema: previewPolicyContract }, async (request) => previewPolicy(request, request.body))
  app.get('/sales/returns/arrived-late', { schema: arrivedLateContract }, async (request) => arrivedLate(request, request.query))

  app.get('/sales/returns/:returnId/depth', { schema: depthContract }, async (request) => returnDepth(request, request.params.returnId))
  app.post('/sales/returns/:returnId/policy', { schema: applyPolicyContract }, async (request) => ({ ...(await applyPolicy(request, request.params.returnId, request.body, idempotencyKeyFrom(request))), return: await depthOfId(request, request.params.returnId) }))
  app.post('/sales/returns/:returnId/fees/preview', { schema: previewFeesContract }, async (request) => previewFees(request, request.params.returnId, request.body))

  app.get('/sales/returns/:returnId/lines/:lineId/garments', { schema: lineGarmentsContract }, async (request) => lineGarments(request, request.params.returnId, request.params.lineId))
  app.put('/sales/returns/:returnId/lines/:lineId/garment', { schema: nameGarmentContract }, async (request) => ({ ...(await nameGarment(request, request.params.returnId, request.params.lineId, request.body, idempotencyKeyFrom(request))), return: await depthOfId(request, request.params.returnId) }))
  app.post('/sales/returns/:returnId/garments/fill', { schema: fillGarmentsContract }, async (request) => ({ ...(await fillGarments(request, request.params.returnId, request.body, idempotencyKeyFrom(request))), return: await depthOfId(request, request.params.returnId) }))
  app.post('/sales/returns/:returnId/garments/scan', { schema: scanGarmentContract }, async (request) => scanGarment(request, request.params.returnId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/returns/:returnId/lines/:lineId/credit-without-return/preview', { schema: previewCreditContract }, async (request) => previewCreditWithoutReturn(request, request.params.returnId, request.params.lineId, request.body))
  app.post('/sales/returns/:returnId/lines/:lineId/credit-without-return', { schema: creditContract }, async (request, reply) => {
    const answer = await creditWithoutReturn(request, request.params.returnId, request.params.lineId, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.credited ? 200 : 202).send({ ...answer, return: await depthOfId(request, request.params.returnId) })
  })

  app.post('/sales/returns/:returnId/scan-code', { schema: scanCodeContract }, async (request) => ({ ...(await setScanCode(request, request.params.returnId, request.body, idempotencyKeyFrom(request))), return: await depthOfId(request, request.params.returnId) }))
  app.get('/sales/returns/:returnId/papers', { schema: papersContract }, async (request, reply) => {
    const { pdf: body, fileName } = await rmaPapersPdf(request, request.params.returnId, request.query)
    return reply.headers(pdf(fileName)).send(body)
  })
})
