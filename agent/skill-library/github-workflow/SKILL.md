---
name: github-workflow
description: Check and manage work on GitHub or GitHub Enterprise with `gh`. Use when the user mentions a pull request (PR), review comments, an issue, a GitHub Actions run or failed check, or asks to create a PR or call the GitHub API.
---

# GitHub (gh)

`gh` is pre-installed. For GitHub Enterprise, the host comes from the repo remote or `GH_HOST`.

## Rules

- Read-only commands are fine. Creating, editing, merging, approving, closing, or deleting anything needs the user's approval.
- `gh api` with `-f/--raw-field`, `-F/--field`, `--input` or `-X POST|PUT|PATCH|DELETE` is a write.
- Never print tokens. If `gh auth status` fails, tell the user to run `gh auth login --hostname <host>` themselves.
- Prefer JSON with the built-in filter: `--json <fields> --jq '<expr>'`. Never use `--web` (no browser here).

## Read

```bash
gh auth status
gh pr list --state open --json number,title,author,headRefName --jq '.[] | "\(.number) \(.title) (\(.author.login))"'
gh pr view 123 --comments
gh pr diff 123
gh pr checks 123                                   # CI status of a PR
gh issue list --assignee @me --json number,title --jq '.[] | "\(.number) \(.title)"'
gh issue view 45 --comments
gh run list --limit 10
gh run view <run-id> --log-failed                  # only the failed steps' logs
gh api repos/{owner}/{repo}/pulls/123/files --jq '.[].filename'
```

`{owner}/{repo}` in `gh api` paths is filled from the current repo. Other repo: add `-R owner/repo` (or `-R host/owner/repo`).

## Write (only after the user approves)

```bash
gh pr create --title "feat: ..." --body-file pr.md --base main --draft
gh pr comment 123 --body "comment text"
gh issue create --title "..." --body-file issue.md
```

Write the PR description to a file first and show it to the user, then use `--body-file`.

## Troubleshooting

- `x509` / certificate errors: internal CA; the user must configure it.
- `HTTP 404` on a repo: check `-R` or that the remote points to the right host.
