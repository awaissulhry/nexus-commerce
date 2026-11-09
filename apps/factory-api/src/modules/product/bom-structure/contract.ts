import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { bomCheckView, bomStructureView, changeStructureBody, explosionQuery, explosionView, setLineStructureBody, usedInView } from '@nexus/factory-domain/product/bom-structure/contracts'

/** The BOM structure routes' contracts: the bodies and answers are factory-domain's product/bom-structure/contracts. No money. */

const revision = input({ styleId: id(), revisionId: id() })
const line = input({ styleId: id(), revisionId: id(), lineId: id() })
const structure = { 200: output({ structure: bomStructureView }) }

export const getStructureContract = defineContract({ params: revision, response: structure })
export const getCheckContract = defineContract({ params: revision, response: { 200: output({ check: bomCheckView }) } })
export const getExplosionContract = defineContract({ params: revision, querystring: explosionQuery, response: { 200: output({ explosion: explosionView }) } })
export const setLineStructureContract = defineContract({ params: line, body: setLineStructureBody, response: structure })
export const changeStructureContract = defineContract({ params: revision, body: changeStructureBody, response: structure })
export const usedInContract = defineContract({ params: input({ styleId: id() }), response: { 200: output({ usedIn: usedInView }) } })
