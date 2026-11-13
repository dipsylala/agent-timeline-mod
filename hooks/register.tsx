import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey } from 'claude-code'

import type { Agent, Call, HookMark, Timeline } from '../types'

const PANE = 'agent-timeline'
const TITLE = 'Agent timeline'
const MAIN = 'main'

// The same thresholds the agent-timeline skill uses.
const IDLE_GAP = 600_000 // a silence this long splits busy spans
const RUNNING_WINDOW = 120_000 // unfinished and active this recently: Running
const STALL_AFTER = 600_000 // unfinished and silent this long: Stalled
const ATTENTION_WINDOW = 15 * 60_000 // hook blocks this recent count as needing attention

const KEEP_CALLS = 20
const KEEP_HOOKS = 200
const SHOWN_ROWS = 30
const SHOWN_CALLS = 8
const BRIEF_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'query', 'title', 'message', 'prompt']

const EMPTY: Timeline = { agents: [], hooks: [] }
// Change the tag when Agent, Call or HookMark change shape: a reload keeps
// what the earlier version stored, and the tag declines it.
const timeline = atom({ plugin: 'agent-timeline', key: 'timeline' } as const, EMPTY, { shape: 'timeline-1' })
const now = atom({ plugin: 'agent-timeline', key: 'now' } as const, 0)
const expanded = atom({ plugin: 'agent-timeline', key: 'expanded' } as const, [] as string[])

function brief(input: object): string {
  const fields = input as Record<string, unknown>
  for (const key of BRIEF_KEYS) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim()) {
      return (value.trim().split('\n')[0] ?? '').replace(/^cd\s+\S+\s*&&\s*/, '').slice(0, 160)
    }
  }
  return ''
}

function newAgent(id: string, t: number, description: string, type: string, parentId?: string): Agent {
  const agent: Agent = { id, description, type, parentId, startedAt: t, lastAt: t, lastCleanAt: 0, spans: [[t, t]], calls: [], callCount: 0 }
  // The main session waits for a prompt until its first turn starts.
  return id === MAIN ? { ...agent, endedAt: t, ending: 'answer' } : agent
}

function touch(agent: Agent, t: number): Agent {
  const spans = agent.spans.slice()
  const last = spans[spans.length - 1]
  if (last && t - last[1] <= IDLE_GAP) spans[spans.length - 1] = [last[0], Math.max(last[1], t)]
  else spans.push([t, t])
  return { ...agent, spans, lastAt: Math.max(agent.lastAt, t) }
}

/** Applies `change` to one agent's row, creating the row if this is its first event. */
async function edit($: EngineInterface, id: string, t: number, change: (agent: Agent) => Agent = a => a) {
  let description = id === MAIN ? 'Main session' : `Agent ${id.slice(0, 8)}`
  let type = id === MAIN ? 'main' : ''
  let parentId: string | undefined = id === MAIN ? undefined : MAIN
  const known = (await read($, timeline)).agents.some(a => a.id === id)
  if (!known && id !== MAIN) {
    // Spawned before the mod loaded: the engine still knows what it is.
    const info = (await $.agent.list()).find(a => a.id === id)
    if (info) {
      description = info.description
      type = info.type
      parentId = info.parentId ?? MAIN
    }
  }
  await update($, timeline, tl => {
    const index = tl.agents.findIndex(a => a.id === id)
    const changed = change(touch(tl.agents[index] ?? newAgent(id, t, description, type, parentId), t))
    const agents = index < 0 ? [...tl.agents, changed] : tl.agents.map((a, i) => (i === index ? changed : a))
    return { ...tl, agents }
  })
}

async function mark($: EngineInterface, hook: HookMark) {
  await update($, timeline, tl => ({ ...tl, hooks: [...tl.hooks, hook].slice(-KEEP_HOOKS) }))
}

/** Records a settings hook's block or message from what the classic chain answered. */
async function markClassic(
  $: EngineInterface,
  event: string,
  decided: { block?: string; additionalContext?: string[] },
  agentId?: string,
  toolUseId?: string,
) {
  const context = decided.additionalContext
  if (decided.block === undefined && !context?.length) return
  await mark($, {
    at: await $.clock.now(),
    event,
    kind: decided.block !== undefined ? 'blocked' : 'message',
    text: decided.block ?? context?.join('\n') ?? '',
    agentId,
    toolUseId,
  })
}

type Status ='Running' | 'Quiet' | 'Stalled' | 'Done' | 'Idle' | 'Failed' | 'Stopped'

function statusOf(agent: Agent, t: number): Status {
  if (agent.endedAt !== undefined) {
    if (agent.ending === 'error' || agent.ending === 'refusal') return 'Failed'
    if (agent.ending === 'aborted') return 'Stopped'
    return agent.id === MAIN ? 'Idle' : 'Done'
  }
  const age = t - agent.lastAt
  return age <= RUNNING_WINDOW ? 'Running' : age <= STALL_AFTER ? 'Quiet' : 'Stalled'
}

const STATUS_COLOR: Record<Status, string> = {
  Running: '#3b82f6',
  Quiet: '#8b9bb4',
  Stalled: '#f59e0b',
  Done: '#22c55e',
  Idle: '#22c55e',
  Failed: '#ef4444',
  Stopped: '#9ca3af',
}

// The pane's own text takes theme keys, so it follows light and dark themes.
const STATUS_THEME: Record<Status, ThemeKey> = {
  Running: 'suggestion',
  Quiet: 'subtle',
  Stalled: 'warning',
  Done: 'success',
  Idle: 'success',
  Failed: 'error',
  Stopped: 'inactive',
}

function activeMs(agent: Agent): number {
  return agent.spans.reduce((sum, [a, b]) => sum + (b - a), 0)
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function clock(t: number): string {
  return new Date(t).toTimeString().slice(0, 8)
}

function xml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

/** Which agent a hook mark belongs to: its own id, else the agent that made the tool call. */
function ownerOf(hook: HookMark, agents: Agent[]): string {
  if (hook.agentId) return hook.agentId
  if (hook.toolUseId) {
    const owner = agents.find(a => a.calls.some(c => c.id === hook.toolUseId))
    if (owner) return owner.id
  }
  return MAIN
}

/** Stalled agents, and agents a hook blocked recently with no clean tool call since. */
function needsAttention(agents: Agent[], hooks: HookMark[], t: number): string[] {
  const names = new Set<string>()
  for (const agent of agents) {
    if (statusOf(agent, t) === 'Stalled') names.add(`${agent.description} (stalled)`)
  }
  for (const hook of hooks) {
    if (hook.kind !== 'blocked' || t - hook.at > ATTENTION_WINDOW) continue
    const agent = agents.find(a => a.id === ownerOf(hook, agents))
    if (agent && agent.lastCleanAt < hook.at) names.add(`${agent.description} (${hook.event} hook blocked)`)
  }
  return [...names]
}

/** The busy bars and hook markers as one SVG, for surfaces that draw one. */
function chart(agents: Agent[], hooks: HookMark[], t: number): string {
  const W = 640
  const LABEL = 180
  const ROW = 20
  const H = agents.length * ROW + 18
  const t0 = Math.min(...agents.map(a => a.startedAt))
  const span = Math.max(t - t0, 1)
  const x = (at: number) => LABEL + ((at - t0) / span) * (W - LABEL - 8)
  const parts: string[] = []
  agents.forEach((agent, i) => {
    const y = i * ROW
    const status = statusOf(agent, t)
    const label = agent.description.length > 28 ? `${agent.description.slice(0, 27)}…` : agent.description
    parts.push(`<text x="4" y="${y + 14}" font-size="11" fill="#8b8b8b">${xml(label)}</text>`)
    const tip = `${agent.description}\n${status} · ${duration(activeMs(agent))} active · ${agent.callCount} calls`
    for (const [a, b] of agent.spans) {
      const end = agent.endedAt === undefined && b === agent.spans.at(-1)?.[1] ?Math.max(b, Math.min(t, b + RUNNING_WINDOW)) : b
      parts.push(
        `<rect x="${x(a).toFixed(1)}" y="${y + 5}" width="${Math.max(2, x(end) - x(a)).toFixed(1)}" height="11" rx="2" fill="${STATUS_COLOR[status]}"><title>${xml(`${tip}\n${clock(a)}–${clock(end)}`)}</title></rect>`,
      )
    }
  })
  for (const hook of hooks) {
    const row = agents.findIndex(a => a.id === ownerOf(hook, agents))
    if (row < 0 || hook.at < t0) continue
    const cx = x(hook.at)
    const cy = row * ROW + 10
    const fill = hook.kind === 'blocked' ? '#ef4444' : '#a855f7'
    parts.push(
      `<path d="M${cx.toFixed(1)},${cy - 6} l5,6 l-5,6 l-5,-6z" fill="${fill}" stroke="#fff" stroke-width="0.8"><title>${xml(`${hook.event} hook ${hook.kind} at ${clock(hook.at)}\n${hook.text.slice(0, 400)}`)}</title></path>`,
    )
  }
  parts.push(`<text x="${LABEL}" y="${H - 4}" font-size="10" fill="#8b8b8b">${clock(t0)}</text>`)
  parts.push(`<text x="${W - 8}" y="${H - 4}" font-size="10" fill="#8b8b8b" text-anchor="end">now</text>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" font-family="system-ui, sans-serif">${parts.join('')}</svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'timeline', description: 'Show the agent timeline pane' })
    await edit($, MAIN, await $.clock.now())
    // Statuses age (Running → Quiet → Stalled) with no event to redraw them.
    $.clock.every(15_000, () => {
      void $.clock.now().then(t => update($, now, () => t))
    })
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'timeline' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Agent timeline pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId) {
      const id = started.agentId
      const t = await $.clock.now()
      await update($, timeline, tl =>
        tl.agents.some(a => a.id === id)
          ? tl
          : { ...tl, agents: [...tl.agents, newAgent(id, t, e.description || e.prompt.slice(0, 60), e.subagentType, e.parentAgentId ?? MAIN)] },
      )
    }
    return started
  })

  on('turn.start', async ($, e, next) => {
    await edit($, e.agentId ?? MAIN, await $.clock.now(), a => ({ ...a, endedAt: undefined, ending: undefined }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const t = await $.clock.now()
    await edit($, e.agentId ?? MAIN, t, a => ({ ...a, endedAt: t, ending: e.reason, result: e.answer.slice(0, 4000) }))
    return done
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const t = await $.clock.now()
    const call: Call = { id: e.tool_use_id ?? `call-${t}`, tool: e.tool, brief: brief(e), at: t }
    await edit($, id, t, a => ({ ...a, callCount: a.callCount + 1, calls: [...a.calls, call].slice(-KEEP_CALLS) }))
    const ran = await next(e)
    const end = await $.clock.now()
    const failed = ran.deny !== undefined || ran.isError === true
    await edit($, id, end, a => ({
      ...a,
      lastCleanAt: failed ? a.lastCleanAt : end,
      calls: a.calls.map(c => (c.id === call.id ? { ...c, endAt: end, isError: failed } : c)),
    }))
    return ran
  })

  // Hooks modules sit above the settings hooks, so `next` answers with what
  // the person's settings hooks decided.
  on('classic.PreToolUse', async ($, e, next) => {
    const decided = await next(e)
    if (decided.deny !== undefined || decided.additionalContext?.length) {
      await mark($, {
        at: await $.clock.now(),
        event: 'PreToolUse',
        kind: decided.deny !== undefined ? 'blocked' : 'message',
        text: decided.deny ?? decided.additionalContext?.join('\n') ?? '',
        toolUseId: e.tool_use_id,
      })
    }
    return decided
  })

  on('classic.PostToolUse', async ($, e, next) => {
    const decided = await next(e)
    await markClassic($, 'PostToolUse', decided, e.agent_id, e.tool_use_id)
    return decided
  })

  on('classic.Stop', async ($, e, next) => {
    const decided = await next(e)
    await markClassic($, 'Stop', decided, e.agent_id)
    return decided
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const decided = await next(e)
    await markClassic($, 'SubagentStop', decided, e.agent_id)
    return decided
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const decided = await next(e)
    await markClassic($, 'UserPromptSubmit', decided, e.agent_id)
    return decided
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const { agents: all, hooks } = await read($, timeline)
    const open = await read($, expanded)
    const t = Math.max(await read($, now), await $.clock.now())

    if (all.length === 0) return <Text dimColor>No activity yet.</Text>

    // Main first, then the latest subagents; unfinished ones always stay.
    const main = all.filter(a => a.id === MAIN)
    const rest = all.filter(a => a.id !== MAIN)
    const unfinished = rest.filter(a => a.endedAt === undefined)
    const finished = rest.filter(a => a.endedAt !== undefined).slice(-Math.max(0, SHOWN_ROWS - 1 - unfinished.length))
    const shown = [...main, ...rest.filter(a => unfinished.includes(a) || finished.includes(a))]
    const hidden = all.length - shown.length

    const counts = new Map<Status, number>()
    for (const agent of rest) counts.set(statusOf(agent, t), (counts.get(statusOf(agent, t)) ?? 0) + 1)
    const summary = [`${rest.length} agent${rest.length === 1 ? '' : 's'}`, ...[...counts].map(([s, n]) => `${n} ${s.toLowerCase()}`)].join(' · ')
    const attention = needsAttention(all, hooks, t)

    const toggle = (id: string) => update($, expanded, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{summary}</Text>
        {attention.length > 0 && <Text color="warning">Needs attention: {attention.join(', ')}</Text>}
        {Svg && <Svg source={chart(shown, hooks, t)} alt={`Timeline of ${shown.length} agents`} isInteractive />}
        {hidden > 0 && <Text dimColor>{hidden} earlier finished agents not shown</Text>}
        <Box flexDirection="column">
          {shown.map(agent => {
            const status = statusOf(agent, t)
            const isOpen = open.includes(agent.id)
            // Never name a variable `h`: JSX compiles to calls of the global `h`.
            const own = hooks.filter(hook => ownerOf(hook, all) === agent.id)
            const blocked = own.filter(hook => hook.kind === 'blocked').length
            return (
              <Box key={agent.id} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text color={STATUS_THEME[status]}>●</Text>
                  <Button key={agent.id} plain onPress={() => toggle(agent.id)}>
                    {isOpen ? '▾' : '▸'} {agent.description}{' '}
                    <Text dimColor>
                      {status} · {duration(activeMs(agent))} active · {agent.callCount} calls{blocked > 0 ? ` · ${blocked} blocked` : ''}
                    </Text>
                  </Button>
                </Box>
                {isOpen && (
                  <Box flexDirection="column" paddingLeft={3} gap={1}>
                    {agent.type && agent.id !== MAIN && <Text dimColor>{agent.type} · started {clock(agent.startedAt)}</Text>}
                    <Box flexDirection="column">
                      {agent.calls.length === 0 && <Text dimColor>No tool calls yet.</Text>}
                      {agent.calls.slice(-SHOWN_CALLS).map(c => (
                        <Text wrap="truncate-end" color={c.isError ? 'error' : undefined} dimColor={c.endAt !== undefined && !c.isError}>
                          {c.endAt === undefined ? '…' : c.isError ? '✗' : '✓'} {clock(c.at)} {c.tool} {c.brief}
                        </Text>
                      ))}
                    </Box>
                    {own.slice(-5).map(hook => (
                      <Text color={hook.kind === 'blocked' ? 'error' : 'remember'} wrap="truncate-end">
                        {hook.event} hook {hook.kind} at {clock(hook.at)}: {hook.text.split('\n')[0]}
                      </Text>
                    ))}
                    {agent.result && <Markdown key={`result-${agent.id}`} text={agent.result.slice(0, 1500)} />}
                    {agent.id !== MAIN && (
                      <Button key={`view-${agent.id}`} label="Open transcript" onPress={() => void $.ui.view({ agentId: agent.id })} />
                    )}
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}
