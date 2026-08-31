// EV.0 — @nexus/events barrel.
//
// The event contract, shared by every service that publishes or consumes.
// Deliberately dependency-free apart from zod: a bounded context must be able
// to depend on the contract without inheriting the primary app's Prisma
// client, its Fastify instance, or anything else that would make an
// independent deploy impossible.

export * from './envelope.js'
export * from './catalog.js'
