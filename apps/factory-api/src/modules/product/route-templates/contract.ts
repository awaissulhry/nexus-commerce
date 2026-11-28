import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { listRouteTemplatesQuery, routeTemplateBody, routeTemplateMoveBody, routeTemplateView, updateRouteTemplateBody } from '@nexus/factory-domain/product/routing/contracts'

/** owb-pd2 2.3: the ready-made routes' contracts (factory-domain product/routing/contracts). No money. */
const template = input({ templateId: id() })
const one = output({ template: routeTemplateView })

export const listTemplatesContract = defineContract({ querystring: listRouteTemplatesQuery, response: { 200: output({ templates: z.array(routeTemplateView) }) } })
export const createTemplateContract = defineContract({ body: routeTemplateBody, response: { 201: one } })
export const updateTemplateContract = defineContract({ params: template, body: updateRouteTemplateBody, response: { 200: one } })
export const moveTemplateContract = defineContract({ params: template, body: routeTemplateMoveBody, response: { 200: one } })
