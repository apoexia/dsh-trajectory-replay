# @dsh-external/dsh-trajectory-replay

轨迹重现插件：把轨迹重放粒度细化到**具体某条 assistant 消息 / 工具调用**（记录级），提供原轨迹 vs 新执行对比、step 级单步门控与执行台账。纯插件实现，**不修改 harness**。

## 架构

**host 半部**（`src/index.ts`，进程内 `ReplayRegistry`）

- `POST /api/replay/start` —— 按 `kind: turn|message|tool` 计算切点 → 构造 seed（记录级以合成 `turn/end {interrupted}` 收口 + plugin-source context 载体续跑）→ 创建 `origin:'subagent'` 子会话
- `POST /api/replay/checkpoints` —— 从完整会话日志派生**全量**可重放点（turn 级 + 记录级，不受浏览器分页限制）
- `POST /api/replay/control` / `discard` / `promote` —— 单步继续/撤销/停止、清理、导出为工作区会话
- `agent/request` 瀑布监听 —— step 模式门控

**client 半部**（`src/client/`）

- `replay-state.ts` —— `ReplayController` 状态机 + 会话快照源（后台 open 子会话窗口）
- `ReplayView.tsx` —— 按 turn 折叠的 checkpoint 选择器、运行控制、执行台账、两侧对比面板
- `TrajectoryTable.tsx` / `TrajectoryView.tsx` —— 轨迹表格内 turn 级与记录级重放按钮（一行最多一个 ▶）
- `replay-checkpoints.ts` —— host 全量 checkpoint 拉取

## 安装

一键安装（构建 + 装配到 profile，默认 `web`）：

```bash
bash scripts/install.sh            # 或 bash scripts/install.sh <profile名>
```

脚本执行：① `tsc` 构建 host；② `tsdown` 构建 client；③ 在目标 profile 建立 `node_modules` junction、写入 `package.json` 的 `link:` 依赖与 `bundles` 条目、禁用官方 `ui-trajectory` 条目（全部幂等）。

- 重启 dsh 生效；运行中的 harness 免重启：`dev_inject_plugin <本目录>`。
- 装配后**刷新浏览器页面**使用。

## 构建（仅编译，不装配）

```bash
npm install
bash scripts/build.sh   # host（需 DSH_CHECKOUT）
npm run build:client    # client（tsdown）
```
