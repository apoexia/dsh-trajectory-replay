/**
 * Browser trajectory-replay plugin: forks the trajectory view and adds
 * per-turn replay checkpoints plus a comparison pane.
 *
 * Registration strategy: when the official `ui-trajectory` entry is still
 * composed (pre-restart), its Definitions already own the `trajectory` view
 * target and the trajectory Definition kinds, so this bundle degrades to the
 * replay tab only (which reads the official-folded trajectory snapshots).
 * Once the profile patch disables the official entry, this bundle takes over
 * the `trajectory` target and renders play buttons inside the trajectory tab.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the 'conversation.view' SlotMap row (declared by the slot's
// owning package) must be in the program for the register calls to type.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createTrajectoryDurationStore } from './duration-store.ts'
import { en, NS, zh, type TrajectoryKey } from './locales.ts'
import { registerTrajectoryAssistantDefinition } from './trajectory-assistant-definition.ts'
import { registerTrajectoryCompactionDefinitions } from './trajectory-compaction-definition.ts'
import { registerTrajectoryMessageDefinitions } from './trajectory-message-definitions.ts'
import { registerTrajectoryRequestHeaderDefinition } from './trajectory-request-header-definition.ts'
import { registerTrajectoryConversationView } from './trajectory-snapshot-builder.ts'
import { registerTrajectoryToolDefinition } from './trajectory-tool-definition.ts'
import { TrajectoryView, type TrajectoryViewInjected } from './TrajectoryView.tsx'
import { ReplayView, type ReplayViewInjected } from './ReplayView.tsx'
import { ReplayController, replaySessions, type ReplayMode } from './replay-state.ts'
import type { ReplayCheckpoint } from './replay-state.ts'

/** Required services: the conversation slot, registries, Session paging, and the locale service. */
export const inject = ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale']

/**
 * Register the trajectory target and tab (Definitions + view + slot entry).
 * Every registration is effect-tied, so a mid-way failure (the official
 * ui-trajectory already owning the same kinds/target) must roll the whole
 * set back — the caller catches and degrades rather than leaving a partial
 * trajectory.
 * @param ctx - client root context.
 * @param t - bound locale translator.
 * @param duration - shared duration preference store.
 * @param onReplay - replay checkpoint handler.
 * @returns true when the trajectory target is owned by this bundle.
 */
function registerTrajectory(
  ctx: Context,
  t: (key: TrajectoryKey) => string,
  duration: ReturnType<typeof createTrajectoryDurationStore>,
  replayState: import('./replay-state.ts').ReplayController['state'],
  onReplay: (sessionId: SessionId, checkpoint: ReplayCheckpoint) => void,
): boolean {
  try {
    registerTrajectoryMessageDefinitions(ctx)
    registerTrajectoryRequestHeaderDefinition(ctx)
    registerTrajectoryAssistantDefinition(ctx)
    registerTrajectoryToolDefinition(ctx)
    registerTrajectoryCompactionDefinitions(ctx)
    registerTrajectoryConversationView(ctx)
    ctx.slots.inject('conversation.view', () => ctx.slots.register({
      name: 'conversation.view',
      id: 'trajectory',
      order: 10,
      locale: NS,
      label: () => t('view.trajectory'),
      inject: (sessionId: SessionId): TrajectoryViewInjected => {
        const session = ctx.sessions.binding(sessionId)?.session
        if (session === undefined) {
          throw new Error(`trajectory-replay: session "${sessionId}" is unavailable`)
        }
        return {
          hooks: {
            duration,
            replayState,
          },
          loadOlder: async () => {
            const before = session.getSnapshot().views.get('trajectory')
            await session.loadOlder()
            return session.getSnapshot().views.get('trajectory') !== before
          },
          setActualDuration: (value) => { duration.set(value) },
          onReplay: (checkpoint) => onReplay(sessionId, checkpoint),
        }
      },
    }, TrajectoryView))
    return true
  } catch (error) {
    // The official ui-trajectory entry still owns the trajectory kinds/target
    // (pre-restart). Degrade to the replay tab, which reads the official-folded
    // trajectory snapshots. Do not fail the whole plugin.
    console.warn('[trajectory-replay] official trajectory view is active; replay buttons are available in the 轨迹重现 tab', error)
    return false
  }
}

/**
 * Client plugin body: register the forked trajectory tab (when the target is
 * free) plus the replay comparison tab, and wire the replay controller.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'trajectory-replay: dictionaries')
  const t = ctx.locale.bind(NS)
  const duration = createTrajectoryDurationStore()
  const replay = new ReplayController(replaySessions(ctx.sessions))
  ctx.effect(() => () => replay.dispose(), 'trajectory-replay: dispose')

  // Shared preference: whether the pre-checkpoint history is merged.
  const preferences: { merge: boolean } = { merge: true }

  const onReplay = (
    originalId: SessionId,
    checkpoint: ReplayCheckpoint,
    options: { mode: ReplayMode; stopAt?: number; merge?: boolean },
  ): void => {
    void replay.start(originalId, checkpoint, {
      mode: options.mode,
      stopAt: options.stopAt,
      merge: options.merge ?? preferences.merge,
    })
  }

  registerTrajectory(ctx, t, duration, replay.state, (sessionId, checkpoint) => {
    // The trajectory tab's ▶ always runs the turn to completion.
    onReplay(sessionId, checkpoint, { mode: 'auto' })
  })

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'replay',
    order: 11,
    locale: NS,
    label: () => t('view.replay'),
    inject: (sessionId: SessionId): ReplayViewInjected => ({
      hooks: {
        replayState: replay.state,
        replayChild: replay.child,
        replayOriginal: replay.original,
        controller: replay,
      },
      onReplay: (checkpoint, options) => {
        preferences.merge = options.merge ?? preferences.merge
        onReplay(sessionId, checkpoint, options)
      },
      onReset: () => replay.reset(),
    }),
  }, ReplayView))
}
