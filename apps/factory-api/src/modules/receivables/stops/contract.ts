import { defineContract } from '@nexus/factory-domain/core/contracts'
import { addStopBody, changeStopBody, liftStopBody, stopAnswer, stopParams, stopsAnswer, stopsQuery } from '@nexus/factory-domain/receivables/stops/contracts'

/** B-W2b-402: the route contracts of reminder stops (the shapes are factory-domain's receivables/stops/contracts). */
export const listStopsContract = defineContract({ querystring: stopsQuery, response: { 200: stopsAnswer } })
export const addStopContract = defineContract({ body: addStopBody, response: { 201: stopAnswer } })
export const changeStopContract = defineContract({ params: stopParams, body: changeStopBody, response: { 200: stopAnswer } })
export const liftStopContract = defineContract({ params: stopParams, body: liftStopBody, response: { 200: stopAnswer } })
