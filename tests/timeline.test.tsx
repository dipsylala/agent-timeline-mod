import { expect, mock, test } from 'claude-code/testing'
import { brief, lineageOf, redact } from '../hooks/transcript'

const PANE = {
  plugin: 'agent-timeline',
  component: 'Pane',
  requestId: 'agent-timeline',
  props: {
    title: 'Agent timeline',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test("a subagent's row, its calls, its result and a hook block, on every surface", async ($, on) => {
  // Each hook here stands for the engine beneath the mod.
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const registered: string[] = []
  on('command.register', (_, e) => (registered.push(e.name), { value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  // Stands for the person's settings hooks: blocks every Write.
  on('classic.PreToolUse', (_, e) => (e.tool === 'Write' ? { deny: 'no writes here' } : {}))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(registered).toEqual(['agent-timeline-pane'])
  await $.agent.spawn({
    prompt: 'Look around the repo',
    description: 'Survey repo',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    tool_use_id: 'spawn-1',
    background: false,
    fork: false,
  })
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Bash', command: 'ls -la', agentId: 'a1', tool_use_id: 't1' })
  await clock.advance(5_000)
  await $.tool.call({ tool: 'Write', file_path: '/x.txt', content: 'y', agentId: 'a1', tool_use_id: 't2' })
  await $.turn.complete({ answer: 'Found three things', durationMs: 5, isAborted: false, turnId: 'turn-1', agentId: 'a1', reason: 'answer' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^1 agent/ }))?.text).toBe('1 agent')
    expect(await ui.find({ type: 'Text', text: /● 1 done/ })).toBeDefined()
    expect((await ui.find({ key: 'a1' }))?.text).toBe('Survey repo')
    // The track is an Svg where the surface draws one, else cells with the block's stripe.
    if (surface === 'terminal') expect(await ui.find({ key: 'mark-0' }), surface).toBeDefined()
    else expect(await ui.find({ type: 'Svg' }), surface).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'a1' })
  expect(await ui.find({ type: 'Text', text: /Done · Explore · started .* · 2 calls · 1 blocked/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Bash ls -la/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Write \/x.txt/ }))?.text).toMatch(/^✗/)
  expect(await ui.find({ type: 'Text', text: /PreToolUse blocked no writes here/ })).toBeDefined()
  // The desktop has no main view to switch, so no Open transcript there.
  expect(await ui.find({ key: 'view-a1' })).toBeUndefined()

  // One agent's details at a time: choosing another replaces them, choosing it again closes them.
  await ui.press({ key: 'main' })
  expect(await ui.find({ type: 'Text', text: /^Main session · Idle/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Bash ls -la/ })).toBeUndefined()
  await ui.press({ key: 'main' })
  expect(await ui.find({ type: 'Text', text: /^Main session · Idle/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Click an agent's name/ })).toBeDefined()
  await ui.unmount()
})

test('a call a hook blocked stays in view when older than the latest calls', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'agent-timeline-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'Survey repo', type: 'Explore', status: 'running' }] }))
  on('tool.call', () => ({ result: {} }))
  on('classic.PreToolUse', (_, e) => (e.tool === 'Write' ? { deny: 'no writes here' } : {}))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: '/x.txt', content: 'y', agentId: 'a1', tool_use_id: 't2' })
  // Enough later calls that the blocked one is no longer among the latest shown.
  for (let i = 0; i < 10; i++) await $.tool.call({ tool: 'Bash', command: `echo ${i}`, agentId: 'a1', tool_use_id: `b${i}` })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'a1' })
  expect((await ui.find({ type: 'Text', text: /Write \/x.txt/ }))?.text).toMatch(/^✗ .* Write \/x.txt/)
  expect(await ui.find({ type: 'Text', text: /^⋮$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Bash echo 9/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Bash echo 1$/ })).toBeUndefined()
  await ui.unmount()
})

test('an unfinished agent silent for over ten minutes shows as stalled and needs attention', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'agent-timeline-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [{ id: 'b2', description: 'Long build', type: 'general-purpose', status: 'running' }] }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // Spawned before the mod loaded: its first event names it via $.agent.list().
  await $.tool.call({ tool: 'Bash', command: 'make', agentId: 'b2', tool_use_id: 't9' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b2' })
  expect((await ui.find({ type: 'Text', text: /· general-purpose ·/ }))?.text).toMatch(/^Long build · Running/)
  await clock.advance(11 * 60_000)
  expect((await ui.find({ type: 'Text', text: /· general-purpose ·/ }))?.text).toMatch(/^Long build · Stalled/)
  expect((await ui.find({ type: 'Text', text: /Needs attention/ }))?.text).toBe('⚠ Needs attention: Long build (stalled)')
  await ui.unmount()
})

test('agents from before the mod loaded come back from the transcripts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_100_000 })
  const at = (s: number) => new Date(1_700_000_000_000 + s * 1000).toISOString()
  const DIR = '/home/u/.claude/projects/-work/s1'
  const files: Record<string, string> = {
    [`${DIR}/subagents/agent-old1.jsonl`]: [
      { timestamp: at(0), type: 'user', message: { content: 'Look around' } },
      { timestamp: at(2), type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_r1', name: 'Read', input: { file_path: '/a.ts' } }] } },
      { timestamp: at(3), type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_r1', content: 'ok' }] } },
      { timestamp: at(4), type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_w1', name: 'Write', input: { file_path: '/b.ts' } }] } },
      {
        timestamp: at(5),
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w1', is_error: true, content: 'PreToolUse:Write hook error: writes are off' }] },
      },
      { timestamp: at(9), type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } },
    ]
      .map(line => JSON.stringify(line))
      .join('\n'),
    [`${DIR}/subagents/agent-old1.meta.json`]: JSON.stringify({ description: 'Earlier survey', agentType: 'Explore', finished: true }),
  }
  // The engine hands paths on in the platform's form (C:\home\u\... on Windows).
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  on('command.register', () => ({ value: { command: 'agent-timeline-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  // The main transcript is there but too large to read; the subagent still comes in.
  on('fs.exists', (_, e) => ({ value: norm(e.path) === `${DIR}.jsonl` }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: norm(e.path) === `${DIR}.jsonl` ? 12_000_000 : 1000, mtimeMs: 0, isLink: false } }))
  on('fs.list', (_, e) =>
    norm(e.path) === `${DIR}/subagents`
      ? { value: Object.keys(files).map(path => ({ name: path.split('/').pop() ?? '', kind: 'file', size: 1000, mtimeMs: 0, isLink: false })) }
      : { value: [] },
  )
  on('fs.read', (_, e) => {
    const text = files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })

  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(JSON.stringify(e))
    return { value: undefined }
  })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  expect(logged).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'old1' }))?.text).toBe('Earlier survey')
  await ui.press({ key: 'old1' })
  expect(await ui.find({ type: 'Text', text: /^Earlier survey · Done · Explore · .* · 2 calls · 1 blocked/ }), 'header').toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Write \/b.ts/ }))?.text).toMatch(/^✗/)
  expect(await ui.find({ type: 'Text', text: /PreToolUse blocked writes are off/ }), 'hook').toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /All done\./ }), 'result').toBeDefined()

  // The main transcript was too large, so the main row starts where the subagent did.
  await ui.press({ key: 'main' })
  const started = new Date(1_700_000_000_000).toTimeString().slice(0, 8)
  expect(await ui.find({ type: 'Text', text: new RegExp(`^Main session · .* started ${started}`) }), 'main start').toBeDefined()
  // The main transcript could not be read here, so the note says how little the bars cover.
  expect(await ui.find({ type: 'Text', text: /^Transcript could not be read \(12 MB\): bars show only when subagents started/ }), 'note').toBeDefined()
  await ui.unmount()
})

test("a main transcript over the read limit is read from its last 2.5 MB, which sets the chart's window", async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_100_000 })
  const at = (s: number) => new Date(1_700_000_000_000 + s * 1000).toISOString()
  const DIR = '/home/u/.claude/projects/-work/s1'
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  // A subagent that finished an hour before the window starts.
  const files: Record<string, string> = {
    [`${DIR}/subagents/agent-early.jsonl`]: [
      { timestamp: at(-3600), type: 'user', message: { content: 'Early task' } },
      { timestamp: at(-3500), type: 'assistant', message: { content: [{ type: 'text', text: 'Done early.' }] } },
    ]
      .map(line => JSON.stringify(line))
      .join('\n'),
    [`${DIR}/subagents/agent-early.meta.json`]: JSON.stringify({ description: 'Early task', agentType: 'Explore', finished: true }),
  }
  on('command.register', () => ({ value: { command: 'agent-timeline-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: norm(e.path) === `${DIR}.jsonl` }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: norm(e.path) === `${DIR}.jsonl` ? 12_000_000 : 1000, mtimeMs: 0, isLink: false } }))
  on('fs.list', (_, e) =>
    norm(e.path) === `${DIR}/subagents`
      ? { value: Object.keys(files).map(path => ({ name: path.split('/').pop() ?? '', kind: 'file', size: 1000, mtimeMs: 0, isLink: false })) }
      : { value: [] },
  )
  on('fs.read', (_, e) => {
    const text = files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  // What tail prints for the transcript (not Windows, as OS is unset here): it starts mid-line.
  const tail = [
    'id":"cut mid-line by tail"}',
    JSON.stringify({ timestamp: at(50), type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ timestamp: at(55), type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_c', content: 'ok' }] } }),
    JSON.stringify({ timestamp: at(60), type: 'assistant', message: { content: [{ type: 'text', text: 'Tests pass.' }] } }),
  ].join('\n')
  const ran: string[] = []
  on('process.run', (_, e) => {
    ran.push(e.argv.join(' '))
    return { value: { exitCode: 0, stdout: `${tail}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  expect(ran[0]).toMatch(/^tail -c 2500000 /)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const since = new Date(1_700_000_050_000).toTimeString().slice(0, 8)
  expect((await ui.find({ type: 'Text', text: /^Since / }))?.text, 'window').toBe(`Since ${since}: the last 2.5 MB of a 12 MB transcript.`)
  expect(await ui.find({ key: 'early' }), 'agent before the window').toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /earlier agent/ }))?.text).toBe('1 earlier agent not shown')
  await ui.press({ key: 'main' })
  expect(await ui.find({ type: 'Text', text: new RegExp(`^Main session · .* started ${since} · 1 call$`) }), 'header').toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Bash npm test/ }))?.text, 'latest call').toMatch(/^✓/)
  expect(await ui.find({ type: 'Markdown', text: /Tests pass\./ }), 'latest reply').toBeDefined()
  await ui.unmount()
})

test('a session like a long resumed one renders', async ($, on) => {
  const NOW = 1_700_100_000_000
  const clock = mock.clock(on, { now: NOW })
  const day = NOW - 3 * 3600_000
  const agents = Array.from({ length: 14 }, (_, i) => {
    const start = day + i * 10 * 60_000
    return {
      id: `ag${i}`,
      description: `Stage ${i} correctness review with a long name`,
      type: 'general-purpose',
      parentId: 'main',
      startedAt: start,
      lastAt: start + 8 * 60_000,
      endedAt: start + 8 * 60_000,
      ending: 'answer',
      lastCleanAt: start + 8 * 60_000,
      spans: [[start, start + 8 * 60_000]],
      calls: [{ id: `t${i}`, tool: 'Bash', brief: 'grep -n "x" src/a.ts', at: start + 60_000, endAt: start + 61_000 }],
      callCount: 30,
      result: 'VERDICT: PASS\n\n- **B1** <fixed> & "done"',
    }
  })
  const moments = agents.flatMap(a => [a.startedAt, a.lastAt])
  const main = {
    id: 'main',
    description: 'Main session',
    type: 'main',
    startedAt: Math.min(...moments),
    lastAt: NOW - 60_000,
    endedAt: NOW - 60_000,
    ending: 'answer',
    lastCleanAt: 0,
    spans: [[day, day + 150 * 60_000], [NOW - 120_000, NOW - 60_000]],
    calls: [],
    callCount: 2,
  }
  const hooks = agents.slice(0, 3).map((a, i) => ({
    at: a.startedAt + 120_000,
    event: 'PostToolUse',
    kind: i === 0 ? 'blocked' : 'message',
    text: `Contents of E:\\Github\\webstore3.0\\.claude\\worktrees\\agent-${i}\\AGENTS.md: <rules> & "quotes"\n${'x'.repeat(600)}`,
    agentId: a.id,
    toolUseId: `t${i}`,
  }))
  // The timeline and the tick are seeded; the selection keeps the engine's own store.
  let tick = 0
  on('state.get', (_, e, next) =>
    e.key === 'timeline'
      ? { value: { value: { shape: 'timeline-1', value: { agents: [main, ...agents], hooks } }, version: 1 } }
      : e.key === 'now'
        ? { value: { value: tick, version: tick + 1 } }
        : next(e),
  )

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 90 }, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^14 agents$/ }))?.text).toBe('14 agents')
  expect(await ui.find({ key: 'ag13' })).toBeDefined()
  // A cut name keeps its whole text for the hover card.
  expect((await ui.find({ key: 'ag13' }))?.text).toMatch(/…$/)
  expect((await ui.find({ key: 'ag13-full' }))?.text).toBe('Stage 13 correctness review with a long name')
  // Choosing an agent redraws the tracks unchanged, so desktop does not reload them.
  const before = (await ui.find({ type: 'Svg' }))?.props.source
  await clock.advance(1000) // the live clock moves on between redraws
  await ui.press({ key: 'ag1' })
  expect((await ui.find({ type: 'Svg' }))?.props.source).toBe(before)

  // Ticks leave finished tracks unchanged until now passes the axis end: a
  // three-hour window ends on a ten-minute step after the latest activity.
  const sources = async () => (await ui.findAll({ type: 'Svg' })).map(svg => svg.props.source)
  const end = Math.ceil((NOW - 60_000) / 600_000) * 600_000
  const first = await sources()
  expect(first).toHaveLength(15)
  tick = end
  await ui.press({ key: 'ag1' })
  expect(await sources(), 'tick inside the step').toEqual(first)
  expect(await ui.find({ type: 'Text', text: new Date(end).toTimeString().slice(0, 8) }), 'axis end').toBeDefined()
  // Past it, each changed track keeps its old drawing on top of the new one
  // while the new one loads, then the old one goes and the new one stays as it was.
  tick = end + 1
  await ui.press({ key: 'ag1' })
  const stacked = await sources()
  expect(stacked, 'old and new layers').toHaveLength(30)
  expect(stacked[3], 'old layer on top').toBe(first[1])
  await clock.advance(700)
  const settled = await sources()
  expect(settled, 'old layers gone').toHaveLength(15)
  expect(settled[1], 'new layer kept').toBe(stacked[2])
  expect(settled[1]).not.toBe(first[1])

  // The hover card's own button opens the card as the cut name does.
  await ui.press({ key: 'ag0-full' })
  expect(await ui.find({ type: 'Text', text: /PostToolUse blocked Contents of/ })).toBeDefined()
  await ui.unmount()

  // The hover card for cut names is drawn on every surface.
  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const other = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 90 }, surface })
    expect(await other.find({ type: 'Text', text: /^Stage 13 correctness review with a long name$/ }), surface).toBeDefined()
    await other.unmount()
  }
})

test('a refused command name does not stop the session start', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ deny: 'it is the user’s command' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.log', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: 'main' }))?.text).toBe('Main session')
  await ui.unmount()
})

test('a timeline an earlier version stored is declined', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('state.get', () => ({ value: { value: { agents: [{ id: 'x' }] }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No activity yet.')
  await ui.unmount()
})

test('credentials in a command are masked before the call is stored', () => {
  expect(brief({ command: 'curl -H "Authorization: Bearer abc.def.ghi123" https://x' })).not.toContain('abc.def')
  expect(brief({ command: 'export OPENAI_API_KEY=sk-proj-1234567890abcdef && run' })).not.toContain('1234567890')
  expect(brief({ command: 'mysql --password=hunter22 db' })).not.toContain('hunter22')
  expect(brief({ command: 'git clone https://me:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r' })).not.toContain('ghp_')
  expect(brief({ command: 'git push origin main' })).toBe('git push origin main')
  expect(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123 here')).toBe('token *** here')
})

test('a draw that fails says why instead of leaving the pane empty', async ($, on) => {
  on('clock.now', () => {
    throw new Error('boom')
  })
  on('state.get', (_, e, next) =>
    e.key === 'timeline' ? { value: { value: { shape: 'timeline-1', value: { agents: [{ id: 'main', spans: [] }], hooks: [] } }, version: 1 } } : next(e),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Draw failed/ }))?.text, surface).toMatch(/^Draw failed \(throw\): /)
    await ui.unmount()
  }
})

test('/clear starts the chart afresh', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'agent-timeline-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn({
    prompt: 'Look around the repo',
    description: 'Survey repo',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    tool_use_id: 'spawn-1',
    background: false,
    fork: false,
  })
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'a1' })).toBeUndefined()
  expect((await ui.find({ key: 'main' }))?.text).toBe('Main session')
  await ui.unmount()
})

test('the open command says why the pane is not shown', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'agent-timeline-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'the terminal is 90 columns, under 110' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ran = await $.command.run({ command: 'agent-timeline-pane', args: '' } as never)
  expect(ran.text).toBe('Agent timeline pane is not shown yet: the terminal is 90 columns, under 110')
})

test('an agent whose permission ask goes unanswered needs attention', async ($, on) => {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('command.register', () => ({ value: { command: 'agent-timeline-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'Deploy', type: 'general-purpose', status: 'running' }] }))
  on('tool.call', () => ({ result: {} }))
  on('tool.check', () => ({ decision: 'ask' }))
  // Stands for the person: answers once the test lets it.
  let answer = () => {}
  const answered = new Promise<void>(resolve => (answer = resolve))
  on('classic.PermissionRequest', async () => {
    await answered
    return { decision: { behavior: 'allow' } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const call = $.tool.call({ tool: 'Bash', command: 'npm publish', agentId: 'a1', tool_use_id: 't1' })
  await clock.advance(1_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The classifier decides most asks within seconds: not yet a person's wait.
  expect(await ui.find({ type: 'Text', text: /Needs attention/ })).toBeUndefined()
  await clock.advance(15_000)
  expect((await ui.find({ type: 'Text', text: /Needs attention/ }))?.text).toBe('⚠ Needs attention: Deploy (waiting for approval)')
  await ui.press({ key: 'a1' })
  expect((await ui.find({ type: 'Text', text: /Bash npm publish/ }))?.text).toMatch(/^\?/)

  answer()
  await call
  await clock.advance(15_000)
  expect(await ui.find({ type: 'Text', text: /Needs attention/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /Bash npm publish/ }))?.text).toMatch(/^✓/)
  await ui.unmount()
})

test('side sessions this one started get rows from their transcripts', async ($, on) => {
  const T0 = 1_700_000_000_000
  const clock = mock.clock(on, { now: T0 })
  const at = (s: number) => new Date(T0 + s * 1000).toISOString()
  const PROJECTS = '/home/u/.claude/projects'
  const OWN = 's1'
  const FRESH = '3f91afa4-54c3-424e-84bf-524dc217e625'
  const FORK = 'a9717fd2-17bf-4767-b7af-5b5c92c0b709'
  const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join('\n')
  const BRIEF = 'Rename the `widget` helper in `src/util.ts`. Done when the tests pass.'
  // As the desktop app writes them: a fresh session in its worktree's folder,
  // its first prompt wrapping the brief; a fork beside this session, opening
  // with a copy of this session's entries.
  const fresh = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: at(2), sessionId: FRESH },
    {
      type: 'user',
      timestamp: at(2),
      sessionId: FRESH,
      turnOrigin: 'host_synthetic',
      message: { content: `<system-reminder>worktree</system-reminder>\n\nBackground (from the session that started this one):\nContext.\n\nTask:\n${BRIEF}` },
    },
    { type: 'custom-title', customTitle: 'Rename widget', sessionId: FRESH },
    {
      type: 'assistant',
      timestamp: at(4),
      sessionId: FRESH,
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_f1', name: 'Bash', input: { command: 'npm test' } }] },
    },
  ]
  const files: Record<string, string> = {
    [`${PROJECTS}/-work/${OWN}.jsonl`]: lines([{ type: 'user', timestamp: at(0), sessionId: OWN, message: { content: 'Hi' } }]),
    [`${PROJECTS}/-work--claude-worktrees-x/${FRESH}.jsonl`]: lines(fresh),
    [`${PROJECTS}/-work/${FORK}.jsonl`]: lines([
      { type: 'user', timestamp: at(-100), sessionId: OWN, message: { content: 'Hi' } },
      {
        type: 'assistant',
        timestamp: at(-90),
        sessionId: OWN,
        message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_parent', name: 'Read', input: { file_path: '/parent.ts' } }] },
      },
      { type: 'custom-title', customTitle: 'Parent title', sessionId: FORK },
      { type: 'user', timestamp: at(3), sessionId: FORK, turnOrigin: 'host_synthetic', message: { content: 'You are a fork. Check the docs.' } },
      { type: 'custom-title', customTitle: 'Check docs', sessionId: FORK },
      { type: 'assistant', timestamp: at(6), sessionId: FORK, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Docs are fine.' }] } },
    ]),
    // Someone else's session, changed meanwhile: no row.
    [`${PROJECTS}/-other/0000aaaa-0000-0000-0000-000000000000.jsonl`]: lines([
      { type: 'user', timestamp: at(2), sessionId: '0000aaaa-0000-0000-0000-000000000000', message: { content: 'Unrelated work' } },
    ]),
  }
  const norm = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
  const stat = (path: string) => ({ kind: 'file' as const, size: files[path]?.length ?? 0, mtimeMs: T0 + 6_000, isLink: false })
  on('command.register', () => ({ value: { command: 'agent-timeline-pane' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: OWN }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: files[norm(e.path)] !== undefined }))
  on('fs.stat', (_, e) => {
    if (files[norm(e.path)] === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: stat(norm(e.path)) }
  })
  on('fs.list', (_, e) => {
    const dir = norm(e.path)
    const below = Object.keys(files).filter(path => path.startsWith(`${dir}/`))
    const names = [...new Set(below.map(path => path.slice(dir.length + 1).split('/')[0] ?? ''))]
    return {
      value: names.map(name =>
        below.includes(`${dir}/${name}`) ? { name, ...stat(`${dir}/${name}`) } : { name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false },
      ),
    }
  })
  on('fs.read', (_, e) => {
    const text = files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  // Stands for the desktop app's session tools.
  on('tool.call', (_, e) => ({
    result: {},
    text: e.tool.endsWith('start_session')
      ? `Started session (session_id: local_${(e as { context?: string }).context === 'fork' ? FORK : '658516cb-2c8c-4126-bb0b-b7154ab55d88'}).`
      : '',
  }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await clock.advance(10)
  const start = (input: object, id: string) =>
    $.tool.call({ tool: 'mcp__ccd_session__start_session', initiation: 'user_asked', tool_use_id: id, ...input } as never)
  await start({ title: 'Rename widget', context: 'fresh', prompt: BRIEF, background: 'Context.' }, 'toolu_s1')
  await start({ title: 'Check docs', context: 'fork', prompt: 'Check the docs.' }, 'toolu_s2')
  await clock.advance(3_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^2 side sessions/ }), 'summary').toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'SIDE SESSIONS' }), 'heading').toBeDefined()
  expect((await ui.find({ key: `session:${FRESH}` }))?.text).toBe('Rename widget')
  expect((await ui.find({ key: `session:${FORK}` }))?.text).toBe('Check docs')
  expect(await ui.find({ key: 'session:0000aaaa-0000-0000-0000-000000000000' }), 'unrelated').toBeUndefined()

  // The fresh session is mid tool call; the fork has answered and waits.
  await ui.press({ key: `session:${FRESH}` })
  expect(await ui.find({ type: 'Text', text: /^Rename widget · Running · side session · .* · 1 call$/ }), 'fresh header').toBeDefined()
  await ui.press({ key: `session:${FORK}` })
  expect(await ui.find({ type: 'Text', text: /^Check docs · Idle · side session \(fork\) · .* · 0 calls$/ }), 'fork header').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Read \/parent.ts/ }), "the parent's copied call").toBeUndefined()
  expect(await ui.find({ type: 'Markdown', text: /Docs are fine\./ }), 'latest reply').toBeDefined()

  // The fresh session's transcript grows: its turn ends.
  files[`${PROJECTS}/-work--claude-worktrees-x/${FRESH}.jsonl`] = lines([
    ...fresh,
    { type: 'user', timestamp: at(20), sessionId: FRESH, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_f1', content: 'ok' }] } },
    { type: 'assistant', timestamp: at(22), sessionId: FRESH, message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Renamed.' }] } },
  ])
  await clock.advance(15_000)
  await ui.press({ key: `session:${FRESH}` })
  expect(await ui.find({ type: 'Text', text: /^Rename widget · Idle · side session · .* · 1 call$/ }), 'fresh idle').toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Bash npm test/ }))?.text).toMatch(/^✓/)
  await ui.unmount()
})

test("a transcript's start says whether it is a side session of this one", () => {
  const head = (...entries: object[]) => entries.map(entry => JSON.stringify(entry)).join('\n')
  const prompt = (sessionId: string, content: string) => ({ type: 'user', sessionId, message: { content } })
  // A fork of this session, and a fork of it when it is itself a fork of g.
  expect(lineageOf(head(prompt('me', 'Hi'), prompt('kid', 'Go')), 'kid', 'me').kind).toBe('fork')
  expect(lineageOf(head(prompt('g', 'Old'), prompt('me', 'Hi'), prompt('kid', 'Go')), 'kid', 'me').kind).toBe('fork')
  // Someone else's fork, and someone else's session.
  expect(lineageOf(head(prompt('g', 'Old'), prompt('kid', 'Go')), 'kid', 'me').kind).toBe('other')
  expect(lineageOf(head(prompt('g', 'Old')), 'kid', 'me').kind).toBe('other')
  // A fresh session: its first prompt, once written.
  expect(lineageOf(head({ type: 'queue-operation', sessionId: 'kid' }), 'kid', 'me').kind).toBe('undecided')
  expect(lineageOf(head({ type: 'queue-operation', sessionId: 'kid' }, prompt('kid', 'Task: do it')), 'kid', 'me')).toEqual({
    kind: 'started',
    firstPrompt: 'Task: do it',
    title: undefined,
  })
})
