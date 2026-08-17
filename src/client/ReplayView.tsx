/**
 * Replay comparison pane: mode picker + step controls + export actions on
 * top, the replayed child conversation below, then the trajectory comparison
 * (original left, replayed right). Pre-checkpoint history is merged into a
 * collapsible block on both sides.
 */
import { useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  ConversationSnapshot,
  ObservableSnapshot,
  SnapshotStore,
} from '@deepseek-ai/dsh-client-runtime/client'
import { EMPTY_TRAJECTORY_SNAPSHOT } from './trajectory-snapshot-builder.ts'
import { TrajectoryTable } from './TrajectoryTable.tsx'
import {
  deriveTrajectoryRequestNumbers,
  deriveTrajectoryTableTurns,
} from './trajectory-table-model.ts'
import { deriveReplayCheckpoints } from './replay-checkpoints.ts'
import { ReplayConversation } from './ReplayConversation.tsx'
import {
  buildTrajectoryMarkdown,
  deriveStepLedger,
  ReplayController,
  type ReplayCheckpoint,
  type ReplayMode,
  type ReplayState,
} from './replay-state.ts'
import type { TrajectoryTurnModel } from './layout.ts'
import type { TrajectoryKey } from './locales.ts'
import css from './ReplayView.module.css'

/** Session-bound controls injected by the replay registrations. */
export interface ReplayViewInjected {
  hooks: {
    replayState: SnapshotStore<ReplayState>
    replayChild: ObservableSnapshot<ConversationSnapshot | null>
    replayOriginal: ObservableSnapshot<ConversationSnapshot | null>
  }
  /** Plain controller passed through verbatim (not a host observable). */
  controller: ReplayController
  onReplay: (checkpoint: ReplayCheckpoint, options: { mode: ReplayMode; stopAt?: number; merge?: boolean }) => void
  onReset: () => void
}

const EMPTY_TURNS = new Set<number>()
const EMPTY_ASSISTANTS = new Set<string>()

interface SideTableProps {
  snapshot: ConversationSnapshot | null
  /** Collapse every turn strictly below this turn number into a merged block. */
  mergeBeforeTurn: number | null
  t: (key: TrajectoryKey, params?: Record<string, string | number>) => string
}

function SideTable({ snapshot, mergeBeforeTurn, t }: SideTableProps) {
  const inspection = snapshot?.views.get('trajectory') ?? EMPTY_TRAJECTORY_SNAPSHOT
  const partial = snapshot?.partial ?? null
  const model = useMemo(
    () => deriveTrajectoryTableTurns(inspection, partial),
    [inspection, partial],
  )
  const requestNumbers = useMemo(
    () => deriveTrajectoryRequestNumbers(inspection.eventNodes, inspection.requests),
    [inspection],
  )
  const [prefixExpanded, setPrefixExpanded] = useState(false)

  const prefixTurns = useMemo(
    () => (mergeBeforeTurn === null
      ? []
      : model.turns.filter(turn => turn.turn !== null && turn.turn < mergeBeforeTurn)),
    [model, mergeBeforeTurn],
  )
  const mainTurns: readonly TrajectoryTurnModel[] = useMemo(
    () => (mergeBeforeTurn === null
      ? model.turns
      : model.turns.filter(turn => turn.turn === null || turn.turn >= mergeBeforeTurn)),
    [model, mergeBeforeTurn],
  )

  const cellsOf = (turns: readonly TrajectoryTurnModel[]) =>
    turns.flatMap(turn => turn.groups.flatMap(group => group.cells))

  return (
    <>
      {prefixTurns.length > 0 && (
        <button
          type="button"
          className={css.mergedRow}
          aria-expanded={prefixExpanded}
          onClick={() => setPrefixExpanded(!prefixExpanded)}
        >
          <span className={css.mergedCaret} aria-hidden="true">{prefixExpanded ? '▾' : '▸'}</span>
          <span className={css.mergedLabel}>
            {t('replay.mergedPrefix', { count: prefixTurns.length })}
          </span>
          <span className={css.mergedHint}>{prefixExpanded ? t('replay.mergedCollapse') : t('replay.mergedExpand')}</span>
        </button>
      )}
      <TrajectoryTable
        requestNumbers={requestNumbers}
        turns={mainTurns}
        streamingCells={cellsOf(mainTurns)}
        historyLoading={snapshot?.openState === 'loading'}
        olderHistoryLoading={snapshot?.loadingOlder}
        hasOlderRecords={snapshot?.hasMore}
        collapsedTurns={EMPTY_TURNS}
        onToggleTurn={() => {}}
        collapsedAssistants={EMPTY_ASSISTANTS}
        onToggleAssistant={() => {}}
      />
      {prefixExpanded && prefixTurns.length > 0 && (
        <TrajectoryTable
          requestNumbers={requestNumbers}
          turns={prefixTurns}
          streamingCells={cellsOf(prefixTurns)}
          collapsedTurns={EMPTY_TURNS}
          onToggleTurn={() => {}}
          collapsedAssistants={EMPTY_ASSISTANTS}
          onToggleAssistant={() => {}}
        />
      )}
    </>
  )
}

/** Trigger a client-side file download. */
function downloadText(text: string, filename: string, mime: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * Render the replay comparison pane.
 * @param props - runtime props, injected replay hooks/callbacks, and locale.
 * @returns the replay view (checkpoint picker when idle, run view otherwise).
 */
export function ReplayView({
  useSession,
  useReplayState,
  useReplayChild,
  useReplayOriginal,
  controller,
  onReplay,
  onReset,
  t,
}: ReplayViewProps) {
  const state = useReplayState(value => value)
  const childSnapshot = useReplayChild(value => value)
  const originalSnapshot = useReplayOriginal(value => value)
  const sessionSnapshot = useSession(value => value)

  const checkpoints = useMemo(
    () => deriveReplayCheckpoints(sessionSnapshot),
    [sessionSnapshot],
  )
  const [mergePref, setMergePref] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const ledger = useMemo(
    () => deriveStepLedger(childSnapshot, state.checkpoint?.turn ?? 0),
    [childSnapshot, state.checkpoint],
  )

  const start = (checkpoint: ReplayCheckpoint, mode: ReplayMode): void => {
    setNotice(null)
    onReplay(checkpoint, { mode, merge: mergePref })
  }

  if (state.phase === 'idle') {
    return (
      <div className={css.root}>
        <div className={css.header}>
          <span className={css.title}>{t('replay.title')}</span>
          <span className={css.hint}>{t('replay.idleHint')}</span>
        </div>
        <label className={css.mergeToggle} title={t('replay.mergeHint')}>
          <input
            type="checkbox"
            checked={mergePref}
            onChange={(event) => setMergePref(event.currentTarget.checked)}
          />
          <span>{t('replay.merge')}</span>
        </label>
        {checkpoints.length === 0
          ? <div className={css.placeholder}>{t('replay.noCheckpoint')}</div>
          : (
            <div className={css.checkpointList}>
              {checkpoints.map(checkpoint => (
                <div key={checkpoint.turn} className={css.checkpointRowWrap}>
                  <span className={css.checkpointTitle}>{t('replay.fromTurn', { turn: checkpoint.turn })}</span>
                  <span className={css.checkpointInput}>{checkpoint.inputText.slice(0, 80)}</span>
                  <span className={css.checkpointActions}>
                    <button
                      type="button"
                      className={css.actionPrimary}
                      title={t('replay.auto')}
                      onClick={() => start(checkpoint, 'auto')}
                    >
                      ▶ {t('replay.auto')}
                    </button>
                    <button
                      type="button"
                      className={css.action}
                      title={t('replay.step')}
                      onClick={() => start(checkpoint, 'step')}
                    >
                      ⏭ {t('replay.step')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
      </div>
    )
  }

  const checkpoint = state.checkpoint
  const busy = state.phase === 'starting' || state.phase === 'running'
  const paused = state.phase === 'paused'
  const error = state.phase === 'error' ? state.error : undefined

  const promote = async (): Promise<void> => {
    const id = await controller.promote()
    if (id !== null) setNotice(t('replay.promoted', { id }))
  }
  const exportMarkdown = (): void => {
    const markdown = buildTrajectoryMarkdown(state, childSnapshot, originalSnapshot)
    downloadText(markdown, `trajectory-replay-${state.childId ?? 'run'}.md`, 'text/markdown')
    setNotice(t('replay.exported'))
  }

  return (
    <div className={css.root}>
      <div className={css.header}>
        <span className={css.title}>{t('replay.title')}</span>
        {checkpoint !== null && (
          <span className={css.badge}>
            {t('replay.checkpointBadge', { turn: checkpoint.turn, seq: checkpoint.sourceSeq })}
          </span>
        )}
        <span className={css.badge}>{state.mode === 'step' ? t('replay.modeStep') : t('replay.modeAuto')}</span>
        {state.mode === 'step' && (
          <span className={css.badge}>
            {t('replay.stepProgress', { executed: state.executedSteps, stopAt: state.stopAt })}
          </span>
        )}
        {busy && <span className={css.live}>{t('replay.running')}</span>}
        {paused && <span className={css.paused}>{t('replay.paused')}</span>}
        {state.phase === 'done' && <span className={css.done}>{t('replay.done')}</span>}
        {error !== undefined && <span className={css.error}>{error}</span>}
        {notice !== null && <span className={css.notice}>{notice}</span>}
      </div>

      <div className={css.controls}>
        {state.mode === 'step' && paused && state.executedSteps > 0 && (
          <button
            type="button"
            className={css.actionPrimary}
            onClick={() => { void controller.continueStep() }}
          >
            ▶ {t('replay.continue')}
          </button>
        )}
        {state.mode === 'step' && paused && state.executedSteps > 0 && (
          <button
            type="button"
            className={css.action}
            title={t('replay.undoHint')}
            onClick={() => { void controller.undoStep() }}
          >
            ↩ {t('replay.undo')}
          </button>
        )}
        {busy && (
          <button
            type="button"
            className={css.action}
            onClick={() => { void controller.stop() }}
          >
            ■ {t('replay.stop')}
          </button>
        )}
        {(state.phase === 'done' || paused) && (
          <button type="button" className={css.action} onClick={() => { void promote() }}>
            {t('replay.promote')}
          </button>
        )}
        {(state.phase === 'done' || paused) && state.childId !== null && (
          <button type="button" className={css.action} onClick={exportMarkdown}>
            {t('replay.exportTrajectory')}
          </button>
        )}
        {(state.phase === 'done' || paused) && state.childId !== null && (
          <a
            className={css.action}
            href={`/api/session.export?sessionId=${encodeURIComponent(state.childId)}&includeDescendants=true`}
            target="_blank"
            rel="noreferrer"
          >
            {t('replay.exportLog')}
          </a>
        )}
        <button type="button" className={css.reset} onClick={onReset}>{t('replay.reset')}</button>
      </div>

      <ReplayConversation snapshot={childSnapshot} style={{ flex: '0 0 140px' }} />

      {state.mode === 'step' && ledger.length > 0 && (
        <div className={css.ledger}>
          <div className={css.ledgerHeader}>{t('replay.ledgerTitle')}</div>
          {ledger.map(row => (
            <div key={row.step} className={css.ledgerRow}>
              <span className={css.ledgerStep}>Step {row.step}{row.status === undefined ? '' : `（${row.status}）`}</span>
              {row.assistantText !== '' && <pre className={css.ledgerText}>{row.assistantText}</pre>}
              {row.toolCalls.map((call, index) => (
                <div key={index} className={css.ledgerCall}>
                  <span className={call.isError ? css.ledgerCallError : css.ledgerCallOk}>
                    {call.isError ? '✗' : '✓'} {call.name}
                  </span>
                  {call.args !== '' && <code className={css.ledgerArgs}>{call.args.slice(0, 240)}</code>}
                  {call.result !== '' && <div className={css.ledgerResult}>{call.result.slice(0, 300)}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className={css.columns}>
        <div className={css.column}>
          <div className={css.columnHeader}>{t('replay.original')}</div>
          <div className={css.sideScroll}>
            <SideTable snapshot={originalSnapshot} mergeBeforeTurn={checkpoint?.turn ?? null} t={t} />
          </div>
        </div>
        <div className={css.column}>
          <div className={css.columnHeader}>{t('replay.replayed')}</div>
          <div className={css.sideScroll}>
            <SideTable snapshot={childSnapshot} mergeBeforeTurn={checkpoint?.turn ?? null} t={t} />
          </div>
        </div>
      </div>
    </div>
  )
}

export interface ReplayViewProps
  extends ConvViewProps,
    InjectFace<ReplayViewInjected>,
    PropsLocale<'trajectory'> {}
