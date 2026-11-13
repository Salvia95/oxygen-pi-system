# Environment (oxygen-pi-system)

- OS: Windows 11. Your `bash` tool runs **Git Bash** (MSYS). Use POSIX shell syntax and forward slashes.
- Native Windows programs need Windows paths: convert with `cygpath -m <path>` when passing paths to them.
- **No internet access.** Never run `npm install`, `pip install`, `curl` to public hosts, or anything that downloads. If a dependency is missing, stop and tell the user.
- CLI tools: `fd`, `rg`, `jq`, `git` are always present. Optional ones (only if brought in): `just`, `hurl`, `glab`, `gh`,
  `ast-grep`, `psmux`, `usql`, `sql` (Oracle SQLcl), `agent-browser`, `obscura`.
- Never run a program that waits for keyboard input in `bash` (it hangs). If `psmux` is present, use it (terminal-session-control skill). If `mcp__graphin__*` tools exist, use them to navigate code.
  A skill is listed only for tools that are installed. Read the matching skill before using a tool: usage here differs from the defaults you may know.
  Before writing a script or using curl, sed or python for a task, check the skill list: if a description matches the situation, read that skill and use its tool.
  If a command is not found, tell the user it was not brought in. Never try to install it.
- Explore code with the `grep` and `read` tools. Find files by name with `fd` in `bash` (`fd -e sql`, `fd Controller src`); it skips ignored folders such as `node_modules`.

# Background work and helpers (your context is small)

- Commands that may take more than ~30 seconds (full builds, test suites, servers, big data loads): use the `background` tool,
  then continue or end your turn. You get a message with the result when it finishes. Never poll with sleep loops.
- Broad searches or reviews that would fill your context: delegate to `subagent` (scout = find facts, reviewer = review,
  worker = make a defined change). Give a complete task; the helper cannot see this conversation. Independent tasks can go in `tasks=[...]`.

# Task log (survives context resets)

- A `[oxy-flow] Task state` message is the record of earlier work in this task. Trust it; use `flow_show` for details of a step.
- When you choose between options (design, library, approach, a fix for a failure), call `flow_note(kind="decision", text, why)`.
  Before ending a turn with work left, set `flow_note(kind="next")`. Files, commands, failures and commits are recorded automatically.
- For a task with several steps, first write the plan with `flow_plan(action="set")`, then mark each item `doing` when you start it and `done` when it is finished.

# Working rules

- Read a file before editing it. Make small, targeted edits; do not rewrite whole files.
- Preserve the existing line endings (CRLF/LF) and encoding of each file.
- After changing code, run the project's build/test command if one exists and report the real result.
- Database: never run INSERT/UPDATE/DELETE/MERGE/DDL or COMMIT without the user's explicit approval. Read-only queries are fine.
- GitLab: never push, merge, or close issues/MRs without the user's explicit approval.
- Never print or store passwords, tokens, or connection strings with credentials.

# Communication

- Reply to the user in Korean. Keep code, commands, and identifiers in their original form.
- Be concise. When a task is done, state what changed and how it was verified.
