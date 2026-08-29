/** LCS 槽位上限:修剪公共前后缀后仍超出则降级为整块替换(防扩展宿主 OOM,实测 2 万行 ≈3.2GB) */
const LCS_CELL_LIMIT = 4_000_000;
/** 输出行上限(降级/极端场景下预览仍有界) */
const OUTPUT_LINE_LIMIT = 4000;

/** 行 diff,输出带 +/- 前缀的行(权限预览用,无需 patch 兼容格式) */
export function lineDiff(aText: string, bText: string, context = 3): string[] {
  const a = aText === '' ? [] : aText.split('\n');
  const b = bText === '' ? [] : bText.split('\n');

  const n = a.length;
  const m = b.length;

  // 先修剪公共前缀/后缀行:Write/Edit 的改动通常集中在文件中部
  let lo = 0;
  while (lo < n && lo < m && a[lo] === b[lo]) {
    lo++;
  }
  let hiA = n;
  let hiB = m;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) {
    hiA--;
    hiB--;
  }
  const coreA = a.slice(lo, hiA);
  const coreB = b.slice(lo, hiB);

  // 编辑脚本
  type Op = { t: '=' | '-' | '+'; line: string };
  const ops: Op[] = [];
  for (let i = 0; i < lo; i++) {
    ops.push({ t: '=', line: a[i] });
  }
  let degraded = false;
  if (coreA.length * coreB.length > LCS_CELL_LIMIT) {
    // 降级:核心区域整块替换,不求精确 LCS;每侧只保留头部若干行供预览
    degraded = true;
    const head = 400;
    for (const line of coreA.slice(0, head)) {
      ops.push({ t: '-', line });
    }
    for (const line of coreB.slice(0, head)) {
      ops.push({ t: '+', line });
    }
  } else {
    // LCS 表(修剪后 O(coreA*coreB),已被上限约束)
    const cn = coreA.length;
    const cm = coreB.length;
    const lcs: number[][] = Array.from({ length: cn + 1 }, () => new Array<number>(cm + 1).fill(0));
    for (let i = cn - 1; i >= 0; i--) {
      for (let j = cm - 1; j >= 0; j--) {
        lcs[i][j] = coreA[i] === coreB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < cn && j < cm) {
      if (coreA[i] === coreB[j]) {
        ops.push({ t: '=', line: coreA[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        ops.push({ t: '-', line: coreA[i] });
        i++;
      } else {
        ops.push({ t: '+', line: coreB[j] });
        j++;
      }
    }
    while (i < cn) {
      ops.push({ t: '-', line: coreA[i++] });
    }
    while (j < cm) {
      ops.push({ t: '+', line: coreB[j++] });
    }
  }
  for (let i = hiA; i < n; i++) {
    ops.push({ t: '=', line: a[i] });
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
    if (out.length >= OUTPUT_LINE_LIMIT) {
      out.push(`(diff 过大,已截断,共 ${ops.length} 行)`);
      return out;
    }
  }
  if (degraded) {
    out.push('(差异过大,已降级为整块替换,每侧仅显示前 400 行)');
  }
  return out;
}
