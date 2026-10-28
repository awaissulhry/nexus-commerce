import { describe, expect, it } from 'vitest'
import { buildApp } from './app'

describe('buildApp', () => {
  it('answers /health', async () => {
    const app = buildApp()
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
    await app.close()
  })

  it('has no other route yet', async () => {
    const app = buildApp()
    const response = await app.inject({ method: 'GET', url: '/' })
    expect(response.statusCode).toBe(404)
    await app.close()
  })
})
