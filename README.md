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

## 🚀 快速开始

```bash
git clone <your-repo-url>
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

## 📄 License

MIT

---

详细飞书配置见 [docs/feishu-setup.md](docs/feishu-setup.md)
