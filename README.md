# @dsh-external/dsh-trajectory-replay

轨迹重现（Trajectory Replay）——DeepSeek Harness 的即插即用 bundle 插件：把轨迹重放从"整 turn 级"细化到**具体某条 assistant 消息 / 工具调用**，提供原轨迹 vs 新执行的对比面板、step 级单步门控、执行台账，以及导出为会话 / Markdown / 原始日志。

纯插件实现，**不修改 harness 本体**（`dsh-checkout` 与运行安装零改动）。

---

## 功能特性

- **记录级重放（核心）**：可从轨迹里任意一条 **assistant 消息**或**工具调用**（step ≥ 2）开始重放——在该记录所在 step 之前切开，模型重新生成该记录及其后续。turn 级重放（从某条用户输入）同样支持。
- **全量 checkpoint**：重放点由 host 从**完整会话日志**派生（turn 级 + 记录级），一次拉取即全部，不受浏览器分页窗口限制。
- **turn 分组可折叠选择器**：checkpoint 按 turn 折叠成组，组头即 turn 级重放按钮，组内是各 step 的记录级重放点。
- **两种模式**：
  - **自动跑完**：fork → 续跑 → 与原轨迹并列对比。
  - **单步**：在 `agent/request` 处暂停，每次"继续"只放行一个模型请求；"撤销"丢弃并重跑至上一暂停点；"停止"保留子会话。
- **执行台账**：按 step 列出 assistant 文本与每个工具调用的参数/结果。
- **对比面板**：原轨迹（记录）与轨迹重现（新执行）并列表格；检查点之前可折叠，turn 级重放可勾选"合并"（`compactRegion` 摘要）。
- **导出**：导出为真实工作区会话（promote）、Markdown 轨迹、原始会话日志 ZIP。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 语言 | TypeScript（strict）、ESM（`"type": "module"`） |
| 宿主 | DeepSeek Harness 插件体系（Cordis）：`ctx.agents` / `ctx.sessions` / `ctx.webServer` / `ctx.compaction` / `ctx.slots` |
| 客户端 | React 18、CSS Modules、dsh client runtime（`conversation.view` 插槽、SnapshotStore、SessionFace 可观测快照）、tsdown（rolldown）打包 |
| 服务端路由 | `webServer` exact HTTP 路由（`/api/replay/*`），进程内注册表 |
| 构建 | host：`tsc`；client：`tsdown`（CSS Modules 内联注入）；类型检查：`tsc --noEmit` |

依赖的 harness 能力：`dsh-agent`（AgentRegistry）、`dsh-agent-loop`（ReactLoopAgent 驱动）、`dsh-session`（事件日志 / surface）、`dsh-llm`（createUserMessage）、`dsh-compaction`（compactRegion）、`dsh-agent-presets`（composition）。

---

## 技术创新点

1. **记录级重放，harness 零改动** —— 驱动要求"每个 turn 必须有 inbox 消息才能开步"，且 seed 不允许含未闭合 turn。方案：
   - 切点在记录所在 `step/start` 之前；seed 末尾补一条合成 `turn/end {interrupted}`（与 harness 崩溃恢复同款收口）通过会话校验；
   - `followup` 一条 `source: {kind:'plugin'}` 的中性 context 载体唤醒驱动开下一个 turn，模型请求由 `deriveMessages()` 从日志续接——**模型重新生成该记录及其后续**，全程不碰驱动代码。
2. **host 全量 checkpoint 派生** —— 浏览器窗口分页（本会话可达 25 万+ 事件），客户端派生只能看到尾部；改为 host 从完整 `session.events` 一次扫描生成全部可重放点，客户端一次 HTTP 拉取即全量。
3. **step 级单步门控** —— 在 `agent/request` 瀑布处按已执行步数暂停/放行，配合 `stopAt` 计数与"继续/撤销/停止"控制。
4. **隔离子会话 + promote** —— 子会话以 `origin:'subagent'` 创建、不挂工作区；完成后可复制日志为真实会话挂到原工作区（未闭合 turn 自动补 closers）。
5. **turn 分组可折叠选择器** —— 数百个重放点收敛为按 turn 折叠的组，组头即重放入口。

---

## 安装

本插件为 DeepSeek Harness bundle 插件，通过注入器装配（免重启，重启后由 `bundles` 列表接管，双路径一致）：

```powershell
# 热装配（需已构建出 lib/）
dev_install_package <插件目录>

# 或运行时注入
dev_build_plugin <插件目录>
dev_inject_plugin <插件目录>
```

装配后**刷新浏览器页面**：轨迹页签出现记录级 ▶ 按钮，"轨迹重现"页签出现完整 checkpoint 选择器。

---

## 使用

1. 打开任意会话的**轨迹**页签：
   - 用户输入行上的 **▶**：从该 turn 重放（自动跑完）。
   - assistant 消息 / 工具调用行上的 **▶**（step ≥ 2）：从该记录重放。
2. 打开**轨迹重现**页签：
   - checkpoint 按 turn 折叠；展开某 turn 可见各 step 的记录级重放点。
   - 每个重放点可选 **▶ 自动跑完** 或 **⏭ 单步**。
   - 单步模式下：**继续** 推进一步，**撤销** 回退一步，**停止** 中止但保留结果。
3. 完成后：**导出为会话/放到工作区**、**导出轨迹（Markdown）**、**导出原始日志**。

---

## 架构

- **host 半部**（`src/index.ts`）：进程内 `ReplayRegistry`（childId → {originalId, handle, mode, stopAt, gate}）；四条 exact 路由：
  - `POST /api/replay/start` —— 按 `kind: turn|message|tool` 计算切点、构造 seed（记录级补合成收口）、创建子会话（`origin:'subagent'`）、提交输入或 context 载体续跑；返回 `replayedTurn`。
  - `POST /api/replay/checkpoints` —— 从完整日志派生全量 checkpoint。
  - `POST /api/replay/control` —— `continue`（stopAt+1 并释放 gate）/ `stop` / `undo`。
  - `POST /api/replay/discard` / `promote`。
  - `agent/request` 瀑布监听器 —— step 模式门控。
- **client 半部**（`src/client/`）：
  - `replay-state.ts` —— `ReplayController`（状态机 idle/starting/running/paused/done/error）、会话快照源（后台 open 子会话窗口）、`deriveStepLedger`、`buildTrajectoryMarkdown`。
  - `replay-checkpoints.ts` —— host 全量 checkpoint 拉取、记录级键（`recordCheckpointKey`）。
  - `ReplayView.tsx` —— turn 分组可折叠选择器、运行控制、执行台账、两侧对比。
  - `TrajectoryTable.tsx` / `TrajectoryView.tsx` —— 轨迹表格内 turn 级与记录级重放按钮（一行最多一个 ▶）。

---

## 构建

```bash
# host：src → lib（需 DSH_CHECKOUT 指向含 node_modules/.bin/tsc 的 dsh checkout，
#       DSH_CORDIS_ROOT 指向已安装的 @deepseek-ai 树）
DSH_CHECKOUT=... DSH_CORDIS_ROOT=... bash scripts/build.sh

# client：lib/client.js（tsdown，CSS Modules 内联）
npm run build:client

# 客户端类型检查
npm run typecheck
```

---

## 已知限制

- **每步耗时 = 模型推理耗时**（约 20-25s/步，取决于上下文大小）：重放子会话与 harness 执行是同一驱动/同一条 LLM 调用路径，不存在更快的"原生"路径；重放点越靠后、seed 越大，每步越慢（turn 级可勾选"合并检查点之前"缓解，记录级暂不合并）。
- 记录级重放的续接 turn 开头会有一条 plugin-source context 载体消息（模型可见，与 harness 自身注入的 time-context 形态一致）——这是"不改驱动实现无输入续跑"的代价。
- 记录级重放跳过了 checkpoint 合并（`compactRegion` 跨 turn 边界不保证干净）。
- 一次只允许一个进行中的重放；新开始会丢弃上一个。
- 撤销会重跑前序步骤（工具副作用会重复）——append-only 日志下的诚实代价。

---

## License

BSD-3-Clause
