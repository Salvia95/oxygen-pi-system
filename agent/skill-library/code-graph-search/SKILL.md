---
name: code-graph-search
description: Navigate a codebase with the graphin MCP tools (mcp__graphin__*) instead of grep plus whole-file reads. Use to find where a feature or symbol lives, what calls a function and what it calls, what a change would affect, or which code uses a database table — while reading as little code as possible.
---

# Navigate code with graphin (mcp__graphin__*)

graphin indexes the current project into a graph of code symbols. Go from cheap to detailed and stop as early as you can:

```
1. mcp__graphin__search_hybrid(query)      → node ids with file and line (no code)
2. mcp__graphin__explore_graph(node_id)    → what it uses / what uses it
3. mcp__graphin__read_code(node_id)        → the exact source of that one symbol
```

- Call `mcp__graphin__bootstrap_workspace` once at the start (pass `offline: true`). Keyword search works at once;
  if a result says the index is still building, keep going and do not call bootstrap again.
- `search_hybrid`: a natural-language description or a symbol name. If you only needed *where* it is, you are done.
- `explore_graph`: `direction` = `used_by` (callers, impact of a change) or `uses` (dependencies). Use the `cursor` for more.
- `read_code`: one node, or `node_ids` for up to 20; `lines: "start-end"` for part of a long symbol.
  Prefer this over the `read` tool for a single function or class.
- `search_keyword`: exact text or regex, with the node that owns each line.
- Only pass node ids that a previous call returned. Never invent them.
- If a symbol you are sure exists is missing, run `mcp__graphin__diagnose_index` once, then fall back to `grep` / `rg`.

Before editing a file, still `read` the part you change (the edit tool requires it).
