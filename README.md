# Bebop

A phone-first client and message system for your own Claude Code session. You run the hub on the machine where the session lives; your phone talks to it as an installed web app over your Tailscale network; the session talks to it through a Claude Code channel. Nothing goes through a third-party chat service.

**New here?** → [Start here](#start-here)

https://github.com/user-attachments/assets/0455afbf-b266-4619-8de6-e85f05b63840

<sub>Music: "Off to Osaka" by Kevin MacLeod (<a href="https://incompetech.com">incompetech.com</a>), licensed under <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons: By Attribution 4.0</a>.</sub>

## Start here

1. Make a folder for your companion and open Claude Code there. Name it anything; `bob` is just an example. The folder name doesn't matter: setup asks what to call your companion.

   ```sh
   mkdir -p ~/companions/bob && cd ~/companions/bob && claude
   ```

2. Install the plugin. When it asks for a scope, pick **local**:

   ```
   /plugin marketplace add funclosure/bebop
   /plugin install bebop@bebop
   ```

   <sub>Local means this folder only. User scope would load the setup skill into every Claude Code session you start. A folder outside your code tree keeps the companion from picking up the `CLAUDE.md` files above it. For a local checkout, use its path instead of `funclosure/bebop`.</sub>

3. Run setup. It asks before every step that touches your system:

   ```
   /bebop:setup
   ```

You end up with the hub running as a background service, the phone app over Tailscale, and your companion started, with a persona it interviewed you for.

**Want to change it?** → [Make it yours](#make-it-yours)

**Later:** `/bebop:update` in the companion's folder updates Bebop and keeps everything that's yours ([Updating](examples/companion/README.md#updating)).

**By hand:** [Requirements](#requirements), [Run it](#run-it), [Keep it running](#keep-it-running), [Expose it on your tailnet](#expose-it-on-your-tailnet), [Lock](#lock-passkeys), then [the companion](examples/companion/README.md).

## Make it yours

To change Bebop and still take its updates, run it from your own fork:

1. Fork [funclosure/bebop](https://github.com/funclosure/bebop) on GitHub, then clone your fork:

   ```sh
   git clone https://github.com/<you>/bebop ~/bebop
   git -C ~/bebop remote add upstream https://github.com/funclosure/bebop
   ```

2. In Start here, step 2, add the plugin from that folder instead: `/plugin marketplace add ~/bebop` (or its full path). Setup then uses that checkout.
3. Change anything, or ask your companion to, and commit. The app is plain HTML, CSS and JavaScript in `web/`, with no build step.
4. To update, run `/bebop:update`. It fetches `upstream` and merges it into your fork, asking first and helping with any conflicts. It never pushes.

## What it is

The idea: **one session is your chief of staff.** It's the one you talk to, from your phone or any browser. It keeps the context (memory, a journal, a task list), finds the right project session for each piece of work and hands it over, follows up, and proposes a new project when nothing fits. The other Claude Code sessions on the machine are its peers: it routes work to them, and you can look at their screens when you need to. Bebop is what makes that work: the app, the hub that carries the messages, and a template for the companion (`examples/companion/`).

What you get, compared with talking to a session over a chat bot:

- **Durable delivery.** The hub keeps every message until the session has it. Anything sent while the session was down arrives when it comes back.
- **History and threads**, searchable, with original-quality photos, videos and files.
- **Cards instead of text menus**: questions with options, approvals, live progress, background tasks.
- **Voice notes**, transcribed by your own command (e.g. whisper.cpp), and dictation that tidies a rambling monologue into a prompt before you send it.
- **Peers and sessions**: relay to other Claude Code sessions on the machine (plain Claude Code messaging, nothing else to install), and, if they run in [herdr](https://herdr.dev) or [Rex](https://superlogical.com/rex), see their screens and answer their prompts from your phone.
- **Engine-agnostic.** The hub knows nothing about any one agent; a thin adapter connects an engine. The first adapter is a Claude Code channel.

```
PWA (phone, browser) ──HTTPS via tailscale serve──▶ hub (Bun, SQLite) ◀──localhost + bearer token── engine adapter
                     ◀──SSE + Web Push─────────────                                                   (channel/: Claude Code)
```

- `hub/`: Bun HTTP server (`Bun.serve`, `bun:sqlite`). Binds 127.0.0.1 only.
- `web/`: the PWA. Plain ES modules and CSS, no build step. `bun install` copies `marked` and `dompurify` into `web/vendor/`.
- `channel/`: a Claude Code channel (MCP stdio server), packaged as a plugin, plus `watch.ts`, a watcher that receives without the channel flag.
- `examples/refine.sh`: a dictation refiner on `claude -p` (see Dictation). Optional.
- `examples/companion/`: a durable, always-on companion built on the hub (identity in files, journal, task ledger, crash relaunch, idle restart). Optional.
- `data/` (gitignored): `hub.sqlite`, `files/`, `vapid.json`, `agent.token`.

## Requirements

- [Bun](https://bun.sh) (tested on 1.4)
- [Tailscale](https://tailscale.com) on the machine and your phone (for HTTPS, login and reaching the hub from anywhere)
- [Claude Code](https://claude.com/claude-code) for the adapter
- Optional: a speech-to-text command for voice notes; [herdr](https://herdr.dev) or [Rex](https://superlogical.com/rex) for the Sessions view only. Relaying to other sessions needs neither: it goes through Claude Code's own messaging, and any session shows up as a peer.

## Security model

- The hub listens on `127.0.0.1` only. `tailscale serve` is the one way in from outside, and it adds the caller's Tailscale login to each request. `HUB_ALLOWED_LOGINS` lists the logins that may use the app; set it before you expose the hub.
- The agent side (`/agent/*`) needs the bearer token in `data/agent.token` and is refused for anything that came through `tailscale serve`, so only processes on the machine can act as the agent.
- The Sessions view never runs a shell: it calls the herdr or Rex CLI with an argument list, accepts only a short list of keys, and logs every action. But it does type into your terminal sessions: **anyone who can open and unlock the app can send keys and prompts to them**, so the app is as powerful as your shell. Keep `HUB_ALLOWED_LOGINS` tight and turn on the passkey lock (below) if you use Sessions.
- Never expose the hub with `tailscale funnel`. Funnel traffic arrives from localhost without a login header, so in dev mode (no `HUB_ALLOWED_LOGINS`) it would be let in as you.
- The login is a header that `tailscale serve` adds. A process on the machine itself could send the same header, so the hub trusts the machine it runs on.
- Messages, files and the token stay in `data/` on your machine.

## Run it

```sh
bun install
HUB_AGENT_NAME="My Companion" bun run hub      # http://127.0.0.1:8787
bun test
```

With `HUB_ALLOWED_LOGINS` unset the hub runs in dev mode: it accepts direct requests from localhost that carry no Tailscale login header, and logs a warning. Set it to your Tailscale login before you expose the hub; this prints it:

```sh
tailscale status --json | jq -r '.User[(.Self.UserID|tostring)].LoginName'
HUB_ALLOWED_LOGINS=you@example.com HUB_AGENT_NAME="My Companion" bun run hub
```

**More than one hub on a machine** (say, a second companion): give each its own `HUB_PORT` and `HUB_DATA_DIR`. The companion that uses it needs the same port in `HUB_URL` and that data dir's `agent.token` in `HUB_TOKEN_FILE` (the companion's `hub.env`, see `examples/companion/README.md`).

## Keep it running

`bun run hub` stops when its terminal closes. To keep it up and start it at login, run it as a service. `/bebop:setup` writes the file for you. By hand, on macOS, a LaunchAgent `~/Library/LaunchAgents/dev.bebop.<name>.plist` with `ProgramArguments` = the absolute path of `bun` and `hub/main.ts`, `WorkingDirectory` = this checkout, the `HUB_*` settings under `EnvironmentVariables` (plus a `PATH` that includes `bun`), and `RunAtLoad` and `KeepAlive` true. Then:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.bebop.<name>.plist   # start, and at every login
launchctl kickstart -k gui/$(id -u)/dev.bebop.<name>                             # restart after an update
```

On Linux, a systemd user unit (`~/.config/systemd/user/bebop.service`, `Restart=always`) and `systemctl --user enable --now bebop`.

## Expose it on your tailnet

Run this on the same machine (it gives the PWA HTTPS with a real certificate, so service workers and push work):

```sh
tailscale serve --bg 8787
```

That takes the machine's root address (`https://<machine>.<tailnet>.ts.net`). If it's already used (`tailscale serve status`), serve the hub on another HTTPS port instead: `tailscale serve --bg --https=8443 8787`, and open `https://<machine>.<tailnet>.ts.net:8443`.

`tailscale serve` adds a `Tailscale-User-Login` header to each request. Set `HUB_ALLOWED_LOGINS` to the logins that may use the app. Open the `https://<machine>.<tailnet>.ts.net` URL on your phone, add it to the Home Screen (iOS needs this for notifications), open it from there and tap the bell.

## Icon

The app's icon is made from the agent's name (`HUB_AGENT_NAME`): the Bebop record, with a turn, an accent colour, a groove and tails of its own, picked by a hash of the name (`web/mark.js`). "Bebop" gets the original. Settings → Appearance → Change shows nine variants at a time (a variant that looks like one of your projects' icons says so), and the original Bebop mark; tapping one changes the header, the sidebar, the favicon and the icon offered when the app is added to the Home Screen. iPhone keeps the old Home Screen icon until the app is removed and added again. A project without an icon of its own gets one made from its name the same way. The hub draws the PNGs itself (`hub/raster.ts`, no image library) and keeps them in `data/app-icons/`. From a terminal: `bun scripts/icon.ts grid NAME --out FILE.png`, `bun scripts/icon.ts set SEED`.

## Lock (passkeys)

The app can also be locked with a passkey (Face ID, Touch ID or the platform's own), on top of the Tailscale login.

- **Turning it on.** The lock is off until the first passkey is registered: in the app, Settings → Security → Face ID lock (Touch ID / Passkey on other devices) → Turn on. Once unlocked, "Another device" adds a passkey for a second phone or computer. There is no off switch in the app on purpose; turning it off is done on the hub machine (below).
- **Managing passkeys.** Settings lists them, with "This device" on the one this browser unlocks with. Tap one to rename it (Save appears once the name changed) or remove it (the trash icon, which asks first). Both ask for the passkey again. The last passkey can't be removed in the app. A removed passkey stays in the device's password manager until you delete it there, and a device already unlocked with it stays unlocked until it locks.
- **What it guards.** With at least one passkey, every `/api/*` route (except `/api/auth/*`) and `/files/*` needs an unlocked session. The agent side (`/agent/*`) is not affected.
- **Idle lock.** The app locks again after 5 minutes away (no requests and no open event stream). "Lock now" locks it at once.
- **Approvals.** Answering an approval card asks for the passkey again (step-up), even while unlocked.
- **The relying party** is the host the app is opened on (for example `<machine>.<tailnet>.ts.net`), so a passkey only works on that hostname. Opening the hub under another name means registering a new passkey there.
- **Two hubs on one machine** (say `https://<machine>…/` and `https://<machine>…:8443`) share that relying party, because the port doesn't count. Each hub gives its passkeys its own user handle and puts its name in the passkey's display name ("you@example.com (Bob)"), so your password manager keeps one passkey per hub. Hubs from before 2026-11-05 used the login as the handle, so a passkey made on one replaced the other's on every device synced with it (iCloud Keychain, for one). If that happened to you, see "Locked out?" below.

**Locked out?** (a lost phone, a renamed machine). Recovery happens on the hub machine, against `data/hub.sqlite` (or `HUB_DATA_DIR`):

```sh
bun scripts/passkeys.ts list           # id, name, login, created, last used
bun scripts/passkeys.ts remove <id>    # drop one passkey (e.g. the lost phone's)
bun scripts/passkeys.ts off            # remove every passkey and session: the lock is off
```

## Connect Claude Code

The adapter reads the agent token from `HUB_TOKEN_FILE` (default: `../data/agent.token` relative to `channel/`) and the hub URL from `HUB_URL` (default `http://127.0.0.1:8787`).

**As a development channel** (plain MCP server entry, e.g. in a project's `.mcp.json`):

```json
{
  "mcpServers": {
    "hub": {
      "command": "bun",
      "args": ["/path/to/bebop/channel/server.ts"],
      "env": { "MCP_PROTOCOL_NEGOTIATION": "legacy" }
    }
  }
}
```

```sh
claude --dangerously-load-development-channels server:hub
```

The server must be named `hub`: Claude Code sets the channel's `source` from it.

**As a plugin:** this repo is also a plugin marketplace (`.claude-plugin/marketplace.json`, plugin `hub` in `channel/`). Add the repo folder as a marketplace, install `hub`, and set `HUB_TOKEN_FILE` to the absolute path of `data/agent.token` (an installed plugin runs from a copy, so the relative default won't find it). Then load it with `--dangerously-load-development-channels plugin:hub@bebop`. It can run next to another channel.

`MCP_PROTOCOL_NEGOTIATION=legacy` matters: stdio servers that negotiate MCP revision 2026-07-28 are not registered as channels.

**Without the channel flag (unattended sessions).** `--dangerously-load-development-channels` asks for confirmation on every launch, which blocks a session that relaunches itself. Instead, load `channel/server.ts` as a plain MCP server with `HUB_INBOUND=off` (it then only sends), and have the agent run `bun channel/watch.ts` in the background (Claude Code's Bash `run_in_background`). The watcher waits for the next message, prints it as a `<channel>` tag, acks it and exits; the exit wakes the session, which reads the output and starts the watcher again. `examples/companion/` is set up this way.

### What the agent sees and can do

User messages arrive as `<channel source="hub" chat_id="hub" message_id=… kind=… thread=… user=… ts=…>`. Attachments come as local paths in `image_path` / `file_paths` (never in the text). A quote-reply adds `reply_to` and `reply_to_text`. An answer to a card arrives as `kind="answer"` with `answer_to`.

Tools: `reply`, `ask` (question card: several questions, options with descriptions, a recommended one, preview images, always an "Other"), `approve` (Approve / Not yet / Change), `progress` (one live bubble; pings once when done), `react`, `history`, `set_threads`, `set_commands`, `set_peers`, `set_tasks`, `presence`.

### Slash commands and peers

The agent publishes two lists, and the app only displays them:

- **Commands** (`set_commands`): typing `/` at the start of the composer opens a filtered list (arrow keys and Enter/Tab on desktop, tap on a phone, IME-safe). Picking one inserts `/name ` and the user sends it as a normal text message; nothing is sent on pick, so a destructive command like `/new` always needs a second tap.
- **Peers** (`set_peers`): other sessions the agent can relay to, each with a state (`idle`, `busy`, `waiting`, …) and a one-line detail. The top bar's Peers sheet lists them with the time of the last update; Refresh sends the text `/peers` so the agent can re-publish. Tapping a peer, or typing `@` in the composer, inserts `@name `. A message that starts with `@name` is plain text: the agent decides that it means "relay this to that peer".

Delivery is durable: the hub keeps every user message until the adapter acks it, which it does after the notification is written. Anything sent while the session was down arrives when it comes back.

### Background tasks

`set_tasks` (or `POST /agent/tasks {tasks:[{id, title, state: running|waiting|done, detail?, started?}]}`) replaces the list of work the agent has running in the background: helper agents, long builds, waiting on a peer. The app shows a small chip right of the status dot with the number of running and waiting tasks (a spinner while any is running, hidden at zero); tapping it opens a sheet with each task's title, state, detail and elapsed time. The list is stored in SQLite and pushed over SSE (`tasks`).

### Sheets

Peers, background tasks and message actions share one bottom sheet (`makeSheet` in `web/app.js`): it slides up over a dimmed backdrop, closes on a backdrop tap, Esc or a drag down (follows the finger, springs back unless pulled past a third of its height or flicked), keeps the app behind inert while open, and only lets the list inside start a dismiss drag when it is scrolled to the top.

### Long history: search, jump to a day, archived threads

The magnifier in the top bar searches every message (text, voice transcripts, card prompts and options, file names; SQLite FTS5 with the trigram tokenizer, so substrings match in any script). A result opens the conversation at that message, and tapping a day header opens a date picker to jump to that day; from there the list scrolls both ways, with "Jump to latest" to come back. A thread whose `state` is `archived` moves out of the chip row into an "Archived (n)" sheet and comes back on its own with the next message. The agent archives one thread with `POST /agent/threads/<id> {"state":"archived"}`; in the app, the line under the chips has Archive / Unarchive.

### Sessions (terminal panes)

If your agent sessions run in [herdr](https://herdr.dev) or [Rex](https://superlogical.com/rex), the app can show them and answer them. This is the only part that needs either; relays work without them. For herdr, set `HUB_HERDR_BIN` (and `HUB_HERDR_SOCKET` if herdr's socket is not at its default path). Rex is used when its CLI is installed (or at `HUB_REX_BIN`; `HUB_REX_BIN=off` turns it off). A terminal button then appears in the top bar, with a dot while a session is waiting for you. With neither, this is all off.

- **List and screen.** The list shows the sessions, waiting first. One session's screen refreshes every 1.5 s with the pane's colors, reflowed to fit the phone: lines wrapped at the desk width are rejoined and wrapped at the phone's width, rules span the width, tables scroll sideways. The real pane is never resized.
- **Switching.** A fleet strip ("2 working · 9 idle") opens a session picker, and a sideways swipe on the header or the strip steps to the next session.
- **Dialogs as cards.** A question (AskUserQuestion), a permission prompt or a short menu without numbers (the folder-trust prompt) appears under the screen as a card: one row per option with its description and a Recommended tag. A tap sends that option's digit (arrows and Enter for a menu without numbers), "Type something" types into the prompt, and Cancel sends Esc. In a multi-select a tap toggles a row and Next moves on.
- **Prompt and keys.** A line below sends a prompt (refused while a dialog is up). A key bar (`Esc` `⇥` `⇧⇥`, `1`–`5`, arrows, `⏎`) handles anything else, and comes up by itself for a dialog the app can't read as a card (`/model`, `/resume`).
- **Earlier turns.** A Claude Code session draws on the alternate screen, so its pane only ever holds one screen. Load earlier, above it, reads the session's own transcript (`~/.claude/projects/<folder>/<session id>.jsonl`, found through `~/.claude/sessions/<pid>.json`; `CLAUDE_CONFIG_DIR` moves it) a page at a time going back: prompts, replies, messages from other sessions, and each tool call as one line (runs of more than three fold into one row).
- **Push.** When a session starts waiting, the hub sends a push (at most one per session per 2 minutes) that opens its screen.
- **Safety.** Only a short list of keys is accepted, every key press and prompt is logged in the `pane_actions` table, and the hub never runs a shell: it calls the herdr or Rex CLI with an argument list. See the security note above: whoever unlocks the app can type into these sessions.

**Shells (off by default).** With `HUB_SHELLS=on` (or `rex` / `herdr` to pick where new ones open; `on` = Rex if there is one, else herdr), a Claude session's screen gets *Open terminal*: a new shell in that session's folder (it must be inside the allowed folders: `HUB_ICON_ROOTS`, default your home folder). Optionally (`"share": true` in `shells.json`), Sessions also gets *Share a terminal*: it lists the plain terminals already open on the machine (no agent running, never a pane the hub has seen running an agent or one named after an agent, in an allowed folder), in Rex and herdr, and shows the one you tap. Only these are ever shown; every other plain shell stays hidden. Opening, listing and sharing need the passkey lock on and a fresh Face ID; typing needs Face ID again after 5 minutes without a command or after the app was in the background. A command goes one line at a time, and a risky one (deleting, `sudo`, `git push`, `curl | sh`, `kill`, redirecting into a file…) comes back as a confirm card first: a speed bump, not a sandbox. The key bar gets ^C. An opened shell is a login zsh started through `env -i` with a short environment (no `HUB_*` settings; your `~/.zshenv` still runs); it ends when you leave it in the app, after 10 minutes idle, and when the hub restarts. A shared terminal is yours: the same events only stop sharing it, and it keeps running. A pane stops being a shell as soon as its shell process changes or an agent starts in it. At most one opened shell per project and two shells in all. Every open, share, command, key, close and unshare is kept in `pane_actions`. Optional `data/shells.json` (`HUB_SHELLS_FILE`): `{"deny": ["<folder name>"], "share": true}` takes a folder out, or turns sharing on (`projects` sets a project's folder for `POST /api/shells {project}`).

### Voice notes

With the composer empty, the send button becomes a mic: tap to record, tap ↑ to send, ✕ to cancel. The note is uploaded as-is (AAC on iOS, Opus elsewhere) and sent as `kind: 'voice'`. If `HUB_TRANSCRIBE_CMD` is set, the hub runs it on each note (`{in}` = the audio file, `{out}` = where to write the transcript), holds the note back from the agent until the transcript exists or `HUB_TRANSCRIBE_TIMEOUT_S` passes, and then delivers it with the text. Lines like `[1:23] text` are kept as timed cues and anything before the first cue is dropped as a header. A plain-text output works too. Without a transcriber, notes are delivered at once with `voice_path` only. Example: `HUB_TRANSCRIBE_CMD="whisper-cli -m model.bin -f {in} -otxt -of {out}"`, or any script that writes text to `{out}`.

**Dictation (✨).** While recording, ✨ stops and turns the note into a draft instead of sending it: the hub transcribes it (`POST /api/dictate`), then runs `HUB_REFINE_CMD` (`{in}` = the transcript, `{out}` = the prompt; timeout `HUB_REFINE_TIMEOUT_S`, default 90) to tidy a rambling monologue into a concise prompt. The draft lands in the composer with the audio attached; Refined/Raw switches between the two, and you edit before sending. The message goes out as text with `dictation: { file, refined }`, and the agent sees `dictated="refined"` plus `raw_transcript_path`. `examples/refine.sh` is a refiner on `claude -p` (Haiku 5.5; `REFINE_MODEL` overrides) that keeps the speaker's language and every constraint; it reads optional settings (speaker, language rules, folders whose names it should get right) from `data/refine.env`, and extra names from `data/glossary.txt`. Example: `HUB_REFINE_CMD="/path/to/bebop/examples/refine.sh {in} {out}"`. Without a refiner, ✨ gives the raw transcript to review.

### Presence (thinking / working)

`POST /agent/presence {state: 'idle'|'thinking'|'working', detail?, thread?}` sets what the app shows: a typing bubble under the last message ("Running a command…") and a pulsing dot in the header. The hub keeps only the latest value, in memory, and falls back to idle after 10 minutes without an update. The agent's next message hides the bubble until the next update. Presence never sends a push.

An agent can call the channel's `presence` tool, but hooks are cheaper. `scripts/presence.ts` takes about 20 ms, prints nothing, always exits 0 within 1.5 s and stays silent if the hub is down:

```sh
bun scripts/presence.ts working "Running the tests"
bun scripts/presence.ts idle
bun scripts/presence.ts --hook    # reads a Claude Code hook event on stdin
```

In `--hook` mode it reads the hook JSON (`{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {…}, "session_id": …, "cwd": …}`) and maps it as follows:

- `UserPromptSubmit` → thinking
- `PreToolUse` → working with a label: Bash → "Running a command", Read/Grep/Glob → "Reading files", Edit/Write → "Editing files", WebSearch/WebFetch → "Searching the web", Agent → "Asking a helper", another MCP tool → "Using <server>"; the hub's own tools (`mcp__hub__*`) leave the state alone
- `Stop` → idle

Add this to the agent's `.claude/settings.json`, with the path to your checkout:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bun /path/to/bebop/scripts/presence.ts --hook", "timeout": 3 }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bun /path/to/bebop/scripts/presence.ts --hook", "timeout": 3 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bun /path/to/bebop/scripts/presence.ts --hook", "timeout": 3 }] }]
  }
}
```

The script reads `HUB_URL` and `HUB_TOKEN_FILE` (by default `data/agent.token` in the same checkout).

## Environment

| Variable | Default | |
|---|---|---|
| `HUB_PORT` | `8787` | listens on 127.0.0.1 |
| `HUB_ALLOWED_LOGINS` | (unset: dev mode) | comma-separated Tailscale logins |
| `HUB_AGENT_NAME` | `Bebop` | app name, notification title |
| `HUB_MAX_UPLOAD_MB` | `2048` | per request |
| `HUB_DATA_DIR` | `./data` | |
| `HUB_VAPID_SUBJECT` | `mailto:bebop@example.com` | contact for push services; set your own |
| `HUB_TRANSCRIBE_CMD` | (unset) | speech-to-text command template with `{in}` and `{out}` |
| `HUB_TRANSCRIBE_TIMEOUT_S` | `120` | deliver a voice note without text after this long |
| `HUB_REFINE_CMD` | (unset) | dictation refiner with `{in}` and `{out}`; `examples/refine.sh` reads `data/refine.env` |
| `HUB_REFINE_TIMEOUT_S` | `90` | |
| `HUB_HERDR_BIN` | (unset: sessions off) | path to the `herdr` binary; turns on the Sessions view |
| `HUB_HERDR_SOCKET` | (herdr's default) | passed to herdr as `HERDR_SOCKET_PATH` |
| `HUB_REX_BIN` | (Rex's CLI, if installed) | optional: path to the [Rex](https://superlogical.com/rex) CLI, whose Claude Code sessions join the Sessions view; `off` disables |
| `HUB_ICON_ROOTS` | (home folder) | colon-separated folders a peer's project `path` must be inside for its icon to be shown; terminals open only inside them too |
| `HUB_SHELLS` | (off) | `on`, `rex` or `herdr`: shells on demand and shared terminals (see Shells); optional overrides in `HUB_SHELLS_FILE` (default `<data dir>/shells.json`) |
| `HUB_TOOLS_FILE` | `<data dir>/tools.json` | the tools to load (see Tools); `bun run tools` uses it too, and keeps `tools.lock.json` and git clones (`tools/<id>/`) beside it |
| `HUB_PUBLIC_ORIGIN` | (unset) | the app's origin(s) from outside, e.g. `https://<machine>.<tailnet>.ts.net`: given to `run: true` tools as `BEBOP_HUB_ORIGIN`, and refused as a tool origin |
| `HUB_AGENT_ID` | the agent name in lowercase | the agent's id, given to tools (Board's answerer) |
| `HUB_BOARD_ORIGIN` | (unset) | deprecated: loads Board (board-host v1) at this origin as a built-in tool; list it in tools.json instead |
| `HUB_USER_NAME` | `You` | the user's name, given to tools for their posts |
| `HUB_URL`, `HUB_TOKEN_FILE` | see above | read by the channel adapter |

## HTTP API (short)

User side (Tailscale login): `GET /api/messages?thread=&before=&after=&around=&date=&tz=&limit=`, `GET /api/search?q=&thread=&before=&limit=`, `POST /api/threads/:id/archive|unarchive`, `POST /api/threads/:id/tools/:tool` (needs `X-Hub-Action: 1`; `{tool, instance, origin, frame, link, scope, page}`; `/board` is an alias for one release), `POST /api/projects/:key/tools/:tool` (a project tool's overview; `X-Hub-Action: 1`, optional `{name}`; adds `project`), `GET /api/tools/:id/icon`, `GET /api/config` (`tools`, `agent_id`, …), `POST /api/messages` (`text` / `voice` / `answer` / `reaction`, optional `client_id` for idempotent retries), `POST /api/upload` (multipart, streamed to disk), `GET /files/:id` (Range), `GET /api/threads`, `GET /api/commands`, `GET /api/peers`, `GET /api/presence`, `GET /api/tasks`, `POST /api/read`, `GET /api/events` (SSE: `message`, `update`, `reaction`, `threads`, `commands`, `peers`, `presence`, `tasks`), `GET /api/push/key`, `POST /api/push/subscribe|unsubscribe`. With sessions on: `GET /api/panes`, `GET /api/panes/:id/screen?lines=&ansi=1`, `POST /api/panes/:id/keys {keys}`, `POST /api/panes/:id/prompt {text}`, `GET /api/panes/:id/history?before=&session=&limit=` (earlier turns from the transcript), `POST /api/shells {pane}` (or `{project}`), `POST /api/shells/shareable`, `POST /api/shells/share {id}`, `POST /api/shells/:id/close|disarm` (shells on), `POST /api/panes/:id/text {text}` (typed as is, even under a dialog; the POSTs need `X-Hub-Action: 1` and a JSON body), SSE `panes`.

Agent side (`Authorization: Bearer <data/agent.token>`; refused if the request came through `tailscale serve`): `GET /agent/stream` (SSE of un-acked user messages), `POST /agent/ack`, `POST /agent/handed` (a watcher's hand-off: received at the agent's next sign of life, offered again after 2 min), `POST /agent/probe`, `GET /agent/version`, `POST /agent/send`, `POST /agent/update`, `POST /agent/react`, `POST /agent/threads`, `POST /agent/threads/:id`, `POST /agent/commands`, `POST /agent/peers`, `POST /agent/presence`, `POST /agent/tasks`, `GET /agent/history`, `GET /agent/file/:id`, `GET /agent/tools` (each tool's id, name, origin, scope, ref keys, CLI path and instructions).

## License

MIT
