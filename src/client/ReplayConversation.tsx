/**
 * Compact conversation strip for the replay pane: renders the replayed
 * child session's chat nodes (user/assistant/tool) as a lightweight,
 * scrollable transcript. The full-featured Chat view remains one tab away on
 * the child session itself.
 */
import type { CSSProperties } from 'react'
import type {
  AssistantMessageNode,
  ConversationNode,
  ConversationSnapshot,
  ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import css from './ReplayConversation.module.css'

interface ContentBlockLike {
  type: string
  text?: string
}

function textOf(node: { content: readonly ContentBlockLike[] }): string {
  return node.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && block.text !== undefined)
    .map(block => block.text)
    .join('\n')
}

function assistantText(node: AssistantMessageNode): string {
  return node.blocks
    .map((block) => {
      switch (block.kind) {
        case 'text':
        case 'reasoning':
          return block.text
        case 'tool-call':
          return `🔧 ${block.name}(${block.argsRaw})`
        case 'image':
          return '[image]'
        case 'other':
          return '[block]'
      }
    })
    .join('\n')
}

function toolResultText(node: ToolResultNode): string {
  const head = node.isError === true ? '✗' : '✓'
  const body = node.content
    ?.filter((block): block is { type: 'text'; text: string } => block.type === 'text' && block.text !== undefined)
    .map(block => block.text)
    .join('\n') ?? ''
  const name = node.call?.name ?? node.callId
  return `${head} ${name}${body === '' ? '' : ` — ${body.slice(0, 200)}`}`
}

function nodeKey(node: ConversationNode, index: number): string {
  return 'seq' in node && typeof node.seq === 'number'
    ? `${node.kind}:${node.seq}`
    : `${node.kind}:${index}`
}

function NodeRow({ node }: { node: ConversationNode }) {
  switch (node.kind) {
    case 'user':
    case 'steering':
    case 'context':
      return <div className={css.user}>{textOf(node)}</div>
    case 'assistant': {
      const text = assistantText(node)
      if (text.trim() === '') return null
      return (
        <div className={css.assistant}>
          <span className={css.role}>assistant</span>
          <pre className={css.pre}>{text}</pre>
        </div>
      )
    }
    case 'tool-result':
      return <div className={css.tool}>{toolResultText(node)}</div>
    case 'turn-error':
      return <div className={css.error}>⛔ {node.message}</div>
    case 'turn-max-tokens':
      return <div className={css.warn}>⏸ reply stopped at the output cap</div>
    case 'command':
      return <div className={css.tool}>/{node.name ?? node.commandId}</div>
    default:
      return null
  }
}

export interface ReplayConversationProps {
  /** The replayed child session snapshot (null while not yet bound). */
  snapshot: ConversationSnapshot | null
  style?: CSSProperties
}

/**
 * Render the replayed conversation as a compact transcript.
 * @param props - child snapshot and optional wrapper style.
 * @returns the transcript strip.
 */
export function ReplayConversation({ snapshot, style }: ReplayConversationProps) {
  const nodes = snapshot?.nodes ?? []
  return (
    <div className={css.root} style={style}>
      {snapshot === null || snapshot.openState === 'loading'
        ? <div className={css.placeholder}>重放会话加载中…</div>
        : nodes.length === 0
          ? <div className={css.placeholder}>尚无重放输出——等待 agent 从 checkpoint 重新执行。</div>
          : nodes.map((node, index) => (
            <NodeRow key={nodeKey(node, index)} node={node} />
          ))}
      {snapshot?.running === true && <div className={css.live}>● 重放执行中…</div>}
    </div>
  )
}
