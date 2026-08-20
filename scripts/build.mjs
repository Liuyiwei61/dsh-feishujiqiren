// build.mjs — dsh-feishu-bot 构建脚本
//
// 本插件是纯 JS 包壳（lib/index.js 直接 spawn bot.mjs），无需 tsc 编译。
// 构建只做两件事：
//   1. 确认 lib/index.js 存在（缺失则报错）
//   2. 把仓库根 config.example.json 复制为 lib/../config.json 仅当不存在时
//      （真正的 config.json 含密钥，由用户在插件目录放置，gitignore 排除）
import { existsSync, copyFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const entry = join(ROOT, 'lib', 'index.js')
if (!existsSync(entry)) {
  console.error('[build] 缺少 lib/index.js，构建失败')
  process.exit(1)
}

const cfg = join(ROOT, 'config.json')
if (!existsSync(cfg)) {
  const example = join(ROOT, 'config.example.json')
  if (existsSync(example)) {
    copyFileSync(example, cfg)
    console.log('[build] 已从 config.example.json 生成 config.json（请填入真实密钥）')
  } else {
    console.log('[build] 注意：无 config.json（bot 运行需要它，请从 dsh-bot/config.json 复制）')
  }
} else {
  console.log('[build] config.json 已存在')
}

console.log('[build] OK — lib/index.js 就绪')
