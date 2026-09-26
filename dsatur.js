/*
 * 确定性 DSATUR 分支定界精确图着色。
 *
 * 同一模块同时服务于浏览器 Worker（importScripts）与 Node 测试（require），
 * 保证页面结论与代码测试行为一致。
 *
 * 算法要点：
 *  - 顶点顺序固定为通道标识升序，所有平局按顶点下标裁决 => 与录入顺序无关；
 *  - 贪心 DSATUR 给出可行上界（初始 incumbent）；
 *  - Tomita 最大团给出可证明下界，并用于团预着色与全局剪枝；
 *  - 分支定界按 DSATUR 饱和度选点、按颜色编号升序尝试，
 *    「used >= best」与「used + 1 >= best 不得开新色」完成上界剪枝。
 * 不使用随机搜索，也不枚举全部完整分配。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DSATUR = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  function popcount(x) {
    x = x - ((x >> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
    return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
  }

  // 最低置位比特的下标（x 必须非 0）
  function lowbitIndex(x) {
    return popcount((x & -x) - 1);
  }

  // 选点规则：饱和度最大；平局 -> 度最大；再平局 -> 下标最小（确定性）
  function pickVertex(color, sat, deg, n) {
    let v = -1;
    for (let i = 0; i < n; i++) {
      if (color[i] !== -1) continue;
      if (
        v === -1 ||
        sat[i] > sat[v] ||
        (sat[i] === sat[v] && (deg[i] > deg[v] || (deg[i] === deg[v] && i < v)))
      ) {
        v = i;
      }
    }
    return v;
  }

  // 贪心 DSATUR：可行上界 + 初始 incumbent
  function greedyDsatur(adj, n, deg) {
    const color = new Array(n).fill(-1);
    const sat = new Array(n).fill(0);
    const nbrColors = new Array(n).fill(0);
    let used = 0;
    let colored = 0;
    while (colored < n) {
      const v = pickVertex(color, sat, deg, n);
      let c = 0;
      while (nbrColors[v] & (1 << c)) c++;
      color[v] = c;
      if (c === used) used++;
      colored++;
      let m = adj[v];
      while (m) {
        const bit = m & -m;
        const u = lowbitIndex(bit);
        m ^= bit;
        if (color[u] === -1 && !(nbrColors[u] & (1 << c))) {
          nbrColors[u] |= 1 << c;
          sat[u]++;
        }
      }
    }
    return { color: color, used: used };
  }

  // Tomita 最大团（贪心着色界剪枝）：可证明下界
  function maxClique(adj, n) {
    let bestSize = 0;
    let bestMask = 0;
    function expand(R, size, P) {
      if (P === 0) {
        if (size > bestSize) {
          bestSize = size;
          bestMask = R;
        }
        return;
      }
      const order = [];
      const bounds = [];
      let uncolored = P;
      let c = 0;
      while (uncolored) {
        c++;
        let avail = uncolored;
        while (avail) {
          const bit = avail & -avail;
          const v = lowbitIndex(bit);
          avail ^= bit;
          uncolored ^= bit;
          order.push(v);
          bounds.push(c);
          avail &= ~adj[v];
        }
      }
      let Pm = P;
      for (let i = order.length - 1; i >= 0; i--) {
        if (size + bounds[i] <= bestSize) return;
        const v = order[i];
        const bit = 1 << v;
        Pm &= ~bit;
        expand(R | bit, size + 1, Pm & adj[v]);
      }
    }
    expand(0, 0, n >= 31 ? -1 : (1 << n) - 1);
    return { size: bestSize, mask: bestMask };
  }

  // 精确 DSATUR 分支定界
  function exactColor(adj, n) {
    const deg = adj.map(popcount);
    const greedy = greedyDsatur(adj, n, deg);
    let best = greedy.used; // 已知可行上界
    let bestColor = greedy.color.slice();
    const clique = maxClique(adj, n);
    const lb = clique.size; // 可证明下界
    let nodes = 0;

    if (lb < best) {
      const color = new Array(n).fill(-1);
      const sat = new Array(n).fill(0);
      // n >= 10 时用单个比特掩码维护邻居颜色集合（含回溯重建）；
      // 小图沿用 touched 列表。两条路径都必须同时服务饱和度与禁色判定。
      const compactSaturation = n >= 10;
      const saturationMask = compactSaturation ? new Array(n).fill(0) : null;
      const nbrColors = compactSaturation ? null : new Array(n).fill(0);
      let used = 0;
      let coloredCount = 0;

      function assign(v, c, touched) {
        color[v] = c;
        let m = adj[v];
        while (m) {
          const bit = m & -m;
          const u = lowbitIndex(bit);
          m ^= bit;
          if (color[u] === -1) {
            if (compactSaturation) {
              saturationMask[u] |= 1 << c;
              sat[u] = popcount(saturationMask[u]);
            } else if (!(nbrColors[u] & (1 << c))) {
              nbrColors[u] |= 1 << c;
              sat[u]++;
              touched.push(u);
            }
          }
        }
      }
      function unassign(v, c, touched) {
        color[v] = -1;
        if (compactSaturation) {
          let m = adj[v];
          while (m) {
            const bit = m & -m;
            const u = lowbitIndex(bit);
            m ^= bit;
            if (color[u] === -1) {
              // 不能仅清掉比特 c：u 可能还有另一个已着色邻居同占 c，
              // 须按当前已着色邻居重建颜色掩码，回溯后状态才正确。
              let mask = 0;
              let wm = adj[u];
              while (wm) {
                const wb = wm & -wm;
                const w = lowbitIndex(wb);
                wm ^= wb;
                if (color[w] !== -1) mask |= 1 << color[w];
              }
              saturationMask[u] = mask;
              sat[u] = popcount(mask);
            }
          }
          return;
        }
        for (let i = 0; i < touched.length; i++) {
          const u = touched[i];
          nbrColors[u] &= ~(1 << c);
          sat[u]--;
        }
        touched.length = 0;
      }

      // 团预着色：团内顶点在任何可行解中颜色两两不同，
      // 经颜色置换可令其依次占用 0..lb-1 —— 这是安全的下界利用。
      let cm = clique.mask;
      while (cm) {
        const bit = cm & -cm;
        const v = lowbitIndex(bit);
        cm ^= bit;
        assign(v, used, []);
        used++;
        coloredCount++;
      }

      function search() {
        nodes++;
        if (best === lb) return; // 已达可证明下界，全局终止
        if (coloredCount === n) {
          if (used < best) {
            best = used;
            bestColor = color.slice();
          }
          return;
        }
        if (used >= best) return; // 上界剪枝：继续不可能严格更优
        const v = pickVertex(color, sat, deg, n);
        // 已着色邻居占用的频段：紧凑模式取掩码，小图模式取 touched 计数集合
        const forbid = compactSaturation ? saturationMask[v] : nbrColors[v];
        for (let c = 0; c < used; c++) {
          if (forbid & (1 << c)) continue;
          const touched = [];
          assign(v, c, touched);
          coloredCount++;
          search();
          coloredCount--;
          unassign(v, c, touched);
        }
        if (used + 1 < best) {
          // 开新频段仅在可能严格优于当前最优时才有意义
          const touched = [];
          assign(v, used, touched);
          used++;
          coloredCount++;
          search();
          coloredCount--;
          used--;
          unassign(v, used, touched);
        }
      }
      search();
    }

    return { k: best, colors: bestColor, lb: lb, ub0: greedy.used, nodes: nodes };
  }

  /*
   * 高层入口：任意顺序的通道标识 + 无向干扰关系 -> 规范结论。
   * 顶点按通道标识升序排列后求解，再按「各频段最小通道标识升序」重编号，
   * 因此改变录入顺序结论保持一致。
   */
  function solveGraph(ids, pairs) {
    const started = Date.now();
    const sorted = ids.slice().sort(function (a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const n = sorted.length;
    const index = new Map();
    sorted.forEach(function (id, i) {
      index.set(id, i);
    });
    const adj = new Array(n).fill(0);
    for (const pair of pairs) {
      const i = index.get(pair[0]);
      const j = index.get(pair[1]);
      if (i === undefined || j === undefined) {
        throw new Error('干扰关系包含未知端点: ' + pair[0] + ' ' + pair[1]);
      }
      adj[i] |= 1 << j;
      adj[j] |= 1 << i;
    }
    const res = exactColor(adj, n);

    // 规范频段编号：按频段内最小通道下标（即通道标识升序）重编号为 1..k
    const colors = res.colors;
    const k = res.k;
    const classMin = new Array(k).fill(Number.MAX_SAFE_INTEGER);
    for (let v = 0; v < n; v++) {
      if (v < classMin[colors[v]]) classMin[colors[v]] = v;
    }
    const order = [];
    for (let c = 0; c < k; c++) order.push(c);
    order.sort(function (c1, c2) {
      return classMin[c1] - classMin[c2];
    });
    const relabel = new Array(k).fill(0);
    order.forEach(function (c, i) {
      relabel[c] = i + 1;
    });
    const bandOf = {};
    const bands = [];
    for (let i = 0; i < k; i++) bands.push([]);
    for (let v = 0; v < n; v++) {
      const b = relabel[colors[v]];
      bandOf[sorted[v]] = b;
      bands[b - 1].push(sorted[v]);
    }
    return {
      k: k,
      bands: bands,
      bandOf: bandOf,
      channels: sorted,
      lb: res.lb,
      ub: res.ub0,
      nodes: res.nodes,
      elapsed: Date.now() - started,
    };
  }

  // 复核：返回两端落在同一频段的干扰关系（应为空）
  function verifyAssignment(pairs, bandOf) {
    const violations = [];
    for (const pair of pairs) {
      if (bandOf[pair[0]] === bandOf[pair[1]]) violations.push([pair[0], pair[1]]);
    }
    return violations;
  }

  return {
    solveGraph: solveGraph,
    verifyAssignment: verifyAssignment,
    exactColor: exactColor,
    greedyDsatur: greedyDsatur,
    maxClique: maxClique,
  };
});
