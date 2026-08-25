# ZCode for VSCode

在 VSCode 侧边栏直接使用 ZCode AI 编程助手:与 ZCode CLI 对话、流式输出、多轮会话续接、附件上下文。

![Version](https://img.shields.io/badge/version-0.1.0-blue) ![License](https://img.shields.io/badge/license-MIT-green)

## 功能

- **侧边栏聊天**:活动栏 ZCode 图标 → Chat,输入问题回车即发,回复实时流式渲染(支持 Markdown/代码块)
- **多轮会话**:同一对话自动通过 CLI `--continue` 续接上下文;"新建会话"按钮随时开新话题
- **工作区感知**:以当前工作区为 `--cwd` 运行,ZCode 可直接读写、执行项目内文件
- **附件**:通过命令或状态栏把当前文件 `--attach` 到下一次提问;支持自动附加活跃文件
- **选区提问**:编辑器右键 → "ZCode: 询问选中文本",选区自动引用进输入框
- **状态栏**:实时显示就绪/运行中/未配置三种状态,点击直达聊天
- **环境诊断**:`ZCode: 诊断环境 (doctor)` 一键查看 CLI 运行时状态

## 前置条件

本插件复用 **ZCode 桌面版** 自带的 CLI,默认路径:

| 组件 | 默认路径 |
|---|---|
| Node | `~/.zcode/server/node` |
| CLI | `~/.zcode/server/agents/glm/zcode.cjs` |

若路径不同或使用独立安装的 CLI,在设置(`zcode.nodePath` / `zcode.cliPath`)中指定。

CLI 需要 model 配置。若 `~/.zcode/cli/config.json` 中没有 `model` 键,headless 模式会报
`Model config is missing`。参考配置(与桌面版同一 provider):

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

> 注意:直接整段复制桌面版 `~/.zcode/v2/config.json` 的 `provider` 会因 CLI 端 schema 校验失败而被整体忽略(实测 0.15.2),只保留 `name/kind/options/enabled` 精简字段即可。

## 安装

### 从 VSIX(本仓库已构建)

```bash
code --install-extension zcode-vscode-0.1.0.vsix
```

### 从源码构建

```bash
npm install
npm run package      # typecheck + esbuild production
npx vsce package --no-dependencies
```

## 使用

1. 重载 VSCode 窗口后,点击活动栏 ZCode 图标(图标过多时收在 "Additional Views" / `···` 溢出区,可拖出固定)
2. 在输入框输入问题,Enter 发送(Shift+Enter 换行)
3. 运行中可点击"停止"终止本轮任务(杀整个进程组)
4. 命令面板(Cmd+Shift+P)可用命令:
   - `ZCode: 打开聊天`
   - `ZCode: 新建会话`
   - `ZCode: 停止当前任务`
   - `ZCode: 附加当前文件到下一次提问`
   - `ZCode: 询问选中文本`(也可编辑器右键)
   - `ZCode: 诊断环境 (doctor)`

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `zcode.nodePath` | `~/.zcode/server/node` | 运行 CLI 的 Node;不存在时回退系统 `node` |
| `zcode.cliPath` | `~/.zcode/server/agents/glm/zcode.cjs` | CLI 入口 |
| `zcode.mode` | `yolo` | 权限模式 `build/edit/plan/yolo`,对应 CLI `--mode`。**yolo = 所有工具自动放行**,注意风险 |
| `zcode.autoAttachActiveFile` | `false` | 每次发送自动附加当前活跃文件 |

## 已知限制(实测 CLI 0.15.2)

- `--settings` 参数在帮助中列出但实际不可用(`Unknown option`)
- `--max-turns` 与其他参数组合会触发参数解析 bug(打印帮助),本插件不使用
- TUI(`zcode tui`)在 node-bundle 发行形态下缺 `@zcode/tui` 依赖无法启动,因此本插件走 headless 路径而非终端复用
- 未信任(Restricted Mode)工作区内扩展不会激活,请信任工作区后使用

## 开发

```
src/extension.ts      激活、命令、状态栏
src/zcodeRunner.ts    CLI 定位/子进程管理/流式输出/进程组终止
src/chatView.ts       侧边栏 WebView Provider + 消息协议
src/webview/main.ts   聊天前端(流式 Markdown 渲染)
```

调试:F5 打开扩展开发宿主窗口。

## License

MIT
