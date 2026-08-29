# v0.4.2 之后的已知问题(延迟项清单)

v0.4.2 稳定版修复了全部 P1 与高危静默 P2(见 PR 描述)。以下为**本轮明确不修**的已知问题,按主题分组,供 v0.4.3+/v0.5 规划。

## 性能(v0.5 主题,M 级)

- 每帧(33ms)全量 JSON 深拷贝整个 UIState 再 postMessage(`sessionController.ts` pushNow):长会话流式期平方级开销
- live 区每帧全量重建 DOM + 全文重跑 marked 解析 + 工具卡重复 stringify(`webview/main.ts` renderLive):长 turn 后期掉帧;流式期间无法选中文字
- @ 文件补全每击键一次全工作区 findFiles:无防抖无缓存(大工作区输入体验)
- lineDiff 已降级防 OOM,但仍是朴素 LCS;超大核心区域降级为整块替换,精度受限

## controller/协议(P2 边角)

- steer 的 -32602 兜底 500ms 轮询依赖 live.active,极端时序下输入可能并入下一轮
- `send()` 无 live.active 守卫:双击/快捷键竞态可穿过 33ms 节流清空进行中的流式叠加层
- runtimeModel 永久缓存(含 null):修好 `~/.zcode/cli/config.json` 后本 controller 生命周期内不生效
- ensureStarted spawn 后未握手即置 connected:CLI 缺失时 UI 状态抖动
- 无会话时快速双发:两次 newSession 竞态可在服务器侧留下孤儿会话(chatView onMessage 'send')
- transport dispose 只杀直接子进程:app-server 的 MCP 孙进程可能孤儿(需 detached 进程组,回归风险大,单独评估)

## webview(P2 边角)

- history 区指纹不含内容:turn 中途快照可产生永久"运行中"的冻结 toolcard
- 点任意附件 chip 清空全部 chip(无单个移除)
- enhance 失败后 ✨ 按钮永久禁用(失败路径不回发消息)
- webview 加载完成前的 attachChip/prefill 消息丢失且缓冲被清
- 顶栏 ↺ 跳过 local- 乐观消息:快照到达前点击可多回退一整轮;send 失败时乐观消息不撤下
- "回复已完成"后台通知从未生效(notifyFileChanges/notifyTurnDoneInBackground 共享 wasLiveActive)
- 多问题用户输入:multiSelect 渲染为 radio、多问题共用 name、只回收一值、无自由文本输入
- Windows 路径全面失效(extractPath startsWith('/')、fileName 按 '/' 切分)
- retry 不清 seenPermKeys/permDiffs:权限 key 撞号后 diff 预览丢失
- 字符串 slice 可切断代理对(emoji 变 �)
- patch 部件"查看 diff"按钮实际只打开文件(openDiffOrFile 未接)

## 架构(v0.5 主题)

- sessionController 1072→约 1100 行仍承担约 15 类职责;EventProjector(纯函数)与 ConnectionLifecycle 拆分是最优先的两刀,顺带解锁单测
- UIState/extractPath 在 controller 与 webview 双份手工维护,应抽共享类型模块
- `clientOrThrow + sessionId 守卫 + request` 同构样板重复 10 处
