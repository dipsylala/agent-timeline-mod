import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey } from 'claude-code'

import type { Agent, Call, HookMark, Timeline } from '../types'
import { brief, IDLE_GAP, KEEP_CALLS, mergeAgent, mergeSpans, newHooks, parseTranscript } from './transcript'

const PANE = 'agent-timeline'
const TITLE = 'Agent timeline'
// Not "agent-timeline": the agent-timeline skill holds that command.
const COMMAND = 'agent-timeline-pane'
const MAIN = 'main'

// The same thresholds the agent-timeline skill uses.
const RUNNING_WINDOW = 120_000 // unfinished and active this recently: Running
const STALL_AFTER = 600_000 // unfinished and silent this long: Stalled
const ATTENTION_WINDOW = 15 * 60_000 // hook blocks this recent count as needing attention

const KEEP_HOOKS = 200
const SHOWN_ROWS = 30
const SHOWN_CALLS = 8
const MAX_READ = 4 * 1024 * 1024 // $.fs.read rejects a file larger than this

const EMPTY: Timeline = { agents: [], hooks: [] }
// Change the tag when Agent, Call or HookMark change shape: a reload keeps
// what the earlier version stored, and the tag declines it.
const timeline = atom({ plugin: 'agent-timeline', key: 'timeline' } as const, EMPTY, { shape: 'timeline-1' })
const now = atom({ plugin: 'agent-timeline', key: 'now' } as const, 0)
// The agent whose details show below the list; '' for none.
const selected = atom({ plugin: 'agent-timeline', key: 'selected' } as const, '')

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

/** One stretch of an agent's track: empty, busy, or a hook marker (its index in the hooks list). */
type Mark = { index: number; hook: HookMark }
type Piece = { kind: 'gap' | 'bar'; pct: number } | ({ kind: 'mark'; onBar: boolean } & Mark)

/**
 * An agent's track over the window t0..t1 as stretches in percent of its
 * width, with each hook marker in the window placed at its time between them.
 */
function track(agent: Agent, marks: { index: number; hook: HookMark }[], t0: number, t1: number, t: number): Piece[] {
  const range = Math.max(t1 - t0, 1)
  const pos = (at: number) => Math.min(100, Math.max(0, ((at - t0) / range) * 100))
  // A running agent's last span reaches toward now; every span shows at least a sliver.
  const spans = agent.spans
    .map(([a, b], i): [number, number] => {
      const isLast = i === agent.spans.length - 1
      return [a, agent.endedAt === undefined && isLast ? Math.max(b, Math.min(t, b + RUNNING_WINDOW)) : b]
    })
    .filter(([a, b]) => b >= t0 && a <= t1)
    .map(([a, b]): [number, number] => [pos(a), Math.max(pos(b), Math.min(100, pos(a) + 0.8))])
  const markAt = marks
    .filter(m => m.hook.at >= t0 && m.hook.at <= t1)
    .map(m => ({ ...m, pct: pos(m.hook.at) }))
    .sort((x, y) => x.pct - y.pct)
  const points = [...new Set([0, 100, ...spans.flat(), ...markAt.map(m => m.pct)])].sort((x, y) => x - y)
  const pieces: Piece[] = []
  points.forEach((p, i) => {
    for (const m of markAt) {
      if (m.pct === p) pieces.push({ kind: 'mark', index: m.index, hook: m.hook, onBar: spans.some(([a, b]) => a <= p && p <= b) })
    }
    const next = points[i + 1]
    if (next === undefined || next <= p) return
    const mid = (p + next) / 2
    const kind = spans.some(([a, b]) => a <= mid && mid <= b) ? 'bar' : 'gap'
    const last = pieces.at(-1)
    if (last && last.kind === kind) last.pct += next - p
    else pieces.push({ kind, pct: next - p })
  })
  return pieces
}

/** A bar holds the hook markers that fall on it, each at a cell offset from its start. */
type Cell =
  | { kind: 'gap'; cells: number }
  | { kind: 'bar'; cells: number; marks: (Mark & { offset: number })[] }
  | ({ kind: 'mark' } & Mark)

/**
 * A track's stretches as whole cells across `columns`. Rounding runs on the
 * total so far, a marker takes one cell from what follows it, and a bar
 * keeps at least one cell. A marker on a bar joins that bar, so the bar
 * stays one piece around it.
 */
function inCells(pieces: Piece[], columns: number): Cell[] {
  const out: Cell[] = []
  let pct = 0
  let used = 0
  for (const piece of pieces) {
    const last = out.at(-1)
    if (piece.kind === 'mark') {
      const mark = { index: piece.index, hook: piece.hook }
      if (piece.onBar && last?.kind === 'bar') {
        last.marks.push({ ...mark, offset: last.cells })
        last.cells += 1
      } else if (piece.onBar) {
        out.push({ kind: 'bar', cells: 1, marks: [{ ...mark, offset: 0 }] })
      } else {
        out.push({ kind: 'mark', ...mark })
      }
      used += 1
      continue
    }
    pct += piece.pct
    let cells = Math.max(0, Math.round((pct / 100) * columns) - used)
    if (piece.kind === 'bar' && cells === 0 && last?.kind !== 'bar') cells = 1
    used += cells
    if (cells === 0) continue
    if (piece.kind === 'bar' && last?.kind === 'bar') last.cells += cells
    else out.push(piece.kind === 'bar' ? { kind: 'bar', cells, marks: [] } : { kind: 'gap', cells })
  }
  return out
}

// An Svg cannot take theme keys: mid tones that read on light and dark backgrounds.
const STATUS_COLOR: Record<Status, string> = {
  Running: '#3b82f6',
  Quiet: '#8b9bb4',
  Stalled: '#f59e0b',
  Done: '#16a34a',
  Idle: '#16a34a',
  Failed: '#dc2626',
  Stopped: '#9ca3af',
}

// Desktop draws an Svg with no `width` at about 300px, whatever its slot, and
// takes `width` in CSS pixels while a Box is sized in cells. This is about one
// cell of the desktop pane's text, measured from a screenshot; a little under,
// so the drawing stays inside its track.
const CELL_PX = 8.5

function xml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

/**
 * One agent's track as an Svg for the surfaces that draw one: thin rounded
 * bars with room above and below, and each hook marker a slim stripe the
 * full height, with tooltips. Bars a marker splits are drawn as one.
 *
 * Drawn as an image, the markup needs a size of its own (`100%` gives none,
 * and the image falls back to 300×150). It is `width` units wide, wider than
 * the slot so it always shrinks to fill it, and stretched across with the
 * height held by the Svg's own `height`.
 */
function trackSvg(pieces: Piece[], color: string, barTip: string, width: number): string {
  const x = (pct: number) => ((pct / 100) * width).toFixed(1)
  const bars: { x: number; w: number }[] = []
  const stripes: string[] = []
  let pct = 0
  for (const piece of pieces) {
    if (piece.kind === 'mark') {
      const fill = piece.hook.kind === 'blocked' ? '#dc2626' : '#a855f7'
      const tip = `${piece.hook.event} hook ${piece.hook.kind} at ${clock(piece.hook.at)}\n${piece.hook.text.slice(0, 400)}`
      stripes.push(
        `<rect x="${x(pct)}" y="1" width="4" height="18" rx="1.5" fill="${fill}" transform="translate(-2 0)"><title>${xml(tip)}</title></rect>`,
      )
      continue
    }
    const last = bars.at(-1)
    if (piece.kind === 'bar') {
      if (last && Math.abs(last.x + last.w - pct) < 0.001) last.w += piece.pct
      else bars.push({ x: pct, w: piece.pct })
    }
    pct += piece.pct
  }
  const rects = bars.map(
    b => `<rect x="${x(b.x)}" y="5" width="${x(b.w)}" height="10" rx="5" fill="${color}"><title>${xml(barTip)}</title></rect>`,
  )
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20" preserveAspectRatio="none">${rects.join('')}${stripes.join('')}</svg>`
}

/** This session's transcript folder: `<id>.jsonl` beside it, `subagents/` inside it. */
async function sessionDir($: EngineInterface, cwd: string): Promise<string | undefined> {
  const id = await $.session.id()
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const projects = `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`}/projects`
  const guess = `${projects}/${cwd.replace(/[^A-Za-z0-9]/g, '-')}`
  if (await $.fs.exists(`${guess}/${id}.jsonl`)) return `${guess}/${id}`
  // The folder is named for where the session started, which may not be cwd now.
  for (const entry of await $.fs.list(projects).catch(() => [])) {
    if (entry.kind === 'dir' && (await $.fs.exists(`${projects}/${entry.name}/${id}.jsonl`))) return `${projects}/${entry.name}/${id}`
  }
  return undefined
}

/** A file's text, or undefined when it is missing or too large for one read. */
async function readSmall($: EngineInterface, path: string): Promise<string | undefined> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  if (!stat || stat.size > MAX_READ) return undefined
  return $.fs.read(path).catch(() => undefined)
}

// The chart covers what the main transcript's last TAIL bytes cover: enough
// for the recent work, and within what one read or one command's output can
// hold. A file larger than `$.fs.read` takes comes from a command that prints
// only those bytes.
const TAIL = 2_500_000
const TAIL_PS = [
  '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
  `$f = [IO.File]::OpenRead($env:AGENT_TIMELINE_FILE); $n = [Math]::Min($f.Length, ${TAIL}); [void]$f.Seek(-$n, 'End')`,
  '$b = New-Object byte[] $n; $got = 0; while ($got -lt $n) { $got += $f.Read($b, $got, $n - $got) }; $f.Close()',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b)); [Console]::Out.Flush()',
].join('; ')

/**
 * The last TAIL bytes of a transcript, from its first whole line: by one read
 * when the file is small enough, else PowerShell on Windows or tail
 * elsewhere. Undefined when it cannot be read.
 */
async function readTail($: EngineInterface, path: string, size: number): Promise<string | undefined> {
  let text: string | undefined
  if (size <= MAX_READ) {
    text = await $.fs.read(path).catch(() => undefined)
    // Characters, not bytes, but near enough to place the window.
    if (text !== undefined && size > TAIL) text = text.slice(-TAIL)
  } else {
    const isWindows = (await $.env.get('OS')) === 'Windows_NT'
    const argv = isWindows ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', TAIL_PS] : ['tail', '-c', String(TAIL), path]
    const run = await $.process.run(argv, { env: { AGENT_TIMELINE_FILE: path }, timeoutMs: 60_000 }).catch(() => undefined)
    text = run?.exitCode === 0 ? run.stdout : undefined
  }
  // A cut file starts mid-line.
  return text !== undefined && size > TAIL ? text.slice(text.indexOf('\n') + 1) : text
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0)} MB`
}

/**
 * Adds what the transcripts hold that the live rows do not: agents from
 * before the mod loaded or from a resumed session, and their hook blocks.
 * The main transcript is read from its last TAIL bytes, whose first entry
 * starts the chart's window.
 */
async function backfill($: EngineInterface, cwd: string) {
  const dir = await sessionDir($, cwd)
  if (!dir) return
  const found: { agent: Agent; hooks: HookMark[]; isMain: boolean }[] = []
  const mainPath = `${dir}.jsonl`
  const mainSize = (await $.fs.stat(mainPath).catch(() => undefined))?.size ?? 0
  const tail = mainSize > 0 ? await readTail($, mainPath, mainSize) : undefined
  const main = tail ? parseTranscript(tail, { id: MAIN, description: 'Main session', type: 'main' }, { isMain: true }) : undefined
  if (main) found.push({ ...main, isMain: true })
  const window = main && mainSize > TAIL ? { since: main.agent.startedAt, transcriptBytes: mainSize } : {}
  const folder = `${dir}/subagents`
  for (const entry of await $.fs.list(folder).catch(() => [])) {
    const id = /^agent-(.+)\.jsonl$/.exec(entry.name)?.[1]
    if (!id || entry.kind !== 'file') continue
    const text = await readSmall($, `${folder}/${entry.name}`)
    if (!text) continue
    const meta = await $.fs
      .read(`${folder}/agent-${id}.meta.json`)
      .then(json => JSON.parse(json) as { description?: string; agentType?: string; finished?: boolean })
      .catch(() => ({}) as { description?: string; agentType?: string; finished?: boolean })
    const base = { id, description: meta.description ?? `Agent ${id.slice(0, 8)}`, type: meta.agentType ?? '', parentId: MAIN }
    const parsed = parseTranscript(text, base, { finished: meta.finished })
    if (parsed) found.push({ ...parsed, isMain: false })
  }
  if (!main && found.length > 0) {
    // The main transcript could not be read: the main session was at least
    // busy when it launched each subagent and when each handed back.
    const moments = found.flatMap(({ agent }) => [agent.startedAt, agent.lastAt])
    found.push({
      agent: {
        id: MAIN,
        description: 'Main session',
        type: 'main',
        startedAt: Math.min(...moments),
        lastAt: Math.max(...moments),
        lastCleanAt: 0,
        spans: mergeSpans(moments.map((at): [number, number] => [at, at])),
        calls: [],
        callCount: 0,
        note:
          mainSize > 0
            ? `Transcript could not be read (${megabytes(mainSize)}): bars show only when subagents started and finished; earlier calls aren't listed.`
            : undefined,
      },
      hooks: [],
      isMain: true,
    })
  }
  if (found.length === 0) return
  await update($, timeline, tl => {
    let agents = tl.agents
    let hooks = tl.hooks
    for (const { agent, hooks: marks, isMain } of found) {
      const index = agents.findIndex(a => a.id === agent.id)
      const merged = mergeAgent(agents[index], agent, isMain)
      agents = index < 0 ? [...agents, merged] : agents.map((a, i) => (i === index ? merged : a))
      hooks = [...hooks, ...newHooks(hooks, marks)]
    }
    // Main first, then by when each agent started.
    agents = [...agents].sort((a, b) => (a.id === MAIN ? -1 : b.id === MAIN ? 1 : a.startedAt - b.startedAt))
    return { ...tl, ...window, agents, hooks: [...hooks].sort((a, b) => a.at - b.at).slice(-KEEP_HOOKS) }
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A name another command holds is refused; the pane must still open.
    await $.command
      .register({ name: COMMAND, description: 'Show the agent timeline pane' })
      .catch(error => $.ui.log(`agent-timeline: /${COMMAND} is not available: ${String(error)}`))
    await edit($, MAIN, await $.clock.now())
    // Statuses age (Running → Quiet → Stalled) with no event to redraw them.
    $.clock.every(15_000, () => {
      void $.clock.now().then(t => update($, now, () => t))
    })
    // Earlier agents come from the transcripts, off the session's start.
    $.clock.after(0, () => {
      void backfill($, e.cwd).catch(error => $.ui.log(`agent-timeline: could not read earlier agents: ${String(error)}`))
    })
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'agent-timeline-pane' }, async $ => {
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
    // The terminal's table carries an Svg at run time that draws nothing there.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : undefined
    const { agents: all, hooks, since, transcriptBytes } = await read($, timeline)
    const chosen = await read($, selected)
    const t = Math.max(await read($, now), await $.clock.now())

    if (all.length === 0) return <Text dimColor>No activity yet.</Text>

    // The window runs to now from where the main transcript's last TAIL bytes
    // start, or from the session's start when it was read whole.
    const t0 = since ?? Math.min(...all.map(a => a.startedAt))
    const t1 = t
    // Main first, then the latest subagents active in the window; unfinished
    // ones always stay.
    const main = all.filter(a => a.id === MAIN)
    const inWindow = all.filter(a => a.id !== MAIN && (a.endedAt === undefined || a.lastAt >= t0))
    const unfinished = inWindow.filter(a => a.endedAt === undefined)
    const finished = inWindow.filter(a => a.endedAt !== undefined).slice(-Math.max(0, SHOWN_ROWS - 1 - unfinished.length))
    const subs = inWindow.filter(a => unfinished.includes(a) || finished.includes(a))
    const shown = [...main, ...subs]
    const hidden = all.length - shown.length

    const counts = new Map<Status, number>()
    for (const agent of subs) counts.set(statusOf(agent, t), (counts.get(statusOf(agent, t)) ?? 0) + 1)
    const attention = needsAttention(all, hooks, t)
    const labelColumns = Math.max(14, Math.min(30, Math.floor(e.props.bodyColumns * 0.32)))
    const timeColumns = 8
    const trackColumns = Math.max(10, e.props.bodyColumns - labelColumns - timeColumns - 2)
    const shortLabel =(text: string) => (text.length > labelColumns - 3 ? `${text.slice(0, labelColumns - 4)}…` : text)

    // One agent's details at a time: another name switches to it, its own closes it.
    const choose = (id: string) => update($, selected, current => (current === id ? '' : id))
    const marksOf = (agent: Agent) => hooks.map((hook, index) => ({ hook, index })).filter(m => ownerOf(m.hook, all) === agent.id)
    // Where no Svg is drawn (the terminal) a hook marker is a one-cell stripe,
    // red for a block and purple for a message.
    const stripe = (mark: Mark) => (
      <Box key={`mark-${mark.index}`} width={1} height={1} backgroundColor={mark.hook.kind === 'blocked' ? 'error' : 'remember'} />
    )

    // Only the terminal has a main view to switch: the desktop answers "no main
    // view here". Elsewhere it can still refuse (the tasks list has no row for
    // the agent…); say why rather than doing nothing.
    const canOpenTranscript = e.surface === 'terminal'
    const openTranscript = async (agentId: string) => {
      const moved = await $.ui.view({ agentId })
      if (moved.deny) await $.ui.toast(`Couldn't open the transcript: ${moved.deny}`)
    }

    const card = (agent: Agent) => {
      const status = statusOf(agent, t)
      // Never name a variable `h`: JSX compiles to calls of the global `h`.
      const own = marksOf(agent).map(m => m.hook)
      const blocked = own.filter(hook => hook.kind === 'blocked')
      // A call a hook blocked stays in view even when it is older than the latest few.
      const blockedCalls = new Set(blocked.map(hook => hook.toolUseId))
      const latest = agent.calls.slice(-SHOWN_CALLS)
      const older = agent.calls.filter(c => blockedCalls.has(c.id) && !latest.includes(c))
      const calls = [...older, ...latest]
      const hookLines = own.slice(-5)
      const details = [
        agent.id === MAIN ? undefined : agent.type,
        `started ${clock(agent.startedAt)}`,
        `${agent.callCount} call${agent.callCount === 1 ? '' : 's'}`,
        blocked.length > 0 ? `${blocked.length} blocked` : undefined,
      ].filter(Boolean)

      return (
        <Box key={`card-${agent.id}`} flexDirection="column" gap={1} borderStyle="round" borderColor="subtle" paddingLeft={1} paddingRight={1}>
          <Text>
            <Text bold>{agent.description}</Text>
            <Text dimColor> · </Text>
            <Text color={STATUS_THEME[status]} bold>
              {status}
            </Text>
            <Text dimColor> · {details.join(' · ')}</Text>
          </Text>
          {agent.note && <Text dimColor>{agent.note}</Text>}

          <Box flexDirection="column">
            <Text dimColor bold>
              TOOL CALLS
            </Text>
            {calls.length === 0 && <Text dimColor>None yet.</Text>}
            {calls.map((c, i) => (
              <Box key={`call-${agent.id}-${c.id}`} flexDirection="column">
                {older.length > 0 && i === older.length && <Text dimColor>⋮</Text>}
                <Text wrap="truncate-end">
                  <Text color={c.isError ? 'error' : 'success'}>{c.endAt === undefined ? '…' : c.isError ? '✗' : '✓'}</Text>{' '}
                  <Text dimColor>{clock(c.at)}</Text> <Text color={c.isError ? 'error' : undefined}>{c.tool}</Text>{' '}
                  <Text dimColor>{c.brief}</Text>
                </Text>
              </Box>
            ))}
          </Box>

          {hookLines.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor bold>
                HOOKS
              </Text>
              {hookLines.map(hook => (
                <Text wrap="truncate-end">
                  <Text color={hook.kind === 'blocked' ? 'error' : 'remember'}>▌</Text> <Text dimColor>{clock(hook.at)}</Text>{' '}
                  <Text color={hook.kind === 'blocked' ? 'error' : 'remember'}>
                    {hook.event} {hook.kind}
                  </Text>{' '}
                  <Text dimColor>{hook.text.split('\n')[0]}</Text>
                </Text>
              ))}
            </Box>
          )}

          {agent.result && (
            <Box flexDirection="column">
              <Text dimColor bold>
                {agent.id === MAIN ? 'LATEST REPLY' : 'RESULT'}
              </Text>
              <Markdown key={`result-${agent.id}`} text={agent.result.slice(0, 1500)} />
            </Box>
          )}

          {canOpenTranscript && agent.id !== MAIN && (
            <Box flexDirection="row">
              <Button key={`view-${agent.id}`} label="Open transcript" onPress={() => void openTranscript(agent.id)} />
            </Box>
          )}
        </Box>
      )
    }
    const chosenAgent = all.find(a => a.id === chosen)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={2}>
          <Text bold>
            {subs.length} agent{subs.length === 1 ? '' : 's'}
          </Text>
          {[...counts].map(([status, n]) => (
            <Text color={STATUS_THEME[status]}>
              ● {n} {status.toLowerCase()}
            </Text>
          ))}
        </Box>
        {since !== undefined && transcriptBytes !== undefined && (
          <Text dimColor>
            Since {clock(since)}: the last {megabytes(TAIL)} of a {megabytes(transcriptBytes)} transcript.
          </Text>
        )}
        {attention.length > 0 && <Text color="warning">⚠ Needs attention: {attention.join(', ')}</Text>}

        <Box flexDirection="column">
          {shown.map(agent => {
            const status = statusOf(agent, t)
            const marks = marksOf(agent)
            return (
              <Box key={`agent-${agent.id}`} flexDirection="row" gap={1}>
                <Box key={`label-${agent.id}`} width={labelColumns} flexDirection="row" gap={1}>
                  <Text color={STATUS_THEME[status]}>●</Text>
                  <Button key={agent.id} plain onPress={() => choose(agent.id)}>
                    <Text bold={agent.id === chosen}>{shortLabel(agent.description)}</Text>
                  </Button>
                  {/* A cut name shows whole on hover, over the name itself; the card has its
                      own Button, as it covers the name's. inverseText is the theme's background
                      colour, so the card hides what is under it. */}
                  {shortLabel(agent.description) !== agent.description && (
                    <Box position="absolute" top={0} left={2} display="none" hover={{ display: 'flex' }} backgroundColor="inverseText">
                      <Button key={`${agent.id}-full`} plain onPress={() => choose(agent.id)}>
                        <Text bold={agent.id === chosen}>{agent.description}</Text>
                      </Button>
                    </Box>
                  )}
                </Box>
                {Svg ? (
                  <Box width={trackColumns}>
                    <Svg
                      source={trackSvg(
                        track(agent, marks, t0, t1, t),
                        STATUS_COLOR[status],
                        `${agent.description}\n${status} · ${duration(activeMs(agent))} active · ${agent.callCount} calls`,
                        trackColumns * CELL_PX,
                      )}
                      alt={`${agent.description}: ${status}`}
                      width={trackColumns * CELL_PX}
                      height={20}
                      isInteractive
                    />
                  </Box>
                ) : (
                  <Box flexDirection="row" width={trackColumns}>
                    {inCells(track(agent, marks, t0, t1, t), trackColumns).map((piece, i) =>
                      piece.kind === 'mark' ? (
                        stripe(piece)
                      ) : piece.kind === 'bar' ? (
                        <Box key={`${agent.id}-${i}`} width={piece.cells} height={1} flexDirection="row" backgroundColor={STATUS_THEME[status]}>
                          {piece.marks.map((mark, j) => [
                            <Box key={`${agent.id}-${i}-lead-${j}`} width={mark.offset - (piece.marks[j - 1]?.offset ?? -1) - 1} />,
                            stripe(mark),
                          ])}
                        </Box>
                      ) : (
                        <Box key={`${agent.id}-${i}`} width={piece.cells} height={1} />
                      ),
                    )}
                  </Box>
                )}
                <Box width={timeColumns}>
                  <Text dimColor>{duration(activeMs(agent))}</Text>
                </Box>
              </Box>
            )
          })}

          <Box flexDirection="row" gap={1}>
            <Box width={labelColumns} />
            <Box flexDirection="row" width={trackColumns}>
              <Text dimColor>{clock(t0)}</Text>
              <Box flexGrow={1} />
              <Text dimColor>{t1 >= t ? 'now' : clock(t1)}</Text>
            </Box>
            <Box width={timeColumns}>
              <Text dimColor>active</Text>
            </Box>
          </Box>
        </Box>
        {hidden > 0 && (
          <Text dimColor>
            {hidden} earlier agent{hidden === 1 ? '' : 's'} not shown
          </Text>
        )}
        {chosenAgent ? card(chosenAgent) : <Text dimColor>Click an agent's name for its details.</Text>}
      </Box>
    )
  })
}
