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
      const anchorSeq = typeof body.anchorSeq === 'number' && Number.isSafeInteger(body.anchorSeq) && body.anchorSeq >= 0 ? body.anchorSeq : -1
      const inputText = typeof body.inputText === 'string' && body.inputText.trim() !== '' ? body.inputText : ''
      if (anchorSeq < 0 || inputText === '') {
        jsonError(res, 400, 'anchorSeq (non-negative integer) and inputText (non-empty) are required')
        return
      }
      const mode = body.mode === 'step' ? 'step' : 'auto'
      const requestedStop = typeof body.stopAt === 'number' && Number.isSafeInteger(body.stopAt) && body.stopAt >= 1 ? body.stopAt : 1
      const merge = body.merge !== false

      // Dispose any previous run before starting a new one.
      for (const childId of registry.ids()) {
        await disposeRun(childId)
      }

      const cut = forkCut(source.events, anchorSeq)
      if (cut < 0) {
        jsonError(res, 409, 'the anchor does not fall in a completed turn; cannot fork')
        return
      }
      const seed = source.events.slice(0, cut)
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
            seedLength: cut,
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
      if (merge) {
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

      // Submit the replayed input; the gate (step mode) pauses before the
      // second request onward.
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: inputText }],
        source: { kind: 'user' },
      }))

      respond(res, 200, { ok: true, childId })
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
