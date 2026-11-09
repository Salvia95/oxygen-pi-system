---
name: find-code
description: Locate code and files across a repository with `rg` (contents) and `fd` (file names). Use when you need where a symbol is defined or used, every file of a type, name pattern or recent change date, match counts, or to run a command or replacement over all matching files.
---

# Find code and files (rg, fd)

## First: built-in tools or CLI?

- One simple search ("where is `UserService`?", "list `*.sql` under db/") → use the built-in `grep` / `find` tools.
- Use `rg` / `fd` in `bash` when you need a **pipeline or a filter the built-ins lack**: file type, context lines, counts, date/size, multiple patterns, or acting on each result.

Both respect `.gitignore` and skip hidden files by default. Paths are printed with `/`, safe to pipe in Git Bash.

## rg: search file contents

```bash
rg -n 'class UserService' -t java          # definition, with line numbers, java only
rg -n '\bUserService\b' -t java -g '!**/test/**'   # usages, excluding tests
rg -l 'OldClass'                           # file names only
rg -c 'ERROR' logs/                        # count per file
rg -n -C 2 'NullPointerException' app.log  # 2 lines of context
rg -F 'a.b(c)' src                         # literal text, no regex
rg -n -e 'TODO' -e 'FIXME' src             # several patterns
rg -n -i 'select .* from users' -g '*.xml' # case-insensitive, by glob
rg --type-list | rg '^(java|ts|sql):'      # which extensions a type covers
```

## fd: find files by name, type, date

The first argument of `fd` is always the **pattern**, the second is the directory.
`fd -e sql db/migration` searches for files *named* like "db/migration" and finds nothing; write `fd -e sql . db/migration`.

```bash
fd -e java                      # by extension
fd -e sql . db/migration        # everything ('.') under a directory
fd 'Controller\.java$'          # regex on the file name
fd -g '*.properties' src        # glob instead of regex
fd -t d node_modules -d 3       # directories only, max depth 3
fd -H -I '^\.env'               # include hidden and git-ignored files
fd -e log --changed-within 1d   # modified in the last day
fd -e jar --size +10m           # larger than 10 MB
```

Do not pass `--path-separator /` (Git Bash rewrites the `/`); output already uses `/`.

## Act on every match

```bash
fd -e md . docs -x wc -l                         # run per file ({} = path); -x and its command go LAST
rg -l 'OldName' -t ts | xargs sed -i 's/OldName/NewName/g'
rg -l 'OldName' -t ts | wc -l                    # check the scope first
```

Before a bulk replace: run the `rg -l` part alone to see the file list, then verify with `rg -n 'NewName'` afterwards and report the changed files.
