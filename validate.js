/*
 * 录入校验：通道清单与无向干扰关系。
 * 浏览器页面与 Node 测试共用，保证定位提示一致。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Validate = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var MIN_CHANNELS = 2;
  var MAX_CHANNELS = 26;
  var MAX_EDGES = 120;
  var SPLIT = /[\s,;，、]+/;

  function parseChannels(text) {
    var errors = [];
    var tokens = String(text == null ? '' : text).split(SPLIT).filter(Boolean);
    var seen = new Set();
    var channels = [];
    tokens.forEach(function (tok, i) {
      if (seen.has(tok)) {
        errors.push({ message: '第 ' + (i + 1) + ' 个通道标识「' + tok + '」重复，通道标识必须唯一。' });
      } else {
        seen.add(tok);
        channels.push(tok);
      }
    });
    if (channels.length < MIN_CHANNELS) {
      errors.push({ message: '唯一通道数为 ' + channels.length + '，至少需要 ' + MIN_CHANNELS + ' 个通道。' });
    }
    if (channels.length > MAX_CHANNELS) {
      errors.push({ message: '唯一通道数为 ' + channels.length + '，至多允许 ' + MAX_CHANNELS + ' 个通道。' });
    }
    return { channels: channels, errors: errors };
  }

  function parseEdges(text, channelSet) {
    var errors = [];
    var edges = [];
    var seen = new Set();
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    lines.forEach(function (line, idx) {
      var ln = idx + 1;
      var tokens = line.split(SPLIT).filter(Boolean);
      if (tokens.length === 0) return;
      if (tokens.length !== 2) {
        errors.push({
          message: '第 ' + ln + ' 行「' + line.trim() + '」：每条干扰关系需恰好两个通道标识，实际为 ' + tokens.length + ' 个。',
        });
        return;
      }
      var a = tokens[0];
      var b = tokens[1];
      if (!channelSet.has(a)) {
        errors.push({ message: '第 ' + ln + ' 行「' + line.trim() + '」：端点「' + a + '」不存在于通道清单。' });
        return;
      }
      if (!channelSet.has(b)) {
        errors.push({ message: '第 ' + ln + ' 行「' + line.trim() + '」：端点「' + b + '」不存在于通道清单。' });
        return;
      }
      if (a === b) {
        errors.push({ message: '第 ' + ln + ' 行「' + line.trim() + '」：不允许自环，干扰关系的两个端点必须不同。' });
        return;
      }
      var key = JSON.stringify(a < b ? [a, b] : [b, a]); // 无向：A B 与 B A 视为同一条
      if (seen.has(key)) {
        errors.push({ message: '第 ' + ln + ' 行「' + line.trim() + '」：与此前录入的无向干扰关系重复。' });
        return;
      }
      seen.add(key);
      edges.push([a, b]);
    });
    if (edges.length > MAX_EDGES) {
      errors.push({ message: '干扰关系共 ' + edges.length + ' 条，至多允许 ' + MAX_EDGES + ' 条。' });
    }
    return { edges: edges, errors: errors };
  }

  return {
    parseChannels: parseChannels,
    parseEdges: parseEdges,
    MIN_CHANNELS: MIN_CHANNELS,
    MAX_CHANNELS: MAX_CHANNELS,
    MAX_EDGES: MAX_EDGES,
  };
});
