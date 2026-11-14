import { expect, mock, test } from 'claude-code/testing'

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
  on('command.register', () => ({ value: { command: 'timeline' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'a1' }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }))
  // Stands for the person's settings hooks: blocks every Write.
  on('classic.PreToolUse', (_, e) => (e.tool === 'Write' ? { deny: 'no writes here' } : {}))
  on('turn.complete', (_, e) => ({ text: e.answer }))

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
  on('command.register', () => ({ value: { command: 'timeline' } }))
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
  on('command.register', () => ({ value: { command: 'timeline' } }))
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

test('a timeline an earlier version stored is declined', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('state.get', () => ({ value: { value: { agents: [{ id: 'x' }] }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No activity yet.')
  await ui.unmount()
})
