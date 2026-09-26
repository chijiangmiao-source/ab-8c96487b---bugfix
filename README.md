# 束流诊断柜 · 读出通道频段分配

为相互干扰的读出通道分配最少频段的单页应用。求解在浏览器 Web Worker 中以
**确定性 DSATUR 分支定界**精确判定色数：贪心 DSATUR 提供可行上界，Tomita
最大团提供可证明下界并用于团预着色与剪枝；不使用随机搜索，也不枚举全部完整分配。

## 功能

- 录入 2–26 个唯一通道标识、至多 120 条无向干扰关系；
- 提交后展示：最少频段数 χ、按通道标识升序裁决的规范频段编号、各频段通道清单
  （组内无干扰边，主线程逐边复核，可复算），以及下界 / 上界 / 分支定界节点等证明信息；
- 改变录入顺序（通道顺序、边顺序、端点方向）后规范分配保持一致；
- 编辑、取消或再次提交时，任务序号递增并终止旧 Worker，迟到的旧任务结果一律丢弃；
- 自环、重复关系、不存在端点等录入错误按行定位提示，并清除既有成功证据。

## 运行

```bash
# 构建并以 Compose 运行页面（默认 http://localhost:8080）
docker compose up web

# 端口可配：宿主端口通过 APP_PORT 指定
APP_PORT=9000 docker compose up web
```

## 验证（代码测试 + 构建检查 + 页面 HTTP 冒烟）

```bash
docker compose up --exit-code-from verify verify
```

`verify` 服务等待 `web` 健康检查通过后，运行围绕三角冲突、四通道完全冲突、
二分链式与输入重排的代码测试、构建检查及页面 HTTP 冒烟，随后退出；
退出码 0 表示全部通过，1 表示存在失败。

无 Docker 时也可本地验证：

```bash
node server.js &          # 默认监听 8080，可用 PORT 覆盖
node verify/run.js        # WEB_URL 默认 http://127.0.0.1:8080
```

## 结构

| 文件 | 说明 |
| --- | --- |
| `index.html` / `styles.css` / `main.js` | 页面：录入、校验提示、结论渲染、过期任务防护 |
| `worker.js` | 求解 Worker 入口 |
| `dsatur.js` | 确定性 DSATUR 分支定界（Worker 与 Node 测试共用） |
| `validate.js` | 录入校验（页面与 Node 测试共用） |
| `server.js` | 零依赖静态服务器，`/healthz` 健康检查 |
| `verify/run.js` | verify 服务：代码测试、构建检查、HTTP 冒烟 |
| `Dockerfile` / `compose.yaml` | 构建与编排（端口可配、健康检查） |
