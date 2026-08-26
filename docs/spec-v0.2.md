# Spec: zcode-vscode v0.2 — Protocol-Native(体感对齐桌面版)

日期:2026-08-26 · 状态:approved · PR:见 `git branch --show-current` 对应 Draft PR

## 0. 背景与依据

v0.1 是 per-turn headless spawn(`--prompt`→stdout),每轮冷启动 ~12s、无结构化事件、无权限流、无会话管理。
调研结论(全部证据在 `/Users/mayuanyuan/Desktop/zcode-vscode-research/`):

- **zcode-app-server-protocol.md**(编码圣经):ZCode Protocol v1,NDJSON stdio,无握手,48 客户端方法 + 25 种 session/event + 3 种 interaction 服务器请求(权限/用户输入/provider headers,1s 起指数重发需按 requestId 去重)。已在真实 CLI 冒烟验证(create/subscribe/send/事件流/usage)。
- **claude-code-extension.md**:diff 审查用双虚拟 FileSystemProvider + `vscode.diff`;权限走 webview;IDE 上下文以文本块注入。
- **codex-extension.md**:JSON-RPC thread/turn/item 命名;webview 桥接协议分块传输。

## 1. 目标(验收即此清单)

常驻 `node zcode.cjs app-server --stdio` 进程 + 协议客户端,达成:

1. **免冷启动聊天**:第二问起仅模型延迟;`part.delta`/`model.streaming` 实时流式渲染
2. **工具卡片**:tool.updated(scheduled/started/progress/result/error)→ 卡片(工具名/输入/耗时/结果摘要,可展开);点击文件路径跳转编辑器
3. **权限确认 UI**:interaction/requestPermission → 选项按钮 + riskLevel 配色 + "记住规则(始终允许本次会话)"(permissionUpdates);requestUserInput(AskUserQuestion/plan 审批)→ 问题表单
4. **会话管理**:session/list 列表(标题/时间/mode)、resume(带 afterSeq 重订阅)、fork、新建;重启 VSCode 后能恢复列表与当前会话
5. **模型/模式切换**:workspace/readState 取目录 → session/setModel / setThoughtLevel / setMode
6. **停止/steer**:停止按钮 → session/stop(旁路队列,即时);输入框在运行中可发送 steer 追加指令
7. **上下文注入**:命令把当前文件/选区引用进输入框(@文件 chip 形态或文本引用)
8. **patch 通知**:patch part(文件列表)→ 提示条 + 打开 git diff(有 git 时)/文件
9. **回滚**:rewind(latestCheckpoint/message)conversation scope + previewFileRewind 安全提示

## 2. 非目标(v0.3+)

- 虚拟 FS 双侧 diff 编辑审查(Claude Code 式 accept/reject 编辑)
- 云端任务、遥测、marketplace 发布、多窗口多会话并发
- subagent 树形视图(origin 字段已含,先只打 "subagent" 徽标)

## 3. 架构

```
extension host (node)
├── protocol/
│   ├── transport.ts   spawn/NDJSON 分帧/行解析/stderr→OutputChannel;可注入流做单测
│   ├── client.ts      四类帧分类;id 分配;pending map+超时;服务器请求分发器
│   │                  (interaction 三类,去重记录最新帧 id);respond/respondError
│   └── types.ts       协议类型(宽松:unknown 字段忽略,不引 zod 运行时依赖)
├── controller/
│   └── sessionController.ts  连接生命周期(崩溃自动重启+resume+afterSeq 续订);
│        事件→UI 投影(messages/parts/toolCalls/pendingPerm/checkpoints 状态机);
│        对 webview 暴露命令式 API + 批量渲染状态推送(~33ms 节流)
└── ui/  chatView.ts(v2)+ webview/main.ts(纯渲染器,收 renderState 全量/增量 delta)
```

关键决策:
- **控制器持有权威状态**,webview 是哑渲染器(收 `state` 快照/`append delta`),避免两端事件溯源分叉
- **权限应答必须回应最新重发帧的 id**(client 层维护 requestId→最新 server frame)
- **strict schema**:只发协议文档内字段;解析容错(unknown 忽略)
- 失败回退:协议进程连续崩溃 3 次 → 状态栏降级提示 + 显示错误,不静默重试

## 4. Tickets(任务图,依赖序)

| # | ticket | 依赖 | 产出 |
|---|---|---|---|
| T1 | protocol/transport+client+types | — | 帧/请求/分发/去重,单测(mock server) |
| T2 | SessionController+连接生命周期+集成冒烟 | T1 | controller API;scripts/protocol-smoke 进 repo 并通过(真实 CLI) |
| T3 | webview v2 渲染骨架 | T2 | state 驱动 UI:消息/部件/流式/工具卡片/停止/steer |
| T4 | 权限+用户输入 UI | T3 | interaction 全流程(含 plan 审批、记规则) |
| T5 | 模型/模式/思考选择器 | T3 | readState 目录 + set* |
| T6 | 会话列表/恢复/fork + rewind | T3 | session 管理 + checkpoint 回滚 |
| T7 | 编辑器上下文注入 + patch 通知 | T2 | 命令、chip、diff 打开 |
| T8 | 打包 0.2.0 + README + CDP 端到端(含权限流) | T3–T7 | vsix 安装 + e2e 证据 |

Frontier 演进:T1 → T2 → {T3,T7} → {T4,T5,T6} → T8

## 5. 验收标准(硬性)

1. `npm run typecheck` 与 esbuild 通过;`node scripts/protocol-smoke.cjs` 真实 CLI 全绿
2. CDP 端到端:发消息流式渲染;提示 "创建文件 hello.txt"(build 模式)→ 权限弹卡 → 批准 → 文件存在;session/stop 即时中断;切模型后生效;会话恢复保留上下文
3. 每个 ticket 独立 commit+merge 到 spec 分支;最终 code-review 通过后转正 PR

## 6. 风险

- CLI 0.15.2 与协议文档(0.13.3 逆向)可能有字段漂移 → 解析容错 + 冒烟护栏
- interaction 重发帧答旧 id 挂死 → client 层强制"最新帧 id"应答,单测覆盖
- session/send 无回调流式(part.delta 走通知)→ 渲染节流避免 webview 洪泛
