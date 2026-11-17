# agent-timeline

A Claude Code mod that keeps a pane beside the chat showing the session's subagents as they run: a timeline of busy bars, each agent's status, active time and recent tool calls, its result, and the settings hooks that blocked it or handed the model a message.

It is the native counterpart of the [agent-timeline skill](https://github.com/dipsylala/skills/tree/main/agent-timeline). The skill reads transcripts and serves a page in the browser. The mod listens to the engine's events directly, so it needs no server, port or token, and doesn't depend on the transcript format.

## Install

At the prompt of a terminal session:

```
/plugin install agent-timeline --marketplace dipsylala/agent-timeline-mod
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install agent-timeline --marketplace dipsylala/agent-timeline-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `dipsylala/agent-timeline-mod`, then Add plugin.

## What the pane shows

- A summary line (agents, and how many are running, done, stalled…) and a **Needs attention** line naming agents waiting more than 10 seconds for a permission decision, stalled agents, and agents a hook blocked in the last 15 minutes with no clean tool call since.
- One row per agent, main session first: a status dot (Running, Quiet, Stalled, Done, Failed, Stopped by colour), its name, its busy bars on a shared time axis, and its active time. The time axis starts where the main transcript's last 2.5 MB begin (the whole session when the transcript is smaller, with a line saying so when it is cut) and ends a little after now, rounded up to a step of about a twentieth of the window, so a finished agent's bars are not redrawn on every update; agents with no activity in that window drop off the list.
- Hook markers on the bars: a red stripe for a block, purple for a hook message. Hover a bar or a stripe for details. The terminal, which draws no SVG, shows the same tracks in text cells, accurate to about one cell.
- Under the subagents, **Side sessions**: desktop sessions this one started with `start_session` or `hand_off_to_session`, fresh or forked, including a proposal card started later. Each row is read from that session's own transcript every 15 seconds, named as the app names it, and shows **Idle** once its turn ends, since it then waits for its person.
- Clicking a name shows that agent's card below the list, one agent at a time (another name switches, the same name closes it): its status, type, start time and counts, its latest tool calls (`?` while one waits for permission; a call a hook blocked stays listed even once older calls scroll off; credentials in a command are masked), hook events and result, and, in the terminal, **Open transcript** to switch the main view to that agent (the desktop app has no main view a mod can switch).

The pane opens when a session starts; `/agent-timeline-pane` reopens it (not `/agent-timeline`, which is the agent-timeline skill's), or says why Claude Code won't show it yet. `/clear` starts the chart afresh.

## Limits

- Agents from before the mod loaded, or from a resumed session, are rebuilt from the session's transcripts under `~/.claude/projects` when the session starts. The main transcript is read from its last 2.5 MB only; over 4 MiB (the most a mod can read at once) those bytes come from a small command (PowerShell on Windows, `tail` elsewhere). If that fails, the main row falls back to the moments it launched each subagent and each handed back, and its card says so. Subagent transcripts are read whole. The transcript format is not a documented Claude Code interface, so an update can break this part.
- Side sessions are linked by their transcripts, not by an engine event: a fork by the copy of this session's entries its transcript opens with, a fresh session by the brief it was handed, found in its first prompt. Rows appear up to 15 seconds after a session starts; transcripts are looked for in every project folder while a brief is unmatched (every tick for two minutes, then every minute, for up to a week). Cloud sessions have no local transcript and don't show. A side session's permission waits and live hook markers don't show; blocks recorded in its transcript do. A stopped or archived side session looks the same as an idle one.
- No batch grouping, no file or diff viewer, no list of sessions this one did not start, no token counts (the skill has these).
- Settings hooks that fail without blocking are not visible to it.
- Under a Team or Enterprise login, or with managed settings, Claude Code doesn't run a user-installed mod's `classic.*` hooks (reported by [claude-flightdeck](https://github.com/scasella/claude-flightdeck#troubleshooting); not checked here). Live hook markers then don't appear; blocks read from the transcripts at session start still do.
- The permission wait is inferred: an "ask" not settled within 10 seconds. In auto mode a slow classifier decision can show briefly as a wait.
- Mod hooks are an early-access Claude Code API and may change between releases.
