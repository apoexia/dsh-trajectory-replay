/** `trajectory` namespace dictionaries (view tab label + toolbar strings). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'trajectory'

/** The trajectory dictionary key set (the source of truth for both locales). */
export type TrajectoryKey =
  | 'view.trajectory'
  | 'view.replay'
  | 'toolbar.aria'
  | 'toolbar.duration'
  | 'toolbar.useActualDuration'
  | 'toolbar.useEqualWidth'
  | 'toolbar.actualTime'
  | 'toolbar.turns'
  | 'toolbar.expandTurns'
  | 'toolbar.collapseTurns'
  | 'toolbar.calls'
  | 'toolbar.expandCalls'
  | 'toolbar.collapseCalls'
  | 'toolbar.search'
  | 'toolbar.searchPlaceholder'
  | 'replay.title'
  | 'replay.idleHint'
  | 'replay.noCheckpoint'
  | 'replay.fromTurn'
  | 'replay.checkpointBadge'
  | 'replay.running'
  | 'replay.reset'
  | 'replay.original'
  | 'replay.replayed'
  | 'replay.auto'
  | 'replay.step'
  | 'replay.merge'
  | 'replay.mergeHint'
  | 'replay.modeAuto'
  | 'replay.modeStep'
  | 'replay.stepProgress'
  | 'replay.continue'
  | 'replay.undo'
  | 'replay.undoHint'
  | 'replay.stop'
  | 'replay.promote'
  | 'replay.exportTrajectory'
  | 'replay.exportLog'
  | 'replay.paused'
  | 'replay.done'
  | 'replay.mergedPrefix'
  | 'replay.mergedExpand'
  | 'replay.mergedCollapse'
  | 'replay.ledgerTitle'
  | 'replay.promoted'
  | 'replay.exported'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The trajectory view tab label and toolbar strings. */
    'trajectory': TrajectoryKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh: Record<TrajectoryKey, string> = {
  'view.trajectory': '轨迹',
  'view.replay': '轨迹重现',
  'toolbar.aria': '轨迹工具栏',
  'toolbar.duration': 'Duration',
  'toolbar.useActualDuration': 'Use actual duration',
  'toolbar.useEqualWidth': 'Use equal-width operations',
  'toolbar.actualTime': '实际时间',
  'toolbar.turns': 'Turns',
  'toolbar.expandTurns': 'Expand turns',
  'toolbar.collapseTurns': 'Collapse turns',
  'toolbar.calls': 'Calls',
  'toolbar.expandCalls': 'Expand calls',
  'toolbar.collapseCalls': 'Collapse calls',
  'toolbar.search': '搜索轨迹',
  'toolbar.searchPlaceholder': '搜索',
  'replay.title': '轨迹重放',
  'replay.idleHint': '选择重放模式：自动跑完并对比，或单步执行（每个模型请求/工具调用后暂停，点击继续）。',
  'replay.noCheckpoint': '当前会话没有可重放的回合（需要至少一个已结束的上一回合与文本输入）。',
  'replay.fromTurn': '从 Turn {turn} 重放',
  'replay.checkpointBadge': 'checkpoint · Turn {turn} · seq {seq}',
  'replay.running': '● 重放执行中…',
  'replay.reset': '重置',
  'replay.original': '原轨迹（记录）',
  'replay.replayed': '轨迹重现（新执行）',
  'replay.auto': '自动跑完',
  'replay.step': '单步',
  'replay.merge': '合并检查点之前',
  'replay.mergeHint': '将检查点之前的轨迹合并为一个摘要节点（LLM 压缩），重放时模型只看到合并后的上下文；对比面板始终把检查点之前折叠显示。',
  'replay.modeAuto': '自动',
  'replay.modeStep': '单步',
  'replay.stepProgress': '第 {executed} 步 / 目标 {stopAt} 步',
  'replay.continue': '继续',
  'replay.undo': '撤销',
  'replay.undoHint': '撤销最后一步：丢弃当前重放，从 checkpoint 重新执行到上一步后暂停（前序工具调用会重跑）。',
  'replay.stop': '停止',
  'replay.promote': '导出为会话/放到工作区',
  'replay.exportTrajectory': '导出轨迹',
  'replay.exportLog': '导出原始日志',
  'replay.paused': '已暂停 · 点击继续执行下一步',
  'replay.done': '重放完成',
  'replay.mergedPrefix': '已合并 · 检查点之前 {count} 个回合',
  'replay.mergedExpand': '点击展开',
  'replay.mergedCollapse': '点击折叠',
  'replay.ledgerTitle': '执行台账（按步骤：assistant 与工具调用）',
  'replay.promoted': '已导出为会话并放入工作区：{id}',
  'replay.exported': '轨迹已导出为 Markdown',
}

/** English dictionary. */
export const en: Record<TrajectoryKey, string> = {
  'view.trajectory': 'Trajectory',
  'view.replay': 'Replay',
  'toolbar.aria': 'Trajectory toolbar',
  'toolbar.duration': 'Duration',
  'toolbar.useActualDuration': 'Use actual duration',
  'toolbar.useEqualWidth': 'Use equal-width operations',
  'toolbar.actualTime': 'Actual time',
  'toolbar.turns': 'Turns',
  'toolbar.expandTurns': 'Expand turns',
  'toolbar.collapseTurns': 'Collapse turns',
  'toolbar.calls': 'Calls',
  'toolbar.expandCalls': 'Expand calls',
  'toolbar.collapseCalls': 'Collapse calls',
  'toolbar.search': 'Search trajectory',
  'toolbar.searchPlaceholder': 'Search',
  'replay.title': 'Trajectory replay',
  'replay.idleHint': 'Pick a replay mode: run the turn to completion and compare, or step through it (pauses after every model request / tool call).',
  'replay.noCheckpoint': 'No replayable turn in this session (need a closed previous turn with a text input).',
  'replay.fromTurn': 'Replay from Turn {turn}',
  'replay.checkpointBadge': 'checkpoint · Turn {turn} · seq {seq}',
  'replay.running': '● replaying…',
  'replay.reset': 'Reset',
  'replay.original': 'Original (recorded)',
  'replay.replayed': 'Replay (new run)',
  'replay.auto': 'Run all',
  'replay.step': 'Step',
  'replay.merge': 'Merge before checkpoint',
  'replay.mergeHint': 'Compact the pre-checkpoint trajectory into one summary node (LLM); the replayed turn then sees merged context. The comparison pane always collapses the pre-checkpoint rows.',
  'replay.modeAuto': 'Auto',
  'replay.modeStep': 'Step',
  'replay.stepProgress': 'Step {executed}/{stopAt}',
  'replay.continue': 'Continue',
  'replay.undo': 'Undo',
  'replay.undoHint': 'Undo the last step: discard this run and re-execute from the checkpoint up to the previous step (earlier tool calls re-run).',
  'replay.stop': 'Stop',
  'replay.promote': 'Export as session',
  'replay.exportTrajectory': 'Export trajectory',
  'replay.exportLog': 'Export raw log',
  'replay.paused': 'Paused · continue to run the next step',
  'replay.done': 'Replay finished',
  'replay.mergedPrefix': 'Merged · {count} turns before checkpoint',
  'replay.mergedExpand': 'click to expand',
  'replay.mergedCollapse': 'click to collapse',
  'replay.ledgerTitle': 'Step ledger (assistant + tool calls)',
  'replay.promoted': 'Exported to workspace: {id}',
  'replay.exported': 'Trajectory exported as Markdown',
}
