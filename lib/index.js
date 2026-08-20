//#region src/index.ts
/**
 * dsh-feishu-bot — DSH 插件壳
 *
 * 职责：随 DSH 启停地管理飞书桥（bot.mjs 子进程）。
 *   - apply(ctx)  ：spawn bot.mjs（node 子进程），崩溃自动重启
 *   - dispose()   ：停止子进程（DSH 退出/插件卸载时）
 *
 * bot.mjs 逻辑零改动——它仍是独立 Node 脚本（读 config.json），
 * 本壳只负责它的生命周期，让 bot 跟随 DSH 一起起停。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const BOT_SCRIPT = join(HERE, '..', 'bot.mjs')
const MIN_RESTART_DELAY_MS = 5000

let child = null
let restartTimer = null
let disposed = false

/** 启动 bot 子进程并接管其生命周期。 */
function startBot() {
  if (disposed) return
  const nodeBin = process.env.DSH_BOT_NODE || process.execPath
  child = spawn(nodeBin, [BOT_SCRIPT], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, DSH_BOT_IN_PLUGIN: '1' }
  })
  child.on('exit', (code, sig) => {
    child = null
    if (disposed) return
    console.log(`[dsh-feishu-bot] bot 子进程退出 (code=${code} sig=${sig})，${MIN_RESTART_DELAY_MS / 1000}s 后重启`)
    restartTimer = setTimeout(startBot, MIN_RESTART_DELAY_MS)
  })
  child.on('error', (err) => {
    console.error('[dsh-feishu-bot] bot 子进程启动失败:', err.message)
    child = null
    if (!disposed) restartTimer = setTimeout(startBot, MIN_RESTART_DELAY_MS)
  })
  console.log(`[dsh-feishu-bot] 已启动 bot 子进程 (pid=${child.pid})`)
}

/** DSH 插件 apply：开始托管 bot 子进程。 */
function apply() {
  startBot()
}

/** DSH 插件 dispose：停止子进程（DSH 退出/插件卸载/热重载）。 */
function dispose() {
  disposed = true
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = null
  if (child) {
    console.log('[dsh-feishu-bot] 停止 bot 子进程')
    child.kill('SIGTERM')
    child = null
  }
}

export { apply, dispose }
//#endregion
