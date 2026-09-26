/*
 * verify 服务入口：代码测试 + 构建检查 + 页面 HTTP 冒烟。
 * 全部完成后退出，退出码 0 表示通过、1 表示存在失败。
 *
 * 用法：node verify/run.js   （WEB_URL 环境变量指向被测页面，默认 http://127.0.0.1:8080）
 */
'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DSATUR = require(path.join(ROOT, 'dsatur.js'));
const Validate = require(path.join(ROOT, 'validate.js'));

const WEB_URL = (process.env.WEB_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

let passed = 0;
let failed = 0;

function report(ok, name, err) {
  if (ok) {
    passed++;
    console.log(`ok ${passed + failed} - ${name}`);
  } else {
    failed++;
    console.error(`not ok ${passed + failed} - ${name}`);
    console.error(
      String((err && err.stack) || err)
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n')
    );
  }
}

function test(name, fn) {
  try {
    fn();
    report(true, name);
  } catch (err) {
    report(false, name, err);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    report(true, name);
  } catch (err) {
    report(false, name, err);
  }
}

/* ---------- 工具：确定性伪随机与重排 ---------- */

function lcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// 录入重排：打乱通道顺序、打乱边的顺序并随机交换端点
function reorder(ids, pairs, rand) {
  const ids2 = ids.slice();
  for (let i = ids2.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [ids2[i], ids2[j]] = [ids2[j], ids2[i]];
  }
  const pairs2 = pairs
    .map((p) => (rand() < 0.5 ? [p[1], p[0]] : [p[0], p[1]]))
    .sort(() => rand() - 0.5);
  return [ids2, pairs2];
}

// 测试专用暴力色数（仅用于交叉验证，不属于产品代码）
function bruteChi(n, pairs) {
  const nbr = Array.from({ length: n }, () => []);
  for (const [a, b] of pairs) {
    nbr[a].push(b);
    nbr[b].push(a);
  }
  const color = new Array(n).fill(-1);
  function rec(v, k) {
    if (v === n) return true;
    for (let c = 0; c < k; c++) {
      let ok = true;
      for (const u of nbr[v]) {
        if (color[u] === c) {
          ok = false;
          break;
        }
      }
      if (ok) {
        color[v] = c;
        if (rec(v + 1, k)) return true;
        color[v] = -1;
      }
    }
    return false;
  }
  for (let k = 1; k <= n; k++) {
    if (rec(0, k)) return k;
  }
  return n;
}

/* ---------- 1. 代码测试：DSATUR 精确求解 ---------- */

test('三角冲突需要 3 个频段', () => {
  const r = DSATUR.solveGraph(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['A', 'C']]);
  assert.strictEqual(r.k, 3);
  assert.strictEqual(r.lb, 3, '最大团下界应为 3');
  assert.deepStrictEqual(r.bands, [['A'], ['B'], ['C']]);
});

test('四通道完全冲突需要 4 个频段', () => {
  const ids = ['C1', 'C2', 'C3', 'C4'];
  const pairs = [];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) pairs.push([ids[i], ids[j]]);
  }
  const r = DSATUR.solveGraph(ids, pairs);
  assert.strictEqual(r.k, 4);
  assert.strictEqual(r.lb, 4);
});

test('二分链式关系需要 2 个频段', () => {
  const r = DSATUR.solveGraph(['A', 'B', 'C', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D']]);
  assert.strictEqual(r.k, 2);
  assert.deepStrictEqual(r.bands, [['A', 'C'], ['B', 'D']]);
  assert.strictEqual(DSATUR.verifyAssignment([['A', 'B'], ['B', 'C'], ['C', 'D']], r.bandOf).length, 0);
});

test('奇环 C5 需要 3 个频段（下界 2 < 3，须经分支定界证明）', () => {
  const ids = ['V1', 'V2', 'V3', 'V4', 'V5'];
  const pairs = [['V1', 'V2'], ['V2', 'V3'], ['V3', 'V4'], ['V4', 'V5'], ['V5', 'V1']];
  const r = DSATUR.solveGraph(ids, pairs);
  assert.strictEqual(r.k, 3);
  assert.strictEqual(r.lb, 2, 'C5 最大团为 2');
  assert.ok(r.nodes > 0, '应实际执行分支定界搜索');
});

// 束流诊断柜十一通道网络：五通道奇环 + 五个辅助通道（各干扰环上相邻两端）
// + 一个汇聚通道（干扰全部辅助）。下界 3 < 色数 4，须经分支定界精确判定。
function beamNetwork() {
  const ids = ['V1', 'V2', 'V3', 'V4', 'V5', 'A1', 'A2', 'A3', 'A4', 'A5', 'H'];
  const pairs = [];
  // 五通道奇环
  pairs.push(['V1', 'V2'], ['V2', 'V3'], ['V3', 'V4'], ['V4', 'V5'], ['V5', 'V1']);
  // 辅助通道 Ai 同时干扰环上相邻的 Vi 与 V(i+1)
  pairs.push(
    ['A1', 'V1'], ['A1', 'V2'],
    ['A2', 'V2'], ['A2', 'V3'],
    ['A3', 'V3'], ['A3', 'V4'],
    ['A4', 'V4'], ['A4', 'V5'],
    ['A5', 'V5'], ['A5', 'V1']
  );
  // 汇聚通道 H 干扰全部五个辅助通道
  for (let i = 1; i <= 5; i++) pairs.push(['H', 'A' + i]);
  return { ids, pairs };
}

// 结论内部一致性：色数 / 升序规范分配 / 频段清单 / 下界上界 / 统计彼此复算
function assertCoherent(r, ids, pairs) {
  assert.strictEqual(r.channels.length, ids.length);
  assert.deepStrictEqual(
    r.channels,
    ids.slice().sort(),
    '通道序列应按标识升序'
  );
  assert.strictEqual(r.bands.length, r.k, '频段清单条数应等于最少频段数');
  assert.ok(r.lb <= r.k && r.k <= r.ub, '下界 / 色数 / 初始上界应有序');
  assert.ok(r.nodes > 0, '下界未达色数时应实际执行分支定界');
  // 频段清单是全部通道的一个划分
  const listed = r.bands.flat();
  assert.deepStrictEqual(listed.slice().sort(), r.channels, '频段清单应恰好覆盖全部通道');
  // 规范编号：频段按组内最小通道标识升序排列，每组内部按标识升序
  const mins = r.bands.map((g) => g[0]);
  for (let i = 1; i < mins.length; i++) {
    assert.ok(mins[i - 1] < mins[i], '频段应按组内最小标识升序编号');
  }
  // 逐边跨频段：每条已录入干扰关系的两端必须分属不同频段
  for (const [a, b] of pairs) {
    assert.ok(r.bandOf[a] >= 1 && r.bandOf[a] <= r.k, `通道 ${a} 频段越界`);
    assert.notStrictEqual(r.bandOf[a], r.bandOf[b], `干扰边 ${a}-${b} 落在同一频段`);
  }
  assert.strictEqual(DSATUR.verifyAssignment(pairs, r.bandOf).length, 0);
}

test('十一通道网络精确判定为 4 个频段，且结论各部分彼此一致', () => {
  const { ids, pairs } = beamNetwork();
  assert.strictEqual(ids.length, 11);
  assert.strictEqual(pairs.length, 20, '5 环边 + 10 辅助边 + 5 汇聚边');
  const r = DSATUR.solveGraph(ids, pairs);
  assert.strictEqual(r.k, 4, '该网络必须精确判定为 4 个频段');
  assert.strictEqual(r.lb, 3, '辅助-环边构成三角形，最大团下界为 3');
  assertCoherent(r, ids, pairs);
  // 与暴力色数交叉验证：确为 4 色、非 3 色
  const sorted = ids.slice().sort();
  const index = new Map(sorted.map((id, i) => [id, i]));
  const numPairs = pairs.map(([a, b]) => [index.get(a), index.get(b)]);
  assert.strictEqual(bruteChi(ids.length, numPairs), 4);
});

test('十一通道网络重排录入顺序（通道 / 边 / 端点方向）后规范结论不变', () => {
  const { ids, pairs } = beamNetwork();
  const base = DSATUR.solveGraph(ids, pairs);
  const rand = lcg(2026092611);
  for (let t = 0; t < 10; t++) {
    const [ids2, pairs2] = reorder(ids, pairs, rand);
    const r = DSATUR.solveGraph(ids2, pairs2);
    assert.strictEqual(r.k, 4, '重排后色数改变');
    assert.strictEqual(r.lb, base.lb, '重排后最大团下界改变');
    assert.strictEqual(r.nodes, base.nodes, '重排后分支定界节点数改变');
    assert.deepStrictEqual(r.bandOf, base.bandOf, '重排后规范分配改变');
    assert.deepStrictEqual(r.bands, base.bands, '重排后频段清单改变');
    assertCoherent(r, ids, pairs);
  }
});

test('无干扰边时只需 1 个频段', () => {
  const r = DSATUR.solveGraph(['A', 'B', 'C'], []);
  assert.strictEqual(r.k, 1);
  assert.deepStrictEqual(r.bands, [['A', 'B', 'C']]);
});

test('录入重排后规范分配保持一致（三角 / K4 / 链式 / 组合图）', () => {
  const cases = [
    { ids: ['A', 'B', 'C'], pairs: [['A', 'B'], ['B', 'C'], ['A', 'C']] },
    {
      ids: ['C1', 'C2', 'C3', 'C4'],
      pairs: [['C1', 'C2'], ['C1', 'C3'], ['C1', 'C4'], ['C2', 'C3'], ['C2', 'C4'], ['C3', 'C4']],
    },
    { ids: ['A', 'B', 'C', 'D'], pairs: [['A', 'B'], ['B', 'C'], ['C', 'D']] },
    {
      ids: ['CH1', 'CH2', 'CH3', 'CH4', 'CH5', 'CH6'],
      pairs: [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH1', 'CH3'], ['CH3', 'CH4'], ['CH4', 'CH5'], ['CH5', 'CH6'], ['CH4', 'CH6']],
    },
  ];
  const rand = lcg(20260926);
  for (const c of cases) {
    const base = DSATUR.solveGraph(c.ids, c.pairs);
    for (let t = 0; t < 8; t++) {
      const [ids2, pairs2] = reorder(c.ids, c.pairs, rand);
      const r = DSATUR.solveGraph(ids2, pairs2);
      assert.strictEqual(r.k, base.k, '重排后色数改变');
      assert.deepStrictEqual(r.bandOf, base.bandOf, '重排后规范分配改变');
      assert.deepStrictEqual(r.bands, base.bands, '重排后频段清单改变');
    }
  }
});

test('随机小图上与暴力色数一致（精确性交叉验证）', () => {
  const rand = lcg(1234567);
  let searched = 0;
  for (let t = 0; t < 200; t++) {
    // 2..8 顶点可取较密边率
    const n = 2 + Math.floor(rand() * 7); // 2..8 个顶点
    const p = 0.15 + rand() * 0.6;
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < p) pairs.push([i, j]);
      }
    }
    const adj = new Array(n).fill(0);
    for (const [a, b] of pairs) {
      adj[a] |= 1 << b;
      adj[b] |= 1 << a;
    }
    const res = DSATUR.exactColor(adj, n);
    const expect = bruteChi(n, pairs);
    assert.strictEqual(res.k, expect, `图 ${t} 色数不符：${JSON.stringify({ n, pairs })}`);
    assert.ok(res.lb <= res.k && res.k <= res.ub0, '下界/上界应夹住色数');
    if (res.nodes > 0) searched++;
  }
  assert.ok(searched > 0, '应有样例实际触发分支定界搜索');
});

test('n>=10 紧凑饱和度路径上与暴力色数一致（回归：禁色掩码 / 回溯重建）', () => {
  const rand = lcg(7654321);
  let compact = 0;
  // 10..11 顶点、较稀疏：暴力色数仍可瞬时完成，同时强制走紧凑路径
  for (let t = 0; t < 120; t++) {
    const n = 10 + Math.floor(rand() * 2);
    const p = 0.1 + rand() * 0.35;
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < p) pairs.push([i, j]);
      }
    }
    const adj = new Array(n).fill(0);
    for (const [a, b] of pairs) {
      adj[a] |= 1 << b;
      adj[b] |= 1 << a;
    }
    const res = DSATUR.exactColor(adj, n);
    const expect = bruteChi(n, pairs);
    assert.strictEqual(res.k, expect, `紧凑图 ${t} 色数不符：${JSON.stringify({ n, pairs })}`);
    assert.ok(res.lb <= res.k && res.k <= res.ub0, '下界/上界应夹住色数');
    // 解本身必须合法：所有边两端异色
    for (let v = 0; v < n; v++) {
      let m = adj[v];
      while (m) {
        const bit = m & -m;
        m ^= bit;
        const u = Math.log2(bit) | 0;
        assert.notStrictEqual(
          res.colors[v],
          res.colors[u],
          `紧凑图 ${t} 存在同色相邻顶点 ${v}-${u}`
        );
      }
    }
    if (res.nodes > 0) compact++;
  }
  assert.ok(compact > 0, '应有样例在紧凑路径上实际触发分支定界搜索');
});

test('紧凑路径上无三角形 4 色图（Grötzsch / Mycielski-C7）判定正确', () => {
  // Grötzsch 图：11 顶点、4 色、最大团 2 —— 深度回溯才能区分 3/4 色
  const gro = [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 0],
    [0, 6], [1, 5], [1, 7], [2, 6], [2, 8],
    [3, 7], [3, 9], [4, 8], [4, 5], [0, 9],
    [10, 5], [10, 6], [10, 7], [10, 8], [10, 9],
  ];
  const adj11 = new Array(11).fill(0);
  for (const [a, b] of gro) {
    adj11[a] |= 1 << b;
    adj11[b] |= 1 << a;
  }
  const r1 = DSATUR.exactColor(adj11, 11);
  assert.strictEqual(r1.k, 4);
  assert.strictEqual(r1.lb, 2, 'Grötzsch 图无三角形');
  assert.strictEqual(bruteChi(11, gro), 4);

  // Mycielski(C7)：15 顶点、4 色、最大团 2
  const L = 7;
  const n15 = 2 * L + 1;
  const my = [];
  for (let i = 0; i < L; i++) {
    const j = (i + 1) % L;
    my.push([i, j], [i, j + L], [j, i + L]);
  }
  for (let i = 0; i < L; i++) my.push([2 * L, i + L]);
  const adj15 = new Array(n15).fill(0);
  for (const [a, b] of my) {
    adj15[a] |= 1 << b;
    adj15[b] |= 1 << a;
  }
  const r2 = DSATUR.exactColor(adj15, n15);
  assert.strictEqual(r2.k, 4);
  assert.strictEqual(r2.lb, 2);
  assert.ok(r2.nodes > 0, '下界 2 < 4，必须实际分支定界');
});

test('随机图上录入重排后规范分配保持一致', () => {
  const rand = lcg(2026);
  for (let t = 0; t < 30; t++) {
    const n = 2 + Math.floor(rand() * 8); // 2..9
    const ids = Array.from({ length: n }, (_, i) => 'CH' + (i + 1));
    const pairs = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (rand() < 0.4) pairs.push([ids[i], ids[j]]);
      }
    }
    const base = DSATUR.solveGraph(ids, pairs);
    for (let s = 0; s < 4; s++) {
      const [ids2, pairs2] = reorder(ids, pairs, rand);
      const r = DSATUR.solveGraph(ids2, pairs2);
      assert.deepStrictEqual(r.bandOf, base.bandOf, `图 ${t} 重排后规范分配改变`);
    }
  }
});

test('求解确定性：同一输入重复求解结论一致', () => {
  const ids = ['CH1', 'CH2', 'CH3', 'CH4', 'CH5'];
  const pairs = [['CH1', 'CH2'], ['CH2', 'CH3'], ['CH3', 'CH4'], ['CH4', 'CH5'], ['CH5', 'CH1']];
  const a = DSATUR.solveGraph(ids, pairs);
  const b = DSATUR.solveGraph(ids, pairs);
  assert.deepStrictEqual(a.bandOf, b.bandOf);
  assert.strictEqual(a.nodes, b.nodes);
});

test('复核器能发现同频段冲突（负例）', () => {
  const v = DSATUR.verifyAssignment([['A', 'B']], { A: 1, B: 1 });
  assert.strictEqual(v.length, 1);
});

/* ---------- 2. 代码测试：录入校验定位 ---------- */

test('自环被定位提示', () => {
  const r = Validate.parseEdges('A B\nA A', new Set(['A', 'B']));
  assert.strictEqual(r.edges.length, 1);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 2 行/);
  assert.match(r.errors[0].message, /自环/);
});

test('重复无向关系被定位提示（A B 与 B A 视为重复）', () => {
  const r = Validate.parseEdges('A B\nB A', new Set(['A', 'B']));
  assert.strictEqual(r.edges.length, 1);
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 2 行/);
  assert.match(r.errors[0].message, /重复/);
});

test('不存在端点被定位提示', () => {
  const r = Validate.parseEdges('A Z', new Set(['A', 'B']));
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 1 行/);
  assert.match(r.errors[0].message, /「Z」/);
});

test('通道数量边界：少于 2 个、多于 26 个、重复标识', () => {
  assert.ok(Validate.parseChannels('ONLY1').errors.some((e) => /至少需要 2 个/.test(e.message)));
  const many = Array.from({ length: 27 }, (_, i) => 'C' + i).join(' ');
  assert.ok(Validate.parseChannels(many).errors.some((e) => /至多允许 26 个/.test(e.message)));
  const dup = Validate.parseChannels('A B A');
  assert.ok(dup.errors.some((e) => /重复/.test(e.message) && /第 3 个/.test(e.message)));
  assert.strictEqual(Validate.parseChannels('A B').errors.length, 0);
});

test('干扰关系条数上限 120 条', () => {
  const ids = Array.from({ length: 26 }, (_, i) => 'C' + i);
  const set = new Set(ids);
  const lines = [];
  outer: for (let i = 0; i < 26; i++) {
    for (let j = i + 1; j < 26; j++) {
      lines.push(`C${i} C${j}`);
      if (lines.length === 121) break outer;
    }
  }
  assert.strictEqual(Validate.parseEdges(lines.slice(0, 120).join('\n'), set).errors.length, 0);
  const over = Validate.parseEdges(lines.join('\n'), set);
  assert.ok(over.errors.some((e) => /至多允许 120 条/.test(e.message)));
});

test('干扰关系行格式错误被定位提示', () => {
  const r = Validate.parseEdges('A B C', new Set(['A', 'B', 'C']));
  assert.strictEqual(r.errors.length, 1);
  assert.match(r.errors[0].message, /第 1 行/);
  assert.match(r.errors[0].message, /恰好两个/);
});

/* ---------- 3. 构建检查 ---------- */

test('构建检查：关键文件存在、JS 语法有效、页面引用完整', () => {
  const files = [
    'index.html',
    'styles.css',
    'main.js',
    'worker.js',
    'dsatur.js',
    'validate.js',
    'server.js',
    'Dockerfile',
    'compose.yaml',
  ];
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `缺少文件 ${f}`);
  }
  const jsFiles = ['main.js', 'worker.js', 'dsatur.js', 'validate.js', 'server.js', 'verify/run.js'];
  for (const f of jsFiles) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, f)]);
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.includes('src="validate.js"') && html.includes('src="main.js"'), 'index.html 脚本引用缺失');
  const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(mainJs.includes("new Worker('worker.js')"), 'main.js 未在 Worker 中求解');
  const workerJs = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8');
  assert.ok(workerJs.includes("importScripts('dsatur.js')"), 'worker.js 未加载求解器');
});

/* ---------- 4. 页面 HTTP 冒烟 ---------- */

async function fetchWithRetry(url, attempts, delayMs) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastErr;
}

async function smoke() {
  const targets = [
    ['/', (body) => body.includes('束流诊断柜') && body.includes('id="channels"') && body.includes('id="edges"')],
    ['/main.js', (body) => body.includes('new Worker')],
    ['/worker.js', (body) => body.includes('importScripts')],
    ['/dsatur.js', (body) => body.includes('solveGraph')],
    ['/validate.js', (body) => body.includes('parseChannels')],
    ['/styles.css', (body) => body.includes('resultPanel')],
    ['/healthz', (body) => body.includes('ok')],
  ];
  for (const [p, check] of targets) {
    await testAsync(`HTTP 冒烟 GET ${p}`, async () => {
      const res = await fetchWithRetry(WEB_URL + p, 12, 500);
      assert.strictEqual(res.status, 200);
      const body = await res.text();
      assert.ok(check(body), '响应缺少预期标记');
    });
  }
}

/* ---------- 主流程 ---------- */

(async () => {
  await smoke();
  console.log(`\n通过 ${passed} 项，失败 ${failed} 项。`);
  process.exitCode = failed === 0 ? 0 : 1;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
