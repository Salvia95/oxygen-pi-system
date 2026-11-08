---
name: shell-data-tools
description: Process JSON with jq and find or batch-process files with fd and rg in shell pipelines. Use when parsing JSON output, extracting fields, or running a command over many files.
---

# jq, fd, rg in Git Bash

For simply finding or searching code, use the built-in `find` / `grep` tools. Use these CLIs when you need a **pipeline**: transform JSON, act on every matching file, count, or feed another command.
In this environment `jq` output uses LF and `rg` prints `/` paths, so their output is safe to pipe in Git Bash.

## jq

```bash
jq '.' data.json                               # pretty print
jq -r '.items[].name' data.json                # raw strings, one per line
jq -r '.items[] | select(.status == "FAIL") | .id' data.json
jq '[.items[] | {id, name}]' data.json         # reshape
jq '.items | length' data.json
jq -r '.items[] | [.id, .name] | @csv' data.json
jq -s 'add' a.json b.json                      # merge arrays from files
jq --arg n "$NAME" '.items[] | select(.name == $n)' data.json   # pass shell values safely
jq '.version = "1.2.3"' package.json > tmp.json && mv tmp.json package.json
```

Use `--arg` for strings and `--argjson` for numbers/JSON instead of splicing shell variables into the filter.

## fd (find files)

```bash
fd -e java                      # by extension, respects .gitignore
fd -e sql . db/migration        # pattern "." = everything, under a directory
fd 'Test\.java$'                # regex on file name
fd -H -I .env                   # include hidden and ignored files
fd -t d node_modules -d 3       # directories only, max depth 3
fd -e md . docs -x wc -l        # run a command per file ({} = path); -x and its command go LAST
fd -e log --changed-within 1d
```

Do not pass `--path-separator /` (Git Bash rewrites the `/`); output already uses `/`.

## rg (search contents)

```bash
rg -n 'TODO|FIXME' src          # with line numbers
rg -l 'OldClass' -t java        # only file names, java files
rg -c 'ERROR' logs/             # count per file
rg -n -C 2 'NullPointer' app.log  # 2 lines of context
rg -F 'a.b(c)' src              # literal string, no regex
rg -l 'OldName' -t ts | xargs sed -i 's/OldName/NewName/g'   # bulk replace (read files first for edits you report)
```
