# Example: a durable companion on the hub

A folder that turns a Claude Code session into a long-running companion: one identity across restarts, a journal, a task ledger, and the hub app as its way to reach you. Copy it, give it a name, and run it in its own terminal pane.

The hub is the client and the message system; this folder is one way to build an agent on it. Nothing here is required to use the hub.

## What's in it

| File | What it does |
|---|---|
| `SOUL.md`, `USER.md`, `MEMORY.md` | Who the companion is, what it knows about you, an index of facts in `memory/`. Write these first. |
| `CLAUDE.md` | How it runs on Claude Code: receiving hub messages, slash commands, relaying to peers, saving and restarting. |
| `bin/companion` | The launcher. Starts Claude Code with a startup prompt, relaunches after a crash (`--continue`), starts fresh after `bin/restart`. |
| `bin/hub-watch` | Waits for the next hub message, prints it and exits. Run in the background, it wakes the session without the development-channels flag. |
| `bin/idle-watch`, `bin/idle-check` | Restart the session when it has been idle for a while and the context is heavy, so it stays cheap and sharp. |
| `bin/recall` | SessionStart hook: hands a new session the last journal digest and today's tail. |
| `bin/task` | The task ledger: one Markdown file per open thread in `tasks/`, `NOW.md` generated from them. `task done` archives the hub thread with the same id. Python 3, standard library only. |
| `bin/restart` | Ends the session so `bin/companion` starts a fresh one (the `/new` command). |
| `bin/presence` | Hook that shows "thinking" / "Running a command…" in the app. |
| `.mcp.json` | The hub's MCP server for sending (`reply`, `ask`, …); `HUB_INBOUND=off` because `bin/hub-watch` does the receiving. |

## Set it up

1. Run the hub and open the app on your phone (see the main README).
2. Copy this folder somewhere of its own and make it a git repo (the companion commits its memory and journal):
   ```sh
   cp -R examples/companion ~/companions/sam && cd ~/companions/sam && git init
   ```
3. Fill in `SOUL.md` and `USER.md`.
4. Point it at the hub checkout and start it in its own pane:
   ```sh
   export HUB_HOME=/path/to/bebop
   bin/companion
   ```
   Approve the `hub` MCP server the first time. Inside the repo, `HUB_HOME` defaults to the checkout this folder sits in.

Needs `zsh`, `jq`, `bun` and `python3`. Optional: `COMPANION_CHANNELS` to load other channels too (e.g. `plugin:telegram@claude-plugins-official`); `COMPANION_IDLE_MIN` and `COMPANION_CONTEXT_MB` for the idle restart.

## Why it's built this way

- **Identity in files, not in the conversation.** A session can crash, be compacted or be replaced; the next one reads the same SOUL, journal and tasks and carries on.
- **Write the step before replying.** The task file and journal are updated before each reply, so a restart in the middle of a thread loses nothing.
- **Watchers instead of polling.** `hub-watch` and `idle-watch` run outside the model and cost nothing while they wait; their exit is what wakes the session.
