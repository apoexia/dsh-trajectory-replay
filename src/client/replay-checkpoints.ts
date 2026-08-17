/**
 * Derive replay checkpoints from a session's trajectory snapshot. Each
 * replayable turn (one that opens with a text-only user message and whose
 * previous turn is closed) becomes a checkpoint: the fork anchor cuts the
 * child prefix at the previous turn's boundary.
 *
 * Anchor sources: the trajectory snapshot's `eventLocations` only carries
 * node-kind contributions (message records), never turn/end boundaries, so
 * previous-turn closure + end seq come from the session snapshot's
 * `turnEnds` map (completed turn number -> its `turn/end` event seq).
 */
import type { ConversationLocation, ConversationSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { ReplayCheckpoint } from './replay-state.ts'

function turnOf(location: ConversationLocation | undefined): number {
  return location?.kind === 'turn' || location?.kind === 'step'
    ? location.turn.turn
    : 0
}

function userText(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && block.text !== undefined)
    .map(block => block.text)
    .join('\n')
    .trim()
}

/**
 * Compute replayable checkpoints in turn order.
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
  for (const node of eventNodes) {
    if (node.kind !== 'user') continue
    const text = userText(node.content)
    if (text === '') continue
    const turn = turnOf(eventLocations.get(node.seq))
    if (turn <= 0) continue
    if (!inputByTurn.has(turn)) {
      inputByTurn.set(turn, { sourceSeq: node.seq, inputText: text })
    }
  }

  const checkpoints: ReplayCheckpoint[] = []
  for (const [turn, input] of [...inputByTurn.entries()].sort((left, right) => left[0] - right[0])) {
    if (turn === 1) continue // no previous turn to cut at: the first turn cannot be forked before its start
    // `turnEnds` only maps completed turns, so this is also the closed check.
    const anchorSeq = turnEnds.get(turn - 1)
    if (anchorSeq === undefined) continue
    checkpoints.push({
      turn,
      sourceSeq: input.sourceSeq,
      anchorSeq,
      inputText: input.inputText,
    })
  }
  return checkpoints
}
