/**
 * Trajectory-replay state and orchestration: the shared replay store, the
 * host-route replay controller (fork → merge → gate → promote), and the live
 * per-session snapshot sources the comparison pane renders from.
 *
 * The replay child is created host-side (`/api/replay/start`) as an isolated
 * `origin: 'subagent'` session: it never joins a workspace and stays out of
 * the sidebar grouping, visible only to the replay tab. The host gates step
 * mode at `agent/request`; this controller advances (`continue`), rewinds
 * (`undo` = discard + fresh run with one fewer step), stops, promotes the
 * replay into a real workspace session, and exports the trajectory.
 */
import type {
  ConversationSnapshot,
  ISessions,
  ObservableSnapshot,
  SessionFace,
  SessionId,
  SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One checkpoint derived from a trajectory turn: fork anchor + replayed input. */
export interface ReplayCheckpoint {
  /** Turn number this checkpoint belongs to (the turn that gets replayed). */
  readonly turn: number
  /** Source event seq of the replayed user message (display anchor). */
  readonly sourceSeq: number
  /**
   * Fork anchor: a seq inside the previous turn. The host's
   * first-`turn/end`-at-or-after cut therefore ends the child prefix at the
   * previous turn's boundary, so the replayed turn starts from scratch.
   */
  readonly anchorSeq: number
  /** Re-submitted input text for the replayed turn. */
  readonly inputText: string
}

export type ReplayMode = 'auto' | 'step'

export type ReplayPhase = 'idle' | 'starting' | 'running' | 'paused' | 'done' | 'error'

export interface ReplayState {
  readonly phase: ReplayPhase
  readonly originalId: SessionId | null
  readonly childId: SessionId | null
  readonly checkpoint: ReplayCheckpoint | null
  readonly mode: ReplayMode
  /** Step-mode target: executed steps before the next gate pause. */
  readonly stopAt: number
  /** Executed (admitted) steps of the replayed turn so far. */
  readonly executedSteps: number
  /** Whether the pre-checkpoint history was merged (host compaction). */
  readonly merge: boolean
  readonly error?: string
}

export const EMPTY_REPLAY_STATE: ReplayState = {
  phase: 'idle',
  originalId: null,
  childId: null,
  checkpoint: null,
  mode: 'auto',
  stopAt: 0,
  executedSteps: 0,
  merge: true,
}

export interface ReplayStartOptions {
  readonly mode: ReplayMode
  readonly stopAt?: number
  readonly merge?: boolean
}

/** Minimal sessions face the controller and sources need (ISessions' public surface). */
export interface ReplaySessions {
  open(id: SessionId): void
  binding(id: SessionId): { readonly session: SessionFace | undefined } | undefined
  list: ObservableSnapshot<{ byId: Readonly<Record<string, unknown>> }>
}

/** Wire reply of one replay route. */
interface ReplayReply {
  ok: boolean
  error?: string
  childId?: string
  sessionId?: string
}

/** POST one replay route with a JSON body (same-origin; the webserver serves both). */
async function replayCall(path: string, body: Record<string, unknown>): Promise<ReplayReply> {
  let response: Response
  try {
    response = await fetch(`/api/replay/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (error) {
    return { ok: false, error: `replay request failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  let payload: ReplayReply
  try {
    payload = await response.json() as ReplayReply
  } catch {
    payload = { ok: false }
  }
  if (!response.ok || payload.ok === false) {
    return { ok: false, error: payload.error ?? `HTTP ${response.status}` }
  }
  return payload
}

/**
 * Live snapshot source for one replay-relevant session. Resolves the target
 * id from the shared replay store, re-binds when the store or the session
 * roster changes, and re-emits whenever the bound Session's snapshot moves.
 */
class ReplaySessionSource implements ObservableSnapshot<ConversationSnapshot | null> {
  private readonly listeners = new Set<() => void>()
  private detachSession: (() => void) | null = null
  private detachStore: (() => void) | null = null

  constructor(
    private readonly sessions: ReplaySessions,
    private readonly state: SnapshotStore<ReplayState>,
    private readonly resolveId: () => SessionId | null,
  ) {}

  getSnapshot(): ConversationSnapshot | null {
    const id = this.resolveId()
    if (id === null) return null
    return this.sessions.binding(id)?.session?.getSnapshot() ?? null
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    if (this.listeners.size === 1) this.attach()
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.detach()
    }
  }

  dispose(): void {
    this.detach()
    this.listeners.clear()
  }

  private attach(): void {
    const unlist = this.sessions.list.subscribe(() => this.rebind())
    const unstate = this.state.subscribe(() => this.rebind())
    this.detachStore = () => {
      unlist()
      unstate()
    }
    this.rebind()
  }

  private detach(): void {
    this.detachStore?.()
    this.detachStore = null
    this.detachSession?.()
    this.detachSession = null
  }

  private rebind(): void {
    this.detachSession?.()
    this.detachSession = null
    const id = this.resolveId()
    const session = id === null ? undefined : this.sessions.binding(id)?.session
    if (session !== undefined) {
      this.detachSession = session.subscribe(() => this.emit())
    }
    this.emit()
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn()
      } catch (error) {
        console.error('trajectory-replay source subscriber failed:', error)
      }
    }
  }
}

/** Derive the run phase + executed-step count from the child's live snapshot. */
function deriveRun(
  snapshot: ConversationSnapshot | null,
  checkpoint: ReplayCheckpoint | null,
  mode: ReplayMode,
  stopAt: number,
  sawRunning: boolean,
  started: boolean,
): { phase: ReplayPhase; executedSteps: number } {
  if (snapshot === null || checkpoint === null) {
    return { phase: started ? 'starting' : 'idle', executedSteps: 0 }
  }
  const inspection = snapshot.views.get('trajectory')
  const requests = inspection?.requests ?? []
  const turnRequests = requests.filter(
    (request) => request.purpose === 'assistant' && request.turn === checkpoint.turn,
  )
  const executedSteps = turnRequests.length
  const running = snapshot.running === true
  const last = turnRequests[turnRequests.length - 1]
  const lastSettled = last === undefined || last.status === 'complete' || last.status === 'error'
  if (!running) {
    // Idle before the driver starts (or after a stop/cancel): only report
    // 'done' once work actually ran.
    return {
      phase: executedSteps > 0 || sawRunning ? 'done' : (started ? 'starting' : 'idle'),
      executedSteps,
    }
  }
  if (mode === 'step' && executedSteps >= stopAt && lastSettled) {
    return { phase: 'paused', executedSteps }
  }
  return { phase: 'running', executedSteps }
}

/**
 * The replay controller: owns the shared state store, the two snapshot
 * sources, and the host-route orchestration for one replay run.
 */
export class ReplayController {
  readonly state: SnapshotStore<ReplayState>
  readonly child: ObservableSnapshot<ConversationSnapshot | null>
  readonly original: ObservableSnapshot<ConversationSnapshot | null>

  private readonly childSource: ReplaySessionSource
  private readonly originalSource: ReplaySessionSource
  private started = false
  private sawRunning = false

  constructor(private readonly sessions: ReplaySessions) {
    this.state = createSnapshotStore<ReplayState>(EMPTY_REPLAY_STATE)
    this.childSource = new ReplaySessionSource(
      this.sessions,
      this.state,
      () => this.state.getSnapshot().childId,
    )
    this.originalSource = new ReplaySessionSource(
      this.sessions,
      this.state,
      () => this.state.getSnapshot().originalId,
    )
    this.child = this.childSource
    this.original = this.originalSource
    // Watch the child snapshot and fold the live run phase into the store.
    this.child.subscribe(() => this.derive())
  }

  dispose(): void {
    this.childSource.dispose()
    this.originalSource.dispose()
  }

  /** Fold the child's latest snapshot into the shared state (no-op when unchanged). */
  private derive(): void {
    const current = this.state.getSnapshot()
    const snapshot = this.childSource.getSnapshot()
    const derived = deriveRun(
      snapshot,
      current.checkpoint,
      current.mode,
      current.stopAt,
      this.sawRunning,
      this.started,
    )
    if (snapshot?.running === true) this.sawRunning = true
    if (
      derived.phase === current.phase
      && derived.executedSteps === current.executedSteps
    ) {
      return
    }
    this.state.set({
      ...current,
      phase: derived.phase,
      executedSteps: derived.executedSteps,
    })
  }

  /**
   * Start a replay run: the host forks an isolated child from the checkpoint
   * (merging the pre-checkpoint history when requested), submits the replayed
   * input, and gates step mode after `stopAt` executed steps.
   * @param originalId - session whose trajectory carries the checkpoint.
   * @param checkpoint - derived replay checkpoint.
   * @param options - mode (auto runs to completion; step pauses), stopAt, merge.
   */
  async start(
    originalId: SessionId,
    checkpoint: ReplayCheckpoint,
    options: ReplayStartOptions,
  ): Promise<void> {
    const mode = options.mode
    const stopAt = mode === 'step' ? Math.max(1, options.stopAt ?? 1) : 1
    const merge = options.merge !== false
    this.started = true
    this.sawRunning = false
    this.state.set({
      phase: 'starting',
      originalId,
      childId: null,
      checkpoint,
      mode,
      stopAt,
      executedSteps: 0,
      merge,
    })
    try {
      const reply = await replayCall('start', {
        originalId,
        anchorSeq: checkpoint.anchorSeq,
        inputText: checkpoint.inputText,
        mode,
        stopAt,
        merge,
      })
      if (!reply.ok || reply.childId === undefined) {
        this.state.set({
          ...this.state.getSnapshot(),
          phase: 'error',
          error: reply.error ?? 'replay start failed',
        })
        return
      }
      this.state.set({
        ...this.state.getSnapshot(),
        childId: reply.childId as SessionId,
      })
    } catch (error) {
      this.state.set({
        ...this.state.getSnapshot(),
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Advance one step in step mode: release the host gate and raise the target. */
  async continueStep(): Promise<void> {
    const current = this.state.getSnapshot()
    if (current.phase !== 'paused' || current.childId === null) return
    const reply = await replayCall('control', { childId: current.childId, action: 'continue' })
    if (!reply.ok) {
      this.state.set({ ...current, phase: 'error', error: reply.error ?? 'continue failed' })
      return
    }
    this.state.set({ ...current, stopAt: current.stopAt + 1 })
  }

  /**
   * Rewind one executed step: cancel + discard the current child, then start a
   * fresh run that re-executes the prefix automatically and pauses one step
   * earlier. The pre-checkpoint prefix re-runs (side effects repeat) — the
   * honest cost of an append-only replay log.
   */
  async undoStep(): Promise<void> {
    const current = this.state.getSnapshot()
    if (current.phase !== 'paused' || current.childId === null || current.executedSteps <= 0) return
    const executed = current.executedSteps
    const checkpoint = current.checkpoint
    const originalId = current.originalId
    const merge = current.merge
    await replayCall('control', { childId: current.childId, action: 'undo' })
    await this.discard()
    const target = Math.max(1, executed - 1)
    if (checkpoint !== null && originalId !== null) {
      await this.start(originalId, checkpoint, { mode: 'step', stopAt: target, merge })
    }
  }

  /** Stop the current run: cancel the agent, keep the child for promote/export. */
  async stop(): Promise<void> {
    const current = this.state.getSnapshot()
    if (current.childId === null || current.phase === 'idle') return
    await replayCall('control', { childId: current.childId, action: 'stop' })
  }

  /** Discard the child and reset to idle. */
  async discard(): Promise<void> {
    const childId = this.state.getSnapshot().childId
    this.started = false
    this.sawRunning = false
    this.state.set(EMPTY_REPLAY_STATE)
    if (childId !== null) {
      await replayCall('discard', { childId })
    }
  }

  /** Reset back to the checkpoint picker. */
  reset(): void {
    void this.discard()
  }

  /**
   * Export the replay as a real workspace session (the "放到工作区" action):
   * the host copies the child's log into a normal session attached to the
   * original's workspace. Opens the exported session on success.
   * @returns the exported session id, or null on failure.
   */
  async promote(): Promise<SessionId | null> {
    const current = this.state.getSnapshot()
    if (current.childId === null) return null
    const reply = await replayCall('promote', { childId: current.childId })
    if (!reply.ok || reply.sessionId === undefined) {
      this.state.set({ ...current, phase: 'error', error: reply.error ?? 'promote failed' })
      return null
    }
    const sessionId = reply.sessionId as SessionId
    this.sessions.open(sessionId)
    return sessionId
  }
}

/** Narrow the sessions service to the replay face. */
export function replaySessions(sessions: ISessions): ReplaySessions {
  return {
    open: id => sessions.open(id),
    binding: id => sessions.binding(id),
    list: sessions.list,
  }
}

/** One rendered step-ledger row (assistant + its tool calls + results). */
export interface StepLedgerRow {
  readonly turn: number
  readonly step: number
  readonly assistantText: string
  readonly toolCalls: readonly { name: string; args: string; result: string; isError: boolean }[]
  readonly status: string | undefined
}

const EMPTY_ROWS: readonly StepLedgerRow[] = []

/**
 * Build the step ledger for the replayed turn from the child's trajectory
 * inspection: one row per executed step with the assistant text and its tool
 * calls (arguments + result snippets).
 * @param snapshot - child conversation snapshot.
 * @param turn - the replayed turn number.
 * @returns ledger rows in step order.
 */
export function deriveStepLedger(
  snapshot: ConversationSnapshot | null,
  turn: number,
): readonly StepLedgerRow[] {
  const inspection = snapshot?.views.get('trajectory')
  const nodes = inspection?.eventNodes ?? EMPTY_ROWS
  const locations = inspection?.eventLocations
  const requests = inspection?.requests ?? EMPTY_ROWS
  if (locations === undefined) return EMPTY_ROWS

  type LedgerAccumulator = Map<number, {
    assistantText: string
    toolCalls: { name: string; args: string; result: string; isError: boolean }[]
    status: string | undefined
  }>
  const byStep: LedgerAccumulator = new Map()

  for (const request of requests) {
    if (request.purpose !== 'assistant' || request.turn !== turn) continue
    const row = byStep.get(request.step) ?? { assistantText: '', toolCalls: [], status: undefined }
    row.status = request.status
    byStep.set(request.step, row)
  }
  for (const node of nodes) {
    const location = locations.get(node.seq)
    const step = location?.kind === 'step' && location.turn.turn === turn ? location.step.step
      : location?.kind === 'turn' && location.turn.turn === turn ? undefined
        : undefined
    if (step === undefined) continue
    const row = byStep.get(step) ?? { assistantText: '', toolCalls: [], status: undefined }
    if (node.kind === 'assistant') {
      const text = (node.blocks ?? [])
        .filter((block) => block.kind === 'text' && typeof (block as { text?: unknown }).text === 'string')
        .map((block) => (block as { text: string }).text)
        .join('\n')
      row.assistantText = text
      for (const block of node.blocks) {
        if (block.kind !== 'tool-call') continue
        const call = block as { name?: string; argsRaw?: string }
        row.toolCalls.push({
          name: call.name ?? '?',
          args: call.argsRaw ?? '',
          result: '',
          isError: false,
        })
      }
    } else if (node.kind === 'tool-result') {
      const text = (node.content ?? [])
        .filter((block) => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
        .map((block) => (block as { text: string }).text)
        .join('\n')
      const resultRow = [...row.toolCalls].reverse().find(call => call.name !== '' && call.result === '')
      if (resultRow !== undefined) {
        resultRow.result = text
        resultRow.isError = node.isError === true
      } else {
        row.toolCalls.push({
          name: node.call?.name ?? '(result)',
          args: node.call?.argsRaw ?? '',
          result: text,
          isError: node.isError === true,
        })
      }
    }
    byStep.set(step, row)
  }
  return [...byStep.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([step, row]) => ({ turn, step, assistantText: row.assistantText, toolCalls: row.toolCalls, status: row.status }))
}

/**
 * Build a Markdown export of the replay: checkpoint facts plus the replayed
 * turn's steps (assistant text, tool calls, results) from the child run.
 * @param state - current replay state.
 * @param childSnapshot - child conversation snapshot.
 * @param originalSnapshot - original conversation snapshot (title/context).
 * @returns the Markdown document.
 */
export function buildTrajectoryMarkdown(
  state: ReplayState,
  childSnapshot: ConversationSnapshot | null,
  originalSnapshot: ConversationSnapshot | null,
): string {
  const checkpoint = state.checkpoint
  const lines: string[] = []
  lines.push('# 轨迹重放导出', '')
  lines.push(`- 原始会话: \`${state.originalId ?? '—'}\``)
  lines.push(`- 重放会话: \`${state.childId ?? '—'}\``)
  lines.push(`- 模式: ${state.mode === 'step' ? '单步' : '自动'}`)
  lines.push(`- 已执行步骤: ${state.executedSteps}`)
  if (state.mode === 'step') lines.push(`- 目标步骤: ${state.stopAt}`)
  lines.push(`- 合并检查点之前: ${state.merge ? '是' : '否'}`)
  if (checkpoint !== null) {
    lines.push(`- checkpoint: Turn ${checkpoint.turn}（源 seq ${checkpoint.sourceSeq}，锚点 seq ${checkpoint.anchorSeq}）`)
    lines.push('', '## 重放输入', '', '```text', checkpoint.inputText, '```')
  }
  const originalTitle = originalSnapshot?.title ?? ''
  if (originalTitle !== '') lines.push('', `> 来源会话标题: ${originalTitle}`)
  lines.push('', '## 重放执行')
  const rows = checkpoint === null ? [] : deriveStepLedger(childSnapshot, checkpoint.turn)
  if (rows.length === 0) {
    lines.push('', '_（尚无已执行步骤）_')
  }
  for (const row of rows) {
    lines.push('', `### Step ${row.step}${row.status === undefined ? '' : `（${row.status}）`}`)
    if (row.assistantText !== '') {
      lines.push('', '```text', row.assistantText, '```')
    }
    for (const call of row.toolCalls) {
      lines.push('', `**工具调用: \`${call.name}\`**${call.isError ? '（错误）' : ''}`)
      if (call.args !== '') {
        lines.push('', '```json', call.args, '```')
      }
      if (call.result !== '') {
        lines.push('', '```text', call.result, '```')
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}
