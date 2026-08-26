# Tickets v0.2(protocol-native)

规则:每 ticket 一个分支(worktree)+ 独立 PR→spec 分支;`docs/spec-v0.2.md` 是总纲,
`/Users/mayuanyuan/Desktop/zcode-vscode-research/zcode-app-server-protocol.md` 是协议权威(字段逐字引用它)。

## T1 protocol/transport+client+types
- `src/protocol/types.ts`:四类帧 + 48 方法 params/result 的 TS 类型(宽松:`[k:string]:unknown` 兼容漂移)
- `src/protocol/transport.ts`:spawn(注入 streams 可测)/ NDJSON 行解析(残行缓冲)/ stderr 回调 / exit 处理
- `src/protocol/client.ts`:request(id 递增/超时/pending)、notify、respond/respondError、
  服务器帧四分类、`onNotification(session/event|state.updated|prompt/enhance/result)`、
  `onServerRequest` 注册表;**interaction 去重**:requestId→最新帧(重发更新 id,应答用最新)
- 单测 `src/protocol/client.test.ts`(node:test,mock 传输):帧分类/超时/去重/双响应幂等
- 验证:`npm run typecheck` + `node --test`

## T2 SessionController + 生命周期 + 冒烟
- `src/controller/sessionController.ts`:
  - ensureStarted(用 `resolveBinaries()`)/ 崩溃重启(≤3 次)/ resume + afterSeq 重订
  - API:createOrResume/list/send(content)/steer/stop/setMode/setModel/setThoughtLevel/fork/rewind/close/usage
  - 事件投影:`messages`(MessageWithParts by messageId)、`parts` 增量(part.delta→part 文本追加)、
    `toolCalls`(tool.updated 状态机)、`pendingPermissions`、`checkpoints`、`status/mode/model/contextUsage`
  - 渲染推送:节流 33ms 全量 state(structuredClone)→ webview
  - 权限/用户输入:转发 UI,UI 应答→client.respond(最新帧 id)
- `scripts/protocol-smoke.cjs`(从 /tmp/zc-protocol-smoke.cjs 改造入 repo,加 file-edit 权限场景)
- 验证:smoke 真实 CLI 全绿(含一次 permission auto-allow 计数≥1)

## T3 webview v2 渲染骨架
- 重写 `src/webview/main.ts` 为 state 驱动:`{status,mode,model,sessions,currentSessionId,messages[],input,running}`
- 消息渲染按 parts:text(markdown)/ reasoning(折叠)/ tool(卡片:状态图标/名称/输入 JSON 折叠/耗时/结果摘要)/ patch(文件列表)/ step-finish(cost+tokens)
- 流式:assistant 尾部 delta 光标;33ms 批次
- 顶栏:会话名 + mode/model 徽标 + [新建][停止/发送 输入框(运行中=steer 提示)]
- 验证:CDP 手测路径可用(#chat/#input 结构保持 e2e 兼容)

## T4 权限+用户输入 UI
- pendingPermissions 渲染:工具名+reason+riskLevel 配色(low 绿/medium 黄/high 橙/critical 红)+ input 摘要 + options 按钮
- checkbox "本会话始终允许" → permissionUpdates addRules(behavior:allow)
- requestUserInput:questions 表单(单选/多选/自由文本)→ {action:accept,content}
- plan 审批(schema.interaction==="plan_approval")用 Approve 文案
- 验证:build 模式触发 Edit 权限→批准→文件修改成功(CDP)

## T5 模型/模式/思考选择器
- `workspace/readState` 取 providers/models/thoughtLevelOptions(容错解析)
- 徽标点击 → QuickPick(vscode 原生)→ session/setModel|setThoughtLevel|setMode
- 状态同步:session.updated/state.updated → 重拉或用快照字段
- 验证:切换后 snapshot.model 变化且下一轮生效

## T6 会话列表/恢复/fork + rewind
- 会话下拉(session/list,按 updatedAt 排序,显示 title/mode/相对时间)
- resume:session/resume + subscribe(afterSeq)+ 全量 messages 渲染;fork 按钮(latestCheckpoint)
- rewind:对话回退(target latestCheckpoint/message)+ previewFileRewind 显示 safe/unsafe/ignored
- 验证:两个会话切换上下文互不串;rewind 后消息列表回退

## T7 编辑器上下文注入 + patch 通知
- 命令:附加当前文件/选区到输入框(chip 列表,发送时拼入 content 引用块,风格仿 `<ide_selection>`)
- patch part → 通知条(vscode.window 信息)+ 命令打开 diff(git 有则 vscode.diff HEAD~ vs 工作区,否则 open file)
- 工具卡 input.path/file_path 字段 → 点击打开编辑器(定位行号若可)
- 验证:选区引用出现在发送的 content;patch 后能一键看 diff

## T8 打包 0.2.0 + README + CDP e2e
- version 0.2.0;README 重写(协议架构图、新配置、旧 headless 说明移附录)
- e2e(CDP 方法沿用 v0.1 验证脚本思路,入 scripts/e2e-cdp.mjs):流式/权限/停止/切模型/会话恢复
- vsce 打包安装到本机 VSCode,隔离实例全绿证据
