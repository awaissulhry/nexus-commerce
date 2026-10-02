/**
 * MCP full control 07 — a route's answer as a value, so route code moved into a service answers exactly as the route
 * did and the route (or a tool) decides what to do with it. `AnswerReply` stands in for Fastify's reply inside the
 * moved code: `reply.code(400).send(body)` becomes RouteAnswer(400, body); a plain value returned is RouteAnswer(200).
 */

export class RouteAnswer {
  constructor(readonly status: number, readonly body: any, readonly headers: Record<string, string> = {}) {}
  get ok(): boolean {
    return this.status >= 200 && this.status < 300
  }
}

export class AnswerReply {
  private statusCode = 200
  private readonly headerValues: Record<string, string> = {}
  code(status: number): this {
    this.statusCode = status
    return this
  }
  /** Fastify's other name for code(). */
  status(status: number): this {
    return this.code(status)
  }
  /** A response header the route sent with its answer (the route passes them on: `reply.headers(answer.headers)`). */
  header(name: string, value: string): this {
    this.headerValues[name] = value
    return this
  }
  send(body: unknown): RouteAnswer {
    return new RouteAnswer(this.statusCode, body, { ...this.headerValues })
  }
}

/** The moved code's result as an answer: a RouteAnswer as it is, anything else a 200 with that body. */
export const answered = (value: unknown): RouteAnswer => (value instanceof RouteAnswer ? value : new RouteAnswer(200, value))

/** What the moved code logs to (the route passes Fastify's logger; a tool its own). */
export interface RouteLog {
  warn: (...args: any[]) => void
  error: (...args: any[]) => void
}
