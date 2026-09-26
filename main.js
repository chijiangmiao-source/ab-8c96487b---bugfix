/*
 * 页面主逻辑：录入校验、Worker 调度、结论渲染。
 *
 * 过期任务防护：jobSeq 单调递增，任何「编辑 / 取消 / 再次提交」都会使其前进
 * 并终止在跑的 Worker；Worker 回包必须携带当前 jobId 且仍是当前 Worker，
 * 否则一律丢弃 —— 迟到的旧任务不得覆盖当前草稿或新结论。
 */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };
  var channelsEl = $('channels');
  var edgesEl = $('edges');
  var submitBtn = $('submit');
  var cancelBtn = $('cancel');
  var statusEl = $('status');
  var errorsEl = $('errors');
  var resultPanel = $('resultPanel');
  var staleEl = $('stale');
  var summaryEl = $('summary');
  var assignmentBody = document.querySelector('#assignment tbody');
  var bandsEl = $('bands');
  var verificationEl = $('verification');

  var jobSeq = 0; // 任务序号：编辑 / 取消 / 提交时递增
  var worker = null; // 当前在跑的 Worker（若有）

  function stopWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    cancelBtn.disabled = true;
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  function showErrors(messages) {
    errorsEl.textContent = '';
    messages.forEach(function (m) {
      var li = document.createElement('li');
      li.textContent = m;
      errorsEl.appendChild(li);
    });
  }

  function clearResults() {
    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    summaryEl.textContent = '';
    assignmentBody.textContent = '';
    bandsEl.textContent = '';
    verificationEl.textContent = '';
  }

  function markStale() {
    if (!resultPanel.hidden) {
      resultPanel.classList.add('stale-on');
      staleEl.hidden = false;
    }
  }

  function onEdit() {
    jobSeq++; // 使任何在途旧任务的结论失效
    stopWorker();
    markStale();
    setStatus('输入已修改，既有结论已失效，请重新提交。', 'muted');
  }
  channelsEl.addEventListener('input', onEdit);
  edgesEl.addEventListener('input', onEdit);

  cancelBtn.addEventListener('click', function () {
    jobSeq++;
    stopWorker();
    setStatus('已取消本次求解。', 'muted');
  });

  function validate() {
    var ch = Validate.parseChannels(channelsEl.value);
    var ed = Validate.parseEdges(edgesEl.value, new Set(ch.channels));
    var errors = ch.errors.concat(ed.errors).map(function (e) {
      return e.message;
    });
    return { ok: errors.length === 0, channels: ch.channels, edges: ed.edges, errors: errors };
  }

  function renderResult(msg, edges) {
    resultPanel.hidden = false;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;

    summaryEl.textContent =
      '最少频段数 χ = ' +
      msg.k +
      '；可证明下界（最大团）= ' +
      msg.lb +
      '；初始可行上界 = ' +
      msg.ub +
      '；分支定界节点 = ' +
      msg.nodes +
      '；耗时 ' +
      msg.elapsed +
      ' ms。';

    assignmentBody.textContent = '';
    msg.channels.forEach(function (id) {
      var tr = document.createElement('tr');
      var tdId = document.createElement('td');
      tdId.textContent = id;
      var tdBand = document.createElement('td');
      tdBand.textContent = '频段 ' + msg.bandOf[id];
      tr.appendChild(tdId);
      tr.appendChild(tdBand);
      assignmentBody.appendChild(tr);
    });

    bandsEl.textContent = '';
    msg.bands.forEach(function (members, i) {
      var li = document.createElement('li');
      li.textContent =
        '频段 ' + (i + 1) + '（' + members.length + ' 个通道）：' + members.join('、') + ' —— 组内无干扰边';
      bandsEl.appendChild(li);
    });

    // 主线程复核：每条干扰边两端必须落在不同频段，结论可复算
    var bad = edges.filter(function (pair) {
      return msg.bandOf[pair[0]] === msg.bandOf[pair[1]];
    });
    var covered = msg.channels.every(function (id) {
      return msg.bandOf[id] >= 1 && msg.bandOf[id] <= msg.k;
    });
    if (bad.length === 0 && covered && msg.bands.length === msg.k) {
      verificationEl.textContent =
        '复核通过：' + edges.length + ' 条干扰边的两端均分属不同频段，各频段内部不存在干扰边。';
      verificationEl.className = 'ok-text';
    } else {
      verificationEl.textContent = '复核失败：求解结果与输入不一致，请重新提交。';
      verificationEl.className = 'error-text';
    }
  }

  function submit() {
    jobSeq++;
    stopWorker();
    showErrors([]);

    var v = validate();
    if (!v.ok) {
      clearResults(); // 清除既有成功证据
      showErrors(v.errors);
      setStatus('输入校验失败：请按提示定位并修正后重新提交。', 'error');
      return;
    }

    var jobId = jobSeq;
    resultPanel.hidden = true;
    resultPanel.classList.remove('stale-on');
    staleEl.hidden = true;
    setStatus('求解中（Worker 内执行确定性 DSATUR 分支定界）…', 'busy');

    var w = new Worker('worker.js');
    worker = w;
    cancelBtn.disabled = false;

    w.onmessage = function (ev) {
      var msg = ev.data;
      if (worker !== w || !msg || msg.jobId !== jobSeq) return; // 迟到的旧任务，丢弃
      stopWorker();
      if (msg.type === 'error') {
        setStatus('求解失败：' + msg.message, 'error');
        return;
      }
      renderResult(msg, v.edges);
      setStatus('求解完成。', 'ok');
    };
    w.onerror = function (ev) {
      if (worker !== w) return;
      stopWorker();
      setStatus('Worker 执行异常：' + (ev.message || '未知错误'), 'error');
    };
    w.postMessage({ jobId: jobId, channels: v.channels, edges: v.edges });
  }
  submitBtn.addEventListener('click', submit);

  var EXAMPLES = {
    triangle: {
      channels: 'CH1 CH2 CH3',
      edges: 'CH1 CH2\nCH2 CH3\nCH1 CH3',
    },
    k4: {
      channels: 'CH1 CH2 CH3 CH4',
      edges: 'CH1 CH2\nCH1 CH3\nCH1 CH4\nCH2 CH3\nCH2 CH4\nCH3 CH4',
    },
    chain: {
      channels: 'CH1 CH2 CH3 CH4',
      edges: 'CH1 CH2\nCH2 CH3\nCH3 CH4',
    },
  };
  Array.prototype.forEach.call(document.querySelectorAll('[data-example]'), function (btn) {
    btn.addEventListener('click', function () {
      var ex = EXAMPLES[btn.getAttribute('data-example')];
      channelsEl.value = ex.channels;
      edgesEl.value = ex.edges;
      onEdit();
      setStatus('已载入示例，点击「提交求解」。', 'muted');
    });
  });
})();
