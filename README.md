# dsh-feishu-bot

**用飞书远程控制 DeepSeek Harness**：手机下发指令、远程审批、选择确认、进度推送。基于飞书长连接，**无需公网服务器、无需域名、无需内网穿透**。

```
你的手机(飞书) ←→ 飞书机器人(自建应用, WebSocket 长连接) ←→ 本机 dsh-feishu-bot ←→ DSH
     下指令 / 点审批 / 点确认            ▲ 无公网入口，纯出站连接
```

## ✨ 功能

| 能力 | 说明 |
|---|---|
| 💬 **远程指令** | 私聊直接打字 / 群聊 `@机器人` → 注入 DSH 当前会话执行 → 完整回复推回飞书 |
| ✅⛔ **审批卡片** | agent 需要权限时，飞书收「⚠️ 需要权限确认」卡片，点批准/拒绝远程放行 |
| ❓ **选择确认卡** | agent 输出 `⚡CONFIRM:` 标记 → 飞书收选项卡片，点选后注入回会话 |
| 📊 **进度推送** | 每小时会话摘要 + 任务完成通知 + 审批提醒 |
| 🏷️ **任务标题** | 所有推送带 `[会话标题]`，一眼分辨属于哪个任务 |

## 📦 依赖（必须）

1. **DeepSeek Harness**（web 版，本机运行，默认 `127.0.0.1:3080`）
2. **remote-web-ui 插件**（`@linxin666/dsh-remote-web-ui`）——bot 复用它的移动 API（`/m/api`）和审批应答（`/api/respond`）
3. **飞书开放平台自建应用**（免费，个人可注册）

## 🧩 版本方案

| 版本 | 方案 | 适用场景 | 安装方式 |
|---|---|---|---|
| **v1.1.0** | **插件部署**（推荐） | DSH 桌面版/常规使用 | DSH 插件随启随停，免 systemd |
| **v1.0.0** | 自行部署 | 独立进程 / 无 DSH 插件体系 | `install.sh` + systemd |

两个方案共用同一套 `bot.mjs` 逻辑与飞书应用配置，按需二选一。

---

## 🚀 快速开始（v1.1.0 插件部署，推荐）

> 要求：DeepSeek Harness 桌面版/web 版，已安装 `dsh-remote-web-ui` 插件。

```bash
# 1. 克隆并装依赖
git clone https://github.com/Liuyiwei61/dsh-feishujiqiren.git
cd dsh-feishu-bot
npm install

# 2. 配置飞书凭据
cp config.example.json config.json
vi config.json              # 填入 App ID / App Secret（勿提交，已被 gitignore）

# 3. 按 docs/feishu-setup.md 完成飞书开放平台配置（10-20分钟，一次性）

# 4. 作为 DSH 插件安装（随 DSH 启停，崩溃自动重启）
dsh plugin --profile web add "$PWD"

# 5. 重启 DSH → 插件自动拉起 bot → 飞书长连接建立
```

**说明**：插件壳（`lib/index.js`）托管 `bot.mjs` 子进程——DSH 启动时自动拉起，退出时自动停止，子进程崩溃 5 秒后自动重启。卸载：`dsh plugin remove dsh-feishu-bot`。

## 🚀 快速开始（v1.0.0 自行部署）

```bash
git clone https://github.com/Liuyiwei61/dsh-feishujiqiren.git
cd dsh-feishu-bot
bash install.sh          # 装依赖 + 生成配置 + 注册 systemd 服务

# 编辑配置（填入你的飞书凭据）
vi config.json

# 按 docs/feishu-setup.md 完成飞书开放平台配置（10-20分钟，一次性）

systemctl --user restart dsh-feishu-bot
```

## 🔧 使用

- **私聊**：直接打字即指令（如 `帮我查一下当前有几个活跃会话`）
- **群聊**：`@机器人 指令` 或 `dsh 指令` 前缀
- **审批**：收到卡片点「✅ 批准 / ⛔ 拒绝」
- **确认**：agent 需要你拍板时，收「❓ 需要确认」卡片点选
- **推送**：每小时摘要 + 实时进展，自动进你最近对话的会话

## 🧱 架构与原理（关键）

bot 通过 DSH 的移动 API 网关工作，有三个**必须遵守**的机制（踩坑总结）：

1. **审批应答按 rpcId**：`/api/respond` 用「事件流里 `approval/requested` 帧携带的 rpcId」查 pending 表（不是 approvalId）。bot 通过 SSE 订阅 `/m/api/events.mux` 持续获取，断线自动重连（mux 重放补映射）
2. **应答信封格式**：`{type:"client-response", rpcId, result:{ok:true, value:{sessionId, approvalId, outcome}}}`
3. **卡片 value 双重编码**：飞书按钮 value 会多包一层 JSON 字符串，需循环解析

## 🛡️ 安全

- **审批是远程放行**：高风险操作（删文件/装软件）被远程批准前，请确认卡片内容（工具名 + 原因）
- 飞书应用**可用范围只限本人**，勿对外共享
- `config.json`（含 App Secret）与 `state.json`（含 DSH 配对 cookie）已被 `.gitignore` 排除，**勿提交**
- 配对 cookie 等于访问你 DSH 的凭据，泄露请删除 `state.json` 重新配对

## ⚠️ 限制

- 依赖 remote-web-ui 插件（DSH 生态标准件）
- 电脑需在线（bot 与 DSH 在本机）
- 共享会话：飞书指令注入当前活跃会话，GUI 正忙时指令会排队
- 确认卡选项 ≤5 个用按钮，更多退化为文字

## 👤 作者与致谢

- **作者**：[Liuyiwei61](https://github.com/Liuyiwei61)
- **致谢**：
  - [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— Agent 框架本体
  - [zhu1090093659 / @linxin666 dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) —— `dsh-remote-web-ui` 插件（bot 复用了它的移动 API 网关 `/m/api` 与审批应答 `/api/respond`，本项目的功能基础）
  - 飞书开放平台 —— 长连接机器人能力（免费）

## 📄 许可证

**MIT License**

```text
MIT License

Copyright (c) 2026 Liuyiwei61

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

依赖项许可：`@larksuiteoapi/node-sdk`（Apache-2.0），见其自身 LICENSE。

## 📜 免责声明

本项目用于**管理你自己的 DeepSeek Harness 实例**。使用本软件即表示你同意：

1. **审批/确认卡片会远程放行高风险操作**（如执行命令、修改文件）。请仅在可信环境中使用，并对你的飞书应用可用范围、App Secret、配对 cookie 的保密负全部责任；
2. 本项目按"现状"提供，作者不对因使用本软件造成的任何数据丢失、系统损坏或安全问题负责；
3. 本项目与飞书/DeepSeek 官方无隶属关系。

## 🗒️ 更新日志

- **1.1.0**：**插件部署方案**——新增 DSH 插件壳（`lib/index.js` 托管 bot 子进程，随 DSH 启停、崩溃自动重启、`dsh plugin add` 一键安装）；README 拆分双版本方案。
- **1.0.0**：首个发布。指令注入、审批卡片（批准/拒绝）、⚡CONFIRM 选择确认卡、完整回复回推（含会话标题）、每小时摘要、SSE 事件流订阅（rpcId 映射）、一键部署脚本与完整文档。

## 🧹 关于"远程访问方案"的说明

本仓库**不包含**任何内网穿透/公网隧道方案（如花生壳、Cloudflare 隧道、frp 等）——飞书机器人走**纯出站长连接**，天然不需要这些。若要浏览器远程访问 DSH 桌面 UI，请单独使用 `dsh-remote-web-ui` 插件（见上游文档）。

---

详细飞书配置见 [docs/feishu-setup.md](docs/feishu-setup.md)
