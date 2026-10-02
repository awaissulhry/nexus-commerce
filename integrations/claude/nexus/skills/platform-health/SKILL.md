---
name: platform-health
description: Check the health of a Nexus business's platform side - channel accounts (sign-in state, missing permissions, last sync and error), how each channel's calls are doing, the alerts inbox, failed or stuck syncs, failed imports, exports and bulk jobs - explain what needs a person, and offer to acknowledge alerts, adjust alert rules or roll back a bulk job as requests a person approves. Use when the person asks whether the connections are healthy, why a sync failed, about alerts or notifications, or about failed jobs or imports.
---

# Platform health

Reads first. Connecting, reconnecting or disconnecting a channel account, retrying or purging queues, triggering schedules and anything about keys, tokens or webhooks stay with a person in Nexus: Claude never does them, and no tool shows a token or secret.

## Ground rules

- **Say which business first.** This connection works in one business, and every Nexus answer names it (`business`). Before you ask for any change, say it in plain words ("This connection works in Acme Racing"), and pass that exact name as `business` on the change tool or on `submit-change-plan`. Never reuse an id, a SKU or an approvalId read on another business's connection: the same SKU can exist in both.
- **Read first, show the plan, ask.** Read what is there now. Show the plan: what changes, from → to, how many, and where it lands (Nexus only, or a marketplace or a buyer). Ask a plain question; go on only after a clear yes. If the person changes the plan, show it again.
- **One request.** Several changes go in ONE `submit-change-plan` (up to 200 steps; a bulk tool counts as one step) or one bulk tool. Never a loop of single requests.
- **Follow up.** A change answers `status: "waiting_for_approval"` (a person approves it on the Nexus Approvals page: give the `approveAt` link; it expires at `expiresAt`), or `status: "runs_by_rule"` (the business lets it run by itself at `runsAt`, and anyone can stop it before then at `stopAt`). With a `confirm` part, the business set it to "confirm in Claude": ask the person who asked for the 6-digit code from their authenticator app, then call `confirm-change` with the `approvalId`, the `planHash` and the code. Never say anything changed until `approval-status` says it ran; repeat its `meaning`.
- **Never** pause an ad (lower its bids instead), change an FBA quantity (it is Amazon's number), send anyone to the old Amazon or eBay flat-file pages (use the product sheet and the product studio), or guess, keep or reuse an authenticator code.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read

1. **Accounts.** `channel-connections` (`channel`; `connectionId` for one account's last 10 events): health and why, sign-in state, markets, permissions missing since the channel asked for more, last sync and last error, own or shared with this business.
2. **Calls.** `channel-health` (`channel`, `hours` up to 168): failed and slow calls against their targets, how long the oldest waiting change has waited, incoming events that gave up, the five worst operations. `traceId` (from `sync-activity`) shows every channel call one change made.
3. **Inbox.** `alerts-inbox` (`source`, `severity`): failed or given-up syncs, alerts that fired and were not acknowledged, unread notifications, failed incoming events, worst first; the first page counts them and lists the alert rules.
4. **Queues.** `sync-activity` with `kind: "queue"` (`tab`: active, dead), `"failed-calls"`, `"webhooks"`, `"error-groups"`.
5. **Jobs.** `job-history` (`kind`: import, export, bulk, transfer; `status: "FAILED"`; `jobId` for one job and its first rows).
6. When asked: `audit-trail` (who changed what), `ai-usage` (Nexus's own AI use), `business-overview`.

## 2. Report

- Accounts that need a person (sign in again, grant a missing permission), with where: Settings › Channels in Nexus.
- Channels whose calls fail or lag, the worst operations, and the oldest waiting change.
- Alerts by severity, the recurring errors, and dead queue items per channel.
- Failed jobs, with the first failing rows' reasons.
- What could not be read (a tool not allowed for this person).

## 3. Offer (only when asked)

| To | Tool |
|---|---|
| Acknowledge or resolve alerts, mark notifications read | `acknowledge-alerts` (up to 50 each, with a `note`) |
| Create an alert rule or change one's threshold, window, channel or on/off | `set-alert-rule` (a new rule notifies the Nexus log only; where alerts are sent is set by a person) |
| Undo a finished bulk job or catalog import | `rollback-bulk-operation` (`jobId` from `job-history`; refused when a value changed since) |

Put them in ONE `submit-change-plan`. A failed listing push is re-sent with `publish-listing` (see `fix-listing-issues`), not from here.
