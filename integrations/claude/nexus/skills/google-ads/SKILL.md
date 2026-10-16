---
name: google-ads
description: Run a business's Google Ads account and its Merchant Center account through Nexus - read first (what Nexus stored with google-ad-details; live from Google with google-ads-live, google-ads-numbers, google-ads-query, google-ads-experiments and google-merchant-live), plan, then ask for the changes as ONE change plan or ONE build call that a person approves in Nexus, never by rule - campaigns, budgets, targeting, audiences, keywords, negatives, ads and assets, Shopping, labels, Google's recommendations, bid strategies, URLs, exclusions, conversions and sales sent to Google, account settings, users, links and billing, experiments and drafts, Performance Max, Demand Gen, Display and App, and Merchant Center products, data sources and promotions. What can spend more (SPENDS MONEY) is the person's decision; a new campaign is made paused. Use when the person asks about their Google Ads or Merchant Center, wants to change, build, copy, pause or enable Google campaigns, send sales to Google, or asks what Nexus can and cannot do in Google Ads.
---

# Google Ads

Nexus works in the Google Ads account, and the Merchant Center account, that a person chose for the business. Every change is a request a person approves in Nexus; it runs as that person and never by a rule, whatever the business set for other tools. A change sent to Google has no cancel window: the approval is the brake. Amounts are minor units (cents) of the account's currency: never convert them.

## Ground rules

The Nexus server's instructions hold the rules for every change — say which business, read first and ask, one change plan for many changes, follow each change until approval-status says it ran, a temporary ad stop is lower bids (a real pause only when the person means one), never an FBA quantity, never the old flat-file pages. Follow them. Read `business-overview` for the exact market codes and account ids before you name one.

- **Money is the person's decision.** A preview marks every way a change can make the account spend more (`spendsMoney`, `spendsMoneyBecause`, "SPENDS MONEY" in its warnings): enabling, a budget or bid raise, wider targeting, a removed negative or exclusion, a goal or value that makes automatic bidding chase more. Repeat each line to the person before they decide. Never ask to enable anything they did not ask to enable.
- **A temporary stop** is lower bids or a lower budget (`set-google-keywords`, `set-google-ad-groups`, `set-google-product-groups`, `set-google-budget`); a pause (`set-google-status`) when the person asks for one. Never a removal: `remove-google-ads-items` and the other remove tools are for good, and only when the person asked to delete.
- **When something is missing.** If no Nexus tools are available, Nexus is not connected or its server is off (Claude Code: `/mcp`, choose Nexus, Authenticate; claude.ai: Customize › Connectors). If a tool is not offered, refuses, or says it is turned off for Claude, pass on the reason in plain words and carry on with the rest.

## 1. Read first

1. `business-overview`: the business. Pass `accountId` (a Google account's connectionId, from `channel-connections`) only when the business has more than one Google account.
2. What Nexus stored (read once a day; no Google cost): `ads-overview` and `ad-campaigns` with `channel: "google"` (never a `market`), then `google-ad-details`, one `view` at a time — `alerts` first, then `search-terms`, `brand-split`, `keywords`, `ad-groups`, `negatives`, `asset-groups`, `products`, `acts-on-its-own`, `recommendations` (the ids `apply-google-recommendations` takes) and `disapprovals`.
3. Live from Google (each read costs operations of the account's daily Google Ads allowance; use it to plan a change and to check one after it ran):
   - `google-ads-live`, one `view`: `campaigns`, `campaign` (one in full), `budgets`, `negative-lists`, `product-groups`, `ads`, `assets`, `asset-links`, `change-history`, `drafts`, `lookup` (ids of locations, languages, audiences, `life-events`, and the account's `user-lists`, `custom-audiences`, `combined-audiences`), `account`, `conversions`, `labels`, `experiments`, `users`, `billing`, `links`, `bid-strategies`, `auto-apply`, `exclusions`. The ids the change tools take come from here.
   - `google-ads-numbers`: numbers at any `level` (`campaign`, `ad-group`, `keyword`, `ad`, `asset`, `ad-group-asset`, `asset-group-asset`, `product`, `search-term`, `location`, `age`, `gender`, `audience`, `ad-group-audience`), `from`/`to` up to today, split by `day`, `hour`, `day-of-week`, `device` or `network`.
   - `google-ads-query`: one read-only GAQL query, for anything the others do not read.
   - `google-ads-experiments`: experiments and campaign drafts, and Google's long-running schedule or promote.
   - `google-merchant-live`: the Merchant Center account — `overview`, `products`, `product`, `data-sources`, `promotions`, `inventory`, `performance`.
4. Say the numbers as Google counts them: cost, conversions and conversion value (Google's attribution, days in the account's time zone). Never call them sales, orders or ACoS. A part not read yet is "not read yet", never 0.

## 2. Plan, then ask

Show one table: what changes, from → to, how many, the SPENDS MONEY lines, what cannot be undone, and whether Google checks it first. Name the business and the Google account. Ask, and go on only after a clear yes.

- **Changes to things that exist:** ONE `submit-change-plan`, one step per tool (see `change-plan`). Google checks each step now, as if it were asked for alone, so steps cannot wait for each other.
- **New parts that point at new parts** (a campaign with its ad groups, keywords, product groups and ads): ONE build call, never steps of a plan — `build-google-campaigns` or `copy-google-campaign` (Search, Shopping), `build-google-pmax` or `copy-google-pmax` (Performance Max), `create-google-demand-gen-campaign`, `create-google-display-campaign` or `create-google-app-campaign` (with their ad groups and ads). `check-google-ads-build` lets Google check a build without asking for it: nothing waits in Approvals.
- Give `why` on every change: the approver reads it.
- A new campaign is always made paused; new ad groups, keywords and ads in an enabled campaign are made paused unless `enable: true` (SPENDS MONEY). Enabling is `set-google-status`.

## 3. Which tool

| To change | Tool |
|---|---|
| Campaign settings, bidding, networks, location option, what Google does on its own (Search, Shopping) | `set-google-campaign`; a new campaign alone: `create-google-campaign` |
| Pause or enable campaigns, ad groups, keywords, ads | `set-google-status` (enabling: SPENDS MONEY) |
| Budgets, shared budgets | `set-google-budget` |
| Locations, languages, ad schedule, devices, radius | `set-google-targeting` |
| Audience segments; age, gender, parental status, income | `set-google-audiences`; `set-google-demographics` |
| Audiences of the account's own: custom segments (keywords, sites, apps); your data lists (website visitors by rules, combinations, converters, lookalikes); reusable audiences for Demand Gen and Performance Max | `set-google-custom-audiences`, `set-google-user-lists`, `set-google-reusable-audiences` (making one spends nothing; a change that widens one a serving campaign uses is SPENDS MONEY) |
| Ad groups (make, rename, default max CPC, rotation) | `set-google-ad-groups` |
| Keywords and their bids; a keyword's text, match type or ad group | `set-google-keywords`; `replace-google-keywords` (the old one is removed: only on the person's ask) |
| Negative keywords; shared negative lists | `set-google-negatives`; `set-google-negative-list` |
| Responsive search ads | `create-google-rsa`, `edit-google-rsa` (in place), `move-google-ads` |
| Assets of every type, at the account, campaigns and ad groups | `add-google-assets`, `set-google-assets`, `edit-google-assets`, `set-google-asset-links` |
| Shopping product groups, inventory filter, Shopping settings | `set-google-product-groups`, `set-google-inventory-filter`, `set-google-shopping-settings` |
| Labels | `set-google-labels`, `remove-google-labels` |
| Google's recommendations; what Google applies by itself | `apply-google-recommendations`, `dismiss-google-recommendations`; `set-google-auto-apply` (on = Google applies them with no approval in Nexus: say so plainly) |
| Portfolio bid strategies | `set-google-bid-strategy`, `remove-google-bid-strategy` |
| Tracking templates, URL suffixes, custom parameters, keyword URLs | `set-google-urls` |
| Placement, content and IP exclusions; brand and placement lists; the account's negative list | `set-google-account-exclusions`, `set-google-campaign-exclusions`, `set-google-exclusion-list` |
| Conversion actions, goals, value rules; sales sent to Google | `set-google-conversion-actions`, `remove-google-conversion-actions`, `set-google-conversion-goals`, `set-google-value-rules`; `upload-google-sales`, `adjust-google-sales` (5) |
| Custom conversion goals (chosen actions); the custom goal a campaign uses | `set-google-custom-goals`; `set-google-conversion-goals` with `customGoals` (more actions for Smart Bidding: SPENDS MONEY) |
| The account's settings, users, links, billing | `set-google-account-settings`, `set-google-user-access`, `set-google-account-links`, `set-google-billing` |
| Experiments and campaign drafts | `create-google-experiment`, `set-google-experiment`, `schedule-google-experiment`, `end-google-experiment`, `promote-google-experiment`, `graduate-google-experiment`, `set-google-campaign-draft`, `promote-google-campaign-draft` |
| Performance Max (with text guidelines, page feeds linked, an asset group's tracking); page feeds (URL inclusions) themselves | `build-google-pmax`, `copy-google-pmax`, `set-google-pmax`, `set-google-customer-acquisition`; `set-google-page-feed` |
| Demand Gen, Display, App (Display image and HTML5 ads, frequency caps, demographics with bid adjustments) | the three create tools above, `add-google-campaign-type-ads`, `set-google-campaign-type`, `edit-google-campaign-type-ads` |
| Delete | `remove-google-ads-items` (campaigns, ad groups, keywords, ads, budgets, lists) — only what the person asked to delete |
| Merchant Center | `set-google-merchant-products`, `set-google-merchant-data-sources`, `set-google-merchant-promotions` |

**Google checks first, except:** Google checks a change before it is queued (validate_only), so one Google would refuse never waits. It cannot for `apply-google-recommendations`, `dismiss-google-recommendations`, `set-google-user-access`, `set-google-account-links` (all but an unlink), `set-google-billing` (a billing setup) and every Merchant Center change: the preview says so, and when the approved change runs Nexus reads the account again and sends it only if nothing it stands on moved. Tell the person which kind they approve.

## 4. What Google's API cannot do

Say so plainly, and that the person does it in Google:
- **A payment card**: no API can add one (Google Ads › Billing). At Google's Explorer access level Google also refuses user management and billing through the API; the answer says so.
- **Google Analytics 4**: the Google Ads API has no GA4 link (`link-ga4` answers so). Link it in Google Analytics › Admin › Product links, or Google Ads › Tools › Data manager.
- **Customer Match lists**: Nexus never uploads buyers' e-mails, phones or addresses to make an audience (Google closed its upload service to new projects; it is personal data). Make the list in Google Ads › Audience manager.
- **Combined segments**: read only in the API (`google-ads-live` lookup `combined-audiences`); make them in Google Ads. `set-google-user-lists` combination lists do the same with lists.
- **A reusable audience cannot be removed**: Google's API has no remove for it; a new one stays, reaching nobody until a campaign uses it.
- **Video campaigns**: not made or changed through the API. Only a video responsive ad's own fields are edited in place (`edit-google-campaign-type-ads`).
- **Location assets**: Google makes them from a Business Profile linked in Google Ads; that link needs the profile owner's sign-in, which Nexus does not have (`link-business-profile` answers so).
- **HTML5 display ads** are taken only from accounts Google allowed (account age, spend, policy history, then "Apply for HTML5 access" in Google Ads); Google's check in the preview says whether this account may. Dynamic HTML5 ads (feed-based) are not made.
- **A Merchant Center link request** is sent from Merchant Center; Nexus accepts it (`accept-merchant-request`) or links directly. A whole YouTube channel is linked in Google Ads; the API links single videos.
- **The Merchant Center primary feed** (Shopify's Google channel) is never touched. Nexus writes only into data sources it made (supplemental and promotion). A supplemental source reaches products only once a person links it to the primary in Merchant Center (Data sources › the primary › Rules). Price, sale price, availability and link are changed in Nexus, from where they reach Shopify and its feed.

## 5. Sending sales to Google

`upload-google-sales` sends the business's Shopify orders that carry a Google click id to an "import from clicks" conversion action (`set-google-conversion-actions` makes one). It goes through Google's Data Manager API, and Google takes nothing until:
1. Nexus's Google sign-in carries the Data Manager permission. A sign-in made before Nexus asked for it lacks it: a person signs in to Google again in Nexus once (Settings › Channels › Google › Reconnect, every permission Google shows left ticked). This is the person's step: stop, tell them, and carry on once they say it is done.
2. The Data Manager API is on in Nexus's Google Cloud project (the Owner's step).

The preview says when either is missing. Buyers' e-mail and phone go only with `enhanced`, hashed, and only with their consent. Google answers with counts per reason, not per sale (Google Ads › Goals › Diagnostics). Sales sent cannot be taken back: `adjust-google-sales` retracts or restates them.

## 6. After, and undo

- `approval-status` with the `approvalId`: never say a change ran before it says so. `google-ads-live` shows the change at once; Nexus's stored views after its next read. A schedule or promote of an experiment or a draft finishes later: `google-ads-experiments` says when.
- `undo-change` asks for the opposite change, as a new request a person approves (see `review-and-undo`). A build or a new campaign is removed by its undo (new assets stay in the account, unused). Never undone: a removal, a dismissed recommendation, an ended experiment, a promoted experiment or draft, retracted sales; an applied recommendation only for a budget. Each tool's description says what its undo does.
