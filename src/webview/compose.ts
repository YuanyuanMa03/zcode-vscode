/** 组装发送内容:带 path 的附件 chip 以文件清单前缀注入提示词 */
export function composePrompt(text: string, chips: { label: string; path?: string }[]): string {
  const files = chips.filter((c) => c.path);
  if (!files.length) {
    return text;
  }
  return `参考以下文件:\n${files.map((c) => `- ${c.path}`).join('\n')}\n\n${text}`;
}
