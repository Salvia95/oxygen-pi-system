---
name: structural-code-search
description: Replace or find every real call of a function or method across many files, leaving comments and strings untouched, with `ast-grep` (matches code syntax, not text like grep or sed). Use when a deprecated or renamed method's calls must be changed, call arguments reordered or wrapped, or text search hits comments and strings; also for every class with a given annotation or shape.
---

# Search and rewrite code by syntax (ast-grep)

`ast-grep` parses the code, so a pattern only matches real code: not comments, not strings, any spacing or line breaks.
For plain names or text, `rg` / the `grep` tool is faster; use ast-grep when the *shape* of the code matters.

## Patterns

- A pattern is a code snippet in the target language. Always pass the language: `-l java|kotlin|ts|tsx|js|python|go|rust|c|cpp|csharp|html|css|yaml|json`.
- `$NAME` matches one node (an expression, argument, identifier). `$$$` matches any number of nodes (argument lists, statements).
- Always quote the pattern with **single quotes** so Git Bash does not expand `$`.

```bash
ast-grep run -l java -p 'userRepo.findById($ID)'                 # calls with any argument
ast-grep run -l java -p '$OBJ.findById($$$)' src/main             # on any object, under a directory
ast-grep run -l ts   -p 'console.log($$$ARGS)'
ast-grep run -l java -p '@Transactional($$$)'                     # annotation with arguments ('@Transactional' = without)
ast-grep run -l python -p 'def $F($$$): $$$' --files-with-matches  # file names only
ast-grep run -l java -p 'userRepo.$M($$$)' --json=stream | jq -r '"\(.file):\(.range.start.line + 1) \(.text)"'
```

Output paths use `/`. With `--json`, line numbers are 0-based (add 1). Exit code 1 means no match.
If a pattern finds nothing although the code exists, the snippet is probably not valid on its own: make it a complete
expression or statement (e.g. include the parentheses of a call). "Multiple AST nodes are detected" means the same:
Java/Kotlin method declarations do not parse without a class around them, so search for the call, annotation or
statement instead (`@Transactional($$$)`, `$X.save($$$)`), or fall back to `rg`.

## Rewrite (refactor many call sites)

1. Preview: `-r` shows a diff and changes nothing.
2. Apply only after checking the preview: add `-U` (update all). Never use `-i` (interactive).
3. Verify: `git diff --stat`, then build/test.

```bash
ast-grep run -l java -p 'log.debug($MSG + $V)' -r 'log.debug("{} {}", $MSG, $V)'        # preview
ast-grep run -l java -p 'log.debug($MSG + $V)' -r 'log.debug("{} {}", $MSG, $V)' -U     # apply
```

Metavariables in `-r` are replaced by the matched code (`$$$ARGS` keeps the whole list).
Report the changed files and how you verified them.
