# @dsh-external/dsh-trajectory-replay — 轨迹重放（checkpoint 回放 + 对比 + 单步）

fork 官方 `@deepseek-ai/dsh-client-ui-trajectory` 并叠加**轨迹重放**能力：

- **轨迹页签**（`trajectory`）：与原版 UI 一致（同一 fork 代码），每个回合起始行左侧多一个 **▶** 播放按钮（自动跑完）。
- **轨迹重现页签**（`replay`，标签「轨迹重现」）：按回合列出 checkpoint，每个 checkpoint 可选 **▶ 自动跑完** 或 **⏭ 单步**。

## 功能（v2）

1. **git 工程化**：插件目录本身就是 git 仓库（`git init` + `.gitignore`，忽略 `node_modules/`、`lib/` 等构建产物）。
2. **重放粒度精确到 turn/step**：单步模式以「一个模型请求 + 其工具调用」为最小执行单元——每次点「继续」只推进一步；顶部有**执行台账**，按步列出 assistant 文本与每个工具调用的参数和结果。
3. **重放点之前的合并**：
   - host 端在 fork 后用 `ctx.compaction.compactRegion` 把检查点之前的 surface 合并成一个 LLM 摘要节点（可选开关，默认开）——重放时模型只看到合并后的上下文；
   - 对比面板两侧把检查点之前的回合折叠为一个「已合并 · N 个回合」块，可展开查看。
4. **会话隔离 + 导出**：
   - 重放子会话以 `origin: 'subagent'` 创建（`ctx.agents.create`），**不挂任何工作区**，侧栏/扁平列表/搜索全部隐藏（`sessionVisible` 语义），只在「轨迹重现」栏可见（列表镜像仍在，binding 与 mux 实时帧可用）；
   - **导出为会话/放到工作区**：点击后 host 把子会话日志复制成一个普通会话并挂到原会话的工作区（中途 turn 未闭合时自动补 `turn/end {interrupted}` 闭合器，与崩溃恢复同机制）；
   - **导出轨迹**：下载 Markdown 版重放轨迹（checkpoint、输入、按步的 assistant/工具调用/结果）；
   - **导出原始日志**：跳转现有 `GET /api/session.export` 下载会话 ZIP。
5. **两种模式**：
   - **自动跑完**：fork → 合并 → 提交输入 → agent 完整执行该回合 → 与原始轨迹并列对比；
   - **单步**：执行到目标步数后，host 在 `agent/request` 瀑布处暂停（等「继续」）；**继续** 推进一步；**撤销** 丢弃当前重放并从 checkpoint 重跑前序步骤（再前一步暂停）——前序工具调用会重跑，这是 append-only 日志下撤销的诚实代价；**停止** 取消 agent 但保留子会话（仍可导出）。

## 架构

- **host 半部**（`src/index.ts`，v2 新增，之前为零 host 代码）：
  - `ReplayRegistry`：进程内注册表，`childId → {originalId, handle, mode, stopAt, gate}`；
  - 四条 exact HTTP 路由（webserver 精确路由优先于连接插件的 `/api` 前缀，浏览器同源访问）：
    - `POST /api/replay/start` — 复刻 host `session.fork`（`ctx.agents.create({sessionId, seed, meta})`，meta 带 `origin:'subagent'`），跳过工作区挂载；可选 `compactRegion` 合并；`followup` 提交重放输入；
    - `POST /api/replay/control` — `continue`（`stopAt+1` 并释放闸门）/ `stop` / `undo`（取消 agent）；
    - `POST /api/replay/discard` — dispose 子会话；
    - `POST /api/replay/promote` — 复制子会话日志为普通会话（未闭合 turn 补合成 closers）+ 挂载原工作区。
  - **步进闸门**：`agent/request` 瀑布监听器——对 step 模式子会话，当已执行步数 ≥ `stopAt` 时等待；`continue` 释放；取消/停止通过 turn 的 AbortSignal 干净中止。
- **client 半部**（`src/client/`）：
  - `replay-state.ts`：`ReplayController`（状态机 idle/starting/running/paused/done/error，快照源派生 `executedSteps`）+ `deriveStepLedger` + `buildTrajectoryMarkdown`；
  - `ReplayView.tsx`：checkpoint 选择（自动/单步 + 合并开关）、运行态控制条（继续/撤销/停止/导出/重置）、执行台账、两侧对比（检查点前折叠）。

## 装配

```powershell
# 热装配（免重启；重启后由 bundles 接管，双路径一致）
dev_install_package <本目录>
# 刷新浏览器页面后生效：轨迹页签带 ▶，出现「轨迹重现」页签。
```

## 构建

```bash
# host: src → lib（需要 DSH_CHECKOUT 指向含 node_modules/.bin/tsc 的 dsh checkout；
#        DSH_CORDIS_ROOT 指向已安装的 @deepseek-ai 树；Windows 下用 git bash 或等价方式链接依赖后直接跑 tsc）
DSH_CHECKOUT=... DSH_CORDIS_ROOT=... bash scripts/build.sh
npm run build:client   # client: lib/client.js（tsdown）
npm run typecheck      # 客户端 tsc --noEmit
```

## 已知限制

- 第一回合不可重放（fork 无法在首个 turn 之前截断）。
- 每次只允许一个进行中的重放；新开始会自动丢弃上一个。
- 撤销会重跑前序步骤（工具副作用会重复）——见上文。
- `origin:'subagent'` 使子会话被 api-remotes 围栏拒绝普通 `session.prompt`，因此重放输入与步进控制全部走 `/api/replay/*`（host 直连 agent），这是刻意设计。
- 上方对话为紧凑渲染（跨包导入被客户端纪律禁止）。
