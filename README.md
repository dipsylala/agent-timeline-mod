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

- A summary line (agents, and how many are running, done, stalled…) and a **Needs attention** line naming stalled agents and agents a hook blocked in the last 15 minutes with no clean tool call since.
- One row per agent, main session first: a status dot (Running, Quiet, Stalled, Done, Failed, Stopped by colour), its name, its busy bars on a shared time axis, and its active time. The axis fits the subagents' activity by default; **Show whole session** widens it to the session's start.
- Hook markers on the bars: a red stripe for a block, purple for a hook message. Hover a bar or a stripe for details. The terminal, which draws no SVG, shows the same tracks in text cells, accurate to about one cell.
- Clicking a name shows that agent's card below the list, one agent at a time (another name switches, the same name closes it): its status, type, start time and counts, its latest tool calls (a call a hook blocked stays listed even once older calls scroll off), hook events and result, and, in the terminal, **Open transcript** to switch the main view to that agent (the desktop app has no main view a mod can switch).

The pane opens when a session starts; `/timeline` reopens it.

## Limits

- Agents from before the mod loaded, or from a resumed session, are rebuilt from the session's transcripts under `~/.claude/projects` when the session starts. A transcript over 4 MiB (the most a mod can read at once) is skipped: in long sessions that is usually the main session's, so its row starts when the mod loaded, while subagents still come in. The transcript format is not a documented Claude Code interface, so an update can break this part.
- No batch grouping, no file or diff viewer, no session list, no token counts (the skill has these).
- Settings hooks that fail without blocking are not visible to it.
- Mod hooks are an early-access Claude Code API and may change between releases.
