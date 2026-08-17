/**
 * Shared trajectory table model: request numbering and turn layout derived
 * from a Trajectory snapshot. Used by the main Trajectory view and by the
 * replay comparison pane so both render byte-identical table content.
 */
import type {
  AssistantMessageNode,
  ConversationNode,
  PartialAssistant,
  RequestView,
  RunningToolCall,
} from '@deepseek-ai/dsh-client-runtime/client'
import {
  appendTrajectoryPartialLayout,
  deriveTrajectoryLayout,
  type TrajectoryTurnModel,
} from './layout.ts'
import type { TrajectoryRequestNumber, TrajectoryUsage } from './TrajectoryTable.tsx'
import type { TrajectorySnapshot } from './trajectory-contract.ts'

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}

function requestUsage(value: unknown): TrajectoryUsage | undefined {
  const usage = value as UsageLike | undefined
  if (usage === undefined) return undefined
  return {
    ...(usage.inputTokens === undefined ? {} : { input: usage.inputTokens }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheRead: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWrite: usage.cacheWriteTokens }),
    ...(usage.outputTokens === undefined ? {} : { output: usage.outputTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
  }
}

function addUsage(
  total: TrajectoryUsage | undefined,
  usage: TrajectoryUsage | undefined,
): TrajectoryUsage | undefined {
  if (usage === undefined) return total
  return {
    ...(total?.input === undefined && usage.input === undefined
      ? {}
      : { input: (total?.input ?? 0) + (usage.input ?? 0) }),
    ...(total?.cacheRead === undefined && usage.cacheRead === undefined
      ? {}
      : { cacheRead: (total?.cacheRead ?? 0) + (usage.cacheRead ?? 0) }),
    ...(total?.cacheWrite === undefined && usage.cacheWrite === undefined
      ? {}
      : { cacheWrite: (total?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0) }),
    ...(total?.output === undefined && usage.output === undefined
      ? {}
      : { output: (total?.output ?? 0) + (usage.output ?? 0) }),
    ...(total?.reasoning === undefined && usage.reasoning === undefined
      ? {}
      : { reasoning: (total?.reasoning ?? 0) + (usage.reasoning ?? 0) }),
  }
}

/**
 * Derive the numbered request list (assistant + compaction) from trajectory
 * event nodes and request views, in log order with cumulative usage.
 * @param nodes - trajectory event nodes.
 * @param requests - trajectory request views.
 * @returns numbered requests.
 */
export function deriveTrajectoryRequestNumbers(
  nodes: readonly ConversationNode[],
  requests: readonly RequestView[],
): TrajectoryRequestNumber[] {
  const assistantsByStep = new Map<string, AssistantMessageNode>()
  for (const node of nodes) {
    if (node.kind !== 'assistant' || node.step <= 0) continue
    assistantsByStep.set(`${node.turn}\u0000${node.step}`, node)
  }
  const requestsByStep = new Map(
    requests
      .filter(request => request.purpose === 'assistant')
      .map(request => [
        `${request.turn}\u0000${request.step}`,
        request,
      ]),
  )
  const orderedRequests = [
    ...requests.map(request => ({
      seq: request.startSeq,
      request,
      node: request.purpose === 'assistant'
        ? assistantsByStep.get(`${request.turn}\u0000${request.step}`)
        : undefined,
    })),
    ...[...assistantsByStep.entries()].flatMap(([key, node]) =>
      requestsByStep.has(key)
        ? []
        : [{
          seq: node.seq,
          request: undefined,
          node,
        }],
    ),
  ].sort((left, right) => left.seq - right.seq)
  const numbered: TrajectoryRequestNumber[] = []
  let cumulativeUsage: TrajectoryUsage | undefined
  for (const [index, entry] of orderedRequests.entries()) {
    const usage = requestUsage(entry.request?.usage ?? entry.node?.usage)
    cumulativeUsage = addUsage(cumulativeUsage, usage)
    if (entry.request?.purpose !== 'compaction') {
      const request = entry.request
      const node = entry.node
      const turn = request?.turn ?? node?.turn
      const step = request?.step ?? node?.step
      if (turn === undefined || step === undefined) continue
      const provider = request?.provenance?.provider ?? node?.provenance?.provider
      const model = request?.provenance?.model ?? node?.provenance?.model
      const requestConfig = request?.requestConfig ?? node?.requestConfig
      numbered.push({
        seq: entry.seq,
        turn,
        step,
        group: `Step ${step}`,
        number: index + 1,
        ...(request?.status === undefined ? {} : { status: request.status }),
        ...(request?.startedAt === undefined ? {} : { startedAt: request.startedAt }),
        ...(request?.completedAt === undefined ? {} : { completedAt: request.completedAt }),
        ...(request?.error === undefined ? {} : { error: request.error }),
        ...(request?.resultSeq === undefined ? {} : { resultSeq: request.resultSeq }),
        ...(request?.retry === undefined ? {} : { retry: request.retry }),
        ...(request?.maxRetries === undefined ? {} : { maxRetries: request.maxRetries }),
        ...(request?.retryDelayMs === undefined
          ? {}
          : { retryDelayMs: request.retryDelayMs }),
        ...(provider === undefined ? {} : { provider }),
        ...(model === undefined ? {} : { model }),
        ...(requestConfig === undefined ? {} : { requestConfig }),
        ...(usage === undefined ? {} : { usage }),
        ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
      })
      continue
    }
    const request = entry.request
    numbered.push({
      seq: request.startSeq,
      turn: request.turn,
      step: 0,
      group: `Compaction ${request.startSeq}`,
      number: index + 1,
      purpose: 'compaction',
      status: request.status,
      startedAt: request.startedAt,
      completedAt: request.completedAt,
      ...(request.error === undefined ? {} : { error: request.error }),
      resultSeq: request.startSeq,
      ...(request.provenance?.provider === undefined
        ? {}
        : { provider: request.provenance.provider }),
      ...(request.provenance?.model === undefined
        ? {}
        : { model: request.provenance.model }),
      ...(request.requestConfig === undefined ? {} : { requestConfig: request.requestConfig }),
      ...(usage === undefined ? {} : { usage }),
      ...(cumulativeUsage === undefined ? {} : { cumulativeUsage }),
    })
  }
  return numbered
}

function lastCellIndex(turns: readonly TrajectoryTurnModel[]): number {
  let last = 0
  for (const turn of turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) last = Math.max(last, cell.index)
    }
  }
  return last
}

/**
 * Derive the turn layout for the trajectory table, optionally including the
 * live partial assistant records.
 * @param inspection - trajectory snapshot.
 * @param partial - live partial assistant (from the session snapshot), or null.
 * @returns the turn models and the highest cell index.
 */
export function deriveTrajectoryTableTurns(
  inspection: TrajectorySnapshot,
  partial: PartialAssistant | null,
): { turns: readonly TrajectoryTurnModel[]; lastIndex: number } {
  const { eventNodes, eventLocations, runningCalls, requests, callSchemas } = inspection
  const partialTurn = partial?.turn ?? null
  const partialStep = partial?.step ?? null
  const finalized = deriveTrajectoryLayout({
    nodes: eventNodes,
    eventLocations,
    partial: partialTurn === null || partialStep === null
      ? null
      : { turn: partialTurn, step: partialStep, blocks: [] },
    runningCalls,
    requests,
    callSchemas,
  })
  const lastIndex = lastCellIndex(finalized)
  const turns = partial === null
    ? finalized
    : appendTrajectoryPartialLayout(finalized, partial, lastIndex)
  return { turns, lastIndex: lastCellIndex(turns) }
}
