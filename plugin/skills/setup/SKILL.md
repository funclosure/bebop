---
name: setup
description: Set up Bebop from scratch in this folder. Installs nothing silently. It runs the Bebop hub as a background service, puts the app on the user's phone over Tailscale, and turns this folder into a chief-of-staff companion, a Claude Code session the user talks to from the app. Use when the user runs /bebop:setup, or asks to set up Bebop or a new companion.
---

# Set up Bebop

You are walking a person through setting up Bebop on this machine. By the end they have:

- **the hub**: a small server on this machine that keeps their messages, running as a background service;
- **the app** on their phone (and any browser), reached over their Tailscale network, locked with a passkey;
- **their companion**: this folder, turned into a long-running Claude Code session they talk to from the app. It acts as their chief of staff. It is the one session they talk to. It keeps the context, hands project work to other Claude Code sessions (its peers), and proposes a new project when nothing fits.

## How to run this

- Go step by step. Before each step, say in one or two plain sentences what it does and why. Then do it.
- Ask with AskUserQuestion whenever there's a real choice. Offer a sensible default as the first option.
- **Ask before anything outside this folder**: writing the service file, `tailscale serve`, cloning, `bun install`. Show the exact command first. Never use `sudo`.
- Commands the person must run themselves (loading the service): give them the exact line to type with the `!` prefix.
- Keep a log of anything that didn't work as described, or that the person found unclear, in `setup-notes.md` in this folder: one bullet each, with the step. Tell them at the end that it's there.
- If a check fails, stop at that step, explain plainly, and offer the fix. Don't skip ahead.

Keep these values as you go; later steps use them: `CHECKOUT`, `NAME`, `SLUG`, `PORT`, `DATA`, `LOGIN`, `URL`, `HERDR`.

## 1. This folder

Run `pwd` and `ls -A`. This folder becomes the companion. It should be empty, or hold only `setup-notes.md` or `.claude/`. If it holds anything else, ask whether to go on here or stop so they can make a fresh folder (for example `mkdir ~/companions/sam && cd ~/companions/sam && claude`).

Also check the folders above it for a `CLAUDE.md` (and say whether `~/.claude/CLAUDE.md` exists). Claude Code loads those into every session started here, so the companion would follow them too, and they color this setup. That can be fine, but say so, and suggest a folder outside their code tree (like `~/companions/<name>`) if they'd rather it start clean.

## 2. What's installed

Check each one (`command -v …` and a version):

| Tool | Needed for | If missing |
|---|---|---|
| `bun` | the hub | https://bun.sh |
| `tailscale` (logged in: `tailscale status`) | HTTPS and reaching the app from the phone | https://tailscale.com/download, then `tailscale up`; the phone needs the Tailscale app on the same account |
| `git`, `zsh`, `jq`, `python3` | the companion's scripts | the system package manager (Homebrew on a Mac) |
| `claude` | the companion | they're running it, so it's there |
| `herdr` (optional) | a pane for the companion, and the app's Sessions view | https://herdr.dev. Without it, they start the companion in a plain terminal tab |

Stop if `bun`, `tailscale` or `git` is missing or Tailscale isn't logged in. Set `HERDR` to herdr's path, or empty.

## 3. The Bebop checkout

Ask where Bebop is checked out. If they don't have it, offer to clone it: `git clone https://github.com/funclosure/bebop ~/bebop`. Check that `CHECKOUT/hub/main.ts` and `CHECKOUT/examples/companion/` exist. Then run `bun install` in `CHECKOUT` (ask first).

## 4. Who the companion is

Ask, in one or two AskUserQuestion rounds. Ask; don't fill in answers from what you've read in CLAUDE.md files or memory. This is about the companion they want, not a guess about them.

1. The companion's name (`NAME`). Make `SLUG` from it: lowercase, letters, digits and dashes.
2. Their own name and how to address them, and their languages.
3. Their time zone. Never guess it. Offer this machine's zone as the first option (`readlink /etc/localtime` on a Mac, `timedatectl` on Linux), and let them pick another.
4. What they mainly want help with (work, a job search, projects, life admin…), and where their project folders live (for example `~/code`). That folder becomes `HUB_ICON_ROOTS` and is where the companion may start new projects.
5. Voice: brief and direct, warm and chatty, or formal. Anything it must never do.

## 5. Hub settings

- **PORT**: the first free port from 8787 up. A port is taken if `lsof -nP -iTCP:<port> -sTCP:LISTEN` prints anything. Another Bebop hub may already be on 8787; each hub needs its own port.
- **DATA**: the hub's data folder, one per hub, outside any git repo: `~/.local/share/bebop/SLUG` (the same on a Mac and on Linux; a path without spaces is easier everywhere). Create it.
- **LOGIN**: their Tailscale login, which may use the app: `tailscale status --json | jq -r '.User[(.Self.UserID|tostring)].LoginName'`. Confirm it with them. More logins can be added later, separated by commas.

## 6. Run the hub as a service

So it keeps running after this terminal closes and starts again after a reboot.

**macOS**: write `~/Library/LaunchAgents/dev.bebop.SLUG.plist` (ask first). Use absolute paths: `BUN` from `command -v bun`, `HOME` from `echo $HOME`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.bebop.SLUG</string>
  <key>ProgramArguments</key><array><string>BUN</string><string>hub/main.ts</string></array>
  <key>WorkingDirectory</key><string>CHECKOUT</string>
  <key>EnvironmentVariables</key><dict>
    <key>HUB_PORT</key><string>PORT</string>
    <key>HUB_DATA_DIR</key><string>DATA</string>
    <key>HUB_AGENT_NAME</key><string>NAME</string>
    <key>HUB_ALLOWED_LOGINS</key><string>LOGIN</string>
    <key>HUB_ICON_ROOTS</key><string>PROJECTS_FOLDER</string>
    <key>PATH</key><string>BUN_DIR:HERDR_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>HOME/Library/Logs/bebop-SLUG.log</string>
  <key>StandardErrorPath</key><string>HOME/Library/Logs/bebop-SLUG.log</string>
</dict></plist>
```

If `HERDR` is set, also add `HUB_HERDR_BIN` = `HERDR`, so the app's Sessions view shows herdr's panes. Leave out `HERDR_DIR` if there's no herdr. Check the file with `plutil -lint`. Then have them load it:

```
! launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.bebop.SLUG.plist
```

Later: restart with `launchctl kickstart -k gui/$(id -u)/dev.bebop.SLUG`, stop with `launchctl bootout gui/$(id -u)/dev.bebop.SLUG`.

**Linux**: write `~/.config/systemd/user/bebop-SLUG.service` with the same settings (`WorkingDirectory=CHECKOUT`, `ExecStart=BUN hub/main.ts`, one `Environment=` line each, `Restart=always`). Have them run `! systemctl --user enable --now bebop-SLUG`.

**Check:** within ten seconds, `DATA/agent.token` exists and `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat DATA/agent.token)" 'http://127.0.0.1:PORT/agent/history?limit=1'` prints `200`. If not, show the last lines of the log.

## 7. Reach it from the phone

`tailscale serve` gives the hub an HTTPS address on the tailnet, with a real certificate (the app needs HTTPS for notifications and passkeys). Run `tailscale serve status` first:

- If nothing serves the root (`https://<machine>…/` without a port), use it: `tailscale serve --bg PORT`.
- Otherwise use a free HTTPS port (8443, then 8444…; one not in the status): `tailscale serve --bg --https=8443 PORT`.

Show the command and ask, then run it. Set `URL` = `https://` + `tailscale status --json | jq -r .Self.DNSName` without the trailing dot, plus `:8443` if a port was used. Never use `tailscale funnel`: it would put the hub on the open internet.

Then walk them through it on the phone, and wait until they say it's done:

1. Open `URL` in Safari (Chrome on Android). Tailscale must be on.
2. Share → **Add to Home Screen**, and open the app from the Home Screen (iOS sends notifications only to Home Screen apps).
3. Tap the name at the top for **Settings**. **Notifications** → Turn on. **Security** → Face ID lock → Turn on (this creates a passkey; after it, the app needs Face ID).

## 8. Make this folder the companion

1. Copy the template without overwriting anything: `rsync -a --ignore-existing CHECKOUT/examples/companion/ ./` (ask first).
2. Write `hub.env` here. `bin/companion` and the other `bin/` scripts (the hooks too) read it, so the companion talks to this hub:
   ```
   HUB_HOME="CHECKOUT"
   HUB_URL="http://127.0.0.1:PORT"
   HUB_TOKEN_FILE="DATA/agent.token"
   ```
   Use absolute paths and quote each value. The scripts read it as plain `KEY=value` lines (never `source`), so a value may contain spaces.
3. Record Bebop's files, so `/bebop:update` can later tell them from the user's: `python3 bin/update --record` (it writes `.bebop.json`).
4. Fill in `SOUL.md` from the interview: the name as the title, the voice under "How you talk", the never-do list under "Authority", and their main goals under "Current missions". Keep the "Your role: chief of staff" section. Fill in `USER.md`: name, languages, time zone, what they work on, where their projects live.
5. `.claude/settings.json` already approves the `hub` MCP server (`enabledMcpjsonServers`), so they won't be asked about it.
6. Check the wiring end to end, the way the companion will use it:
   - `zsh -c 'source bin/hub-env.zsh && hub_settings_ok && bun "$HUB_HOME/channel/check.ts" --strict --hello "NAME is set up. You'll hear from me here."'`. It checks the settings, makes a real request with the token, sends a probe around the agent stream, and sends that hello to the app. It prints `ok` per step, or what's wrong and how to fix it. Don't go on until all pass.
   - Ask them whether the hello shows in the app. If it doesn't, the app isn't reaching this hub: check the address from step 7.
   - The hooks: `echo '{}' | env -u HUB_HOME -u HUB_URL -u HUB_TOKEN_FILE bin/presence --hook` prints nothing (an error there names the problem). `env -u HUB_HOME -u HUB_URL -u HUB_TOKEN_FILE bin/task list` runs without an error.
7. `git init && git add -A && git commit -m "NAME: first day"`. The companion commits its memory and journal here; nothing is pushed.

## 9. Start the companion

It runs in its own terminal pane, started by `bin/companion`, which restarts it after a crash. **The first start must be `bin/companion --fresh`**: without it, Claude Code would continue the most recent conversation in this folder, which is this setup.

**Before starting it, warn them:** on its first start in this folder, Claude Code may ask in the companion's pane whether to trust the folder and its new settings (the `.mcp.json` server and the hooks this setup just added), even though this session didn't ask. That pane needs an answer before the companion can do anything. Don't get around it by editing Claude Code's own files; let them answer it.

- **With herdr**: `herdr tab create --cwd "$PWD" --label SLUG` prints the new tab as JSON. Take its pane id, then `herdr pane run <pane id> bin/companion --fresh`. Then watch the pane: every 10 seconds for up to 2 minutes, `herdr pane read <pane id> --source visible --format text`.
  - If it shows a question (a trust prompt, "Do you trust…", an MCP server approval, any numbered choice), stop waiting and tell them: switch to the SLUG tab in herdr and answer it. They can also answer it from the app: the Sessions view shows the pane, with the prompt as a card.
  - When the screen shows the companion working (it starts `bin/hub-watch` first), go on.
- **Without herdr**: ask them to open a new terminal tab and run `cd <this folder> && bin/companion --fresh`, answer any trust or MCP question it asks there, and tell you when it's waiting. (Rex, tmux and others work the same way.)

`bin/companion` runs the same check (quietly) before every start. If `hub.env` is wrong it stops with the reason; if the hub is down it waits for it and says so in that pane. The new session then starts its hub watcher and publishes its commands, which takes up to a minute.

## 10. Say hello

Ask them to send "hi" from the app. The companion should answer in the app within a minute. To check from here: `curl -s -H "Authorization: Bearer $(cat DATA/agent.token)" 'http://127.0.0.1:PORT/agent/history?limit=5'`.

If nothing comes back, check, in order: the companion's pane (an error, or a question waiting there: with herdr, `herdr pane read`), that `hub.env` has the right port and token path, and the hub log.

## 11. Wrap up

Tell them, briefly:

- the app's address (`URL`), and where the hub's data and log live;
- how to restart the hub (step 6) and the companion (`/new` in the app, or Ctrl-C in its pane and `bin/companion` again);
- that the companion hands project work to other Claude Code sessions. Any session on this machine can be a peer. With herdr, the app's Sessions view also shows their screens;
- that `setup-notes.md` holds anything that went wrong along the way;
- that `/bebop:update` updates Bebop and the companion later, keeping SOUL, USER, memory, journal, tasks and `CLAUDE.md` as they are;
- that this setup session can be closed now. The companion runs in its own pane.
