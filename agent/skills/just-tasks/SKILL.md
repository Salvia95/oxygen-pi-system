---
name: just-tasks
description: Run and write project tasks with just (justfile). Use when a project has a justfile, or the user asks to add a build/test/run command or task runner recipe.
---

# Task runner (just)

`just` is pre-installed (1.59). Recipes run in Git Bash `sh`.

## Use an existing justfile

```bash
just --list               # recipes with their doc comments (start here)
just --summary            # names only
just --show <recipe>      # print a recipe's body
just --dry-run <recipe>   # print commands without running
just <recipe> arg1 arg2
```

Prefer the project's recipes over guessing raw commands: they encode the correct flags.

## Write recipes

```just
# Comments directly above a recipe become its description in `just --list`.
set shell := ["bash", "-uc"]
set windows-shell := ["bash", "-uc"]
set dotenv-load                      # load .env if present

default:
    @just --list

# Build the app
build:
    ./gradlew build -x test

# Run tests; extra args are passed through: just test --tests '*UserTest'
test *args:
    ./gradlew test {{args}}

# Recipe with a default parameter
deploy env="dev": build
    ./scripts/deploy.sh {{env}}
```

- Indent recipe bodies with 4 spaces (consistently; no mixing tabs/spaces).
- `{{name}}` interpolates parameters; `*args` collects the rest; `name="default"` sets defaults.
- `deploy: build` runs `build` first.
- A line starting with `@` is not echoed. Each line runs in a new shell, so `cd` does not carry over; use `cd dir && cmd` on one line.
- Check your edit with `just --list` and `just --dry-run <recipe>` before running it.
