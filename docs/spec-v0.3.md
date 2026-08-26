# Spec: zcode-vscode v0.3 — Diff 审查与体验打磨

日期:2026-08-26 · 前置:v0.2.0(PR #2)· 仓库已公开

## 0. 动机

v0.2 端到端已 PASS,但相对桌面版仍有三处差距:
1. **批准前看不到改什么**:Write/Edit 权限卡只显示 JSON 输入,桌面版可见改动内容
2. **长对话体验**:webview 全量重渲染丢 `<details>` 展开态
3. **未活体验证的 功能**:fork/rewind/steer/模型切换/停止(e2e 只覆盖权限流)

## 1. 目标

1. **权限卡 diff 预览**:Write/Edit 权限卡内嵌改动预览(Edit: old_string→new_string;Write: 与当前文件内容的逐行 diff,+/- 行配色)。扩展宿主生成 diff 文本,webview 只渲染
2. **渲染态保持**:details 展开状态跨全量渲染保持(key=权限/工具调用标识);回滚/切换会话后滚动位置复位到底部
3. **e2e 扩展**(scripts/e2e-cdp.mjs):stop 中断、steer 追加、rewind 消息回退、fork 会话分叉、模型切换生效——逐项活体验证并记录结果
4. **marketplace-ready**:package.json 补 repository 字段;README 加公开仓库徽章;版本 0.3.0

## 2. Tickets

| # | ticket | 依赖 |
|---|---|---|
| V1 | 渲染态保持(details open 集合 + 渲染后重应用) | — |
| V2 | 权限 diff 预览(宿主 diff 工具 + readFile 通道 + 卡内渲染) | V1(同文件) |
| V3 | e2e 扩展五项活体验证 | V2 |
| V4 | 0.3.0 发布(repository 字段/README/打包安装/记忆) | V3 |

## 3. 验收

- e2e 权限流照旧 PASS 且权限卡内出现 diff 预览节点
- e2e 新增五项:逐项输出 OK/SKIP 与证据行
- tsc/单测/冒烟全绿;0.3.0 装入本机与隔离实例
