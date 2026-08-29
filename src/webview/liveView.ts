export interface LiveStateLike {
  active: boolean;
  turnError?: string;
}

export type LiveAction = 'stream' | 'error' | 'clear';

/**
 * live 区渲染决策。关键约束:turnError 会驻留在状态里直到下一轮 beginLive/会话切换,
 * 因此"错误"检查必须先于"空闲清空"——否则 turn.failed 后的任何一次状态推送
 * (会话列表刷新、400ms 快照等)都会立刻把错误面板擦掉,失败反馈只存活约 0.4s。
 */
export function liveViewAction(live: LiveStateLike): LiveAction {
  if (live.active) {
    return 'stream';
  }
  if (live.turnError) {
    return 'error';
  }
  return 'clear';
}
