#!/usr/bin/env bash
# dsh-feishu-bot 一键部署
# 用法: bash install.sh  （会提示输入安装目录，或直接用当前目录）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== [1/4] 检查依赖 ==="
command -v node >/dev/null || { echo "❌ 需要 Node.js ≥18（建议 20+），请先安装"; exit 1; }
node -e "process.exit(process.versions.node.split('.')[0] < 18 ? 1 : 0)" || { echo "❌ Node 版本过低"; exit 1; }
echo "  Node: $(node -v) ✓"

# 检查 DSH 是否在运行（本机 3080）
if ! curl -s -m 3 -o /dev/null "http://127.0.0.1:3080/"; then
  echo "⚠️  未检测到 DSH web（127.0.0.1:3080）——请先启动 DSH 并安装 remote-web-ui 插件"
fi

echo "=== [2/4] 安装依赖 ==="
npm install --no-audit --no-fund

echo "=== [3/4] 配置 ==="
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "已生成 config.json——请编辑填入你的飞书 App ID / App Secret"
  echo "（获取方式见 docs/feishu-setup.md）"
else
  echo "config.json 已存在，跳过"
fi

echo "=== [4/4] 注册 systemd 用户服务 ==="
mkdir -p ~/.config/systemd/user
NODE_BIN="$(command -v node)"
cat > ~/.config/systemd/user/dsh-feishu-bot.service << EOF
[Unit]
Description=DSH Feishu bot (commands + approval cards + confirm cards)
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE_BIN "$DIR/bot.mjs"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now dsh-feishu-bot || true

echo ""
echo "✅ 部署完成！"
echo "  下一步："
echo "  1. 编辑 config.json 填入 App ID/App Secret"
echo "  2. 按 docs/feishu-setup.md 完成飞书开放平台配置"
echo "  3. systemctl --user restart dsh-feishu-bot"
echo "  4. 飞书里 @机器人 发消息测试"
