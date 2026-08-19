#!/usr/bin/env node
/**
 * dsh-bot — 飞书机器人桥接 DSH（长连接模式，无需公网）
 *
 * 能力：
 *   1. 飞书消息指令（前缀 "dsh "）→ session.prompt 注入 DSH 会话 → agent 执行
 *   2. 审批卡片（approve/reject）→ POST /api/respond 答复 DSH 审批
 *
 * 依赖 DSH 本机回环 API（127.0.0.1:3080，免配对门禁）。
 */
import * as lark from '@larksuiteoapi/node-sdk'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CFG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'))
const DSH = CFG.dshBase || 'http://127.0.0.1:3080'
const STATE_FILE = fileURLToPath(new URL('./state.json', import.meta.url))
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/** —— 会话文件与回复回推 —— */
let pendingReplies = {} // sessionId -> { chatId, sinceSeq, file, acc, lastMtime, stableSince }
let approvalTrack = {}  // sessionId -> { lastSeq, file, mtime }
let todoTrack = {}      // sessionId -> { lastSeq, todos }
let pendingRpcMap = {}  // approvalId -> { rpcId, sessionId }（来自事件流 approval/requested 帧）
let defaultChatId = null
function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      pairCookie = s.pairCookie || null
      pendingReplies = s.pendingReplies || {}
      approvalTrack = s.approvalTrack || {}
      todoTrack = s.todoTrack || {}
      pendingRpcMap = s.pendingRpcMap || {}
      defaultChatId = s.defaultChatId || null
    }
  } catch {}
}
function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify({ pairCookie, pendingReplies, approvalTrack, todoTrack, pendingRpcMap, defaultChatId }, null, 1))
}

/** 订阅 DSH 事件流（SSE），捕获 approval/requested 帧的 rpcId，断线自动重连（mux 重放补映射）。 */
async function startEventStream() {
  while (true) {
    try {
      await ensurePaired()
      const res = await fetch(`${DSH}/m/api/events.mux`, {
        headers: { Cookie: pairCookie, Accept: 'text/event-stream' }
      })
      if (!res.ok || !res.body) throw new Error(`events.mux HTTP ${res.status}`)
      console.log('[dsh-bot] 📡 事件流已连接')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              const frame = JSON.parse(line.slice(6))
              const pl = frame.payload
              if (pl?.type === 'approval/requested') {
                pendingRpcMap[pl.approvalId] = { rpcId: frame.rpcId, sessionId: pl.sessionId }
                console.log(`[dsh-bot] 审批 rpcId 已登记: ${pl.approvalId.slice(0, 8)} rpcId=${frame.rpcId.slice(0, 8)}`)
                saveState()
              }
            } catch {}
          }
        }
      }
      console.log('[dsh-bot] 📡 事件流断开，5 秒后重连（mux 重放将补回映射）')
    } catch (e) {
      console.error('[dsh-bot] 事件流异常:', e.message)
    }
    await new Promise((r) => setTimeout(r, 5000))
  }
}
function findSessionFile(sessionId) {
  try {
    for (const ws of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      const p = join(SESSIONS_ROOT, ws.name, sessionId, 'session.jsonl.zstd')
      if (existsSync(p)) return p
    }
  } catch {}
  return null
}
function readLines(file) {
  const r = spawnSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 })
  if (r.status !== 0) return []
  return r.stdout.toString('utf8').split('\n').filter(Boolean)
}
/** 取 assistant/message 的文本（跳过 reasoning）。 */
function assistantText(line) {
  try {
    const o = JSON.parse(line)
    const parts = (o.data?.message?.content || []).filter((c) => c.type === 'text' && c.text).map((c) => c.text)
    return parts.join(' ').trim()
  } catch { return '' }
}
/** 从会话 JSONL 取任务标题（session/title 事件；无则用首条用户消息，再退回会话id）。 */
function sessionTitle(sessionId) {
  const file = findSessionFile(sessionId)
  if (!file) return sessionId.slice(0, 8)
  let title = ''
  let firstUser = ''
  for (const ln of readLines(file)) {
    let o; try { o = JSON.parse(ln) } catch { continue }
    if (o.type === 'session/title' && o.data?.title) title = o.data.title
    if (!firstUser && o.type === 'user/message') {
      const t = (o.data?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim()
      if (t) firstUser = t
    }
  }
  const pick = title || firstUser || sessionId.slice(0, 8)
  return pick.slice(0, 30)
}
/** 轮询：把 agent 在会话里的完整回复推回飞书（累积 + 等写入稳定 8 秒，避免推半截）。 */
async function scanReplies() {
  for (const [sessionId, p] of Object.entries(pendingReplies)) {
    if (!p.file || !existsSync(p.file)) { delete pendingReplies[sessionId]; continue }
    const st = statSync(p.file)
    let maxSeq = p.sinceSeq
    let found = p.acc || ''
    let turnDone = false
    for (const ln of readLines(p.file)) {
      let o; try { o = JSON.parse(ln) } catch { continue }
      if (typeof o.seq !== 'number' || o.seq <= p.sinceSeq) continue
      if (o.seq > maxSeq) maxSeq = o.seq
      if (o.type === 'assistant/message') {
        const t = assistantText(ln)
        if (t) found = found ? `${found}\n${t}` : t
      } else if (o.type === 'assistant/chunk' && o.data?.chunk?.type === 'finish') {
        turnDone = true // 回合结束信号：立即推，不等稳定
      }
    }
    // 回合结束（finish）→ 立即推完整内容
    if (turnDone && found.trim()) {
      // ⚡CONFIRM 标记 → 发选择确认卡（不推原始标记文本）
      const confirmM = found.match(/⚡CONFIRM:\s*([^\n]+)((?:\n-\s*[^\n]+)+)/)
      if (confirmM) {
        const question = confirmM[1].trim()
        const options = confirmM[2].split('\n').map((s) => s.replace(/^-\s*/, '').trim()).filter(Boolean)
        try { await sendConfirmCard(p.chatId, sessionId, question, options); console.log(`[dsh-bot] 确认卡已发送: ${question.slice(0, 30)}`) }
        catch (e) { console.error('[dsh-bot] 确认卡发送失败:', e.message) }
        const clean = found.replace(/⚡CONFIRM:[\s\S]*$/, '').trim()
        if (clean) {
          const ttl = sessionTitle(sessionId)
          try { await reply(p.chatId, `🤖 [${ttl}]\n${clean.slice(0, 2000)}`) } catch {}
        }
        delete pendingReplies[sessionId]
        continue
      }
      const ttl = sessionTitle(sessionId)
      try { await reply(p.chatId, `🤖 [${ttl}]\n${found.trim().slice(0, 2000)}`); console.log(`[dsh-bot] 完整回复已推送(${found.trim().length}字, finish信号)`) }
      catch (e) { console.error('[dsh-bot] 回复推送失败:', e.message) }
      delete pendingReplies[sessionId]
      continue
    }
    // 兜底：文件写入稳定 ≥3s 且已有文本 → 推（防漏掉 finish 信号）
    if (found.trim() && p.lastMtime === st.mtimeMs && Date.now() - (p.stableSince || Date.now()) >= 3000) {
      const ttl = sessionTitle(sessionId)
      try { await reply(p.chatId, `🤖 [${ttl}]\n${found.trim().slice(0, 2000)}`); console.log(`[dsh-bot] 完整回复已推送(${found.trim().length}字, 3s稳定)`) }
      catch (e) { console.error('[dsh-bot] 回复推送失败:', e.message) }
      delete pendingReplies[sessionId]
      continue
    }
    // 无文本：超 10 分钟放弃，否则继续等
    if (p.lastMtime === st.mtimeMs && !found.trim() && Date.now() - (p.stableSince || Date.now()) >= 3000) {
      if (!p.startedAt || Date.now() - p.startedAt > 600000) {
        delete pendingReplies[sessionId]
        continue
      }
      p.stableSince = Date.now()
    }
    // 推进状态
    if (p.lastMtime !== st.mtimeMs) {
      p.lastMtime = st.mtimeMs
      p.stableSince = Date.now()
    }
    p.sinceSeq = maxSeq
    p.acc = found
  }
  saveState()
}

/** —— 自配对（DSH /m/api 需要配对设备会话）—— */
let pairCookie = null
async function ensurePaired() {
  // 已有 cookie 且可用 → 直接返回
  if (pairCookie) {
    const probe = await fetch(`${DSH}/m/api/workspace.list`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: pairCookie },
      body: JSON.stringify({ rpcId: 'probe', payload: {} })
    })
    const b = await probe.json().catch(() => ({}))
    if (b.result?.ok !== false && b.type === 'server-response') return
    pairCookie = null
  }
  // 重新配对
  const issue = await fetch(`${DSH}/api/pair/issue`, { method: 'POST' }).then((r) => r.json())
  const token = issue.token || String(issue.url || '').split('pair=').pop()
  if (!token) throw new Error(`配对 issue 失败: ${JSON.stringify(issue).slice(0, 150)}`)
  const accept = await fetch(`${DSH}/api/pair/accept`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  })
  const setCookie = accept.headers.get('set-cookie') || ''
  const match = setCookie.match(/(dsh_pair=[^;]+)/)
  if (!match) throw new Error(`配对 accept 未返回 cookie: ${(await accept.text()).slice(0, 150)}`)
  pairCookie = match[1]
  saveState()
}

/** DSH 移动 RPC 网关调用（/m/api/<method>，需配对 cookie）。 */
async function dshRpc(method, payload) {
  await ensurePaired()
  const res = await fetch(`${DSH}/m/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: pairCookie },
    body: JSON.stringify({ rpcId: `feishu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, payload })
  })
  const body = await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status}` } }))
  if (body.type === 'server-response' && body.result) {
    if (body.result.ok === false) throw new Error(body.result.error?.message || `RPC ${method} 失败`)
    return body.result.value
  }
  if (body.ok === false) throw new Error(body.error?.message || `RPC ${method} 失败`)
  return body
}

/** DSH 审批答复（POST /api/respond，必须用事件流拿到的 pending rpcId）。 */
async function dshRespond(sessionId, approvalId, outcome) {
  const entry = pendingRpcMap[approvalId]
  console.log(`[dsh-bot] respond 查表: approval=${approvalId.slice(0,8)} 映射大小=${Object.keys(pendingRpcMap).length} 命中=${entry ? '是' : '否'}`)
  if (!entry) throw new Error(`未获取到该审批的 rpcId（事件流未同步）: ${approvalId.slice(0, 8)}`)
  const body = {
    type: 'client-response',
    rpcId: entry.rpcId,
    result: { ok: true, value: { sessionId, approvalId, outcome } }
  }
  const res = await fetch(`${DSH}/api/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

/** 取当前最新会话（共享：飞书命令就在用户正在看的会话里执行）。 */
async function pickSession() {
  const ws = await dshRpc('workspace.list', {})
  const items = ws?.items || ws?.workspaces || []
  const workspaceId = CFG.defaultWorkspace || items[0]?.workspaceId || items[0]?.id
  if (!workspaceId) throw new Error('没有可用工作区')
  const s = await dshRpc('session.list', { workspaceId })
  const sessions = s?.items || s?.sessions || []
  if (sessions.length === 0) throw new Error('该工作区没有会话')
  const first = sessions[0]
  return { id: first.sessionId || first.id }
}

/** 发飞书文本消息回群。 */
async function reply(chatId, text) {
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }
  })
}

/** 以应用身份发审批交互卡片（带 批准/拒绝 按钮）。 */
async function sendApprovalCard(sessionId, approvalId, toolName, reason, taskTitle) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '⚠️ 需要权限确认' }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**任务**: ${taskTitle || sessionId.slice(0, 8)}\n**工具**: ${toolName || '?'}\n**原因**: ${String(reason || '').slice(0, 200)}` } },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '✅ 批准' }, type: 'primary', value: JSON.stringify({ sessionId, approvalId, decision: 'approve' }) },
          { tag: 'button', text: { tag: 'plain_text', content: '⛔ 拒绝' }, type: 'danger', value: JSON.stringify({ sessionId, approvalId, decision: 'reject' }) }
        ]
      }
    ]
  }
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: defaultChatId, msg_type: 'interactive', content: JSON.stringify(card) }
  })
}

/** 发"选择确认卡"（agent 输出 ⚡CONFIRM 标记时触发，选项按钮）。 */
async function sendConfirmCard(chatId, sessionId, question, options) {
  const actions = options.slice(0, 5).map((opt, i) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: String(opt).slice(0, 20) },
    type: i === 0 ? 'primary' : 'default',
    value: JSON.stringify({ type: 'confirm', sessionId, option: String(opt) })
  }))
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '❓ 需要确认' }, template: 'blue' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: String(question).slice(0, 200) } },
      { tag: 'action', actions }
    ]
  }
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) }
  })
}

/** 扫描所有会话的新审批 → 发交互卡片。 */
async function scanApprovals() {
  if (!defaultChatId) return
  for (const ws of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    for (const s of readdirSync(join(SESSIONS_ROOT, ws.name), { withFileTypes: true })) {
      if (!s.isDirectory() || !s.name.startsWith('session-')) continue
      const file = join(SESSIONS_ROOT, ws.name, s.name, 'session.jsonl.zstd')
      if (!existsSync(file)) continue
      const st = statSync(file)
      const prev = approvalTrack[s.name] || { lastSeq: -1, file, mtime: 0 }
      if (prev.mtime === st.mtimeMs && prev.lastSeq !== -1) continue
      let maxSeq = prev.lastSeq
      const asked = []
      const doneTodos = []
      const prevTodos = todoTrack[s.name]?.todos
      let todosNow = prevTodos
      for (const ln of readLines(file)) {
        let o; try { o = JSON.parse(ln) } catch { continue }
        if (typeof o.seq !== 'number' || o.seq <= prev.lastSeq) continue
        if (o.seq > maxSeq) maxSeq = o.seq
        if (o.type === 'approval/asked') asked.push({ id: o.data?.id, toolName: o.data?.toolName, reason: o.data?.reason })
        else if (o.type === 'todo/write' && Array.isArray(o.data?.todos)) {
          const t = o.data.todos.map((x) => ({ content: x.content, status: x.status }))
          if (Array.isArray(todosNow)) {
            const doneNow = new Set(t.filter((x) => x.status === 'completed').map((x) => x.content))
            const doneBefore = new Set(todosNow.filter((x) => x.status === 'completed').map((x) => x.content))
            for (const c of doneNow) if (!doneBefore.has(c)) doneTodos.push(c)
          }
          todosNow = t
        }
      }
      approvalTrack[s.name] = { lastSeq: maxSeq, file, mtime: st.mtimeMs }
      if (todosNow !== prevTodos) todoTrack[s.name] = { lastSeq: maxSeq, todos: todosNow }
      if (prev.lastSeq === -1) continue // 首见=基线
      for (const a of asked) {
        try { await sendApprovalCard(s.name, a.id, a.toolName, a.reason, sessionTitle(s.name)); console.log(`[dsh-bot] 审批卡片已发送: ${a.toolName}`) }
        catch (e) { console.error('[dsh-bot] 审批卡片发送失败:', e.message) }
      }
      for (const c of doneTodos) {
        try { await reply(defaultChatId, `✅ [${sessionTitle(s.name)}] 任务完成: ${c}`); console.log(`[dsh-bot] 任务完成推送: ${c.slice(0, 30)}`) }
        catch (e) { console.error('[dsh-bot] 任务完成推送失败:', e.message) }
      }
    }
  }
  saveState()
}

/** —— 每小时会话进展摘要（原 dsh-push 逻辑并入）—— */
function buildSummary() {
  const lookbackMs = 60 * 60 * 1000
  const now = Date.now()
  let total = 0
  const active = []
  try {
    for (const ws of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      for (const s of readdirSync(join(SESSIONS_ROOT, ws.name), { withFileTypes: true })) {
        if (!s.isDirectory() || !s.name.startsWith('session-')) continue
        const file = join(SESSIONS_ROOT, ws.name, s.name, 'session.jsonl.zstd')
        if (!existsSync(file)) continue
        const st = statSync(file)
        total++
        if (now - st.mtimeMs <= lookbackMs) {
          active.push({ sid: s.name.replace('session-', '').slice(0, 8), mtime: st.mtimeMs })
        }
      }
    }
  } catch {}
  active.sort((a, b) => b.mtime - a.mtime)
  const rel = (ms) => { const m = Math.floor((now - ms) / 60000); return m < 1 ? '刚刚' : m < 60 ? `${m}分钟前` : `${Math.floor(m / 60)}小时前` }
  let msg = `📊 DSH 会话进展 · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`
  msg += `会话总数：${total} | 近1小时活跃：${active.length}`
  for (const a of active.slice(0, 5)) msg += `\n┌ ${a.sid} · ${rel(a.mtime)}`
  if (active.length === 0) msg += `\n近1小时无活跃会话。`
  return msg
}
async function sendHourlySummary() {
  if (!defaultChatId) { console.log('[dsh-bot] 摘要跳过：尚无对话（defaultChatId 为空）'); return }
  try { await reply(defaultChatId, buildSummary()); console.log(`[dsh-bot] 每小时摘要已推送 (${new Date().toLocaleTimeString()})`) }
  catch (e) { console.error('[dsh-bot] 摘要推送失败:', e.message) }
}
/** 调度：每到整点+5 分推一次摘要。 */
function scheduleHourlySummary() {
  const schedule = () => {
    const now = new Date()
    const next = new Date(now)
    next.setMinutes(5, 0, 0)
    if (next <= now) next.setHours(next.getHours() + 1)
    const delay = next - now
    console.log(`[dsh-bot] 下次摘要: ${next.toLocaleTimeString()}（${Math.round(delay / 60000)} 分钟后）`)
    setTimeout(async () => {
      await sendHourlySummary()
      schedule()
    }, delay)
  }
  schedule()
}

const client = new lark.Client({
  appId: CFG.appId,
  appSecret: CFG.appSecret,
  appType: lark.AppType.SelfBuild,
  loggerLevel: lark.LoggerLevel.INFO
})

const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.INFO })

// —— 指令：收到飞书消息 ——
dispatcher.register({
  'im.message.receive_v1': async (data) => {
    const msg = data.message
    console.log(`[dsh-bot] 📩 收到消息 chat=${msg?.chat_id?.slice(0,8)}… type=${msg?.message_type} content=${String(msg?.content).slice(0,80)}`)
    defaultChatId = msg.chat_id // 记住默认回复群
    saveState()
    let text = ''
    let mentioned = false
    try {
      const raw = JSON.parse(msg.content || '{}')
      // text 类型: {"text":"..."} ; post 类型: {"content":[[{"tag":"text","text":"..."},...]]}
      if (typeof raw.text === 'string') {
        text = raw.text
      } else if (Array.isArray(raw.content)) {
        text = raw.content.flat().map((s) => s.text || s.user_name || '').join('')
      }
      mentioned = /@_user_\d+/.test(JSON.stringify(raw))
      text = text.replace(/@_user_\d+\s*/g, '').trim()
    } catch { console.log('[dsh-bot] 内容解析失败'); return }
    // 指令判定：单聊(p2p)=整句即指令；群聊(group)=@了才是指令，否则要 "dsh " 前缀
    let instruction = null
    if (msg.chat_type === 'p2p') {
      instruction = text
    } else if (mentioned) {
      instruction = text
    } else if (text.startsWith(CFG.commandPrefix + ' ')) {
      instruction = text.slice(CFG.commandPrefix.length).trim()
    }
    if (!instruction) return
    try {
      const session = await pickSession()
      const result = await dshRpc('session.prompt', {
        sessionId: session.id,
        mode: 'steer',
        content: [{ type: 'text', text: instruction }]
      })
      const summary = result?.message?.content?.[0]?.text || result?.text || '已下发指令，agent 开始执行'
      await reply(msg.chat_id, `🤖 已下发到会话 ${session.id.slice(0, 8)}:\n${summary.slice(0, 500)}`)
      // 登记回复回推：监听专用会话的 agent 回复（累积 + 等稳定）
      const file = findSessionFile(session.id)
      if (file) {
        const maxSeq = readLines(file).reduce((m, ln) => {
          try { const o = JSON.parse(ln); return typeof o.seq === 'number' && o.seq > m ? o.seq : m } catch { return m }
        }, -1)
        pendingReplies[session.id] = { chatId: msg.chat_id, sinceSeq: maxSeq, file, acc: '', lastMtime: 0, stableSince: 0, startedAt: Date.now() }
        saveState()
      }
    } catch (e) {
      await reply(msg.chat_id, `❌ ${e.message}`)
    }
  }
})

// —— 审批卡片 ——
dispatcher.register({
  'card.action.trigger': async (data) => {
    console.log(`[dsh-bot] 🔘 收到卡片按钮事件: value=${JSON.stringify(data.action?.value)?.slice(0, 150)}`)
    // value 可能被飞书多层 JSON 编码，循环解到对象为止
    let value = data.action?.value
    while (typeof value === 'string') {
      try { value = JSON.parse(value) } catch { break }
    }
    const chatId = data.open_chat_id
    // —— 选择确认卡：把选项注入会话，让 agent 继续 ——
    if (value?.type === 'confirm' && value?.sessionId && value?.option) {
      try {
        const session = { id: value.sessionId }
        await dshRpc('session.prompt', {
          sessionId: session.id,
          mode: 'steer',
          content: [{ type: 'text', text: `（飞书确认）你选择了: ${value.option}` }]
        })
        if (chatId) await reply(chatId, `✅ 已选择: ${value.option}`)
        console.log(`[dsh-bot] 确认选项已注入: ${value.option.slice(0, 20)}`)
      } catch (e) {
        if (chatId) await reply(chatId, `❌ 注入失败: ${e.message}`)
      }
      return
    }
    // —— 审批卡：批准/拒绝 ——
    const outcome = value?.decision === 'approve' ? 'allowed-once' : value?.decision === 'reject' ? 'rejected' : null
    if (!outcome || !value?.sessionId || !value?.approvalId) { console.log('[dsh-bot] 卡片值缺字段，忽略:', JSON.stringify(value)); return }
    const r = await dshRespond(value.sessionId, value.approvalId, outcome)
    console.log(`[dsh-bot] /api/respond -> HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 120)}`)
    if (r.body?.accepted === true) delete pendingRpcMap[value.approvalId], saveState()
    if (chatId) await reply(chatId, r.body?.accepted === true ? '✅ 已批准' : `❌ 审批失败: ${r.body?.reason || '未知'}`)
  }
})

const ws = new lark.WSClient({
  appId: CFG.appId,
  appSecret: CFG.appSecret,
  autoReconnect: true,
  loggerLevel: lark.LoggerLevel.INFO,
  onReady: () => console.log(`[dsh-bot] ✅ 飞书长连接已建立 (${new Date().toLocaleTimeString()})`),
  onError: (err) => console.error('[dsh-bot] 连接错误:', err.message)
})

await ws.start({ eventDispatcher: dispatcher })
console.log(`[dsh-bot] 已启动 · 指令前缀 "${CFG.commandPrefix} " · DSH ${DSH}`)

// 启动时加载状态 + 事件流订阅 + 扫描 + 每小时摘要
loadState()
startEventStream().catch((e) => console.error('[dsh-bot] 事件流启动失败:', e.message))
scheduleHourlySummary()
setInterval(() => {
  scanReplies().catch((e) => console.error('[dsh-bot] 回复扫描异常:', e.message))
  scanApprovals().catch((e) => console.error('[dsh-bot] 审批扫描异常:', e.message))
}, 5000)
