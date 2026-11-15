import { defineContract } from '@nexus/factory-domain/core/contracts'
import { correctFiguresBody, figuresAnswer, figuresListAnswer, figuresListQuery, figuresParams, recordFiguresBody } from '@nexus/factory-domain/receivables-figures/contracts'

/** B-W2b-406: the route contracts of a customer's own figures (the shapes are factory-domain's receivables-figures/contracts). */
export const listFiguresContract = defineContract({ querystring: figuresListQuery, response: { 200: figuresListAnswer } })
export const getFiguresContract = defineContract({ params: figuresParams, response: { 200: figuresAnswer } })
export const recordFiguresContract = defineContract({ body: recordFiguresBody, response: { 201: figuresAnswer } })
export const correctFiguresContract = defineContract({ params: figuresParams, body: correctFiguresBody, response: { 200: figuresAnswer } })
