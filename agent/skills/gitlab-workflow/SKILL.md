---
name: gitlab-workflow
description: Check and manage work on the internal GitLab with `glab`. Use when the user mentions a merge request (MR), code review comments, an issue, a pipeline or CI job failure, or asks to create an MR or call the GitLab API.
---

# GitLab (glab)

`glab` is pre-installed. The host comes from `GITLAB_HOST`; inside a git repo glab uses the repo's remote.

## Rules

- Read-only commands are fine. Creating, updating, merging, approving, closing, or deleting anything needs the user's approval.
- `glab api` with `-F/--field`, `-f/--raw-field`, `--input` or `-X POST|PUT|PATCH|DELETE` is a write.
- `glab mr create --fill` also **pushes the branch**.
- Never print tokens. If not logged in (`glab auth status` fails), tell the user to run:
  `glab auth login --hostname <host>` (they enter the token themselves).
- Prefer JSON output with the built-in filter: `-F json --jq '<expr>'` (no extra jq needed).

## Read

```bash
glab auth status
glab mr list                                   # open MRs of the current repo
glab mr list --author=@me -F json --jq '.[] | {iid, title, source_branch}'
glab mr view 123 --comments                    # description + discussion
glab mr view 123 --unresolved                  # only unresolved threads
glab mr note list 123                          # discussions with their ids
glab mr diff 123
glab issue list --assignee=@me
glab issue view 45 --comments
glab ci status                                 # pipeline of the current branch
glab ci status -F json --jq '.status'
glab ci view                                   # jobs of the latest pipeline (interactive: avoid)
glab ci trace <job-id>                         # job log
glab api projects/:id/merge_requests/123/changes --jq '.changes[].new_path'
```

`:id` in `glab api` paths is replaced with the current project. Use `--paginate` for long lists.
Other repo: add `-R group/subgroup/project`.

## Write (only after the user approves)

```bash
glab mr create --title "feat: ..." --description-file mr.md --target-branch main --draft
glab mr note create 123 -m "comment text"
glab issue create --title "..." --description "..."
```

Write the MR description to a file first and show it to the user, then use `--description-file`.

## Troubleshooting

- `x509` / certificate errors: internal CA. The user sets `glab config set ca_cert <pem> --host <host>`.
- `404 Not Found` on a project: check `-R` path or that the remote points to the internal GitLab.
