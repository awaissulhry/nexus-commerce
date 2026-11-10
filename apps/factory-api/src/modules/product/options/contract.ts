import { defineContract, output } from '@nexus/factory-domain/core/contracts'
import {
  checkBody,
  checkView,
  createEffectBody,
  createGroupBody,
  createValueBody,
  effectParams,
  groupListView,
  groupParams,
  groupView,
  lineOptionBody,
  lineOptionView,
  lineParams,
  listGroupsQuery,
  offerBody,
  offerParams,
  priceBody,
  removeEffectQuery,
  rulesBody,
  statusBody,
  styleOptionsView,
  styleParams,
  updateEffectBody,
  updateGroupBody,
  updateValueBody,
  valueParams,
  withdrawBody,
  withdrawnView,
} from '@nexus/factory-domain/product/options/contracts'

/** The option library's contracts (B-W2b-229): factory-domain's product/options/contracts. */

const group = { 200: output({ group: groupView }) }
const options = { 200: output({ options: styleOptionsView }) }

export const listGroupsContract = defineContract({ querystring: listGroupsQuery, response: { 200: groupListView } })
export const getGroupContract = defineContract({ params: groupParams, response: group })
export const createGroupContract = defineContract({ body: createGroupBody, response: { 201: output({ group: groupView }) } })
export const updateGroupContract = defineContract({ params: groupParams, body: updateGroupBody, response: group })
export const groupStatusContract = defineContract({ params: groupParams, body: statusBody, response: group })

export const addValueContract = defineContract({ params: groupParams, body: createValueBody, response: { 201: output({ group: groupView }) } })
export const updateValueContract = defineContract({ params: valueParams, body: updateValueBody, response: group })
export const valueStatusContract = defineContract({ params: valueParams, body: statusBody, response: group })

export const setRulesContract = defineContract({ params: groupParams, body: rulesBody, response: group })

export const addEffectContract = defineContract({ params: valueParams, body: createEffectBody, response: { 201: output({ group: groupView }) } })
export const updateEffectContract = defineContract({ params: effectParams, body: updateEffectBody, response: group })
export const removeEffectContract = defineContract({ params: effectParams, querystring: removeEffectQuery, response: group })
export const setPriceContract = defineContract({ params: valueParams, body: priceBody, response: group })

export const styleOptionsContract = defineContract({ params: styleParams, response: options })
export const offerContract = defineContract({ params: offerParams, body: offerBody, response: options })
export const withdrawContract = defineContract({ params: offerParams, body: withdrawBody, response: { 200: withdrawnView } })
export const checkContract = defineContract({ params: styleParams, body: checkBody, response: { 200: output({ check: checkView }) } })

export const lineOptionContract = defineContract({ params: lineParams, body: lineOptionBody, response: { 200: lineOptionView } })
