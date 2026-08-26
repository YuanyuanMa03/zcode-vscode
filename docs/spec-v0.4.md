# Spec: zcode-vscode v0.4 — 真实可用的日用级(对标 Claude Code / Codex)

日期:2026-08-26 · 前置:v0.3.0(e2e 7/7)

## 0. 差距来源(对照两款官方插件逆向笔记)

| 日用场景 | Claude Code / Codex | 我们 v0.3 | v0.4 动作 |
|---|---|---|---|
| 提示词编辑器 | @-file 引用、上下文附件、增强按钮(Codex enhance) | 仅路径 chip | **@文件补全 + /命令补全 + ✨增强(prompt/enhance)** |
| 上下文管理 | autocompact/手动 compact | 无 | **compact 按钮 + >60% 显示 + 高占用提醒** |
| 后台完成感知 | 完成通知 | 无 | **视图不可见时 turn 完成弹通知** |
| 配置失败体验 | 引导面板 | 一行错误文本 | **失败面板:诊断/设置按钮** |
| 快捷入口 | 键绑定 | 无 | **openChat / askSelection 键绑定** |
| 渲染性能 | — | 全量 innerHTML @33ms(闪烁/CPU) | **history/live/interactions 分层渲染 + 指纹跳过** |
| 状态栏 | 模型/token | 仅状态 | **附上下文 token 数** |
| 真实任务验证 | — | 单步场景 | **e2e R 场景:多工具真实编码任务** |

## 1. Tickets

| # | ticket | 内容 |
|---|---|---|
| W1 | 渲染分层 | #history(消息指纹变更才渲染)/#live(运行中 33ms)/#interactions(权限/表单指纹);chip 携带绝对路径并发送时引用真实路径 |
| W2 | Composer 2.0 | @→文件补全(findFiles 模糊)、/→命令补全(snapshot.slashCommands 宽松解析)、✨增强(prompt/enhance 回填输入框)、replaceInput 消息 |
| W3 | 上下文管理 | controller.compact(session/compact);头部 Compact 按钮(usage>60% 出现);>85% 一次性 toast 建议;状态栏 token 数 |
| W4 | 触达与容错 | 后台完成通知(视图不可见);connection=failed 失败面板(运行诊断/打开设置按钮);键绑定 cmd+alt+z / cmd+alt+a |
| W5 | 验证与发布 | e2e 增:R 真实任务(多工具+多权限)、@弹窗、enhance;0.4.0 发布装主实例;README |

## 2. 验收

- e2e 9+ 场景全绿(7 旧 + R 真实任务 + @/enhance 至少冒烟)
- 渲染:长对话(20+ 消息)运行中肉眼无整页闪烁;live 区独立滚动定位
- 真实任务:让 Agent 改代码 + 跑命令,多工具卡 + 多权限批准全链路成功
- tsc / 单测 / 冒烟全绿
