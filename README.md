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
- A timeline of busy bars per agent, with hook markers: red ◆ for a block, purple ◆ for a hook message. Clicking a ◆ opens that agent's row at the tool call the hook fired on, highlighted (kept in view even when it is older than the latest calls), or at the hook's own line for hooks with no tool call, such as Stop. The chart is drawn from text cells, so it shows on every surface, the terminal included; positions are accurate to about one cell.
- One row per agent, main session first: status (Running, Quiet, Stalled, Done, Failed, Stopped), active time, tool-call count and blocked count. Click a row for its latest tool calls, hook events and result, and **Open transcript** to switch the main view to that agent.

The pane opens when a session starts; `/timeline` reopens it.

## Limits

- It sees only what happens after it loads; an agent already running then gets its name from the engine's agent list.
- No batch grouping, no file or diff viewer, no session list, no token counts (the skill has these).
- Settings hooks that fail without blocking are not visible to it.
- Mod hooks are an early-access Claude Code API and may change between releases.
