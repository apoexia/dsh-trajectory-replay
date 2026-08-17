# @dsh-external/dsh-trajectory-replay — 轨迹重放（checkpoint 回放 + 对比）

fork 官方 `@deepseek-ai/dsh-client-ui-trajectory` 并叠加**轨迹重放**能力：

- **轨迹页签**（`trajectory`）：与原版 UI 完全一致（同一 fork 代码），每个回合起始行左侧多一个 **▶** 播放按钮。
- **轨迹重现页签**（`replay`，标签「轨迹重现」）：点击 ▶ 后自动 fork 出重放会话并重新执行 agent，新栏布局为——
  - 上方：重放会话的实时对话（紧凑渲染）；
  - 下方左右：**原轨迹（记录）** ‖ **轨迹重现（新执行）**，checkpoint 之前两侧逐行一致，checkpoint 之后并列对比。

## 机制

- **checkpoint 推导**（`replay-checkpoints.ts`）：从轨迹快照按回合提取首个文本用户消息（`sourceSeq`），锚点取**上一回合的 `turn/end` seq**——host `session.fork` 的"第一个 `turn/end` 在锚点处或之后"语义恰好让子会话截止于上一回合，从而**重放被点击的整个回合**。第一回合与上一回合未闭合的回合不提供按钮。
- **重放编排**（`replay-state.ts`）：`sessions.fork({atSeq: anchor})` → `sessions.open(child)` → `child.prompt(输入, 'queue')`，全部复用现有客户端 RPC，**零 host 代码**。
- **快照源**：`ReplaySessionSource` 订阅 sessions 列表 + 共享重放状态 + 子会话快照，把非活动会话（原/子）的实时快照以 inject `hooks` 形式提供给对比面板。
- **冲突降级**：官方 `ui-trajectory` 仍装配时（注册 target 冲突），本插件退化为只提供「轨迹重现」页签（其内也有按回合的 ▶ 清单）；profile patch 禁用官方条目后，本插件接管 `trajectory` target。

## 装配

```powershell
# 热装配（免重启；重启后由 bundles 接管，双路径一致）
dev_install_package <本目录>

# profile patch（已写入 ~/.dsh/profiles/web/cordis.patch.yml）：
#   - id: ui-trajectory → disabled: true
# 刷新浏览器页面（客户端树重建）后生效：轨迹页签带 ▶，出现「轨迹重现」页签。
```

## 构建

```bash
# 需要 DSH_CHECKOUT（含 node_modules/.bin/tsc）与 DSH_CORDIS_ROOT（已安装的 @deepseek-ai 树）
DSH_CHECKOUT=... DSH_CORDIS_ROOT=... bash scripts/build.sh   # host: lib/index.js
npm run build:client                                        # client: lib/client.js（tsdown）
npm run typecheck                                           # 客户端 tsc --noEmit
```

## 已知限制

- 上方对话为**紧凑渲染**（非完整 ChatView 组件——跨包导入被客户端纪律禁止）；完整对话在子会话自身的「对话」页签。
- 第一回合不可重放（fork 无法在首个 turn 之前截断）。
- 每次只允许一个进行中的重放（状态机守卫）。
