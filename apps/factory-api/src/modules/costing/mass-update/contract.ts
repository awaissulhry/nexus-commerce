import { defineContract } from '@nexus/factory-domain/core/contracts'
import { massApplyBody, massApplyView, massPreviewBody, massPreviewView } from '@nexus/factory-domain/costing/mass-update/contracts'

/** The route contracts of the mass cost update: the shapes are factory-domain's costing/mass-update/contracts (cost, price and margin by grain). */
export const massPreviewContract = defineContract({ body: massPreviewBody, response: { 200: massPreviewView } })
export const massApplyContract = defineContract({ body: massApplyBody, response: { 200: massApplyView } })
