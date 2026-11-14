import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { ppvAnswer, ppvPostAnswer, ppvPostBody, ppvQuery, ppvReverseAnswer, ppvReverseBody } from '@nexus/factory-domain/costing/ppv/contracts'
import { actualSettingsBody, actualSettingsQuery, actualSettingsView } from '@nexus/factory-domain/costing/ppv/settings'

/** The route contracts of the purchase price variance and the actual-cost settings: factory-domain's costing/ppv shapes. */

export const settingsContract = defineContract({ querystring: actualSettingsQuery, response: { 200: output({ settings: actualSettingsView }) } })
export const saveSettingsContract = defineContract({ body: actualSettingsBody, response: { 200: output({ settings: actualSettingsView }) } })
export const ppvListContract = defineContract({ querystring: ppvQuery, response: { 200: ppvAnswer } })
export const ppvPostContract = defineContract({ body: ppvPostBody, response: { 200: ppvPostAnswer, 201: ppvPostAnswer } })
export const ppvReverseContract = defineContract({ params: input({ varianceId: id() }), body: ppvReverseBody, response: { 201: ppvReverseAnswer, 200: ppvReverseAnswer } })
