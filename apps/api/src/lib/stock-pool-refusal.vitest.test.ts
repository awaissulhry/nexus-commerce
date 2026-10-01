import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { installStockPoolRefusalReplies, stockPoolConnectedRefusal } from './stock-pool-refusal.js'

// What Prisma 7 throws when the database guard refuses (a P2010-style message with the SQLSTATE and the sentence).
const prismaStyle = (sentence: string) => Object.assign(new Error(`
Invalid \`prisma.product.update()\` invocation:


Database error. Code: \`23514\`. Message: \`${sentence}\``), { code: 'P2010' })
const borrower = 'GALE-JACKET-BLACK-M sells from the stock of Xavia Racing. Disconnect it first (Matrix, Stock source), then change it.'
const lender = 'GALE-JACKET-BLACK-M shares its stock with Motovento. Disconnect it there first, then change it.'

describe('a product that shares stock: the refusal reaches the person in words', () => {
  let apps: FastifyInstance[] = []
  afterEach(async () => { await Promise.all(apps.map((a) => a.close())); apps = [] })
  const app = (withHandler: boolean, error: unknown) => {
    const instance = Fastify({ logger: false })
    if (withHandler) installStockPoolRefusalReplies(instance)
    instance.get('/x', async () => { throw error })
    apps.push(instance)
    return instance
  }

  it('finds the sentence in a Prisma error, a plain error and a cause; nothing else', () => {
    expect(stockPoolConnectedRefusal(prismaStyle(borrower))).toBe(borrower)
    expect(stockPoolConnectedRefusal(prismaStyle(lender))).toBe(lender)
    expect(stockPoolConnectedRefusal(new Error(borrower))).toBe(borrower)
    expect(stockPoolConnectedRefusal(new Error('wrapped', { cause: prismaStyle(lender) }))).toBe(lender)
    expect(stockPoolConnectedRefusal(new Error('Unique constraint failed on the fields: (`workspaceId`,`sku`)'))).toBeNull()
    expect(stockPoolConnectedRefusal(new Error('The product sells from the stock of nobody'))).toBeNull()
    expect(stockPoolConnectedRefusal(null)).toBeNull()
  })

  it('replies 409 with the sentence', async () => {
    const res = await app(true, prismaStyle(borrower)).inject({ method: 'GET', url: '/x' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: borrower, code: 'stock_shared' })
  })

  it('leaves every other error exactly as the default handler answers it', async () => {
    const cases: unknown[] = [
      new Error('boom'),
      Object.assign(new Error('Bad input'), { statusCode: 400 }),
      Object.assign(new Error('Not yours'), { statusCode: 403, code: 'FORBIDDEN' }),
      prismaStyle('Some other database refusal'),
    ]
    for (const error of cases) {
      const ours = await app(true, error).inject({ method: 'GET', url: '/x' })
      const plain = await app(false, error).inject({ method: 'GET', url: '/x' })
      expect([ours.statusCode, ours.json()]).toEqual([plain.statusCode, plain.json()])
    }
  })
})
