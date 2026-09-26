/* 频段分配求解 Worker：在后台线程执行确定性 DSATUR 分支定界。 */
importScripts('dsatur.js');

self.onmessage = function (ev) {
  var msg = ev.data || {};
  try {
    var res = DSATUR.solveGraph(msg.channels, msg.edges);
    res.type = 'result';
    res.jobId = msg.jobId;
    self.postMessage(res);
  } catch (err) {
    self.postMessage({
      type: 'error',
      jobId: msg.jobId,
      message: String((err && err.message) || err),
    });
  }
};
