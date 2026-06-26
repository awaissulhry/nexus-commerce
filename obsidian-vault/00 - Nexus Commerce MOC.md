# Nexus Commerce — Map of Content

> **What is this?** Nexus Commerce is a full-stack, multi-channel e-commerce operations platform built for **Xavia** (Italian motorcycle gear brand). It manages ~279 master SKUs across Amazon (11 EU markets), eBay, and Shopify with real-time sync, AI-powered listing content, and sophisticated fulfillment/repricing automation.

---

## Architecture

- [[01 - System Architecture Overview]]
- [[02 - Monorepo Structure]]
- [[03 - Deployment Architecture]]

## Backend

- [[04 - API Layer (Fastify)]]
- [[05 - Database Schema]]
- [[06 - Background Jobs & Workers]]
- [[07 - Real-time Architecture]]

## Frontend

- [[08 - Web App (Next.js)]]
- [[09 - Design System]]
- [[10 - Pages & Routes]]

## Integrations

- [[11 - Amazon SP-API Integration]]
- [[12 - eBay Integration]]
- [[13 - Shopify Integration]]
- [[14 - External Services]]

## Business Domains

- [[15 - Product Management]]
- [[16 - Listing Management]]
- [[17 - Inventory & Fulfillment]]
- [[18 - Orders & Sales]]
- [[19 - Pricing & Repricing]]
- [[20 - Advertising]]
- [[21 - Marketing & Content]]
- [[22 - Reviews & Customer Engagement]]
- [[23 - Analytics & Insights]]
- [[24 - Bulk Operations & Automation]]

## Cross-Cutting Concerns

- [[25 - Authentication & Authorization]]
- [[26 - Shared Packages]]
- [[27 - Bidding Engine Microservice]]

---

## Quick Reference

| Layer | Tech | Notes |
|-------|------|-------|
| Frontend | Next.js 16 App Router, React 18, Tailwind | Vercel (fra1) |
| Backend | Fastify 5, TypeScript, ES modules | Railway (europe-west4) |
| Database | PostgreSQL via Prisma 6, Neon managed | 416 models, 310 migrations |
| Queue | BullMQ 5 + ioredis on Redis | 102 cron jobs, 8 workers |
| Channels | Amazon SP-API, eBay Inventory API, Shopify REST | 3 channels, 11 Amazon markets |
| AI | Google Gemini (`@google/generative-ai`) | Listing wizard, content gen |
| DAM | Cloudinary | Image upload, transform, CDN |
| Real-time | Server-Sent Events (SSE) + Amazon SQS polling | ~30 s order latency |
| Search | Typesense (DORMANT) → Postgres FTS fallback | Dormant at 279 SKU scale |
| Observability | OpenTelemetry → HTTP OTLP exporter | HTTP + Prisma tracing |

---

## Key Constraints & Decisions

- `/products/amazon-flat-file` and `/products/ebay-flat-file` pages/routes are **untouchable** — sync via shared store only
- Operators read **English only** — Italian is for customer-facing listing content
- No local Docker/scratch DBs for verification — commit → push → Railway/Vercel live
- Design system (`apps/web/src/design-system`) is **mandatory** for all new UI — no hand-rolled components
- Typesense dormant by choice — Postgres FTS is sufficient at current scale
