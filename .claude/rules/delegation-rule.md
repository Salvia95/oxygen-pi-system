# Delegation rule

## When to delegate
- Delegate a task to a subagent only when the task fits exactly one agent role and can be written with a closed scope and checkable acceptance criteria.
- Keep a task in the main session when it needs a conversation with the user or a decision the user has not made yet.
- Keep a task in the main session when it spans several agent roles at once; split it into one brief per role instead.
- Keep a small task in the main session when doing it takes fewer steps than writing its brief.
- Never delegate an approval: commits, pushes, releases, changes to the real install, paid LLM use, and actions on the user's own terminal or mouse stay with the main session and the user.

## Agent roles
- main session: talks with the user, writes and updates specs, splits work into briefs, makes non-screen code changes, and reviews every agent result before reporting it.
- tui-implementer: implements installer and Tweak screens (layout, wording, keys, step flow) exactly as an approved section of docs/tui-spec.md defines them and proves the result with real terminal captures.
- skill-evaluator: measures the skills in agent/skill-library with a real LLM and applies a description or body change only when no case type (P, N, G) gets worse.
- harness-engineer: designs and maintains the development process itself: spec format, spec states and transitions, agent work loops, and rules made from repeated mistakes.

## Brief for tui-implementer
- Name the approved section of docs/tui-spec.md that the task implements; update that section and get the user's approval before delegating when the spec does not yet say what to build.
- List every screen and every file the task may change, and state that files outside that list must stay untouched.
- State every decision already made (exact wording, row placement, key behavior) so tui-implementer implements the decision instead of choosing one.
- List acceptance criteria as commands and evidence tui-implementer can produce alone: unit tests, `just tui-test`, `bash tests/installer-sandbox.sh` when the step flow or line-input numbering changes, and named mintty 80×24 captures of each changed screen.
- Name the open points and side issues that are out of scope, so tui-implementer reports them instead of fixing them.
- State the environment limits: installer runs only with `--sandbox`, Tweak saves only to a sandbox copy, API keys never printed, LF line endings, no git commit.
- Ask for a short report in Korean listing changed files, test results, capture paths, and any spec point that could not be followed.

## Brief for any agent
- Include the facts the agent cannot see: what is already done, what was tried and ruled out, and which uncommitted changes in the working tree belong to other work.
- Say whether another agent may run tests, real LLM requests, or psmux sessions at the same time, so the agent can tell interference from a real failure.
- Ask for results as evidence (command output, file paths, capture paths) rather than as conclusions.

## Reviewing agent results
- Check the evidence an agent returns (test output, captures, diffs) before reporting the result to the user.
- Treat a decision an agent made on its own as a proposal, and bring it to the user when the decision changes what the user sees.
- Re-run a failing check once before blaming the code when another agent was running heavy tests at the same time.
