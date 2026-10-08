# Nexus for Claude

This folder connects Claude to Nexus. It holds two Claude plugins and the marketplace that lists them:

- **`nexus`** — the commerce side (catalog, listings, content, ids, prices, stock, suppliers, orders, returns, ads, automations, platform). It holds the address of the Nexus MCP server, `https://nexusapi-production-b7bb.up.railway.app/mcp`, and 22 skills. Claude signs in with your own Nexus account.
- **`nexus-factory`** — the factory app. It starts the factory's own small server on the factory machine (no network) and adds one skill, `factory-desk`.

No token, password or client secret is stored in these files.

> **The Owner controls access.** The Nexus MCP server must be switched on, and a business must be on the server's list of businesses Claude may connect to, before Claude can connect to it. While it is off, Claude shows the connector as unable to connect, and the skills have nothing to read.

## What Claude can and cannot do

- **One business per connection.** A connection works in exactly one business. Claude sees and changes nothing else through it. See [Several businesses](#several-businesses).
- **Your own permissions.** Claude can do only what your role in that business allows, and figures hidden from you (such as revenue or costs) are hidden from Claude too. Buyers are always masked (first name, city, country, masked e-mail).
- **Reads:** products and families, listings and what the channel shows, text and translations, ids, prices and their reasons, stock and warehouses, suppliers and purchase orders, orders, shipments, returns, reviews, ads on Amazon and eBay, every automation, catalog structure, reports, alerts, sync activity and what Claude itself did.
- **Asks for changes:** create products and listings, publish, close and reopen listings, text, photos, ids, prices and promotions, stock counts and transfers, purchase orders, shipments and labels, returns and refunds, buyer messages, invoice numbers, ad bids, budgets and keywords, automation levels and rules, catalog structure, imports. Each change is first stored as a request with a preview. What happens next is the business's choice, per tool: see [Trust levels](#trust-levels-settings--ai--claude).
- **Never approves its own changes.** Claude cannot approve, raise its own levels or limits, or change who may do what. See [Never for Claude](#never-for-claude).

## Several businesses

- **One connection per business.** Each business has its own Nexus address: `https://nexusapi-production-b7bb.up.railway.app/mcp/w/<businessId>`. The business id is the part after `/w/` in the address bar when you are in that business in Nexus.
- The plugin's own connector uses the plain `/mcp` address: you pick the business when you sign in. To add a second business in Claude Code, run (once per business, with a name of your choice):

  ```
  claude mcp add --transport http --scope user nexus-<name> https://nexusapi-production-b7bb.up.railway.app/mcp/w/<businessId>
  ```

  In claude.ai, add one custom connector per business with that business's address.
- Claude then shows each connection with its business ("Nexus — Acme Racing", "Nexus — Acme Moto"). Every answer names the business it came from.
- **Every change names the business.** A change tool and a change plan need `business`: the business's name, as a check. Another name is refused ("This connection works in Acme Racing; you named Acme Moto. Nothing was queued."). The same SKU can exist in two businesses, so this catches the change sent through the wrong connection.
- **Ids never cross.** Products, listings and channel ids (eBay Item IDs, ASINs, Shopify products) are found only inside the connection's business. The `nexus-business-check` skill keeps Claude to one business at a time.

## Trust levels (Settings › AI › Claude)

For each business and each tool, the Owner sets how a change Claude asks for gets its "yes". The page is **Settings › AI › Claude**, tab **Rules**.

| Level | What happens |
|---|---|
| **Off** | The tool is not offered to Claude in this business. |
| **Ask** (the start for every tool) | A person approves or rejects it on the Nexus **Approvals** page. It expires if nobody decides. |
| **Confirm** | The person who asked approves it in Claude by typing the 6-digit code from their authenticator app. See [Confirm with your authenticator code](#confirm-with-your-authenticator-code). |
| **Auto** | It runs by the business's rule, without a person, but only inside that tool's limits (for example how far a price may move). Outside them it waits for a person, and Claude says why. |

- **Ceilings in code.** Each tool has a highest level it can ever take. Refunds, order cancellations, buyer messages, publishing, sending a purchase order and other changes that reach a buyer, a supplier or money cannot go above Ask. FBA quantity has no tool at all.
- **Raising** a level, loosening a limit, raising the daily limit or resuming after a pause needs the `settings.security.manage` permission and a fresh 2FA code. **Lowering**, tightening a limit and **Pause** need neither: a brake is always easy.
- **Brakes per business:** at most 200 changes run by rule in 24 hours (the Owner can change the number); **Pause every change that runs by rule** sends every waiting rule-run back to a person, at once; and Nexus pauses by itself after repeated rule-runs that were stale or failed within an hour.
- **The connection must allow it too.** When you connect, the tick "Run the changes your business set to run by rule" (scope `nexus.run`) lets that connection use Confirm and Auto. Without it, every change waits for a person, whatever the level.
- A change that runs by rule still waits a short undo window (about 20 seconds) in which anyone with permission can stop it on the Approvals page.

## Change plans

Many changes can travel as ONE request: `submit-change-plan`, up to 200 steps (a bulk change of up to 250 products is one step).

- Every step is checked when Claude asks, exactly as if it were asked for alone. If any step is refused, nothing is stored and Claude gets each refusal to fix.
- The Approvals page shows ONE card: a one-line summary, a table of the steps (you can untick some: the plan is then replaced by a smaller one), one tick per kind of consequence ("120 price changes reach Amazon and eBay"), and a counted **Approve** button.
- After approval the steps run in order. A step whose facts moved in the meantime is skipped with its reason; the others go on.
- A plan runs by rule only when every one of its steps may.

The `change-plan` skill walks Claude through it.

## Undo

- Every change that ran is recorded with what it replaced. **Undo** asks for the opposite change (the old price, the old text) as a NEW request, through the same approval.
- In Claude: `undo-change` with the change id or the approval id; a plan's approval id puts back the whole plan. In Nexus: **Settings › AI › Claude**, tab **Activity**, the **Undo** button (your click is the approval).
- An undo is refused when the value changed again since (it would overwrite that), or when the change cannot be undone: a message sent, a refund, a cancelled order, a confirmed shipment, a numbered invoice, a purchase order sent to a supplier, a new campaign.
- A change that already reached a marketplace is undone by sending the old value again.

The `review-and-undo` skill answers "what did you change yesterday?" and asks for undos.

## Confirm with your authenticator code

For a tool set to **Confirm**:

1. Claude asks for the change. The answer holds a short summary and a `planHash`, a fingerprint of exactly what was shown.
2. Claude asks you for the 6-digit code from your authenticator app, and passes it with `confirm-change`.
3. The code approves exactly that change, once. It works only for the person who asked, and only while the change has not expired. Too many wrong codes lock it for 15 minutes; a code already used is refused.
4. The change then runs after the short undo window, like any approved change.

Claude never guesses, stores or reuses a code, and never asks for one for anything else.

## Never for Claude

No tool does these, and a test in the code fails if a change tool ever needs one of their permissions:

- Signing in, passwords, 2FA, sessions; users, roles and invitations.
- Approving its own changes; raising its own trust levels, limits or daily limit; the AI tool policy.
- OAuth consent and Claude's own access; API keys, channel tokens, app secrets, any credential; outgoing webhooks.
- Connecting, reconnecting, disconnecting or moving a channel account; turning ON account-level live writes (such as Amazon Ads or eBay marketing writes).
- Sharing accounts, products or stock with another business; creating, renaming, archiving or restoring a business.
- Personal-data export and deletion, retention, consent and suppression lists.
- Hard deletes, the delist cascade, recycle-bin purge and admin repair; platform queues, job retries and cron triggers.
- AI providers, models, budgets and the kill switch.
- The old Amazon and eBay flat-file pages; FBA quantity.
- In the factory: users, roles, permission mode, integrations, sending e-mails or quotes, converting quotes, labels, invoices, payments, backups.

## Server switches that start OFF

Some new paths only act when the Owner turns them on in the server's environment (on Railway). Until then the preview says "dry run" or "off" and nothing reaches the channel.

| Variable | Turns on |
|---|---|
| `NEXUS_ENABLE_AMAZON_MESSAGING=true` | Buyer messages to Amazon buyers through Amazon's own messaging (`send-customer-message`). |
| `NEXUS_ENABLE_EBAY_MESSAGING=true` | Buyer messages to eBay buyers through eBay's own member messages. |
| `NEXUS_ENABLE_ETSY_SHIP_CONFIRM=true` | Tracking numbers pushed back to Etsy when a shipment is confirmed. |
| `NEXUS_STUDIO_PUBLICATION_SETTLE=1` | A 5-minute sweep that settles pending Amazon and eBay publications (otherwise one settles only when someone opens its result in the studio). `NEXUS_STUDIO_PUBLICATION_SETTLE_SCHEDULE` moves it. |
| `NEXUS_IDENTITY_SWEEP=1` | An off-peak sweep that reads which channel ids each account really holds, for the identity checks. `NEXUS_IDENTITY_SWEEP_SCHEDULE` moves it. |

**Per-business engine switches.** Seven engines that only a server variable switched before now also have a switch per business: rank-defend, budget enforcement, auto-bid, top-of-search defense, the coverage engine, the analyst fleet sweep and the snapshot repricer. With no switch set, the server variable alone decides, exactly as before. A business switch can only hold an engine lower than the server allows: down is at once, up goes only as far as the server variable allows and always with a person's click. They are in Nexus under Marketing › Ads › Rules & automation › Control room, and Claude asks for them with `turn-down-automation` / `turn-up-automation`.

## The skills

| Skill | Use it when |
|---|---|
| `weekly-channel-health` | "How are my channels doing?", a Monday check (reads only) |
| `fix-listing-issues` | "Fix my Amazon DE listing errors" |
| `list-product` | Create a product, list it on a new channel or market, publish or re-publish (one reference file per channel, and one for every status and action of the product page) |
| `listing-content` | Write, rewrite or translate titles, bullets, descriptions and keywords |
| `identity-check` | Duplicate or wrong ids, broken families, barcode and SKU problems |
| `bulk-reprice` | "Raise all helmets by 5%" |
| `price-review` | Why a listing has its price, promotions, scheduled price changes, costs |
| `stock-count` | Count, correct, move or hold stock at your own warehouses |
| `listing-stock` | How much each listing shows and from where: pin, follow, buffer, hold, warehouse feeds, shared stock, Amazon's one EU quantity |
| `reorder` | What to reorder, purchase orders, receiving goods |
| `order-desk` | What to ship today, late orders, labels, tracking, refunds due |
| `handle-return` | A return from request to refund |
| `buyer-message` | Write to a buyer, reply to eBay feedback, ask for an Amazon review |
| `ads-weekly-review` | How the ads are doing, and what to change (a stop is lower bids; a real pause only when you mean one) |
| `ads-strategy` | Your ads strategy per market, category and product, kept in Nexus: read it, compare, and propose the changes as one plan |
| `ads-playbook` | How a product's Amazon ads are built and run: include it, build or adopt its campaigns through Nexus's own builder, start them (with your code) or stop them with low bids; phases, drift and winners as Nexus adds them |
| `ads-daily-manager` | The daily Amazon ads run of a scheduled Claude routine: reads, asks for one plan inside your strategy (it waits for you in Nexus unless you set it to run by rule), reports to Nexus; for a product the ads brain runs it only supervises (never a lever the brain owns; the brain's report, clashes, tool gaps and your decisions in its report); the routine's setup steps are inside |
| `automation-review` | What is automated, why a rule did or did not act, rules and levels |
| `platform-health` | Channel accounts, alerts, failed syncs and jobs |
| `change-plan` | Many changes as one request |
| `review-and-undo` | What Claude did, and putting changes back |
| `nexus-business-check` | Which business a connection is for; working with several businesses |
| `factory-desk` (plugin `nexus-factory`) | The factory's orders, quotes, production, materials, shipments and inbox |

Every skill reads first, shows the plan, asks you, sends ONE change plan or one request, and follows it up with `approval-status`. Just ask in your own words and Claude picks the skill. In Claude Code you can also type `/nexus:<skill>`, for example `/nexus:fix-listing-issues AMAZON DE`.

## Install in Claude Code

Claude Code downloads only the plugin's own folder from the `main` branch on GitHub, not the whole repository. So both ways below work once this folder is on `main`.

**Without a copy of the repository**, in a Claude Code session:

```
/plugin marketplace add https://raw.githubusercontent.com/awaissulhry/nexus-commerce/main/integrations/claude/.claude-plugin/marketplace.json
/plugin install nexus@nexus-commerce
```

**From a copy of the repository**, in its top folder:

```
/plugin marketplace add ./integrations/claude
/plugin install nexus@nexus-commerce
```

`/plugin install` opens the plugin's page; choose **Install for you**. If Claude Code asks, run `/reload-plugins`. From a terminal instead of a session, the same commands are `claude plugin marketplace add …` and `claude plugin install nexus@nexus-commerce`.

To try the files in a copy before they reach `main`, start Claude Code with `claude --plugin-dir ./integrations/claude/nexus`.

## Connect Nexus in Claude Code

1. Run `/mcp`, choose `plugin:nexus:nexus` (or a business connection you added), then **Authenticate**. Your browser opens Nexus.
2. Sign in to Nexus if it asks.
3. On the **Connect … to Nexus** page:
   - A warning says the page sends you back to a program on this computer. Continue only if you started Claude Code yourself.
   - Pick the **one business** Claude may work in (with a business's own address, it is already chosen). A business marked "needs ai.run" is one where your role does not allow the assistant; ask an admin.
   - Reading is always allowed. Tick **Ask for changes** if Claude may ask for changes. Tick **Run the changes your business set to run by rule** if it may also use Confirm and Auto.
   - Enter the 6-digit code from your authenticator app, then **Connect**. Two-factor authentication is required: if you have not turned it on, the page asks you to do that first (Settings › Security).
4. Back in Claude Code, `/mcp` shows Nexus as connected.

## Add Nexus to claude.ai, the desktop app or Cowork

**The connector only:**

1. Go to **Customize › Connectors** (older menus: Settings › Connectors) and choose **Add custom connector**.
2. Name it after the business (`Nexus — <business>`) and enter its address: `https://nexusapi-production-b7bb.up.railway.app/mcp/w/<businessId>` (or the plain `…/mcp` to pick the business at sign-in). Leave the OAuth client ID and secret empty: Nexus needs no client secret. If you are asked how Claude identifies itself, **Use Claude's published identity** and **Register automatically** both work.
3. Choose **Add**, then **Connect**, and complete the same Nexus page as above. Add one connector per business.

On a Team or Enterprise plan, an Owner adds the connector in **Organization settings › Connectors**, and then each person chooses **Connect** and signs in with their own Nexus account.

**The connector and the skills** (upload the plugin):

1. Make a zip of the plugin folder: `cd integrations/claude && zip -r nexus.zip nexus -x '*.DS_Store'`
2. In claude.ai go to **Customize › Plugins › Add › Upload plugin** and choose `nexus.zip`.
3. Open the plugin, go to its **Connectors** tab, and add and connect Nexus.

claude.ai's **Add marketplace** takes a whole repository and cannot point at a folder inside one, so use **Upload plugin** there. A plugin added on claude.ai also appears in Claude Code (as `nexus@synced`); if you installed it in Claude Code as well, turn one of them off.

## The factory plugin

The factory app runs on one machine with its own database and its own sign-in. Its Claude server runs on that same machine, started by Claude Code or Claude Desktop as a local process: nothing listens on the network, and it does not work from claude.ai on the web or a phone.

**Before you start**

- A copy of this repository on the factory machine, the one the factory app runs from, with its dependencies installed (`npm ci` in the top folder).
- A token: in the factory app, **Settings › Integrations › Claude**, the Owner creates one: a label, the factory user it acts as (Claude sees what that person may see; money only with their permission), what it may do (`read`, or `read,draft`), and how many days it lasts (at most 90). The token is shown once.
- The server refuses to start unless its permission checks are enforced (`FACTORY_RBAC_MODE=enforce`; the plugin sets this for its own server) and the factory database is in WAL mode (the factory app sets it). Run the factory app itself with `FACTORY_RBAC_MODE=enforce` too.

**Install in Claude Code** (from the copy of the repository):

```
/plugin marketplace add ./integrations/claude
/plugin install nexus-factory@nexus-commerce
```

Claude Code asks for two values: the **Nexus repository folder** (the copy's top folder) and the **Factory token**. The token is kept in the computer's secure storage, never in a file. Then `/mcp` shows `plugin:nexus-factory:nexus-factory`.

**Claude Desktop, or by hand.** Add this server to the Claude configuration on the factory machine, with your own folder and token:

```json
{
  "mcpServers": {
    "nexus-factory": {
      "type": "stdio",
      "command": "/path/to/nexus-commerce/node_modules/.bin/tsx",
      "args": [
        "--tsconfig", "/path/to/nexus-commerce/apps/factory/tsconfig.json",
        "/path/to/nexus-commerce/apps/factory/mcp/server.ts"
      ],
      "env": { "FACTORY_MCP_TOKEN": "<the token>", "FACTORY_RBAC_MODE": "enforce" }
    }
  }
}
```

The `--tsconfig` argument matters: without it the server cannot find the factory's own code and stops before it starts.

**What it does.** Reads orders, quotes, production, materials, shipments, the inbox (summaries only) and, with permission, the money. With a `read,draft` token it can also make drafts: a DRAFT quote, a DRAFT purchase order, an internal comment, one work-order stage step — at most 100 a day. Nothing leaves the factory from Claude: sending, converting, labels, invoices and payments stay the Owner's click in the factory app.

**Stop it.** Revoke the token in the factory app, **Settings › Integrations › Claude**. It stops working at once.

## Stop Claude's access

- **In Nexus** (this is the one that counts): **Settings › Security › Connected apps**, then **Revoke**. Admins can end anyone's connection to their business in **Team & Access › Connected apps**. The connection and all its tokens stop working at once. To stop changes running by rule without ending the connection, use **Pause** in **Settings › AI › Claude**.
- **In Claude**: in Claude Code, `/mcp`, choose Nexus, then **Clear authentication**, or remove the plugin with `/plugin uninstall nexus@nexus-commerce`. In claude.ai, disconnect or remove Nexus under **Customize › Connectors**. This only removes Claude's copy of the sign-in; revoke in Nexus to end the connection itself.
- **The factory**: revoke the token in the factory app (above).

## Why the marketplace lives in this folder

A Claude Code marketplace is a `.claude-plugin/marketplace.json` file. The short form `/plugin marketplace add owner/repo` looks for it at the top of the repository and clones the whole repository, which here is a very large download. Keeping it in `integrations/claude/` adds nothing to the top of the repository. The URL route above reads just this one file, and each plugin entry (a `git-subdir` source) fetches only its own folder: `integrations/claude/nexus` or `integrations/claude/nexus-factory`.

## Changing the plugins

- Edit the files under `nexus/` or `nexus-factory/` and raise `version` in that plugin's `.claude-plugin/plugin.json`. Installed copies stay on their version until it changes.
- A skill may name only tools that exist in Nexus (`apps/api/src/services/agents/tools/`) or in the factory server (`apps/factory/mcp/tools/`), and only tools offered to Claude.
- Check before you commit: `claude plugin validate integrations/claude/nexus`, `claude plugin validate integrations/claude/nexus-factory` and `claude plugin validate integrations/claude`.
- After the change is on `main`, people update with `/plugin marketplace update nexus-commerce`, then **Update now** on the plugin in `/plugin` (in a terminal: `claude plugin update nexus@nexus-commerce`).
- Keep this folder free of tokens, secrets, real business or seller ids, and real email addresses: the repository is public.
