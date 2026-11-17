/** One tool call an agent made. `endAt` is unset while it runs. */
export type Call = {
  id: string
  tool: string
  brief: string
  at: number
  endAt?: number
  isError?: boolean
  /** When its permission check answered "ask"; it waits on a decision until `endAt` is set. */
  askedAt?: number
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
  /** What the row leaves out, when its transcript could not be read whole. */
  note?: string
}

/** A desktop side session this one started, linked to its transcript. Its row's id is `session:<id>`. */
export type SideSession = {
  /** The transcript's own session id, its file's name. */
  id: string
  path: string
  isFork: boolean
  /** The transcript's size when last read, so an unchanged one is not read again. */
  size: number
  /** Its subagents' transcripts as `name:size` when last read, comma-separated. */
  agentSizes?: string
}

/** A brief this session handed a side session it started or proposed, matched to the transcript it opens. */
export type Brief = {
  at: number
  title?: string
  prompt?: string
  isFork: boolean
  /** The id the desktop app gave the session (a fork's transcript is named for it). */
  localId?: string
  /** The transcript it was matched to. */
  matched?: string
}

export type Timeline = {
  agents: Agent[]
  sessions?: SideSession[]
  briefs?: Brief[]
  hooks: HookMark[]
  /** Where the chart starts when the main transcript was read from its tail only. */
  since?: number
  /** That transcript's size, for saying what the window covers. */
  transcriptBytes?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-timeline': {
      timeline: Shaped<Timeline>
      now: number
      /** The agent whose details show below the list; '' for none. */
      selected: string
      /** Bumped to redraw once a changed track has had time to load. */
      settle: number
    }
  }
}
