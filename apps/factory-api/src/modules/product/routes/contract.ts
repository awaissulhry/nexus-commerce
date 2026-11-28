import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { deleteStyleRouteQuery, routeSourcesQuery, routeSourceView, styleRouteBody, styleRouteView, updateStyleRouteBody } from '@nexus/factory-domain/product/routing/contracts'

/** owb-pd2 2.3: the style routes' and route sources' contracts (factory-domain product/routing/contracts). No money. */
const revision = input({ styleId: id(), revisionId: id() })
const route = input({ styleId: id(), revisionId: id(), routeId: id() })
const list = { 200: output({ routes: z.array(styleRouteView) }) }

export const listStyleRoutesContract = defineContract({ params: revision, response: list })
export const createStyleRouteContract = defineContract({ params: revision, body: styleRouteBody, response: { 201: output({ route: styleRouteView }) } })
export const updateStyleRouteContract = defineContract({ params: route, body: updateStyleRouteBody, response: { 200: output({ route: styleRouteView }) } })
export const deleteStyleRouteContract = defineContract({ params: route, querystring: deleteStyleRouteQuery, response: list })
export const routeSourcesContract = defineContract({ querystring: routeSourcesQuery, response: { 200: output({ products: z.array(routeSourceView) }) } })
