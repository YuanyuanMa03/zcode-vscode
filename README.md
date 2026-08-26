# ZCode for VSCode

在 VSCode 侧边栏获得与 ZCode 桌面版几乎一致的 AI 编程体验:常驻协议进程、流式对话、工具调用卡片、权限审批、多会话管理、检查点回滚。

![Version](https://img.shields.io/badge/version-0.2.0-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## v0.2 架构(协议原生)

```
VSCode 扩展宿主
├── protocol/     ZCode Protocol v1 客户端(NDJSON stdio)
│   ├── transport 帧收发/残行缓冲/stderr 日志
│   └── client    请求配对/超时/interaction 去重(重发帧应答最新 id)
├── controller/   SessionController:会话生命周期、事件投影(25 种 session/event)、
│                 崩溃自动重启(≤3 次)+ resume/afterSeq 续订、33ms 节流 UIState
└── webview       纯渲染器:消息/部件/流式光标/工具卡/权限卡/会话下拉/上下文条
        ↕
~/.zcode/server/node zcode.cjs app-server --stdio(与桌面版同一协议进程)
```

## 功能

- **免冷启动多轮对话**:常驻进程,第二问起仅模型延迟;`model.streaming`/`part.delta` 实时渲染
- **工具卡片**:工具名/状态/耗时/输入输出(可折叠),文件路径一键跳转
- **权限审批**:风险分级配色(low/medium/high/critical),Allow once / Always allow in this project / Deny,与桌面版同款选项
- **用户输入表单**:AskUserQuestion、计划审批(plan approval)
- **会话管理**:启动自动恢复最近会话;下拉切换历史会话;一键新建 / fork(检查点分叉)/ rewind(对话回滚)
- **模型与模式**:模型选择器(真实 workspace/readState 目录)、plan/build/edit/yolo 切换
- **上下文注入**:当前文件/选区引用(chip 形态,编辑器右键"询问选中文本")
- **改动通知**:turn 结束后 Write/Edit 落盘文件弹通知,一键查看 git diff
- **steer**:运行中回车追加指令;停止按钮即时中断(session/stop 旁路队列)

## 前置条件

复用 ZCode 桌面版自带的 CLI(默认路径):

| 组件 | 默认路径 |
|---|---|
| Node | `~/.zcode/server/node` |
| CLI | `~/.zcode/server/agents/glm/zcode.cjs` |

CLI 需要 model 配置(`~/.zcode/cli/config.json`):

```json
{
  "model": "builtin:bigmodel-coding-plan/GLM-5.3",
  "provider": {
    "builtin:bigmodel-coding-plan": {
      "name": "BigModel - Coding Plan",
      "kind": "anthropic",
      "options": { "apiKey": "<你的 key>", "baseURL": "https://open.bigmodel.cn/api/anthropic" },
      "enabled": true
    }
  }
}
```

> 不要整段复制桌面版 `v2/config.json` 的 provider(CLI 端 schema 校验会静默忽略);只保留 `name/kind/options/enabled`。

## 安装与构建

```bash
code --install-extension zcode-vscode-0.2.0.vsix
# 或从源码
npm install && npm run package && npx vsce package --no-dependencies
```

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `zcode.nodePath` | `~/.zcode/server/node` | 运行 CLI 的 Node |
| `zcode.cliPath` | `~/.zcode/server/agents/glm/zcode.cjs` | CLI 入口 |
| `zcode.mode` | `yolo` | 新会话默认权限模式(**yolo=全自动放行,介意请改 build**) |
| `zcode.autoAttachActiveFile` | `false` | 兼容旧版设置(协议模式下用上下文 chip) |

## 开发

```bash
npm run typecheck          # tsc --noEmit
node --test src/protocol/client.test.ts   # 协议层单测
node scripts/protocol-smoke.ts [ws] [prompt] [mode]  # 真实 CLI 集成冒烟
node scripts/e2e-cdp.mjs   # 隔离 VSCode 实例 CDP 端到端(含权限流)
```

代码结构见 `docs/spec-v0.2.md` 与 `docs/tickets-v0.2.md`。

## 已知限制

- 协议为 ZCode 内部契约(逆向自 0.13.3 双 bundle,实测 0.15.2 兼容),CLI 大版本升级可能破坏兼容
- 权限/工具卡在 webview 全量重渲染时 `<details>` 展开状态会重置(长对话场景待优化)
- 编辑器内联 diff 审查(accept/reject)计划 v0.3(参考 Claude Code 双虚拟 FS 方案)
- 未信任(Restricted Mode)工作区扩展不激活

## License

MIT
