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
    expect((await ui.find({ type: 'Text', text: /^1 agent/ }))?.text).toBe('1 agent · 1 done')
    const row = await ui.find({ key: 'a1' })
    expect(row?.text).toMatch(/Survey repo/)
    expect(row?.text).toMatch(/Done · .* · 2 calls · 1 blocked/)
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'a1' })
  expect(await ui.find({ type: 'Text', text: /Bash ls -la/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Write \/x.txt/ }))?.text).toMatch(/^✗/)
  expect(await ui.find({ type: 'Text', text: /PreToolUse hook blocked .*no writes here/ })).toBeDefined()
  expect(await ui.find({ key: 'view-a1' })).toBeDefined()
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
  expect((await ui.find({ key: 'b2' }))?.text).toMatch(/Long build .*Running/)
  await clock.advance(11 * 60_000)
  expect((await ui.find({ key: 'b2' }))?.text).toMatch(/Stalled/)
  expect((await ui.find({ type: 'Text', text: /Needs attention/ }))?.text).toBe('Needs attention: Long build (stalled)')
  await ui.unmount()
})

test('a timeline an earlier version stored is declined', async ($, on) => {
  mock.clock(on, { now: 1_700_000_000_000 })
  on('state.get', () => ({ value: { value: { agents: [{ id: 'x' }] }, version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('No activity yet.')
  await ui.unmount()
})
