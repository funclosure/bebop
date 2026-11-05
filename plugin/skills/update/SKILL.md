---
name: update
description: Update a Bebop companion and its hub to the latest Bebop. Updates the Bebop checkout, restarts the hub, and replaces the companion's Bebop files (bin/, BEBOP.md, .mcp.json) while keeping everything that's the user's (SOUL, USER, memory, journal, tasks, CLAUDE.md, hub.env). Use when the user runs /bebop:update, or asks to update Bebop or the companion. The companion can run it on its own folder.
---

# Update Bebop

You're updating one companion folder (normally the current folder) and the Bebop checkout it uses. The companion folder holds two kinds of files:

- **Bebop's**: `bin/*`, `BEBOP.md`, `.mcp.json`. They're replaced when the user hasn't changed them.
- **The user's**: `SOUL.md`, `USER.md`, `MEMORY.md`, `CLAUDE.md`, `NOW.md`, `memory/`, `journal/`, `tasks/`, `hub.env`, `setup-notes.md`. Never change them here.
- `.claude/settings.json` and `.gitignore` are merged: Bebop's hooks, permissions and lines are added, the user's own stay.

`bin/update` does the file work. This skill wraps it: the checkout, the hub restart, explaining changes, files both sides changed, and the restart.

Go step by step and say in plain words what each step does. Ask before anything outside the companion folder. Never push anything.

## 1. Find things

- The companion folder: the current folder, if it has `hub.env` and `bin/companion`. Otherwise ask.
- `CHECKOUT` = `HUB_HOME` from `hub.env`. Check that `CHECKOUT/examples/companion/bin/update` exists.
- The hub's service: on a Mac, `launchctl list | grep dev.bebop` (the setup names it `dev.bebop.<name>`); on Linux, `systemctl --user list-units 'bebop-*'`.

If the folder has no `bin/update` yet (set up before it existed), that's fine: run the checkout's copy, `python3 CHECKOUT/examples/companion/bin/update --folder <folder>`, wherever these steps say `bin/update`.

## 2. Update the checkout (ask first)

`git -C CHECKOUT status --short` must be clean; if it isn't, ask them to commit or stash first. Note `<old>` = `git -C CHECKOUT rev-parse --short HEAD`.

Where updates come from: the `upstream` remote if there is one (a fork, see README "Make it yours"), else the branch's own remote. Fetch it (`git -C CHECKOUT fetch upstream`, or `git -C CHECKOUT fetch`) and let `NEW` = `upstream/main` (or `@{u}`). Then:

- **Nothing new** (`git -C CHECKOUT merge-base --is-ancestor NEW HEAD`): go on.
- **Only Bebop moved** (`git -C CHECKOUT merge-base --is-ancestor HEAD NEW`): `git -C CHECKOUT merge --ff-only NEW`.
- **Both moved** (their own commits on top, and new Bebop commits): show both sides in a few plain lines (`git -C CHECKOUT log --oneline NEW..HEAD` is theirs, `HEAD..NEW` is Bebop's), and ask to merge: `git -C CHECKOUT merge --no-edit NEW`. On conflicts, show each one plainly and resolve it with them (keep their change unless they say otherwise), then commit the merge. If they'd rather not, `git -C CHECKOUT merge --abort` and go on with the checkout as it was.

Then `bun install` in `CHECKOUT`. Say which commits came in (`git -C CHECKOUT log --oneline <old>..HEAD`), in a few plain lines. Never push, not even to their own fork; tell them they can push it when they like. If the checkout isn't a git clone, or they don't want to update it, go on with it as it is.

## 3. Restart the hub (always before the companion)

Decide by what the hub is running, not by whether step 2 pulled anything (the checkout may have moved earlier). Ask the hub: `curl -s -H "Authorization: Bearer $(cat <HUB_TOKEN_FILE>)" '<HUB_URL>/agent/version'`. Restart it if that isn't `200`, or if its `commit` differs from `git -C CHECKOUT rev-parse --short HEAD`. (`bun CHECKOUT/channel/check.ts` says the same in its `note hub:` line.)

The hub goes first: the companion's new `bin/companion` checks the hub before it starts, and waits while the hub is the old one. Give them the line to type: on a Mac `! launchctl kickstart -k gui/$(id -u)/dev.bebop.<name>`, on Linux `! systemctl --user restart bebop-<name>`. Then check it's back: `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat <HUB_TOKEN_FILE>)" '<HUB_URL>/agent/history?limit=1'` prints `200`.

If you are the companion running this on yourself: restarting the hub cuts your link for a few seconds. The hub replays missed messages, so that's fine.

## 4. See what would change

Run `bin/update --dry`. Explain each line:

- `add` / `update` / `remove`: Bebop's file, replaced (the user hadn't changed it).
- `merge`: settings or `.gitignore`, merged.
- `yours`: changed here and in Bebop. The user's version stays. Bebop's goes next to it as `FILE.bebop-new`.
- `up to date`: nothing to do. Stop here.

## 5. Update

Run `bin/update`. It copies the files, records them in `.bebop.json` and commits in the companion's repo ("Update from Bebop <commit>"), touching only Bebop's files.

For each `yours` file: show `diff FILE FILE.bebop-new` in a few plain lines, and ask whether to take Bebop's version, keep theirs, or merge the two. Then one command per answer (it records the choice and removes the `.bebop-new`):

- take Bebop's: `bin/update --take FILE` (commits it);
- keep theirs: `bin/update --keep FILE`;
- merged by hand (you do the merge, they check it): `bin/update --accept FILE`, then commit the file.

`FILE` can be `all`.

If `bin/update` notes that `CLAUDE.md` doesn't load `BEBOP.md`, the companion is from before the split, and its `CLAUDE.md` still holds the old copy of Bebop's rules. Offer to fix it: show them the part from `## When running on Claude Code` on, ask, then replace that part with one line, `@BEBOP.md`, keeping the `@…` lines at the top and anything they added themselves. Commit it. This is the one change to a file of theirs, and only with their yes.

A companion set up before `.bebop.json` existed: on this first run every Bebop file that differs counts as `yours`. Usually the user never changed them. Ask once whether to take Bebop's version of all of them (`bin/update --take all`), and go file by file only if they say they made changes.

## 6. Check and restart the companion

- The hooks find the hub: `echo '{}' | env -u HUB_HOME -u HUB_URL -u HUB_TOKEN_FILE bin/presence --hook` prints nothing and exits 0.
- Restart the companion so it loads the new files.
  - **If `bin/companion` itself changed in this update** (it was listed under `update`, or taken with `--take`): `/new` is not enough. `/new` restarts inside the running loop, which is still the old script with its old settings. A full restart: `/exit` in the companion's pane, Ctrl-C during the 10-second countdown, then `bin/companion` again in that pane. If you are the companion, save first (*Saving and restarting*, steps 1–3 in BEBOP.md), then ask the user to do those three steps in your pane.
  - Otherwise `/new` in the app is enough. If you are the companion, do your own *Saving and restarting*.
- After it's back, it should answer in the app as usual.

Finish with a short summary: what changed, anything kept as theirs, and that nothing was pushed.
