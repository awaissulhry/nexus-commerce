# How This Vault Updates

→ [[00 - Nexus Commerce MOC]]

This vault has two layers. They behave differently. Know which one you are reading.

## Layer 1 — the handbook (these numbered notes)

`01 - System Architecture Overview`, `05 - Database Schema`, and the rest.

- Written by hand.
- **Does not update automatically.** Prose needs a model to write it.
- Newest note: 29 July 2026. Treat anything here as possibly out of date.
- Kept in git.

## Layer 2 — the map (the `graph/` folder)

About 4,300 auto-generated articles, one per area of the code, plus one per
heavily-connected "god node". Start at [[index]].

- **Rebuilds itself after every `git commit`.** No model, no tokens, no cost.
- Built from the real code by AST extraction, so it cannot drift from the code.
- Not in git (ignored). It is disposable — rebuild it any time.

### What free rebuilds do and do not buy you

| | Auto-updates free? |
|---|---|
| Structure: files, calls, imports, areas | Yes |
| Area **names** | No — named after a hub file, e.g. `env.ts` |
| Doc / markdown changes | No — needs `/graphify --update` |
| The handbook above | No |

Readable area names like `web · App Routes & Analytics` come from a model and
cost tokens. Run `graphify label` when you want them back. The previous set is
kept in `graphify-out/2026-09-19/.graphify_labels.json`.

## Controls

```
# rebuild the map by hand
graphify update /Users/awais/nexus-commerce
/Users/awais/.local/share/uv/tools/graphifyy/bin/python \
  /Users/awais/.claude/scripts/graphify-vault-sync.py /Users/awais/nexus-commerce

# skip the auto-rebuild for one commit
GRAPHIFY_SKIP_VAULT_SYNC=1 git commit -m "..."

# see what the last automatic run did
cat ~/.cache/graphify-vault-sync.log
```

The hook lives in `.githooks/post-commit`, between the markers
`# graphify-vault-sync-start` and `# graphify-vault-sync-end`. Delete that block
to turn the auto-update off.

> **Do not point the exporter at this folder.** It deletes every `.md` in its
> target before writing. It is aimed at `graph/`, which it owns. A guard in the
> sync script refuses any other target, and your notes here are never touched.
