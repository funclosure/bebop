# Bebop: design log (v0)

A self-hosted messaging hub for a personal always-on agent ("companion"), with a PWA client. It stays engine-agnostic, and keeps **nothing personal in the repo** (no names, ids, tokens or paths; config comes from env or `data/`).

This is the design spec, kept version by version as the hub grew. For setup and usage, start with `README.md`.

## Shape
```
PWA (browser, phone)  ──HTTPS via tailscale serve──▶  hub (Bun, bun:sqlite)  ◀──local HTTP + token──  engine adapter
                      ◀──SSE + Web Push──────────────                                                  (channel/: Claude Code MCP channel)
```
- `hub/`: Bun HTTP server. No framework needed (`Bun.serve`). Data in `data/` (gitignored): `hub.sqlite`, `files/`, `vapid.json`, `agent.token`.
- `web/`: the PWA. Static files served by the hub. **No build step**: plain ES modules + CSS; vendor small libs (e.g. `marked`, `dompurify`) into `web/vendor/` from node_modules at install time, or import them as ESM.
- `channel/`: a Claude Code channel (MCP stdio server) that connects to the hub as the agent.
- Port: `HUB_PORT` (default 8787), bind 127.0.0.1 only. Exposed to the phone with `tailscale serve` (done by the operator, not by code).

## Auth
- **User side** (`/api/*`, `/files/*`, `/`): `tailscale serve` adds `Tailscale-User-Login`. Allow only logins listed in env `HUB_ALLOWED_LOGINS` (comma-separated). If unset, dev mode: allow requests that come straight from localhost *without* that header, and log a warning. Requests with a non-allowed login → 403.
- **Passkey lock** (`hub/lock.ts`): a second layer, off until the first passkey is registered (the lock button in the header; WebAuthn with user verification, so Face ID / Touch ID). Then `/api/*` (except `/api/auth/*`) and `/files/*` need an unlocked session: an HttpOnly, SameSite=Strict cookie set by a passkey assertion. It locks after 5 min without requests while no event stream is open (the app is closed or in the background), and after 30 days at most. Answering an approval card needs an assertion from the last 2 min (step-up); so does adding another passkey (Settings: Add passkey, then Add this device; two taps because browsers want a tap before each prompt). Endpoints: `GET /api/auth/status`, `POST /api/auth/{register,login}/{options,verify}`, `POST /api/auth/lock`. The relying party is the Host header (tailscale serve keeps it). Recovery on the hub machine: `bun scripts/passkeys.ts list|remove <id>|off`.
- **Agent side** (`/agent/*`): `Authorization: Bearer <data/agent.token>` (generated on first run, 0600). Never accept agent calls on the user auth path, and vice versa. Note: tailscale serve also proxies from localhost, so "is localhost" alone is NOT an agent check.

## Data model (SQLite)
- `messages(id INTEGER PK, ts, sender 'user'|'agent', source TEXT NULL /*e.g. a peer session name the agent relays from*/, thread TEXT NULL, kind, body_json, reply_to INTEGER NULL, delivered_at NULL /*user→agent ack*/, edited_at NULL)`
- kinds and `body_json`:
  - `text` `{text}` (Markdown) + optional `files:[fileId]`
  - `progress` `{text, done:bool}`, updated in place by the agent; pings once when done flips to true
  - `question` `{questions:[{id, prompt, header?, multi?:bool, options:[{label, description?, recommended?:bool, image?:fileId}]}], answered?:{...}}`. The user answers all questions in one submit; "Other" free text is always allowed
  - `approval` `{prompt, detail?, options?:["Approve","Not yet","Change"], answered?:label}`
  - `answer` `{to: messageId, answers:{[qid]: string[] | {other:string}}}` (user→agent, from a question or approval card)
  - `reaction` `{to: messageId, emoji}` (both directions; show reactions on the target message, not as bubbles)
- `files(id TEXT PK /*random*/, name, mime, size, path, ts)`. Originals stored as-is; no size cap besides `HUB_MAX_UPLOAD_MB` (default 2048).
- `push_subs(endpoint PK, json, ts)`
- `threads`: derived (`SELECT DISTINCT thread`). Also accept an optional agent-provided list with titles: `thread_meta(id PK, title, state, updated)`.

## HTTP API
User side:
- `GET /api/messages?thread=&before=&limit=` → newest first, with reactions folded into their targets
- `POST /api/messages` `{kind:'text'|'answer'|'reaction', thread?, reply_to?, ...body}` → stored; pushed to the agent stream
- `POST /api/upload` (multipart, field `file`, multiple allowed) → `[{id,name,mime,size}]`. Stream to disk, don't buffer whole files in memory
- `GET /files/:id` → original bytes, correct content-type, Range support (video)
- `GET /api/threads` → `[{id, title, state, updated, unread}]`
- `GET /api/events` → SSE: `message`, `update` (progress/edit/answered), `reaction`
- `GET /api/push/key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`

Agent side (Bearer token):
- `GET /agent/stream` → SSE of user messages not yet delivered (oldest first, including those sent while no agent was connected). The agent acks with `POST /agent/ack {ids:[...]}`. Redelivers un-acked ones on reconnect, which makes it **durable**
- `POST /agent/send` `{kind:'text'|'progress'|'question'|'approval', thread?, source?, reply_to?, notify?:bool, ...body}` → `{id}`. Files: `files:[absolute local path]`; the hub copies them into `data/files` (the hub runs on the same machine)
- `POST /agent/update` `{id, ...partial body}` for progress text / done, or an edit
- `POST /agent/react` `{to, emoji}`
- `POST /agent/threads` `[{id,title,state,updated}]` to replace the thread metadata
- `GET /agent/history?thread=&limit=` lets the agent read back the conversation
- `GET /agent/file/:id` → `{path}` (local path for the agent to Read)

## Push (Web Push, VAPID)
- Generate VAPID keys on first run (`data/vapid.json`). Use the `web-push` npm package if it works under Bun, else implement with `crypto.subtle`.
- Send a push for agent messages with `notify !== false`: text, question, approval, progress only when `done` flips true. Payload: `{title: source ?? the agent's name (env HUB_AGENT_NAME, default "Bebop"), body: first 120 chars, thread, id}`. Remove subscriptions that return 404/410.

## PWA (web/)
Phone-first, works on desktop. Light and dark. Calm, legible; no framework required.
- `manifest.webmanifest` (name from `HUB_AGENT_NAME`, served dynamically or templated), icons (simple generated SVG/PNG), `sw.js` (push → showNotification; notificationclick → focus/open the thread). Cache the app shell only.
- Layout: thread switcher (All + threads, unread dots) → message list → composer.
- Messages: Markdown rendered and sanitized; long ones collapsible; the source label on agent messages (e.g. "via my-app-1a"); timestamps; quoted reply preview when `reply_to`.
- Images: originals, tap for a full-screen zoom/pan viewer; several images in one message as a grid. Video: inline `<video>` with Range. Other files: a download chip.
- Question card: each question with its options as tappable rows (recommended marked), option images side by side when present, multi-select where `multi`, an "Other" text field, one Submit for all. After answering, show the chosen answers and disable the card.
- Approval card: buttons; after a tap show the outcome.
- Progress: a single updating bubble with a subtle working indicator until done.
- Composer: text (Enter sends on desktop; newline on mobile), attach files (photos/videos/any), long-press or swipe a message → reply (quote) / react (👍 ❤️ 😂 👀 ✅ ❌).
- "Enable notifications" button (must come from a user gesture; iOS requires the app to be installed to the Home Screen — show a hint when not in standalone mode).
- Reconnect SSE automatically; queue outgoing messages while offline and retry.

## Channel adapter (channel/): Claude Code
Model it on the official Telegram channel (`~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7/server.ts`). **Read it**: same SDK, same patterns.
- MCP stdio server (`@modelcontextprotocol/sdk`), capabilities `{tools:{}, experimental:{'claude/channel':{}}}`. Do NOT declare `claude/channel/permission` in v0.
- `instructions`: explain that the user reads the PWA, not the terminal; messages arrive as `<channel source="hub" ...>`; how to reply, ask, show progress, react; untrusted-content warning style like Telegram's.
- Inbound: connect to `/agent/stream` (token from `HUB_TOKEN_FILE`, URL from `HUB_URL`), and for each user message emit
  `notifications/claude/channel` with `{content, meta:{chat_id:'hub', message_id, thread?, user, ts, reply_to?, reply_to_text?, kind, answer_to?, image_path?/file_paths?, file_names?}}`. `content` for an answer: a readable rendering (e.g. "Answer to question 42 — pacing: Gentle; mode: Other: 'try both'"). Attachments: put local paths in meta (never in content). Ack after the notification is sent. Reconnect with backoff.
- Tools: `reply {text, files?, thread?, reply_to?, source?, notify?}`; `ask {questions[...], thread?, source?}` (returns the message id; the answer arrives later as a channel event); `approve {prompt, detail?, options?, thread?, source?}`; `progress {id?, text, done?}` (no id → create, returns id); `react {message_id, emoji}`; `history {thread?, limit?}`; `set_threads {threads[...]}`.
- Package it as a Claude Code plugin folder (`.claude-plugin/plugin.json` + `.mcp.json` running `bun run …`), mirroring the Telegram plugin, so it can be added through a local marketplace. Don't install or enable it anywhere; the operator does that.

## Quality bar
- `bun test`: hub API tests (auth both sides, durable redelivery of un-acked messages, upload + Range, question → answer flow, progress update, push subscription cleanup).
- `README.md`: what it is, run it (`bun install && bun run hub`), expose with `tailscale serve`, connect Claude Code, env vars. Generic: no personal details.
- `.gitignore`: `data/`, `node_modules/`.
- Keep it small and readable. Prefer the platform (Bun.serve, bun:sqlite, Web Push, SSE) over dependencies.

## Channel facts (Claude Code docs, checked 2026-10-20; channels are a research preview)
- Meta keys must match `[A-Za-z0-9_]`; other keys are silently dropped. `source` is set automatically from the MCP server name, so name the server `hub`.
- A custom channel loads with `claude --dangerously-load-development-channels server:<name>` (plain `.mcp.json` entry) or `plugin:<name>@<marketplace>`. It can run alongside an allowlisted one: `--channels plugin:telegram@claude-plugins-official --dangerously-load-development-channels server:hub` (to be tested).
- Stdio servers that negotiate MCP protocol revision 2026-07-28 are not registered as channels. Set `MCP_PROTOCOL_NEGOTIATION=legacy` in the server's env (put it in the `.mcp.json` `env`).
- Notifications are fire-and-forget: Claude Code sends no ack. That's why the hub keeps un-acked messages: the adapter acks after `mcp.notification()` resolves, and anything sent while the session was down is redelivered on reconnect.
- Permission relay (`claude/channel/permission`, v2.1.234+) exists. It's a later step, because it requires the channel to authenticate the sender.

## v0.1: slash commands and peers
Both lists are published by the agent and replaced as a whole; the hub stores and shows them and attaches no meaning to them.
- Data: `commands(name PK, description, args, pos)`, `peers(name PK, kind, state, detail, project, pos)`, `lists_meta(name PK, updated)`.
- Agent side: `POST /agent/commands [{name, description?, args?}]` (or `{commands:[…]}`; a leading `/` is stripped; names `[A-Za-z0-9_-]{1,32}`). `POST /agent/peers {peers:[{name, kind?, state?, detail?, project?}], updated?}` (or a bare array; a leading `@` is stripped; names `[\w.-]{1,64}`; `updated` is an ISO time or ms, default now).
- User side: `GET /api/commands` → `{commands, updated}`, `GET /api/peers` → `{peers, updated}`; SSE events `commands` and `peers` with the same shapes.
- Channel tools: `set_commands {commands}`, `set_peers {peers, updated?}`. The instructions tell the agent that `/name` arrives as text, that a message starting with `@name` is for that peer (relay it, report back with `source` = the peer), and that `/peers` asks it to re-publish the list.
- PWA: `/` at the start of the composer opens a command list above it, filtered as you type (↑/↓, Enter/Tab, Esc on desktop; tap on a phone; IME-safe). `@` anywhere opens the peer list. Picking inserts `/name ` or `@name `; nothing is sent until the user sends, so `/new` can't go out by a stray tap. A Peers button in the top bar opens a sheet: state dot, name, state, detail, project, "updated N min ago" and Refresh (sends `/peers`). Tapping a peer starts `@name ` in the composer. A dot on the button marks a peer that is `waiting`.

## v0.2: voice notes
- `kind: 'voice'`, body `{files:[audioId], duration, transcript, transcript_cues?:[{at, text}], transcript_status:'pending'|'done'|'timeout'|'failed'|'off'}`. User side: `POST /api/messages {kind:'voice', files:[id], duration, thread?, reply_to?, client_id?}` after `/api/upload`.
- Optional transcriber: env `HUB_TRANSCRIBE_CMD` (shell template, `{in}`/`{out}` are shell-quoted paths) and `HUB_TRANSCRIBE_TIMEOUT_S` (default 120). While `pending`, the note is held from `/agent/stream`. When the command finishes (or fails or times out), the body is updated, the PWA gets an SSE `update`, and the note is delivered. Pending notes are re-run after a restart. Without the env var, `transcript_status` is `off` and delivery is immediate.
- Transcript parsing: `[M:SS]` / `[H:MM:SS]` cue lines become `transcript_cues`, their text joined is `transcript`, and lines before the first cue are dropped as a header. Output without cues is used as plain text.
- Channel: `content` is the transcript (or a note that there is none), and meta has `kind="voice"`, `voice_path` and `voice_duration`. The instructions warn that the text is a machine transcript.
- PWA: the mic replaces send when the composer is empty. Recording uses getUserMedia + MediaRecorder (`audio/mp4` if supported, else `audio/webm;codecs=opus`), the AudioContext is resumed in the tap, and the mic track stops as soon as recording ends. A recording bar shows ✕, a timer, a level meter and ↑. Recording is capped at 10 min. A voice bubble has a player (play/pause, scrub bar, time) with the transcript below it, clamped to 3 lines with tap to expand, and "Transcribing…" while pending. Any audio file, including one the agent sends with `reply`, uses the same player.

## v0.3: presence
- `POST /agent/presence {state:'idle'|'thinking'|'working', detail?, thread?}` (Bearer) → the stored presence `{state, detail, thread, updated}`. Only the latest value is kept, in memory. A non-idle state falls back to idle after 10 min without an update. `GET /api/presence` and an SSE `presence` event carry the same shape. No push.
- Channel tool `presence {state, detail?, thread?}`.
- `scripts/presence.ts <state> [detail]` or `--hook` (a Claude Code hook event on stdin: UserPromptSubmit → thinking, PreToolUse → working + a tool label, Stop → idle, `mcp__hub__*` ignored). It prints nothing, always exits 0, and has a 1 s request timeout and a 1.5 s hard stop.
- PWA: while not idle, a typing bubble (three pulsing dots plus the detail) sits under the last message in All or in the presence's thread. An agent message hides it until the next presence update. The header's connection dot pulses while not idle.
- Voice player colors: in the user's bubble the player uses the bubble's text color (button, progress at 90%, track at 25%) with the glyph in the bubble color. Agent bubbles keep the accent treatment.

## v0.4: background tasks and real sheets
- `tasks(id PK, title, state, detail, started, pos)`; `lists_meta('tasks')`. `POST /agent/tasks {tasks:[{id, title, state, detail?, started?}]}` (or a bare array) replaces the list; tasks without id or title are dropped, an unknown state becomes `running`, `started` is ISO or ms. `GET /api/tasks` → `{tasks, updated}` with `started` as ISO; SSE `tasks` with the same shape.
- Channel tool `set_tasks {tasks}`: "Replace the list of background tasks the app shows next to your status dot. Leave out housekeeping such as watchers."
- PWA: a chip right of the status dot with the count of running + waiting tasks (hidden at zero; a spinner while any runs, a warn dot when all wait). Tap → a sheet: running, waiting, done; title, state, detail, elapsed since `started` (not for done).
- Sheets (`makeSheet`): slide-up with a dimmed backdrop (tap closes), grabber, drag down to dismiss (1:1, rubber band upward, closes past 1/3 of the height or on a flick > 0.45 px/ms), Esc, `#app` inert while open, focus to the sheet and back to the opener (not to a text field on touch), safe-area padding, no motion with prefers-reduced-motion. `.sheet-body` scrolls and starts a dismiss drag only at scrollTop 0.

## v0.8: topics (desktop sidebar)

- `POST /agent/topics` `[{id, title, lane, detail, updated}]` (Bearer) publishes the agent's open topics. `lane` is who's next (`you`, `others`, `mine`), `detail` one line. Threads left out lose lane and detail, keep their title. `state` never changes here, so archiving stays independent. `GET /api/threads` carries `lane` and `detail`. `examples/companion`-style `bin/task` calls this after every change.
- **PWA.** From 900 px wide a sidebar replaces the chip row: All, lanes, Archived (n), and peers (replaced in v0.9). On the phone the chips are All, Topics (n) (the same list in a sheet), the current topic, unread topics, then Needs you.


## v0.9.1: project conversations

A project with no open topics opens on a conversation with its session: thread `project-<key>` (`<key>` = the project name lowercased), a plain user message whose text starts with `@<peer> `, so the existing relay handles it. `GET /api/threads` derives the thread's `project` from its id, which is why `POST /agent/topics` can't clear it. The first non-offline peer of the project is addressed (an offline one if the project has a live pane); with no valid peer the composer is off. The bubble hides the prefix. A new message un-archives the thread like any other.

## v0.9.2: status on the agent's row

From 900 px wide, the agent's sidebar row holds the global status: presence detail as a second line in a row of fixed height, the hub-lost and failed-send states (red dot and the same line), and the background-task count, which opens the task sheet. The header chip is phone-only.

## v0.9.3: live topics

`presence.thread` is the focus, null meaning the main chat. The hub infers it: the newest message `/agent/ack` newly delivers (not a reaction), and every agent message except reactions. An explicit `thread` in `/agent/presence` wins; a call with none keeps it. Idle and the TTL clear it. A background task may name a `thread`; while running or waiting it keeps that topic live, so several can be live at once. A task with no thread only counts.

`liveThreads()` in web/app.js is the one source; `topicState()` is the one rule. A live topic pulses green whatever its lane, except red, which stays red. A project takes the worst of its topics and pulses only if that is green and a topic is live. The typing bubble shows in a chat only when that thread is live, or in All when any is; a task shows its detail or title. On both layouts.

## v0.9.4: the right side follows the left

From 900 px wide the right side always shows what's selected on the left. A session card in a column is a selectable row: its terminal (screen, keys, prompt, dialog cards) takes the conversation's place under the header, and a poll runs only while it's shown. Each view remembers its last selection, a topic or `pane:<id>`; a session that's gone falls back to the first topic. A project with no topics and no peer opens on its pane. A peer or a `?pane=` push selects the project and session. The sidebar's Sessions row lists every session in the column, red, green, then empty, and remembers its selection like a project. The header's terminal icon toggles between a project's chat and its terminal, marked while the terminal shows; elsewhere it opens Sessions. Done, Switch session and the fleet strip are the phone's.

A selected topic that gets archived moves the selection to the next open topic, or the project conversation if none is left; Undo brings it back and selects it. Every project's column ends with New conversation, which opens `project-<key>` (one per project, continued if it exists).

## v0.9: projects

- **Project link.** A topic may carry `project` (and optionally `path`) in `POST /agent/topics`; `bin/task` sends the `project:` header field. Names match a peer's `project` case-insensitively. `GET /api/threads` carries `project` per thread and `projects` (lowercase name -> icon url). The `projects` table keeps each project's folder and icon, so one with no peer still has a face: the folder is the topic's `path`, a pane's cwd, or the name looked up under the icon roots, one level down at most.
- **One status scale.** Red: you need to act (topic with lane `you`, blocked pane, error, stalled). Amber: someone else has it (lane `others`, a waiting peer). Green: moving (lane `mine`, working). Empty circle: nothing happening. Offline sessions dim the icon. `--alert`, `--warn` and `--ok` in both themes; `stateClass` in web/app.js is the one mapping.
- **PWA.** From 900 px wide the sidebar is the agent's chat and Needs you (pinned), Projects (from topics, peers and panes; sorted by worst dot, then name), No project, Other (threads with no task, collapsed), Archived (n). A project opens its page: session cards with a Terminal button, then topics by dot. A thread in a project has a back link in its context bar. On the phone the app still opens on the chat, and the Topics sheet holds the same list and pages.

## v0.9: peer icons

- `POST /agent/peers` takes an optional `path` per peer: the session's project folder. It must lie inside `iconRoots` (`HUB_ICON_ROOTS`, default the home folder); anything else gets no icon. `path` is never sent to the client.
- `hub/icons.ts`: an `IconSource` is `find(dir) → image path | null` and knows one kind of project (`xcodeIcon`: the main target's AppIcon set, largest default-appearance image; `webIcon`: apple-touch-icon, then favicon). The resolver tries `ICON_SOURCES` in order, shrinks the image to 96 px with `sips` (an SVG is copied as is) into `data/icons/<hash of path + mtime>`, and that name goes in `peers.icon`. A new kind of project is one more source.
- `GET /api/peers` carries `icon` (`api/icons/<name>`), served behind the usual auth. The file name changes with the image, so it caches for good.
- PWA: sidebar and Peers sheet show the icon with the state dot on its corner; no icon → the name's initial. Peers of one `project` stay together: in the sidebar, several sessions sit under the app's icon and name, one session is a plain row.
- Sidebar: the divider above Peers drags to set their height (72 px to the window minus 120), kept per browser; double-click resets; ↑/↓ when focused.

## v0.5: long history (search, jump to a message or a day) and archived threads
- **Search index.** `messages_fts` (FTS5, `tokenize='trigram'`, rowid = message id) holds each message's searchable text: text, voice transcript, approval prompt and detail, question headers, prompts and option labels/descriptions, attachment file names. Markdown is flattened (links become `label url`, emphasis marks and line markers dropped). Answers and reactions aren't indexed (they point at messages that are). The row is written on every insert and every body change (edits, progress updates, transcripts, answered cards); rows missing at startup (an older database) are backfilled once and logged.
- `GET /api/search?q=&thread=&before=&limit=` (limit 1–100, default 30) → messages in the `present()` shape, newest first, each with a `snippet` (~140 chars around the first match, `…` where cut). Every whitespace-separated word must appear as a case-insensitive substring (`LIKE` on the trigram index; `%` and `_` are literal). Words under 3 characters (common in CJK) still match, by a scan. `before` pages further back.
- `GET /api/messages` gains: `around=<id>` → a window of `limit` messages, about 40% older than the anchor and the rest from the anchor on; `date=YYYY-MM-DD&tz=<getTimezoneOffset() minutes>` → the same window anchored at the first message on or after that local midnight (the newest message if there is none; with `thread=` within that thread; 400 for a bad date). `after=<id>` alone now returns the next `limit` messages after it (still newest first), so a reader in the middle can page forward without a gap. All pages stay newest first.
- **Threads.** `thread_meta.state = 'archived'` marks an archived thread. `POST /agent/threads/<id> {state?, title?}` (Bearer) upserts one thread without touching the others; `state: 'open'` (or null) clears the state; a missing field keeps its value. User side: `POST /api/threads/<id>/archive` and `/unarchive` (unarchive clears the state). Both broadcast `threads`. Any new message in an archived thread, from either side (not a reaction), clears the state and broadcasts `threads`. `POST /agent/threads` (replace all) keeps archived threads: one left out stays archived, one listed without a state keeps `archived`; an explicit state wins.
- `examples/companion`'s `bin/task done <id>` archives the thread with the task's id (fire-and-forget `curl` to `/agent/threads/<id>`; never fails or slows the command when the hub is down).
- **PWA: threads.** Archived threads leave the chip row (the one being read stays, dashed) for an `Archived (n)` chip at its end that opens a sheet: title, id, last active, tap to open (full history), Unarchive. The context line under the chips has Archive / Unarchive for the current thread, with an Undo toast.
- **PWA: search.** A magnifier in the top bar opens a full view over the app (not a sheet, so it follows the keyboard): input (250 ms debounce, waits for IME composition), Everywhere / In <thread> chips when a thread is open, results with thread name, sender, date and time and the snippet with the words marked; More results pages back. A result opens its thread (All for one without a thread; the current thread when searching in it) at that message, flashed for ~2 s.
- **PWA: windowed history.** `jumpTo(id)` (search results, quote taps, the waiting pill, notification taps, `#m<id>` links) opens an `around` window when the message isn't loaded. While the window doesn't reach the newest message (`atLatest` false): older pages load on scroll up as before, newer pages (`after=`) are appended on scroll down until a short page says it's caught up; live messages aren't attached to the window but counted (`↓ n new`) and kept aside; the floating pill reads "Jump to latest ↓" and reloads the latest page. Sending from the middle goes back to the latest first.
- **PWA: jump to a day.** Each day header is also a date picker: a transparent native `<input type="date">` over the label (iOS opens its picker on the tap; desktop calls `showPicker()`), max today. Picking a day opens a `date` window with that day's header at the top, or the next day with messages, with a toast saying so.

## v0.6: panes (see and answer agent sessions from the PWA)
Goal: the user can see what an agent session in a terminal multiplexer shows and answer it from the phone: a permission prompt, a question dialog, or a "go" the session waits for. First provider: [herdr](https://herdr.dev) (its CLI returns JSON and classifies each agent as `idle`, `working`, `blocked` (an approval or question UI is up), `done` or `unknown`). Off unless configured; nothing herdr-specific leaks outside `hub/panes.ts`.

- **Config.** `HUB_HERDR_BIN` (path to the `herdr` binary) turns it on. `HUB_HERDR_SOCKET` (optional) is passed as `HERDR_SOCKET_PATH`. Unset → `/api/panes*` return 404 and the PWA hides the button.
- **Provider (`hub/panes.ts`).** Runs the CLI with `Bun.spawn` (argv array, never a shell string), a 5 s timeout, and parses JSON. `list()` ← `herdr agent list`: `{id: pane_id, title: terminal_title_stripped, agent, status: agent_status, cwd, project: basename(cwd), focused}`. `screen(id, lines, {ansi?})` ← `herdr agent read <id> --source recent --lines <n> --format text|ansi` (the screen plus the scrollback above it; plain text with ANSI stripped, or with `ansi` only SGR escapes kept and each styled line ending in a reset; trailing whitespace and blank lines trimmed). `keys(id, keys[])` ← `herdr agent send-keys <id> …`. `prompt(id, text)` ← `herdr agent prompt <id> <text>` (herdr refuses with `agent_blocked` while a dialog is up; pass that error to the client).
- **Watcher.** While any SSE client is connected, poll `list()` every 3 s; broadcast SSE `panes` `{panes, updated}` when anything but `updated` changed. On a pane's transition into `blocked`, send a push (title = pane title, body "Waiting for you", tag `pane:<id>`, url `/?pane=<id>`), at most one per pane per 2 min. Poll every 15 s with no SSE client (so the push still fires when the app is closed).
- **User API** (normal user auth, plus a CSRF guard: every POST must have `Content-Type: application/json` and header `X-Hub-Action: 1`; the hub answers no CORS preflight, so other origins can't send it):
  - `GET /api/panes` → `{panes, updated}`.
  - `GET /api/panes/:id/screen?lines=` (default 60, max 400) → `{id, text, status, updated}`; with `&ansi=1` also `ansi` (the same screen with SGR escapes).
  - `POST /api/panes/:id/keys {keys:[…]}`: only keys from an allowlist: `1`–`9`, `y`, `n`, `enter`, `esc`, `tab`, `shift+tab`, `up`, `down`, `left`, `right`, `space`, `backspace`; at most 8 per request. Anything else → 400.
  - `POST /api/panes/:id/prompt {text}` (1–4000 chars).
  - `:id` must match a pane in the current `list()` (re-read before every write); otherwise 404. Shell panes without an agent are never targets.
  - Every write is logged (`hub: pane <id> <title> keys [..] by <login>`) and kept in `pane_actions(id PK, ts, pane, title, action, payload, login)`.
- **PWA.** A terminal button in the top bar (hidden when panes are off) with a warn dot while any pane is `blocked`. It opens a full view (like search): a list of panes, blocked first, then working, then the rest: state dot, title, project, status. Tapping one opens its screen: the last lines in a monospace block (fitted to the width since v0.6.1, below; auto-scroll to the bottom), refreshed every 1.5 s while open and visible; a key bar (`1` `2` `3` `↑` `↓` `⏎` `Esc` `⇧⇥`); and a one-line input that sends a prompt (disabled with a hint while blocked). A key tap shows a brief "sent" state; nothing is retried automatically. `?pane=<id>` (from a push) opens that pane's screen.
- **As built.** The watcher's first poll is a baseline: a pane already blocked when the hub starts doesn't ping (a pane that appears blocked later does). `GET /api/config` carries `panes: bool` for the button. The push payload gains `tag`, `pane` and `url`; the service worker uses `tag` and opens `./?pane=<id>` (or tells an open window `open-pane`). Provider errors reach the client as `{error, code}`: `agent_blocked` → 409, `agent_not_found` → 404, `timeout` → 504, others 502. Only successful writes are kept in `pane_actions` (failures are logged). herdr reads the prompt text as the first positional after the target, so a leading `-` is safe without `--` (checked on herdr's own parser).
- **Fitted to the phone (v0.6.1).** The PWA asks for `ansi=1` and 150 lines and lays the screen out with `web/term.js` (pure, tested in `test/term.test.ts`): SGR colors/bold/dim/italic/underline/inverse become spans, colors adapted to the theme (basic 16 from a per-theme palette; 256/truecolor keep their hue, lightness moved to read on the background). Lines the agent wrapped at the pane's width (the widest line, usually a rule) are joined back (same indent, not a new bullet, and the next first word would not have fit) and wrapped by the browser at the phone's width with a hanging indent; deep indents are capped at about a third of the width; `───` rules become a full-width rule keeping their label; `│ … │` box rows keep a left edge; tables stay unwrapped in a sideways-scrolling block. The font fits the pane's columns between 11.5 and 13 px, so a tablet shows the pane as is and a phone wraps. The screen fills down to the key bar (short output sits at the bottom) and stays pinned to the bottom unless scrolled up. A fleet strip under the header (counts per state; done counts as idle) and the title open a picker sheet of every session; a sideways swipe on them steps through the sessions in list order. A hub without `ansi` support still works: the PWA lays out `text`.
- **Rex provider (v0.6.3).** `rexProvider` in `hub/panes.ts`, joined with herdr's by `combinedProvider` (lists concatenated; each action goes to the provider that listed the pane; one provider failing leaves the other's panes). Pane id `rex:<session uuid>:<block uuid>`. `list()` ← `rex api call session.list`, then per session `session.list_blocks`, then per terminal block `rex block call -b <block> process` (agent = foreground `argv0`/invoked path `claude`; shells dropped), `program_status` (the root OSC 7501 record owned by the foreground pid; `error` → idle, none → unknown) and `title` (glyph stripped; "Claude Code" → the session label). `screen` ← `rex capture -b <block> --format text|vt` (cursor-right runs become spaces before SGR filtering). `keys` ← `rex send-key -b <block> …` (`esc` → `escape`). `text` ← `rex api call block.event` with a `paste` event (JSON argument). `prompt` = `agent_blocked` if the status is blocked, else paste then `send-key enter`. Config: `HUB_REX_BIN`, else Rex's bundled CLI when present; `off` disables.
- **Dialogs as cards (v0.6.2).** `web/dialog.js` (pure, tested in `test/dialog.test.ts`) reads a Claude Code selection dialog off the bottom of the screen: numbered options counting 1..N (❯ on the focused one) with indented descriptions (a label wrapped at the pane edge is told apart by the first-word test), a "Type something." option, a separator and "Chat about this", the footer ("Enter to select · ↑/↓ to navigate · Esc to cancel"), the question paragraph above, header chips (several = a multi-question dialog: shown as chips), and for "Do you want to …?" with Yes/No options a permission: the title and the command or diff above it. `│` borders and boxes are read through. Anything off (numbers out of order, text after the options, no cursor and no footer, no question) → null. While the pane is blocked, a parsed single-select dialog is a card under the screen (the ask card's option rows; the screen above shows only what led up to it): a tap sends the digit (Claude Code selects on the digit, no Enter); "Type something" focuses that option with arrows from the cursor and the prompt line types into it, via `POST /api/panes/:id/text` (`herdr pane send-text`, which works under a dialog; no control characters), then Enter; Cancel sends Esc. Multi-select (checkboxes) is detected but stays on the keys, since its key behavior is unverified. The key bar is hidden by default behind a keyboard button (which also shows the whole screen), and shown by itself when the pane is blocked and no card could be read.
- **Later (v0.7): approval cards.** A Claude Code `PermissionRequest` hook in user settings posts the request to the hub (`/agent/permission`), shows a proper Approve/Deny card, waits for the tap, and returns the decision, so the session gets a real allow/deny. The pane view stays as the fallback for anything the hook doesn't cover.

## v0.10: boards (Board's host bridge v1)

- **Config.** `HUB_BOARD_ORIGIN` (normalized to its origin). `GET /api/config` carries `board: origin | null`. The hub sets no CSP, so nothing else to allow.
- **Ids.** `boards(thread PK, board UNIQUE, created)`, separate from `thread_meta` because `POST /agent/threads` rewrites that. `POST /api/threads/:id/board` → `{board, origin}`, made on first use: the thread id with runs of other characters as `-`, trimmed, `-board` added under 6 chars, cut to 64; a taken id gets `-2`, `-3`… 404 with boards off.
- **Messages.** `POST /api/messages` (text) accepts `board: {id, thread?, number?, link?}`; a valid one is kept in the body (anything else dropped). The channel adds meta `board_id` and `board_thread`.
- **PWA.** A Board button in the context bar (only with an origin). Wide: a fixed column on the right (`--board-col`, resizable like the other columns, kept per browser), `#app.board-on` makes room. Phone: a full-screen sheet with ✕ (Esc too), the app behind inert. The board follows the topic: picking another topic opens its board; All, a session or a blank view closes it. Bridge: only `event.origin === origin && event.source === iframe.contentWindow`, protocol `board-host` v1. `hello` → `init {deliver:[<answerer>], defaultAnswerer:<answerer>, user:{name: HUB_USER_NAME, default "You"}}`, where the answerer is `HUB_BOARD_ANSWERER` or the agent name as an id (`answererIdFor`); `ready` → link; `status` → "Drawing… · n open threads" in the header; no answer in 12 s → "Board isn’t answering". `comment` → upload snapshot (data URL decoded, skipped if null) and `board-context.json` (context minus snapshot), post `📌 Board #<n>: <text>\n\n<link>` with `client_id board:<board>:<comment>` (a resend is a no-op), then `comment-ack {ok:true}`, or `{ok:false, error}` on failure or after 9 s.

