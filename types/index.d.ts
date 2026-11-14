/** One tool call an agent made. `endAt` is unset while it runs. */
export type Call = {
  id: string
  tool: string
  brief: string
  at: number
  endAt?: number
  isError?: boolean
}

/** A settings hook that blocked something or handed the model a message. */
export type HookMark = {
  at: number
  event: string
  kind: 'blocked' | 'message'
  text: string
  /** Set for subagents; PreToolUse marks find their agent by `toolUseId`. */
  agentId?: string
  toolUseId?: string
}

/** One row: the main session (id `main`) or a subagent. */
export type Agent = {
  id: string
  description: string
  type: string
  parentId?: string
  startedAt: number
  /** Set when its latest turn ended; cleared when a new turn starts. */
  endedAt?: number
  ending?: 'answer' | 'aborted' | 'refusal' | 'error'
  lastAt: number
  /** When a tool call last finished without an error or a deny. */
  lastCleanAt: number
  /** Busy spans as [start, end], split by gaps longer than IDLE_GAP. */
  spans: [number, number][]
  calls: Call[]
  callCount: number
  result?: string
}

export type Timeline = { agents: Agent[]; hooks: HookMark[] }

declare module 'claude-code' {
  interface PluginState {
    'agent-timeline': {
      timeline: Shaped<Timeline>
      now: number
      /** The agent whose details show below the list; '' for none. */
      selected: string
      /** The chart's window: the subagents' activity, the whole session, or the last 30 minutes. */
      zoom: 'agents' | 'session' | 'recent'
    }
  }
}
