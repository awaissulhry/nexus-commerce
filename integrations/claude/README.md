# Nexus for Claude

This folder connects Claude to Nexus. It holds a Claude plugin called `nexus` with two parts:

- **The Nexus connector**: the address of the Nexus MCP server, `https://nexusapi-production-b7bb.up.railway.app/mcp`. Claude signs in to it with your own Nexus account. No token, password or client secret is stored in these files.
- **Three skills**: step-by-step instructions Claude follows for a weekly channel health check, fixing listing issues, and a bulk reprice. They use only the Nexus tools.

> **The Owner controls access.** The Nexus MCP server must be switched on for your business before Claude can connect. While it is off, Claude shows the connector as unable to connect, and the skills have nothing to read.

## What Claude can and cannot do

- **One business.** When you connect, you pick one business. Claude sees only that business. To use another one, connect again.
- **Your own permissions.** Claude can do only what your role in Nexus allows, and figures hidden from you (such as revenue) are hidden from Claude too. If you allow reading only, Claude can only read.
- **Reads**: products, orders, stock, prices, listing issues, out-of-sync listings, stock drift, replenishment forecasts, sales figures and alerts.
- **Asks for changes, never makes them.** Claude can ask to change product text, set a price, publish a listing, message a customer, or change prices or attributes for many products at once. Nothing changes when Claude asks. Each request waits in the Nexus **Approvals** page, where a person with the right permission approves or rejects it. It expires if nobody decides. Claude has no way to approve anything; it can only check what became of a request.
- **Advertising** (negative keywords, graduating keywords, target bids): preview only. Nothing is queued and nothing changes.

## The three skills

| Skill | Use it when | What it does |
|---|---|---|
| `weekly-channel-health` | "How are my channels doing?", a Monday check | Reads listing errors, out-of-sync listings, stock drift, prices and alerts. Ends with a short to-do list, says plainly what was not checked, and asks before proposing any change. |
| `fix-listing-issues` | "Fix my Amazon DE listing errors" | Explains each problem in plain words. Where a Nexus tool can fix it, it prepares the change and gives you the Approvals link. |
| `bulk-reprice` | "Raise all helmets by 5%" | Gathers the products and their current prices, shows the plan, and only after you agree asks for one bulk price change, which waits for approval. |

Just ask in your own words and Claude picks the skill. In Claude Code you can also type `/nexus:weekly-channel-health`, `/nexus:fix-listing-issues AMAZON DE` or `/nexus:bulk-reprice raise all helmets by 5%`.

## Install in Claude Code

Claude Code downloads only the `integrations/claude/nexus` folder from the `main` branch on GitHub, not the whole repository. So both ways below work once this folder is on `main`.

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

1. Run `/mcp`, choose `plugin:nexus:nexus`, then **Authenticate**. Your browser opens Nexus.
2. Sign in to Nexus if it asks.
3. On the **Connect … to Nexus** page:
   - A warning says the page sends you back to a program on this computer. Continue only if you started Claude Code yourself.
   - Pick the **one business** Claude may work in. A business marked "needs ai.run" is one where your role does not allow the assistant; ask an admin.
   - Reading is always allowed. Tick **Ask for changes** if Claude may ask for changes (each one still waits for approval).
   - Enter the 6-digit code from your authenticator app, then **Connect**. Two-factor authentication is required: if you have not turned it on, the page asks you to do that first (Settings › Security).
4. Back in Claude Code, `/mcp` shows Nexus as connected.

## Add Nexus to claude.ai, the desktop app or Cowork

**The connector only:**

1. Go to **Customize › Connectors** (older menus: Settings › Connectors) and choose **Add custom connector**.
2. Name it `Nexus` and enter the URL `https://nexusapi-production-b7bb.up.railway.app/mcp`. Leave the OAuth client ID and secret empty: Nexus needs no client secret. If you are asked how Claude identifies itself, **Use Claude's published identity** and **Register automatically** both work.
3. Choose **Add**, then **Connect**, and complete the same Nexus page as above.

On a Team or Enterprise plan, an Owner adds the connector in **Organization settings › Connectors**, and then each person chooses **Connect** and signs in with their own Nexus account.

**The connector and the skills** (upload the plugin):

1. Make a zip of the plugin folder: `cd integrations/claude && zip -r nexus.zip nexus -x '*.DS_Store'`
2. In claude.ai go to **Customize › Plugins › Add › Upload plugin** and choose `nexus.zip`.
3. Open the plugin, go to its **Connectors** tab, and add and connect Nexus.

claude.ai's **Add marketplace** takes a whole repository and cannot point at a folder inside one, so use **Upload plugin** there. A plugin added on claude.ai also appears in Claude Code (as `nexus@synced`); if you installed it in Claude Code as well, turn one of them off.

## Stop Claude's access

- **In Nexus** (this is the one that counts): **Settings › Security › Connected apps**, then **Revoke**. Admins can end anyone's connection to their business in **Team & Access › Connected apps**. The connection and all its tokens stop working at once.
- **In Claude**: in Claude Code, `/mcp`, choose Nexus, then **Clear authentication**, or remove the plugin with `/plugin uninstall nexus@nexus-commerce`. In claude.ai, disconnect or remove Nexus under **Customize › Connectors**. This only removes Claude's copy of the sign-in; revoke in Nexus to end the connection itself.

## Why the marketplace lives in this folder

A Claude Code marketplace is a `.claude-plugin/marketplace.json` file. The short form `/plugin marketplace add owner/repo` looks for it at the top of the repository and clones the whole repository, which here is a very large download. Keeping it in `integrations/claude/` adds nothing to the top of the repository. The URL route above reads just this one file, and the plugin entry (a `git-subdir` source) fetches only `integrations/claude/nexus`.

## Changing the plugin

- Edit the files under `nexus/` and raise `version` in `nexus/.claude-plugin/plugin.json`. Installed copies stay on their version until it changes.
- Check before you commit: `claude plugin validate integrations/claude/nexus` and `claude plugin validate integrations/claude`.
- After the change is on `main`, people update with `/plugin marketplace update nexus-commerce`, then **Update now** on the plugin in `/plugin` (in a terminal: `claude plugin update nexus@nexus-commerce`).
- Keep this folder free of tokens, secrets, real business or seller ids, and real email addresses: the repository is public.
