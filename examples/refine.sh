#!/bin/zsh
# refine: a dictated monologue's transcript → a concise prompt for an agent.
# usage: refine.sh <transcript-in> <prompt-out>
# Called by the hub as HUB_REFINE_CMD="…/examples/refine.sh {in} {out}".
# Optional settings in data/refine.env (sourced if present):
#   REFINE_SPEAKER="Sam, a developer"     who is talking (default: the user)
#   REFINE_STYLE="Chinese is …"           extra language or wording rules, one line
#   REFINE_TERM_DIRS=(~/code ~/tools)     folder names there count as names to get right
#   REFINE_MODEL=claude-haiku-5-5
# Names that speech recognition tends to mishear: REFINE_TERM_DIRS plus
# data/glossary.txt (one term per line, optional).

emulate -L zsh
setopt pipe_fail no_unset

in=$1 out=$2
[[ -r $in && -n $out ]] || { print -u2 "usage: refine.sh <in> <out>"; exit 2 }

here=${0:A:h}
REFINE_SPEAKER="the user" REFINE_STYLE="" REFINE_TERM_DIRS=()
[[ -r $here/../data/refine.env ]] && source $here/../data/refine.env
terms=()
(( ${#REFINE_TERM_DIRS} )) && terms=( ${(f)"$(ls $REFINE_TERM_DIRS 2>/dev/null | grep -v ':$' | grep .)"} )
[[ -r $here/../data/glossary.txt ]] && terms+=( ${(f)"$(grep -v '^#' $here/../data/glossary.txt | grep .)"} )

# Drop the "[M:SS] " cue stamps and any header before the first cue.
text=$(sed -n '/^\[[0-9:]*\]/,$p' $in | sed 's/^\[[0-9:]*\] *//')
[[ -n ${text// } ]] || text=$(<$in)

system="You turn a dictated voice monologue into a clear prompt for an AI coding agent. The speaker is $REFINE_SPEAKER; the transcript came from speech recognition, so expect misheard words, especially names.

Rules:
- Write as the speaker, in first person, addressed to the agent. Output only the prompt: no preamble, no notes about what you did.
- Same language as the speaker. Keep English technical terms in English. A mixed monologue stays mixed.${REFINE_STYLE:+ $REFINE_STYLE}
- Drop filler, false starts, repetition and thinking-out-loud. Keep every request, fact, constraint, number, name, preference and 'don't'.
- Self-corrections: when the speaker changes their mind or settles something later in the monologue ('not sure… actually, I've decided X'), keep only the final version and drop what it replaced.
- Keep uncertainty: if they are still unsure or undecided at the end, say so in the prompt; never pick for them. Keep questions they ask as questions.
- Fix a misheard word only when the context makes the intended word clear${terms:+ (these names are common: ${(j:, :)terms})}. Mark [unclear: …] only when a word is garbled and matters; a word that reads fine is not unclear.
- Short monologue (a few sentences): return one tidy paragraph. Longer: a one-line ask first, then short bullet groups only where they help, e.g. Context, Requirements, Open questions. No headings for their own sake.
- Say each point once. Never add requirements, steps, ideas or instructions they did not say (not even 'don't decide for me')."

${CLAUDE_BIN:-$HOME/.local/bin/claude} -p --model ${REFINE_MODEL:-claude-haiku-5-5} --tools "" --setting-sources "" --strict-mcp-config \
  --no-session-persistence --system-prompt $system <<<"Transcript:
$text" > $out.tmp && [[ -s $out.tmp ]] && mv $out.tmp $out || { rm -f $out.tmp; exit 1 }
