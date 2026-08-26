/** 朴素 LCS 行 diff,输出带 +/- 前缀的行(权限预览用,无需 patch 兼容格式) */
export function lineDiff(aText: string, bText: string, context = 3): string[] {
  const a = aText === '' ? [] : aText.split('\n');
  const b = bText === '' ? [] : bText.split('\n');

  // LCS 表(O(n*m),权限预览的文件规模可接受)
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  // 回溯得到编辑脚本
  type Op = { t: '=' | '-' | '+'; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: '=', line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ t: '-', line: a[i] });
      i++;
    } else {
      ops.push({ t: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ t: '-', line: a[i++] });
  }
  while (j < m) {
    ops.push({ t: '+', line: b[j++] });
  }

  // 压缩:等同行只保留变更块周围 context 行
  const out: string[] = [];
  if (!ops.some((op) => op.t !== '=')) {
    return out;
  }
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.t !== '=') {
      for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) {
        keep[k] = true;
      }
    }
  });
  let skipping = false;
  for (let k = 0; k < ops.length; k++) {
    if (keep[k]) {
      out.push(ops[k].t === '=' ? ' ' + ops[k].line : ops[k].t + ops[k].line);
      skipping = false;
    } else if (!skipping) {
      out.push('⋯');
      skipping = true;
    }
  }
  return out;
}
