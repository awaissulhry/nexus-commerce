import {
  addMappingBody,
  changeMappingBody,
  mappingAnswer,
  mappingParams,
  mappingQuery,
  mappingRowAnswer,
  removedAnswer,
  removeMappingQuery,
  settingsAnswer,
  settingsBody,
  settingsQuery,
} from '@nexus/factory-domain/accounting/mapping/contracts'
import { defineContract } from '@nexus/factory-domain/core/contracts'

/** The route contracts of the account mapping and the journals switch (B-W2b-408): the shapes are factory-domain's accounting/mapping/contracts. */

export const mappingContract = defineContract({ querystring: mappingQuery, response: { 200: mappingAnswer } })
export const addMappingContract = defineContract({ body: addMappingBody, response: { 201: mappingRowAnswer } })
export const changeMappingContract = defineContract({ params: mappingParams, body: changeMappingBody, response: { 200: mappingRowAnswer } })
export const removeMappingContract = defineContract({ params: mappingParams, querystring: removeMappingQuery, response: { 200: removedAnswer } })
export const settingsContract = defineContract({ querystring: settingsQuery, response: { 200: settingsAnswer } })
export const saveSettingsContract = defineContract({ body: settingsBody, response: { 200: settingsAnswer } })
