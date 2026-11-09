---
name: json-querying
description: Extract, filter, reshape, and edit JSON with `jq`. Use when you need specific fields from a JSON file or command output (API responses, package.json, config, logs), want to filter or count records, convert JSON to CSV, or change a value in a JSON file.
---

# Query and transform JSON (jq)

`jq` output uses LF line endings here, so it is safe to compare and pipe in Git Bash.
For JSON from `glab`, prefer its built-in `--jq` flag. For a quick look at a small file, just `read` it.

## Read values

```bash
jq '.' data.json                                # pretty print / validate
jq -r '.name, .version' package.json            # raw strings, one per line
jq -r '.items[].name' data.json
jq '.items | length' data.json                  # count
jq 'keys' config.json                           # top-level keys
jq -r 'paths(scalars) | join(".")' config.json  # every leaf path (find where a field lives)
```

## Filter and reshape

```bash
jq -r '.items[] | select(.status == "FAIL") | .id' report.json
jq '[.items[] | select(.size > 1000)] | length' data.json
jq '[.items[] | {id, name, owner: .owner.login}]' data.json
jq 'group_by(.type) | map({type: .[0].type, count: length})' data.json
jq -r '.items[] | [.id, .name, .status] | @csv' data.json > out.csv
jq -s 'add' a.json b.json                       # merge arrays from several files
some-command | jq -r '.data[].id'               # from a pipe
```

## Pass shell values safely

```bash
jq --arg n "$NAME" '.items[] | select(.name == $n)' data.json      # strings
jq --argjson max 10 '.items[:$max]' data.json                     # numbers / JSON
```

Never splice shell variables into the filter text itself.

## Edit a file

jq cannot edit in place; write to a temp file and move it:

```bash
jq '.version = "1.2.3"' package.json > package.json.tmp && mv package.json.tmp package.json
jq 'del(.scripts.prepare)' package.json > package.json.tmp && mv package.json.tmp package.json
```

This rewrites formatting (indentation, key spacing). For a small change in a hand-formatted file, prefer the `edit` tool.
