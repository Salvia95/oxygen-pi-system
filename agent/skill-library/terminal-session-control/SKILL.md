---
name: terminal-session-control
description: Drive programs that need a real terminal with `psmux` (tmux-compatible) — interactive REPLs and CLIs that ask questions or wait for keys, TUIs, and servers you must watch and type into. Use when a bash command hangs waiting for input, needs a TTY, or must keep running while you send it more input and read its screen.
---

# Control interactive programs in a terminal session (psmux)

Your `bash` tool has no terminal, so programs that prompt, show a REPL, or need a TTY hang or fail there.
Run them in a detached psmux session instead: start it, send keys, read the screen, repeat.
psmux uses tmux syntax. The harness `psmux` command uses its own server and opens panes in Git Bash.

For a long command that only needs to finish (build, tests), use the `background` tool instead.

```bash
psmux new-session -d -s dev -x 200 -y 50                 # start (in the current folder)
psmux send-keys -t dev 'node' Enter                       # type a command and press Enter
psmux capture-pane -p -t dev                              # read the visible screen
psmux capture-pane -p -t dev -S -200                      # ... with 200 lines of scrollback
psmux send-keys -t dev C-c                                # Ctrl+C;  also Escape, Up, Down, Tab, C-d
psmux send-keys -t dev -l 'text with $vars "quotes"'      # literal text (no key names), then:
psmux send-keys -t dev Enter
psmux has-session -t dev                                  # exit code 0 if it exists
psmux kill-session -t dev                                 # always clean up when done
psmux ls                                                  # list sessions
```

## Rules

- Use a short, unique session name per task. Kill the session when you are finished.
- After `send-keys`, the program needs time: wait, then `capture-pane`. Poll for the text you expect instead of
  one long sleep:
  ```bash
  for i in $(seq 30); do psmux capture-pane -p -t dev | grep -q 'ready' && break; sleep 1; done
  ```
- Start a server directly as the session command, then wait for its "listening" line:
  ```bash
  psmux new-session -d -s web -x 200 -y 50 'npm run dev'
  ```
- Answer prompts one at a time: capture, read the question, send the answer.
- Never type passwords or secrets into a session. Ask the user instead.
- The user can watch a session: `psmux attach -t dev` (detach with Ctrl+B then D). Tell them the session name.
