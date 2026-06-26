# Reviews & Customer Engagement

→ [[00 - Nexus Commerce MOC]] | [[10 - Pages & Routes]]

## Overview

Automated review request emails, sentiment analysis, response management, GDPR compliance, and customer RFM segmentation.

---

## Review Pipeline (RV-series, Series Complete)

All phases shipped 2026-05-23 (commit `bee32904`).

| Phase | Feature |
|-------|---------|
| RV.1 | Review ingestion + storage |
| RV.2 | Request rule builder |
| RV.3 | Email campaign engine |
| RV.4 | Sentiment analysis (Gemini AI) |
| RV.5 | Response management + approval |
| RV.6 | Analytics dashboard |
| RV.7 | Spotlight curation |
| RV.8 | GDPR EmailSuppression |
| RV.9.1 | Setup nudge |
| RV.9.2 | Orphan-sweeper |
| Health banner | Pipeline health indicator |
| RV.9.3 | IT/DE/FR/ES multi-language emails |
| RV.9.4 | Per-rule analytics |
| RV.9.5 | GDPR EmailSuppression + unsubscribe |
| RV.9.6 | Test mode |
| RV.9.7 | Review → rule attribution |

---

## Data Models

| Model | Purpose |
|-------|---------|
| `Review` | Product review (rating, body, channel, date) |
| `ReviewResponse` | Brand response to review |
| `ReviewRequest` | Review solicitation record |
| `ReviewRule` | Automation rule (trigger, delay, template, channel) |
| `ReviewSpotlight` | Curated featured reviews |
| `ReviewSentiment` | AI sentiment score + topics |

---

## Review Request Flow

```
Order status → DELIVERED
    │
    ▼
ReviewRule evaluation
(trigger: delivered, delay: +7 days)
    │
    ▼
ReviewRequest created (status: PENDING)
    │
    ▼
Email sent (IT/DE/FR/ES localised)
    │
    ▼
ReviewRequest.status = SENT
    │
    ├── Customer clicks → OPENED
    ├── Customer responds → RESPONDED
    └── Unsubscribe → SUPPRESSED (EmailSuppression)
```

---

## Sentiment Analysis

Uses **Google Gemini** AI:
- `ReviewSentiment.score` — 0.0 to 1.0
- `ReviewSentiment.topics` — extracted topics (sizing, comfort, quality, delivery)
- Used in per-rule analytics + aggregation

---

## GDPR Compliance

- `EmailSuppression` model — stores unsubscribe records
- Unsubscribe link in every review request email
- `ConsentRecord` — tracks opt-in/opt-out events
- `DataRetentionPolicy` — automatic purge schedule
- `/settings/privacy` — admin GDPR panel

---

## Per-Rule Analytics

Each `ReviewRule` tracks:
- Request sent count
- Open rate
- Response rate
- Review attributions (which rule drove which review)
- A/B test results (test mode)

---

## Review Response Workflow

1. Negative review triggers alert
2. Response drafted (manually or AI-assisted)
3. Approval queue — manager approves
4. Response posted to marketplace (Amazon/eBay)

---

## Customer Intelligence (CI-series)

4 phases shipped 2026-05-16:

| Phase | Feature |
|-------|---------|
| CI.1 | RFM scoring (Recency, Frequency, Monetary) |
| CI.2 | Segment builder (rule-based segments) |
| CI.3 | Analytics dashboard |
| CI.4 | Bulk actions (email campaigns, offers) |

### RFM Segmentation

```
Champions        — Recent, Frequent, High-value
Loyal Customers  — Frequent, High-value
At Risk          — Was loyal, not recent
Lost             — Low recency, low frequency
New Customers    — Recent, low frequency
```

Route: `/customers`  
Model: `Customer`, `CustomerSegment`

---

## Multi-language Email Support

Review request emails localised for:
- 🇮🇹 Italian (IT)
- 🇩🇪 German (DE)
- 🇫🇷 French (FR)
- 🇪🇸 Spanish (ES)

Locale detection: based on Amazon marketplace of the order.

---

## Customer Models

| Model | Purpose |
|-------|---------|
| `Customer` | Customer record (email, name, channel, externalId) |
| `CustomerSegment` | Named segment with RFM/custom rules |
| `CustomerAddress` | Shipping + billing addresses |
| `CustomerNote` | Internal CRM notes |

---

## Review API Routes (`reviews.routes.ts` — 79.2 KB)

| Route | Purpose |
|-------|---------|
| `GET /api/reviews` | List reviews |
| `GET /api/reviews/rules` | List review request rules |
| `POST /api/reviews/rules` | Create rule |
| `GET /api/reviews/requests` | List sent requests |
| `GET /api/reviews/analytics` | Aggregated analytics |
| `POST /api/reviews/:id/respond` | Submit response |

---

## Related Notes

- [[18 - Orders & Sales]] — orders trigger review requests
- [[14 - External Services]] — Gemini AI for sentiment
- [[05 - Database Schema]] — Review, ReviewRule models
- [[23 - Analytics & Insights]] — customer analytics
