// Rebuilds agents the mod did not see live (from before it loaded, or a
// resumed session) from the transcripts Claude Code writes, as the
// agent-timeline skill reads them. The format is not a documented interface.

import type { Agent, Call, HookMark } from '../types'

export const IDLE_GAP = 600_000 // a silence this long splits busy spans
export const KEEP_CALLS = 20
const BRIEF_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'query', 'title', 'message', 'prompt']
const TOOL_ID = /toolu_[A-Za-z0-9]+/ // a hook's toolUseID can carry a suffix
// How the engine reports a hook that blocked a tool call in the call's result.
const HOOK_ERROR = /^(\w+)(?::\S+)? hook error: ([\s\S]*)$/

// Credentials a command line or URL can carry, masked before a brief is stored.
const SECRETS: [RegExp, string][] = [
  [/\b(authorization:\s*(?:bearer|basic|token)\s+)[^\s"']+/gi, '$1***'],
  [/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/\b(\w*(?:key|token|secret|password|passwd|credential)\w*\s*=\s*)("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1***'],
  [/(--?(?:password|passwd|token|api[-_]?key|secret)[=\s]+)("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1***'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, '$1***@'],
  [/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g, '***'],
]

export function redact(text: string): string {
  return SECRETS.reduce((out, [pattern, to]) => out.replace(pattern, to), text)
}

/** One line saying what a tool call did, e.g. the command or the file it touched; credentials masked. */
export function brief(input: object): string {
  const fields = input as Record<string, unknown>
  for (const key of BRIEF_KEYS) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim()) {
      return redact((value.trim().split('\n')[0] ?? '').replace(/^cd\s+\S+\s*&&\s*/, '')).slice(0, 160)
    }
  }
  return ''
}

/** Busy spans joined where the silence between them is within IDLE_GAP. */
export function mergeSpans(spans: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a - last[1] <= IDLE_GAP) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

type Block = {
  type?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  text?: string
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

type Entry = {
  timestamp?: string
  type?: string
  subtype?: string
  uuid?: string
  toolUseID?: string
  preventedContinuation?: boolean
  stopReason?: string
  message?: { content?: unknown }
  attachment?: {
    type?: string
    hookEvent?: string
    hookName?: string
    toolUseID?: string
    blockingError?: unknown
    content?: unknown
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part && typeof part === 'object' && typeof (part as Block).text === 'string' ? (part as Block).text : ''))
    .join('\n')
}

/** A hook's own record in the transcript: a block or a message it handed the model. */
function hookOf(entry: Entry, at: number, agentId?: string): HookMark | undefined {
  if (entry.type === 'system' && entry.subtype === 'stop_hook_summary' && entry.preventedContinuation) {
    return { at, event: 'Stop', kind: 'blocked', text: entry.stopReason ?? '', agentId }
  }
  const attachment = entry.attachment
  const type = attachment?.type ?? ''
  if (!attachment || !type.startsWith('hook_')) return undefined
  const event = attachment.hookEvent ?? attachment.hookName ?? '?'
  const toolUseId = TOOL_ID.exec(attachment.toolUseID ?? '')?.[0]
  if (type === 'hook_blocking_error') {
    const error = attachment.blockingError
    const text = error && typeof error === 'object' ? String((error as { blockingError?: unknown }).blockingError ?? '') : String(error ?? '')
    return { at, event, kind: 'blocked', text, agentId, toolUseId }
  }
  if (type === 'hook_additional_context' || type === 'hook_system_message') {
    const content = attachment.content
    const text = Array.isArray(content) ? content.join('\n\n') : String(content ?? '')
    return { at, event, kind: 'message', text, agentId, toolUseId }
  }
  return undefined
}

/**
 * One agent's row and hook marks from its transcript's text. `finished`
 * comes from the subagent's meta file; the main session's is left to the
 * live events.
 */
export function parseTranscript(
  text: string,
  base: Pick<Agent, 'id' | 'description' | 'type' | 'parentId'>,
  options: { finished?: boolean; isMain?: boolean } = {},
): { agent: Agent; hooks: HookMark[] } | undefined {
  const times: number[] = []
  const calls = new Map<string, Call>()
  const hooks: HookMark[] = []
  const agentId = options.isMain ? undefined : base.id
  let result: string | undefined
  let lastCleanAt = 0

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: Entry
    try {
      entry = JSON.parse(line) as Entry
    } catch {
      continue // a line still being written
    }
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN
    if (Number.isNaN(at)) continue
    times.push(at)
    const hook = hookOf(entry, at, agentId)
    if (hook) hooks.push(hook)
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Block[]) {
      if (entry.type === 'assistant' && block.type === 'tool_use' && block.id && !calls.has(block.id)) {
        calls.set(block.id, { id: block.id, tool: block.name ?? '?', brief: brief(block.input ?? {}), at })
        if (block.name === 'SubagentHandback') result = String(block.input?.message ?? '').trim() || result
      } else if (entry.type === 'assistant' && block.type === 'text' && block.text?.trim()) {
        result = block.text.trim()
      } else if (entry.type === 'user' && block.type === 'tool_result' && block.tool_use_id) {
        const call = calls.get(block.tool_use_id)
        if (call) {
          call.endAt = at
          call.isError = block.is_error === true
        }
        if (!block.is_error) lastCleanAt = at
        const blocked = block.is_error ? HOOK_ERROR.exec(textOf(block.content)) : null
        if (blocked) hooks.push({ at, event: blocked[1] ?? '?', kind: 'blocked', text: blocked[2] ?? '', agentId, toolUseId: block.tool_use_id })
      }
    }
  }
  const spans = mergeSpans(times.map((t): [number, number] => [t, t]))
  const first = spans[0]
  const last = spans[spans.length - 1]
  if (!first || !last) return undefined
  const all = [...calls.values()].sort((a, b) => a.at - b.at)
  return {
    agent: {
      ...base,
      startedAt: first[0],
      lastAt: last[1],
      ...(options.finished ? { endedAt: last[1], ending: 'answer' as const } : {}),
      lastCleanAt,
      spans,
      calls: all.slice(-KEEP_CALLS),
      callCount: all.length,
      result: result?.slice(0, 4000),
    },
    hooks,
  }
}

/** A row the mod saw live joined with the same agent rebuilt from its transcript. */
export function mergeAgent(live: Agent | undefined, past: Agent, isMain: boolean): Agent {
  if (!live) return past
  const calls = new Map(past.calls.map(c => [c.id, c]))
  for (const c of live.calls) calls.set(c.id, c)
  // A row the mod made for an agent it had not seen spawn has a placeholder name.
  const isPlaceholder = live.description.startsWith('Agent ') && !live.type
  return {
    ...live,
    description: isPlaceholder ? past.description : live.description,
    type: live.type || past.type,
    startedAt: Math.min(live.startedAt, past.startedAt),
    lastAt: Math.max(live.lastAt, past.lastAt),
    lastCleanAt: Math.max(live.lastCleanAt, past.lastCleanAt),
    spans: mergeSpans([...live.spans, ...past.spans]),
    calls: [...calls.values()].sort((a, b) => a.at - b.at).slice(-KEEP_CALLS),
    callCount: Math.max(live.callCount, past.callCount),
    // The main session's state is the live one; a subagent's meta file may know it finished.
    ...(isMain || live.endedAt !== undefined ? {} : { endedAt: past.endedAt, ending: past.ending }),
    result: live.result ?? past.result,
    // The latest read of the transcript says what it could not cover.
    note: past.note ?? live.note,
  }
}

/** Hook marks from a transcript that the live list does not already hold. */
export function newHooks(live: HookMark[], past: HookMark[]): HookMark[] {
  const isSame = (a: HookMark, b: HookMark) =>
    a.event === b.event && (a.toolUseId && b.toolUseId ? a.toolUseId === b.toolUseId : Math.abs(a.at - b.at) < 2000)
  return past.filter(p => !live.some(l => isSame(l, p)))
}
