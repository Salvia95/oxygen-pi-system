# Environment (oxygen-pi-system)

- OS: Windows 11. Your `bash` tool runs **Git Bash** (MSYS). Use POSIX shell syntax and forward slashes.
- Native Windows programs need Windows paths: convert with `cygpath -m <path>` when passing paths to them.
- **No internet access.** Never run `npm install`, `pip install`, `curl` to public hosts, or anything that downloads. If a dependency is missing, stop and tell the user.
- Pre-installed CLI tools: `fd`, `rg`, `jq`, `just`, `hurl`, `glab`, `sql` (Oracle SQLcl), `agent-browser`, `git`, `java`.
  Before using `sql`, `glab`, `hurl`, or `agent-browser`, read the matching skill: their usage here differs from the defaults you may know.
- Prefer the `grep`, `find`, `ls`, `read` tools over shell equivalents for exploring code.

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
