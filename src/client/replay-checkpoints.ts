/**
 * Derive replay checkpoints from a session's trajectory snapshot.
 *
 * Turn-level checkpoints: every turn that opens with a text-only user message
 * becomes a checkpoint — the fork anchor cuts the child prefix at the previous
 * turn's boundary (turn 1 uses an empty prefix — the replay runs the very
 * first turn from scratch).
 *
 * Record-level checkpoints: every assistant message and tool call of step ≥ 2
 * is its own checkpoint. The host cuts the child prefix right before the
 * record's `step/start`, closes the source turn synthetically, and continues
 * the conversation from the log — so the model re-generates that exact record
 * (assistant message / tool-call decision) and everything after it. Step-1
 * records are the turn's own input boundary and replay as the turn checkpoint.
 *
 * Anchor sources: the trajectory snapshot's `eventLocations` only carries
 * node-kind contributions (message records), never turn/end boundaries, so
 * previous-turn closure + end seq come from the session snapshot's `turnEnds`
 * map (completed turn number -> its `turn/end` event seq). A turn whose
 * previous turn is not closed yet cannot be forked cleanly, so it is skipped.
 */
import type {
  AssistantMessageNode,
  ConversationLocation,
  ConversationSnapshot,
  SessionId,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ReplayCheckpoint } from './replay-state.ts'

function turnOf(location: ConversationLocation | undefined): number {
  return location?.kind === 'turn' || location?.kind === 'step'
    ? location.turn.turn
    : 0
}

function stepOf(location: ConversationLocation | undefined): number {
  return location?.kind === 'step' ? location.step.step : 0
}

function userText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && block.text !== undefined)
    .map(block => block.text)
    .join('\n')
    .trim()
}

function snippet(value: string, max = 60): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max)}…` : single
}

function assistantLabel(node: AssistantMessageNode): string {
  const text = snippet(node.blocks
    .filter((block): block is { kind: 'text'; text: string } => block.kind === 'text' && block.text !== '')
    .map(block => block.text)
    .join(' '))
  return text === '' ? 'assistant' : text
}

function toolLabel(node: ToolResultNode): string {
  const name = node.call?.name ?? node.callId
  const text = snippet((node.content ?? [])
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && block.text !== undefined && block.text !== '')
    .map(block => block.text)
    .join(' '))
  return text === '' ? name : `${name} · ${text}`
}

/**
 * Stable identity for one record-level replay point, shared by the derived
 * checkpoints and the table rows that render the replay button (a step's tool
 * calls share a cut but keep distinct call ids for row identity).
 * @param kind - record kind ('message' assistant message, 'tool' tool call).
 * @param turn - source turn number.
 * @param step - source step number (≥ 2).
 * @param callId - tool call id; ignored for assistant messages.
 * @returns the record checkpoint key.
 */
export function recordCheckpointKey(
  kind: 'message' | 'tool',
  turn: number,
  step: number,
  callId?: string,
): string {
  return kind === 'tool'
    ? `record:tool:${turn}:${step}:${callId ?? ''}`
    : `record:message:${turn}:${step}`
}

/**
 * Fetch the FULL replay checkpoint list from the host, derived from the source
 * session's complete event log. The browser-side window is paged, so local
 * derivation would only ever see the loaded tail; the host log is the complete
 * authority for which turns/records can be replayed.
 * @param originalId - source session id.
 * @returns checkpoints in picker order (turn checkpoints, then records by turn/step/seq).
 */
export async function fetchReplayCheckpoints(
  originalId: SessionId,
): Promise<ReplayCheckpoint[]> {
  try {
    const response = await fetch('/api/replay/checkpoints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ originalId }),
    })
    const payload = await response.json() as {
      ok?: boolean
      checkpoints?: ReplayCheckpoint[]
    }
    return payload.ok === true && Array.isArray(payload.checkpoints)
      ? payload.checkpoints
      : []
  } catch {
    return []
  }
}

/**
 * Compute replayable checkpoints in turn order (turn checkpoints first, then
 * record checkpoints sorted by turn/step/seq).
 * @param snapshot - session snapshot with a populated trajectory target.
 * @returns checkpoints (empty when the trajectory is absent or no turn is replayable).
 */
export function deriveReplayCheckpoints(
  snapshot: ConversationSnapshot | null,
): ReplayCheckpoint[] {
  if (snapshot === null) return []
  const inspection = snapshot.views.get('trajectory')
  const eventNodes = inspection?.eventNodes ?? []
  const eventLocations = inspection?.eventLocations
  const turnEnds = snapshot.turnEnds
  if (eventLocations === undefined || turnEnds === undefined) return []

  const inputByTurn = new Map<number, { sourceSeq: number; inputText: string }>()
  const records: ReplayCheckpoint[] = []
  for (const node of eventNodes) {
    if (node.kind === 'user') {
      const text = userText(node.content)
      if (text === '') continue
      const turn = turnOf(eventLocations.get(node.seq))
      if (turn <= 0) continue
      if (!inputByTurn.has(turn)) {
        inputByTurn.set(turn, { sourceSeq: node.seq, inputText: text })
      }
      continue
    }
    if (node.kind === 'assistant') {
      const { turn, step } = node
      // Turn 1 has no previous turn to close; later turns need theirs closed.
      if (turn > 0 && step >= 2 && (turn === 1 || turnEnds.get(turn - 1) !== undefined)) {
        records.push({
          kind: 'message',
          turn,
          step,
          sourceSeq: node.seq,
          anchorSeq: 0,
          inputText: '',
          label: assistantLabel(node),
        })
      }
      continue
    }
    if (node.kind === 'tool-result') {
      const location = eventLocations.get(node.seq)
      const turn = turnOf(location)
      const step = stepOf(location)
      if (turn > 0 && step >= 2 && (turn === 1 || turnEnds.get(turn - 1) !== undefined)) {
        records.push({
          kind: 'tool',
          turn,
          step,
          sourceSeq: node.seq,
          anchorSeq: 0,
          inputText: '',
          callId: node.callId,
          label: toolLabel(node),
        })
      }
    }
  }

  const checkpoints: ReplayCheckpoint[] = []
  for (const [turn, input] of [...inputByTurn.entries()].sort((left, right) => left[0] - right[0])) {
    // The very first turn replays from an empty prefix (anchorSeq 0 = fork
    // at the session start); every later turn needs its previous turn closed
    // so the fork cut has a real boundary to end the child prefix at.
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
    left.turn - right.turn
    || (left.step ?? 0) - (right.step ?? 0)
    || left.sourceSeq - right.sourceSeq)
  return [...checkpoints, ...records]
}
