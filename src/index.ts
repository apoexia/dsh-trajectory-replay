/**
 * Host half of the trajectory-replay bundle.
 *
 * Owns the replay machinery that the browser cannot express through the
 * standard RPC surface:
 *
 * - **Isolated replay children**: `ctx.agents.create` with `origin: 'subagent'`
 *   keeps the child out of the workspace/sidebar grouping while remaining
 *   visible to the replay tab's binding. The child is never attached to a
 *   workspace; only the explicit "export as session" action materializes a
 *   real workspace session from it.
 * - **Checkpoint merge**: `ctx.compaction.compactRegion` over the surface
 *   before the replay anchor collapses the pre-checkpoint history into one
 *   summary node, so the replayed turn starts from a merged context.
 * - **Step gating**: an `agent/request` waterfall listener pauses the child
 *   between steps in step mode (`stopAt` executed steps, then wait); the
 *   client resumes with `continue`, rewinds by discarding + re-running from
 *   the checkpoint, or stops by cancelling the agent.
 *
 * Wire: four exact HTTP routes under `/api/replay/*` (the webserver matches
 * exact routes before the connection plugin's `/api` prefix, and the browser
 * is same-origin). All state lives in a process-local registry keyed by the
 * child session id.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: pull the Context merge declarations (webServer / agentDefaultModel).
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-agent-default-model'

export const name = 'dsh-trajectory-replay'

/** Services the host half needs unconditionally. */
export const inject = ['agents', 'sessions', 'webServer', 'agentDefaultModel']

/**
 * Model-visible context carrier that opens the continuation turn of a record
 * replay. The agent driver requires an inbox message to start a turn, so a
 * record replay submits this neutral plugin-source context message (rendered
 * as a context row, exactly like the harness's own injected context) — the
 * model request then derives from the seeded log and re-generates the chosen
 * record and everything after it.
 */
const CONTINUATION_CONTEXT_TEXT = '（轨迹重放：从该记录点继续执行）'

/** A resolved gate: the client's `continue` control releases it. */
interface PendingGate {
  resolve: () => void
}

/** One in-flight replay run. */
interface ReplayEntry {
  /** The hidden replay child session/agent id. */
  readonly childId: SessionId
  /** The session whose trajectory is being replayed. */
  readonly originalId: SessionId
  /** Consumer teardown capability for the child agent. */
  readonly handle: AgentHandle
  /** 'auto' runs the replayed turn to completion; 'step' pauses at stopAt. */
  mode: 'auto' | 'step'
  /** Number of replayed steps to execute before pausing (step mode). */
  stopAt: number
  /** Pending step gate, present while the child waits before the next request. */
  gate: PendingGate | null
}

/** Event envelope of one appended session event. */
interface SessionEventEnvelope {
  seq: number
  time: number
  type: string
  data: unknown
}

const MAX_BODY_BYTES = 1024 * 1024

/** Read and parse a JSON request body, bounded to MAX_BODY_BYTES. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/** Write a JSON response. */
function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Resolve the fork cut for an anchor: the first turn/end at-or-after the anchor, then the next turn/start. */
function forkCut(events: readonly SessionEvent[], anchorSeq: number): number {
  // anchorSeq 0 = replay the first turn from an empty prefix (no prior turn
  // to cut at): the child seed is empty and the replayed input starts turn 1.
  if (anchorSeq <= 0) return 0
  const boundary = events.find((event) => event.type === 'turn/end' && event.seq >= anchorSeq)
  if (boundary === undefined) return -1
  let cut = boundary.seq + 1
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut++
  return cut
}

/** Count completed steps of the child's current (last) turn. */
function replayedSteps(session: Session): number {
  let lastTurn = 0
  let count = 0
  for (const event of session.events) {
    if (event.type === 'turn/start') {
      lastTurn = (event.data as { turn: number }).turn
      count = 0
    } else if (event.type === 'step/end' && (event.data as { turn: number }).turn === lastTurn) {
      count++
    }
  }
  return count
}

/** The provider/model route the child should run with: the source's logged selection when present. */
function selectionForSource(source: Session, fallback: { provider: string; model: string }): {
  provider: string
  model: string
  reasoningEffort?: string
} {
  const logged = source.requestHeader()?.config
  if (logged === undefined) return fallback
  return {
    provider: logged.provider,
    model: logged.model,
    ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
  }
}

/**
 * Build the child's creation meta + setup from the source session's composition
 * (agent preset), mirroring the host `session.fork` path.
 */
function compositionFor(
  ctx: Context,
  source: Session,
): Promise<{ agentPreset?: string; setup: (agentCtx: Context & { agent?: Agent }) => Promise<void> }> {
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    return Promise.resolve({ setup: () => Promise.resolve() })
  }
  const presetId = resolveSessionPreset({ header: source.header, events: source.events })
  return presets.resolve(presetId).then((resolved: { id: string }) => ({
    agentPreset: resolved.id,
    setup: async (agentCtx: Context & { agent?: Agent }) => {
      await presets.mount(agentCtx, resolved.id)
    },
  }))
}

/** One process-local registry of replay runs. */
class ReplayRegistry {
  private readonly entries = new Map<SessionId, ReplayEntry>()

  get(childId: SessionId): ReplayEntry | undefined {
    return this.entries.get(childId)
  }

  set(entry: ReplayEntry): void {
    this.entries.set(entry.childId, entry)
  }

  delete(childId: SessionId): boolean {
    return this.entries.delete(childId)
  }

  ids(): SessionId[] {
    return [...this.entries.keys()]
  }
}

/**
 * Client plugin body: register the replay HTTP routes and the step gate.
 * @param ctx - host root context.
 */
export function apply(ctx: Context): void {
  const registry = new ReplayRegistry()
  // webServer.register returns a caller-owned disposer (routes do not unwind
  // with the fiber), so keep every disposer and release the routes on teardown
  // — otherwise a hot reload leaves stale routes and the next apply throws
  // duplicate-path.
  const routeDisposers: Array<() => void> = []

  /** Dispose one run: stop the agent, drop the registry entry, and remove the
   *  persisted artifact so discarded replay children do not linger as cold
   *  sessions (the persistence seam has no deletion API; this is out-of-band
   *  best-effort cleanup of the child's own transcript). */
  const disposeRun = async (childId: SessionId): Promise<void> => {
    const entry = registry.get(childId)
    if (entry === undefined) return
    registry.delete(childId)
    await entry.handle.dispose()
    try {
      const persistence = ctx.get('sessionPersistence')
      if (persistence !== undefined) {
        const location = persistence.locate(entry.handle.agent.session.header)
        if (location !== undefined && location.kind === 'jsonl') {
          await rm(location.path, { force: true })
          await rm(dirname(location.path), { recursive: true, force: true })
        }
      }
    } catch (error) {
      ctx.logger.warn(`dsh-trajectory-replay: replay artifact cleanup failed for "${childId}": ${String(error)}`)
    }
  }

  ctx.effect(() => () => {
    for (const dispose of routeDisposers.splice(0)) {
      try { dispose() } catch (error) { ctx.logger.warn(`dsh-trajectory-replay: route dispose failed: ${String(error)}`) }
    }
    void Promise.allSettled(registry.ids().map((childId) => disposeRun(childId)))
  }, 'dsh-trajectory-replay: dispose runs')

  /** Resolve the live source session for a replay/promote request. */
  const sourceSession = (originalId: unknown): Session | undefined => {
    if (typeof originalId !== 'string') return undefined
    return ctx.sessions.get(SessionId(originalId))
  }

  const jsonError = (res: ServerResponse, status: number, message: string): void => {
    respond(res, status, { ok: false, error: message })
  }

  // ---- POST /api/replay/start -----------------------------------------
  routeDisposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/api/replay/start',
    handler: async (req, res) => {
      let body: Record<string, unknown>
      try {
        const parsed = await readJsonBody(req)
        body = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
      } catch (error) {
        jsonError(res, 400, error instanceof Error ? error.message : String(error))
        return
      }
      const source = sourceSession(body.originalId)
      if (source === undefined) {
        jsonError(res, 404, 'source session is not attached')
        return
      }
      // 'turn' replays fork at a previous turn's boundary and re-submit the
      // turn's user input; 'message'/'tool' replays cut before the record's
      // step and continue the conversation from the log via a context carrier.
      const kind = body.kind === 'message' || body.kind === 'tool' ? body.kind : 'turn'
      const recordTurn = typeof body.turn === 'number' && Number.isSafeInteger(body.turn) && body.turn >= 1 ? body.turn : -1
      const recordStep = typeof body.step === 'number' && Number.isSafeInteger(body.step) && body.step >= 1 ? body.step : -1
      const anchorSeq = typeof body.anchorSeq === 'number' && Number.isSafeInteger(body.anchorSeq) && body.anchorSeq >= 0 ? body.anchorSeq : -1
      const inputText = typeof body.inputText === 'string' && body.inputText.trim() !== '' ? body.inputText : ''
      if (kind === 'turn') {
        if (anchorSeq < 0 || inputText === '') {
          jsonError(res, 400, 'anchorSeq (non-negative integer) and inputText (non-empty) are required for turn replays')
          return
        }
      } else if (recordTurn < 1 || recordStep < 2) {
        jsonError(res, 400, 'record replays require turn (≥ 1) and step (≥ 2) — step 1 records replay as the turn checkpoint')
        return
      }
      const mode = body.mode === 'step' ? 'step' : 'auto'
      const requestedStop = typeof body.stopAt === 'number' && Number.isSafeInteger(body.stopAt) && body.stopAt >= 1 ? body.stopAt : 1
      const merge = body.merge !== false

      // Dispose any previous run before starting a new one.
      for (const childId of registry.ids()) {
        await disposeRun(childId)
      }

      // A record replay cuts before the record's step (the model re-decides
      // that assistant message / tool call and everything after) and closes
      // the source turn with a synthetic interrupted closer, so the seed
      // stays valid for the session validator; the child then continues the
      // conversation from the log via a plugin-source context carrier (no
      // re-submitted user input). Step-1 records are the turn's own
      // checkpoint, not forkable here — the client maps them to the turn
      // replay.
      const recordReplay = kind !== 'turn'
      let cut: number
      let replayedTurn: number
      let seed: readonly SessionEvent[]
      if (recordReplay) {
        const startIndex = source.events.findIndex((event) =>
          event.type === 'step/start'
          && (event.data as { turn: number }).turn === recordTurn
          && (event.data as { turn: number; step: number }).step === recordStep)
        if (startIndex <= 0) {
          jsonError(res, 409, `step ${recordStep} of turn ${recordTurn} is not in the source log; cannot fork`)
          return
        }
        cut = startIndex
        const last = source.events[cut - 1]!
        seed = [
          ...source.events.slice(0, cut),
          {
            type: 'turn/end',
            seq: last.seq + 1,
            time: Date.now(),
            data: { turn: recordTurn, reason: { kind: 'interrupted' } },
          },
        ]
        replayedTurn = recordTurn + 1
      } else {
        cut = forkCut(source.events, anchorSeq)
        if (cut < 0) {
          jsonError(res, 409, 'the anchor does not fall in a completed turn; cannot fork')
          return
        }
        seed = source.events.slice(0, cut)
        replayedTurn = cut < source.events.length
          ? (source.events[cut]?.data as { turn: number }).turn
          : 1
      }
      const defaultSelection = ctx.agentDefaultModel.currentSelection()
      const agentOptions = selectionForSource(source, defaultSelection)
      let composition
      try {
        composition = await compositionFor(ctx, source)
      } catch (error) {
        jsonError(res, 500, `failed to resolve the source composition: ${error instanceof Error ? error.message : String(error)}`)
        return
      }

      const childId = SessionId(`replay-${randomUUID()}`)
      let handle: AgentHandle
      try {
        handle = await ctx.agents.create({
          sessionId: childId,
          seed,
          meta: {
            ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
            seedLength: seed.length,
            // 'subagent' hides the child from workspace/sidebar grouping while
            // keeping it in the list mirror (bindings + live frames work).
            origin: 'subagent',
            ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
          },
          agentOptions,
          setup: composition.setup,
        })
      } catch (error) {
        jsonError(res, 500, `failed to fork the replay session: ${error instanceof Error ? error.message : String(error)}`)
        return
      }

      // Merge the pre-checkpoint history into one summary node (best-effort).
      // Record replays skip it: their prefix ends mid-turn, which the
      // compaction region fold does not close cleanly.
      if (merge && !recordReplay) {
        const compaction = ctx.get('compaction')
        if (compaction !== undefined) {
          try {
            const prefix = handle.agent.session.surface.nodes.filter((seq) => seq < cut)
            if (prefix.length > 1) {
              await compaction.compactRegion(prefix[0], prefix[prefix.length - 1], {
                session: handle.agent.session,
                options: agentOptions,
              })
            }
          } catch (error) {
            ctx.logger.warn(`dsh-trajectory-replay: checkpoint merge failed, replay continues unmerged: ${String(error)}`)
          }
        }
      }

      registry.set({
        childId,
        originalId: source.id,
        handle,
        mode,
        stopAt: mode === 'step' ? requestedStop : Number.POSITIVE_INFINITY,
        gate: null,
      })

      // A turn replay re-submits the turn's user input. A record replay
      // continues the seeded log instead: the driver needs an inbox message
      // to open its next turn, so we submit a neutral plugin-source context
      // carrier — the model request then derives from the seeded history and
      // re-generates the chosen record and everything after it. The gate,
      // registered above, pauses before the second request onward.
      handle.agent.followup(createUserMessage(recordReplay
        ? {
          content: [{ type: 'text', text: CONTINUATION_CONTEXT_TEXT }],
          source: { kind: 'plugin', plugin: name },
        }
        : {
          content: [{ type: 'text', text: inputText }],
          source: { kind: 'user' },
        }))

      respond(res, 200, { ok: true, childId, replayedTurn })
    },
  }))

  // ---- POST /api/replay/checkpoints ------------------------------------
  // Derive the FULL replay checkpoint list from the source session's complete
  // event log. The browser window is paged, so client-side derivation only
  // sees the loaded tail; the host log is the complete authority, and this
  // route lets the replay picker list every replayable turn/record.
  routeDisposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/api/replay/checkpoints',
    handler: async (req, res) => {
      let body: Record<string, unknown>
      try {
        const parsed = await readJsonBody(req)
        body = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
      } catch (error) {
        jsonError(res, 400, error instanceof Error ? error.message : String(error))
        return
      }
      const source = sourceSession(body.originalId)
      if (source === undefined) {
        jsonError(res, 404, 'source session is not attached')
        return
      }
      const events = source.events
      const turnEnds = new Map<number, number>()
      const callNames = new Map<string, string>()
      let currentTurn = 0
      const inputByTurn = new Map<number, { sourceSeq: number; inputText: string }>()
      // One record per (turn, step): every record inside a step shares the
      // same fork cut (before step/start), so the picker folds a step's
      // assistant message + tool calls into a single entry.
      const steps = new Map<string, {
        turn: number
        step: number
        messageSeq?: number
        messageLabel?: string
        toolSeq?: number
        toolNames: string[]
        callId?: string
      }>()
      const stepKey = (turn: number, step: number): string => `${turn}\u0000${step}`
      const textOf = (blocks: readonly { type?: string; text?: string }[] | undefined): string =>
        (blocks ?? [])
          .filter((block): block is { type: string; text: string } =>
            block.type === 'text' && typeof block.text === 'string' && block.text !== '')
          .map(block => block.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      for (const event of events) {
        if (event.type === 'turn/start') {
          currentTurn = (event.data as { turn: number }).turn
        } else if (event.type === 'turn/end') {
          turnEnds.set((event.data as { turn: number }).turn, event.seq)
        } else if (event.type === 'user/message') {
          const text = textOf((event.data as { content?: readonly { type?: string; text?: string }[] }).content)
          if (text !== '' && currentTurn > 0 && !inputByTurn.has(currentTurn)) {
            inputByTurn.set(currentTurn, { sourceSeq: event.seq, inputText: text })
          }
        } else if (event.type === 'assistant/message') {
          const data = event.data as {
            turn: number
            step: number
            message?: { content?: readonly { type?: string; text?: string }[] }
          }
          const entry = steps.get(stepKey(data.turn, data.step))
            ?? { turn: data.turn, step: data.step, toolNames: [] }
          entry.messageSeq = event.seq
          const text = textOf(data.message?.content).slice(0, 60)
          if (entry.messageLabel === undefined && text !== '') entry.messageLabel = text
          steps.set(stepKey(data.turn, data.step), entry)
        } else if (event.type === 'tool/call') {
          const data = event.data as { callId?: string; name?: string }
          if (data.callId !== undefined && data.name !== undefined) {
            callNames.set(data.callId, data.name)
          }
        } else if (event.type === 'tool/result') {
          const data = event.data as {
            turn: number
            step: number
            message?: { source?: { callId?: string }; content?: readonly { type?: string; text?: string }[] }
          }
          const entry = steps.get(stepKey(data.turn, data.step))
            ?? { turn: data.turn, step: data.step, toolNames: [] }
          entry.toolSeq ??= event.seq
          const callId = data.message?.source?.callId
          entry.callId ??= callId
          const name = callId === undefined ? undefined : callNames.get(callId)
          if (name !== undefined && !entry.toolNames.includes(name)) entry.toolNames.push(name)
          steps.set(stepKey(data.turn, data.step), entry)
        }
      }
      const records: Array<{
        kind: 'message' | 'tool'
        turn: number
        step: number
        sourceSeq: number
        callId?: string
        label?: string
      }> = []
      for (const entry of [...steps.values()].sort((left, right) =>
        left.turn - right.turn || left.step - right.step)) {
        if (entry.step < 2 || (entry.turn !== 1 && !turnEnds.has(entry.turn - 1))) continue
        const toolText = entry.toolNames.length > 0 ? entry.toolNames.join(', ') : undefined
        const label = [entry.messageLabel, toolText].filter(Boolean).join(' · ')
        records.push({
          kind: entry.messageSeq !== undefined ? 'message' : 'tool',
          turn: entry.turn,
          step: entry.step,
          sourceSeq: entry.messageSeq ?? entry.toolSeq ?? 0,
          ...(entry.messageSeq !== undefined || entry.callId === undefined
            ? {}
            : { callId: entry.callId }),
          ...(label === '' ? {} : { label }),
        })
      }
      const checkpoints: Array<Record<string, unknown>> = []
      for (const [turn, input] of [...inputByTurn.entries()].sort((left, right) => left[0] - right[0])) {
        const anchorSeq = turn === 1 ? 0 : turnEnds.get(turn - 1)
        if (anchorSeq === undefined) continue
        checkpoints.push({
          kind: 'turn',
          turn,
          sourceSeq: input.sourceSeq,
          anchorSeq,
          inputText: input.inputText,
        })
      }
      records.sort((left, right) =>
        left.turn - right.turn || left.step - right.step || left.sourceSeq - right.sourceSeq)
      for (const record of records) checkpoints.push(record)
      respond(res, 200, { ok: true, checkpoints })
    },
  }))

  // ---- POST /api/replay/control ---------------------------------------
  routeDisposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/api/replay/control',
    handler: async (req, res) => {
      let body: Record<string, unknown>
      try {
        const parsed = await readJsonBody(req)
        body = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
      } catch (error) {
        jsonError(res, 400, error instanceof Error ? error.message : String(error))
        return
      }
      const childId = typeof body.childId === 'string' ? SessionId(body.childId) : undefined
      const entry = childId === undefined ? undefined : registry.get(childId)
      if (entry === undefined) {
        jsonError(res, 404, 'replay run not found')
        return
      }
      const action = body.action
      if (action === 'continue') {
        if (entry.mode !== 'step') {
          jsonError(res, 409, 'continue is only valid in step mode')
          return
        }
        entry.stopAt += 1
        const gate = entry.gate
        entry.gate = null
        gate?.resolve()
        respond(res, 200, { ok: true })
        return
      }
      if (action === 'stop' || action === 'undo') {
        // Cancelling the agent aborts the pending gate through the turn signal.
        entry.handle.agent.cancel({ kind: 'user' })
        respond(res, 200, { ok: true })
        return
      }
      jsonError(res, 400, 'action must be "continue", "stop", or "undo"')
    },
  }))

  // ---- POST /api/replay/discard ---------------------------------------
  routeDisposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/api/replay/discard',
    handler: async (req, res) => {
      let body: Record<string, unknown>
      try {
        const parsed = await readJsonBody(req)
        body = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
      } catch (error) {
        jsonError(res, 400, error instanceof Error ? error.message : String(error))
        return
      }
      const childId = typeof body.childId === 'string' ? SessionId(body.childId) : undefined
      const entry = childId === undefined ? undefined : registry.get(childId)
      if (childId === undefined || entry === undefined) {
        respond(res, 200, { ok: true })
        return
      }
      await disposeRun(childId)
      respond(res, 200, { ok: true })
    },
  }))

  // ---- POST /api/replay/promote ---------------------------------------
  // Export the replay as a real workspace session: copy the child's log into a
  // fresh normal-origin session and attach it to the original's workspace.
  routeDisposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/api/replay/promote',
    handler: async (req, res) => {
      let body: Record<string, unknown>
      try {
        const parsed = await readJsonBody(req)
        body = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
      } catch (error) {
        jsonError(res, 400, error instanceof Error ? error.message : String(error))
        return
      }
      const childId = typeof body.childId === 'string' ? SessionId(body.childId) : undefined
      const entry = childId === undefined ? undefined : registry.get(childId)
      if (entry === undefined) {
        jsonError(res, 404, 'replay run not found')
        return
      }
      const child = entry.handle.agent.session
      const source = ctx.sessions.get(entry.originalId)

      // The seed must end outside an open turn. When the replayed turn is still
      // open (step mode paused mid-turn), close it with the same synthetic
      // `turn/end {interrupted}` closer crash recovery uses.
      let seed: readonly SessionEvent[]
      const last = child.events[child.events.length - 1]
      const lastTurnStart = [...child.events].reverse().find((event) => event.type === 'turn/start')
      const open = lastTurnStart !== undefined
        && !child.events.some((event) => event.type === 'turn/end' && event.seq > lastTurnStart.seq)
      if (open && lastTurnStart !== undefined && last !== undefined) {
        const closer: SessionEventEnvelope = {
          seq: last.seq + 1,
          time: Date.now(),
          type: 'turn/end',
          data: {
            turn: (lastTurnStart.data as { turn: number }).turn,
            reason: { kind: 'interrupted' },
          },
        }
        seed = [...child.events, closer as SessionEvent]
      } else {
        seed = child.events
      }

      const defaultSelection = ctx.agentDefaultModel.currentSelection()
      const agentOptions = selectionForSource(child, defaultSelection)
      let composition
      try {
        composition = await compositionFor(ctx, child)
      } catch (error) {
        jsonError(res, 500, `failed to resolve the replay composition: ${error instanceof Error ? error.message : String(error)}`)
        return
      }

      const exportedId = SessionId(`session-${randomUUID()}`)
      try {
        await ctx.agents.create({
          sessionId: exportedId,
          seed,
          meta: {
            ...(child.header.cwd === undefined ? {} : { cwd: child.header.cwd }),
            parentSession: entry.originalId,
            seedLength: seed.length,
            ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
          },
          agentOptions,
          setup: composition.setup,
        })
      } catch (error) {
        jsonError(res, 500, `failed to export the replay session: ${error instanceof Error ? error.message : String(error)}`)
        return
      }

      // Attach to the original's workspace (or the caller-named one).
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : undefined
      const workspaces = ctx.get('workspaceRegistry')
      if (workspaces !== undefined) {
        const target = workspaceId !== undefined
          ? workspaces.get(workspaceId)
          : (source !== undefined
            ? workspaces.list().find((candidate: { sessionIds: readonly string[] }) => candidate.sessionIds.includes(source.id))
            : undefined)
        if (target !== undefined) {
          try {
            await target.attachSession(exportedId)
          } catch (error) {
            ctx.logger.warn(`dsh-trajectory-replay: exported session "${exportedId}" could not attach to a workspace: ${String(error)}`)
          }
        }
      }

      respond(res, 200, { ok: true, sessionId: exportedId })
    },
  }))

  // ---- Step gate --------------------------------------------------------
  // Pause the child before the next model request once `stopAt` steps of the
  // replayed turn have executed. 'auto' runs never gate.
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const entry = agent === undefined ? undefined : registry.get(agent.id)
    if (entry === undefined || entry.mode !== 'step') return next()
    const executed = replayedSteps(agent.session)
    if (executed < entry.stopAt) return next()
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('replay step gate aborted'))
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      entry.gate = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
      }
    })
    return next()
  })
}
