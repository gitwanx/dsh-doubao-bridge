/**
 * dsh-doubao-bridge — DSH 会话 ↔ 豆包会话 的协作桥（宿主侧）。
 *
 * 设计要点
 * --------
 * - 豆包桌面端（Chromium）由 `doubao_bridge/bridge_server.py` 通过 CDP 驱动，
 *   本插件只做 HTTP 客户端（127.0.0.1:8765），不直接碰 Chromium。
 * - 桥服务没起来时插件自动拉起（detached python 子进程），无需用户手工开终端。
 * - 所有"操作豆包界面"的请求在服务端单线程串行，绝不会两条消息打架。
 * - 每个 DSH 会话（exec.agent.session.id）在豆包侧有独立的"协作主对话"，用于
 *   brief/keep 模式保留上下文；dispatch 每次开新对话，避免上下文污染。
 * - 任务板（SQLite）是两边唯一的分工账本：DSH 建任务、派给豆包、豆包回复自动
 *   回填结果；豆包留给 DSH 的交接消息进 inbox。
 *
 * 工具
 * ----
 *   doubao_status   桥/豆包/任务板状态
 *   doubao_ask      问豆包一句（new=新对话，keep=沿用本会话协作对话）
 *   doubao_dispatch 分工：建任务板任务 → 派给豆包 → 等交付 → 回填
 *   doubao_review    请豆包独立审阅代码/文档/方案
 *   doubao_chats    列豆包最近会话
 *   doubao_read     读某个豆包会话消息
 *   doubao_brief    往本会话的协作对话灌一条简报（保留上下文）
 *   coop_board      任务板：list / add / claim / done / inbox
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = '@local/dsh-doubao-bridge'

/** 只依赖 tools 服务；webServer 等按需 ctx.get，避免版本差异。 */
export const inject = ['tools']

const BASE = process.env.DOUBAO_BRIDGE_URL || 'http://127.0.0.1:8765'
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
/** 优先环境变量，其次工作区 doubao_bridge/，最后插件自带 py/。 */
export function resolveBridgeDir() {
  const env = process.env.DOUBAO_BRIDGE_DIR
  if (env && existsSync(env)) return env
  const candidates = [
    resolve(PLUGIN_DIR, '..', '..', 'doubao_bridge'),
    resolve(PLUGIN_DIR, '..', '..', '..', 'doubao_bridge'),
    resolve(PLUGIN_DIR, 'py'),
  ]
  for (const c of candidates) if (existsSync(c) && existsSync(resolve(c, 'bridge_server.py'))) return c
  return candidates[0]
}

// ---------------------------------------------------------------- HTTP
async function jsonFetchOnce(path, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + path, {
      method,
      signal: ctrl.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data
    try {
      data = JSON.parse(text)
    } catch {
      data = { ok: res.ok, raw: text }
    }
    return { status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}

/** 带一次重试的 JSON 请求：桥重启/连接被回收时不至于直接失败。 */
async function jsonFetch(path, opts = {}) {
  try {
    return await jsonFetchOnce(path, opts)
  } catch (error) {
    const msg = String(error?.message ?? error)
    const transient = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|aborted|AbortError|other side closed/i.test(msg)
    if (!transient) throw error
    for (const waitMs of [400, 1200]) {
      await new Promise((r) => setTimeout(r, waitMs))
      await ensureServer().catch(() => {})
      try {
        return await jsonFetchOnce(path, opts)
      } catch (retryError) {
        const retryMsg = String(retryError?.message ?? retryError)
        if (!/fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|aborted|AbortError|other side closed/i.test(retryMsg)) {
          throw retryError
        }
      }
    }
    throw error
  }
}

async function ping(timeoutMs = 1500) {
  // 注意：这里必须用 jsonFetchOnce（不带重试），否则 jsonFetch 的重试会再调
  // ensureServer → ping，形成递归死锁（2026-10-30 实测踩到）。
  try {
    const { status } = await jsonFetchOnce('/health', { timeoutMs })
    return status === 200
  } catch {
    return false
  }
}

/** 找一个能跑 playwright 的 python：优先显式路径，其次常见安装位置，最后 PATH。 */
function resolvePython() {
  const explicit = process.env.DOUBAO_BRIDGE_PYTHON
  const candidates = [
    explicit,
    'D:/Python/python.exe',
    'C:/Python311/python.exe',
    'C:/Python312/python.exe',
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return explicit || 'python'
}

/** 清掉可能污染子进程的 PYTHON* 变量（宿主环境里被设过 PYTHONPATH 会让依赖解析失败）。 */
function cleanEnv() {
  const env = { ...process.env }
  for (const k of ['PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYTHONEXECUTABLE']) {
    delete env[k]
  }
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUNBUFFERED = '1'
  return env
}

/** 读桥服务 stdout 日志的最后几行，用于把失败原因回给调用方。 */
function tailServerLog(lines = 20) {
  const home = process.env.LOCALAPPDATA || ''
  const file = `${home}\\DSHDoubaoBridge\\server.out.log`
  try {
    const text = readFileSync(file, 'utf8')
    return text.trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

let ensuring = null

/** 桥服务不在就拉起来；返回 {ok, started, detail}。 */
async function ensureServer() {
  if (await ping()) return { ok: true, started: false }
  if (ensuring) return ensuring
  ensuring = (async () => {
    const dir = resolveBridgeDir()
    const server = resolve(dir, 'bridge_server.py')
    if (!existsSync(server)) {
      return { ok: false, started: false, detail: `找不到桥服务脚本：${server}` }
    }
    const python = resolvePython()
    let childExit = ''
    try {
      const child = spawn(python, [server], {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: cleanEnv(),
      })
      child.on('exit', (code, signal) => {
        childExit = `子进程退出 code=${code} signal=${signal || ''}`
      })
      child.unref()
    } catch (error) {
      return { ok: false, started: false, detail: `启动桥服务失败（${python}）：${String(error?.message ?? error)}` }
    }
    // 等服务就绪（豆包冷启动 + CDP 连接大约 5-15s；启动期给 60s）
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      if (await ping(1000)) {
        return { ok: true, started: true, detail: `桥服务已启动（python=${python}）` }
      }
      if (childExit) break
    }
    const tail = tailServerLog(15)
    return {
      ok: false,
      started: true,
      detail: [
        '桥服务启动超时/失败',
        childExit || undefined,
        `python=${python}`,
        tail ? `日志尾部：\n${tail}` : '（server.out.log 为空）',
      ].filter(Boolean).join('\n'),
    }
  })().finally(() => {
    ensuring = null
  })
  // 兜底看门狗：万一以后再有循环/卡死，不让工具调用无限挂住，超时后明确报错
  return Promise.race([
    ensuring,
    new Promise((resolve) =>
      setTimeout(
        () => resolve({ ok: false, started: true, detail: '桥服务启动超时（150s 看门狗触发）；看 %LOCALAPPDATA%\DSHDoubaoBridge\server.out.log' }),
        150000,
      ).unref?.(),
    ),
  ])
}

function fail(message) {
  return JSON.stringify({ ok: false, message }, null, 2)
}

function textOf(value) {
  return JSON.stringify(value, null, 2)
}

// ---------------------------------------------------------------- 工具实现
function sessionOf(exec) {
  return exec?.agent?.session?.id ?? 'default'
}

async function doStatus() {
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  let st = {}
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data } = await jsonFetch('/status', { timeoutMs: 120000 })
    st = data || {}
    if (st.port) break
    await new Promise((r) => setTimeout(r, 3000))
  }
  const readyNow = st.port ? true : false
  return textOf({
    ok: true,
    bridge: ready,
    doubao: { logged_in: st.logged_in, cdp_port: st.port, page: st.page },
    board: st.board,
    busy: st.stale ? { current: st.busy, busy_s: st.busy_s } : undefined,
    hint: readyNow
      ? (st.logged_in ? undefined : '豆包未登录：打开桥接豆包窗口点「登录」（登录态是本机设备级的，通常自动完成）')
      : `桥服务在，但豆包还没就绪${st.busy ? `（正忙：${st.busy} ${st.busy_s}s）` : ''}；稍等几秒再查，或看 %LOCALAPPDATA%\DSHDoubaoBridge\server.out.log`,
  })
}

async function doAsk(args, exec) {
  const text = String(args?.text ?? '').trim()
  if (!text) return fail('text 不能为空')
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const timeout = Number(args?.timeout_s ?? 300)
  const { status, data } = await jsonFetch('/doubao/ask', {
    method: 'POST',
    timeoutMs: (timeout + 60) * 1000,
    body: { text, conv: args?.mode === 'keep' ? 'keep' : 'new', timeout, session: sessionOf(exec) },
  })
  if (status !== 200) return fail(`桥服务返回 ${status}: ${JSON.stringify(data)}`)
  return textOf({ ok: data.ok !== false, conv: data.conv, elapsed_s: data.elapsed_s, reply: data.reply })
}

async function doDispatch(args, exec) {
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const title = String(args?.title ?? '').trim()
  if (!title) return fail('title 不能为空（一句话说清这块子任务）')
  const timeout = Number(args?.timeout_s ?? 900)
  const created = await jsonFetch('/task/create', {
    method: 'POST',
    body: {
      title,
      detail: String(args?.detail ?? ''),
      spec_file: String(args?.spec_file ?? ''),
      source: `dsh:${sessionOf(exec)}`,
    },
  })
  const tid = created?.data?.task_id
  if (!tid) return fail(`建任务失败: ${JSON.stringify(created?.data)}`)
  const started = await jsonFetch('/coop/dispatch', {
    method: 'POST',
    body: { task_id: tid, timeout, mode: String(args?.mode ?? '') },
  })
  if (started?.data?.ok === false) return textOf({ ok: false, task_id: tid, error: started.data })

  // 可选：等一段时间，看它是不是已经干完（不阻塞太久，默认 0=立即返回）
  const waitS = Number(args?.wait_s ?? 0)
  let st = { status: 'running' }
  if (waitS > 0) {
    const deadline = Date.now() + waitS * 1000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000))
      const { data } = await jsonFetch(`/coop/status?task_id=${encodeURIComponent(tid)}`, { timeoutMs: 15000 })
      st = data || st
      if (['done', 'failed', 'blocked'].includes(st.status)) break
    }
  }
  return textOf({
    ok: true,
    task_id: tid,
    status: st.status ?? 'running',
    spec_file: created?.data?.spec_file,
    result_file: st.result_file,
    summary: st.summary || undefined,
    next: st.status === 'done'
      ? '已交付：需要细节时用 doubao_task_result 取全文，或直接读 result_file'
      : `还在跑：用 doubao_task_status(task_id="${tid}") 查进度，干完再取结果`,
  })
}

async function doTaskStatus(args) {
  const tid = String(args?.task_id ?? '').trim()
  if (!tid) return fail('task_id 不能为空')
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const { data } = await jsonFetch(`/coop/status?task_id=${encodeURIComponent(tid)}`, { timeoutMs: 15000 })
  return textOf(data)
}

async function doMedia(args, forcedKind) {
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const action = String(args?.action ?? 'plan')
  const kind = String(forcedKind || args?.kind || 'video')
  if (action === 'plan') {
    const { data } = await jsonFetch('/media/plan', {
      method: 'POST', timeoutMs: 30000,
      body: {
        kind,
        text: String(args?.text ?? ''),
        title: String(args?.title ?? ''),
        channel: String(args?.channel ?? ''),
      },
    })
    return textOf({
      ...data,
      must_show_user: data?.ok
        ? `预计额度 ${data.quota_estimate}（${data.quota_level}档）/ 预计耗时 ${data.eta_min} 分钟 / 规格 ${JSON.stringify(data.spec)}；今日已用 ${data.used_today}/${data.daily_limit}；等用户明确同意后调 ${kind === 'image' ? 'doubao_image' : 'doubao_video'} action=authorize plan_id=${data.plan_id}`
        : undefined,
    })
  }
  if (action === 'authorize') {
    const { data } = await jsonFetch('/media/authorize', {
      method: 'POST', timeoutMs: 30000,
      body: { plan_id: String(args?.plan_id ?? ''), approve: args?.approve !== false },
    })
    return textOf(data)
  }
  if (action === 'status') {
    const { data } = await jsonFetch(`/media/status?plan_id=${encodeURIComponent(String(args?.plan_id ?? ''))}`, { timeoutMs: 20000 })
    return textOf(data)
  }
  return fail('action 只能是 plan / authorize / status')
}

const doVideo = (args) => doMedia(args, 'video')
const doImage = (args) => doMedia(args, 'image')

async function doMode(args) {
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const action = String(args?.action ?? 'get')
  if (action === 'set') {
    const name = String(args?.name ?? '').trim()
    if (!name) return fail('set 需要 name（本地电脑 / 云电脑 / 悦星 / 对话）')
    const { data } = await jsonFetch('/mode/set', { method: 'POST', timeoutMs: 120000, body: { name } })
    return textOf(data)
  }
  const { data } = await jsonFetch('/mode', { timeoutMs: 90000 })
  return textOf(data)
}

async function doAccount(args) {
  const action = String(args?.action ?? 'status')
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  if (action === 'status') {
    const { data } = await jsonFetch('/account', { timeoutMs: 90000 })
    return textOf(data)
  }
  if (action === 'switch') {
    const target = String(args?.target ?? '').trim()
    const qs = target ? `?target=${encodeURIComponent(target)}` : ''
    const { data } = await jsonFetch(`/account/switch${qs}`, { timeoutMs: 150000 })
    return textOf({ ...data, note: data?.screenshot ? `二维码截图: ${data.screenshot}（用 read_image 打开给用户扫）` : undefined })
  }
  if (action === 'logout') {
    const { data } = await jsonFetch('/account/logout', { method: 'POST', timeoutMs: 120000 })
    return textOf(data)
  }
  return fail('action 只能是 status / switch / logout')
}

async function doTaskAnswer(args) {
  const tid = String(args?.task_id ?? '').trim()
  const choice = String(args?.choice ?? '').trim()
  if (!tid) return fail('task_id 不能为空')
  if (!choice) return fail('choice 不能为空（选项序号如 "1"、选项名片段，或自定义文本）')
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const { data } = await jsonFetch('/coop/answer', {
    method: 'POST',
    timeoutMs: 120000,
    body: { task_id: tid, choice },
  })
  return textOf(data)
}

async function doTaskResult(args) {
  const tid = String(args?.task_id ?? '').trim()
  if (!tid) return fail('task_id 不能为空')
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const head = args?.full === true ? 0 : Number(args?.limit ?? 2000)
  const q = head > 0 ? `&head=1&limit=${head}` : ''
  const { data } = await jsonFetch(`/coop/result?task_id=${encodeURIComponent(tid)}${q}`, { timeoutMs: 20000 })
  if (head <= 0 && data?.result_file) {
    try {
      const fs = await import('node:fs/promises')
      data.full = (await fs.readFile(data.result_file, 'utf8')).slice(0, 200000)
    } catch (error) {
      data.full_error = String(error?.message ?? error)
    }
  }
  return textOf(data)
}

async function doReview(args) {
  const content = String(args?.content ?? '').trim()
  if (!content) return fail('content 不能为空')
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const { status, data } = await jsonFetch('/coop/review', {
    method: 'POST',
    timeoutMs: 500 * 1000,
    body: { content: content.slice(0, 60000), focus: String(args?.focus ?? '') },
  })
  if (status !== 200) return fail(`桥服务返回 ${status}: ${JSON.stringify(data)}`)
  return textOf({ ok: data.ok !== false, conv: data.conv, reply: data.reply })
}

async function doChats(args) {
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const { data } = await jsonFetch(`/doubao/chats?limit=${Number(args?.limit ?? 20)}`, { timeoutMs: 120000 })
  return textOf(data)
}

async function doRead(args) {
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const conv = args?.conversation_id ? `&conv=${encodeURIComponent(args.conversation_id)}` : ''
  const { data } = await jsonFetch(`/doubao/read?limit=${Number(args?.limit ?? 30)}${conv}`, { timeoutMs: 120000 })
  return textOf(data)
}

async function doBrief(args, exec) {
  const text = String(args?.text ?? '').trim()
  if (!text) return fail('text 不能为空')
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  const { data } = await jsonFetch('/coop/brief', {
    method: 'POST',
    timeoutMs: 240 * 1000,
    body: { text, session: sessionOf(exec) },
  })
  return textOf({ ok: data.ok !== false, conv: data.conv, reply: data.reply })
}

async function doBoard(args) {
  const action = String(args?.action ?? 'list')
  const ready = await ensureServer()
  if (!ready.ok) return textOf({ ok: false, server: ready })
  if (action === 'add') {
    const { data } = await jsonFetch('/board/task', {
      method: 'POST',
      body: { title: args?.title ?? '未命名', detail: args?.detail ?? '', owner: args?.owner ?? 'dsh' },
    })
    return textOf(data)
  }
  if (action === 'claim') {
    const { data } = await jsonFetch('/board/claim', { method: 'POST', body: { task_id: args?.task_id, owner: args?.owner ?? 'dsh' } })
    return textOf(data)
  }
  if (action === 'done') {
    const { data } = await jsonFetch('/board/done', {
      method: 'POST',
      body: { task_id: args?.task_id, result: args?.result ?? '', files: args?.files ?? '', ok: args?.ok !== false },
    })
    return textOf(data)
  }
  if (action === 'inbox') {
    const { data } = await jsonFetch('/board/inbox?recipient=dsh&unread=1', { timeoutMs: 30000 })
    return textOf(data)
  }
  const { data } = await jsonFetch('/board?limit=100', { timeoutMs: 30000 })
  return textOf(data)
}

// ---------------------------------------------------------------- 工具定义
function def(name, description, parameters, execute) {
  const TOOL_DEADLINE_MS = 240000   // 工具调用硬性上限：再慢也必须在 4 分钟内返回
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute(args, exec) {
      let timer
      const deadline = new Promise((resolve) => {
        timer = setTimeout(
          () => resolve(JSON.stringify({
            ok: false,
            deadline_exceeded: true,
            message: '工具调用超过 240s 硬上限，已中止等待；桥可能卡住，看 %LOCALAPPDATA%\DSHDoubaoBridge\server.out.log（看门狗会在卡死后重启桥）',
          }, null, 2)),
          TOOL_DEADLINE_MS,
        )
      })
      try {
        return await Promise.race([Promise.resolve(execute(args, exec)), deadline])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

const TOOLS = [
  def(
    'doubao_status',
    '检查 DSH↔豆包 协作桥是否就绪：桥服务、豆包登录态、任务板统计。**任何豆包工具报错时先调它**（桥服务没起会自动拉起，豆包窗口掉登录需要人工点一次登录）。',
    { type: 'object', properties: {} },
    async () => doStatus(),
  ),
  def(
    'doubao_ask',
    '问豆包一句话并等它回完。mode=new 每次开新对话（推荐用于独立问题，避免上下文污染）；mode=keep 沿用本 DSH 会话的协作主对话（需要连续讨论同一件事时用，先 doubao_brief 灌背景）。用于取第二意见、查资料、写文案、让它做你不想占本会话上下文的活。',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发的内容（可以多行，支持 markdown）' },
        mode: { type: 'string', enum: ['new', 'keep'], description: 'new=新对话（默认）/ keep=沿用本会话协作对话' },
        timeout_s: { type: 'number', description: '等回复上限秒数，默认 300' },
      },
      required: ['text'],
    },
    doAsk,
  ),
  def(
    'doubao_dispatch',
    '**分工主入口（异步、省 token）**：把子任务派给豆包（**生视频/图生视频类任务禁止派给豆包——会烧豆包额度，桥会直接 403 拒绝；媒体生成走其他渠道**） → 任务书落盘成 spec 文件（prompt 只给路径）→ 立即返回 task_id，不阻塞。豆包在本地电脑上干完会把详细报告写到 result 文件，回复只给 ≤600 字摘要。之后用 doubao_task_status 查进度、doubao_task_result 取结果。适合把可独立完成的活整块外包，DSH 只出规格+验收。',
    {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话子任务标题（会进任务板）' },
        detail: { type: 'string', description: '完整要求/背景/交付标准（会写成 spec.md 给豆包读；不需要塞进 prompt）' },
        spec_file: { type: 'string', description: '可选：已有任务书文件路径（比 detail 更省 token，迭代时优先用）' },
        timeout_s: { type: 'number', description: '豆包干活上限秒数，默认 900' },
        wait_s: { type: 'number', description: '可选：最多原地等多少秒（默认 0=立即返回，靠 status 轮询更省）' },
        mode: { type: 'string', enum: ['local', 'cloud', '悦星', '对话'], description: '可选：工作模式——local=本地电脑（默认）、cloud=云电脑（豆包云端跑，本地不动）、悦星=悦星、对话=普通对话。按实际需要选。' },
      },
      required: ['title'],
    },
    doDispatch,
  ),
  def(
    'doubao_task_status',
    '查一个已派任务的进度（轻量，不阻塞、不 dump 会话）。返回 status/elapsed_s/phase/conv/result_file/summary；豆包在问用户时 status=needs_input 且带 question（题目+选项），用 doubao_task_answer 作答。status=done 时用 doubao_task_result 取结果。',
    {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'doubao_dispatch 返回的 task_id' } },
      required: ['task_id'],
    },
    doTaskStatus,
  ),
  def(
    'doubao_image',
    '图片生成（一次一票授权制）。plan=先出「预计额度 + 预计耗时 + 规格 + 今日已用次数」，不执行；必须先把这几项报给用户并得到明确同意；authorize=消费票才开跑（一次性、10 分钟有效、未授权不执行）；status=看阶段与进度。channel=chat 用对话模式（更省额度），channel=work 用工作任务模式。执行后不打断，超时写 alerts 并告警。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['plan', 'authorize', 'status'], description: '默认 plan' },
        text: { type: 'string', description: 'plan 用：图片需求（尺寸/张数/风格）' },
        title: { type: 'string', description: 'plan 用：任务标题' },
        channel: { type: 'string', enum: ['chat', 'work'], description: 'plan 用：执行通道，chat=对话模式（白嫖额度）、work=工作任务模式' },
        plan_id: { type: 'string', description: 'authorize/status 用' },
        approve: { type: 'boolean', description: 'authorize 用：true=授权，false=拒绝' },
      },
    },
    doImage,
  ),
  def(
    'doubao_video',
    '视频生成（一次一票授权制）。plan=先出「预计额度 + 预计耗时 + 规格」拿 plan_id（不执行）；必须先把这三个数字报给用户并得到明确同意；authorize=消费这张票才开始跑（一次性、10 分钟有效、未授权一律不跑）；status=看阶段与进度百分比。开始执行后不打断，直到生成完成/产物落盘/总超时 40 分钟，超时写 alerts 并告警。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['plan', 'authorize', 'status'], description: '默认 plan' },
        text: { type: 'string', description: 'plan 用：视频需求描述（含分辨率/时长/数量）' },
        title: { type: 'string', description: 'plan 用：任务标题' },
        plan_id: { type: 'string', description: 'authorize/status 用' },
        approve: { type: 'boolean', description: 'authorize 用：true=授权执行，false=拒绝' },
      },
    },
    doVideo,
  ),
  def(
    'doubao_mode',
    '查看/切换豆包「工作模式」：get=当前模式+可选（对话/工作任务·本地电脑/云电脑/悦星）；set 传 name。本地电脑=在你这台机器上跑、能动本地文件；云电脑=在豆包云端跑、不碰本地；按实际需要选。派单时也可以直接在 doubao_dispatch 里传 mode。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set'], description: '默认 get' },
        name: { type: 'string', enum: ['本地电脑', '云电脑', '悦星', '对话'], description: 'set 时必填' },
      },
    },
    doMode,
  ),
  def(
    'doubao_account',
    '查看/切换/退出豆包账号。status=当前账号名与登录态；switch=打开「设置→切换账号」面板并截图（把 screenshot 路径给用户扫二维码，扫完再 status 确认）；logout=退出当前账号。注意：真正换号需要手机扫码，桥负责把面板点和状态查好；同一时刻只激活一个账号。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'switch', 'logout'], description: '默认 status' },
        target: { type: 'string', description: 'switch 时目标账号名（如 星玥涯；不填只打开切换面板并给截图）' },
      },
    },
    doAccount,
  ),
  def(
    'doubao_task_answer',
    '回答豆包在「询问用户」时弹出的选项卡片。task_id + choice（选项序号 1/2/3、选项名片段、或任意自定义文本）。豆包在等答案时，doubao_task_status 会返回 status=needs_input 和 question.options，按它作答。',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id' },
        choice: { type: 'string', description: '选项序号(1/2/3)、选项名片段，或自定义文本' },
      },
      required: ['task_id', 'choice'],
    },
    doTaskAnswer,
  ),
  def(
    'doubao_task_result',
    '取任务交付物：默认只回前 N 字（省 token），需要全文时用 full=true。会给出 result_file 路径，DSH 也可以直接用 read 工具读那个文件。',
    {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id' },
        limit: { type: 'number', description: '摘要截取字数，默认 2000' },
        full: { type: 'boolean', description: 'true=返回完整报告（长任务慎用，更省的做法是读 result_file）' },
      },
      required: ['task_id'],
    },
    doTaskResult,
  ),
  def(
    'doubao_review',
    '请豆包做一次独立审阅（代码、diff、方案、文档），返回「总判断 + 问题清单 + 遗漏点」。审阅是独立上下文，不会看到本会话历史，所以 content 要贴全。用于在提交前拿一个不同模型的视角。',
    {
      type: 'object',
      properties: {
        content: { type: 'string', description: '待审内容（代码/文档/方案原文，最多 6 万字）' },
        focus: { type: 'string', description: '审阅重点，如「并发正确性」「是否漏了边界」「可执行性」' },
      },
      required: ['content'],
    },
    doReview,
  ),
  def(
    'doubao_brief',
    '往本 DSH 会话的「豆包协作主对话」里灌一条背景简报，并让豆包复述它理解的重点。之后用 doubao_ask mode=keep 就能接着这个上下文聊（相当于给豆包建档）。',
    {
      type: 'object',
      properties: { text: { type: 'string', description: '简报内容：项目背景、目标、约定、当前进度' } },
      required: ['text'],
    },
    doBrief,
  ),
  def(
    'doubao_chats',
    '列豆包最近会话（id + 标题），用来找某个已存在的讨论或核对协作对话是否建对了。',
    { type: 'object', properties: { limit: { type: 'number', description: '默认 20' } } },
    doChats,
  ),
  def(
    'doubao_read',
    '读豆包某会话的消息正文（user/assistant 交替）。不给 conversation_id 就读豆包当前打开的会话。用于回看豆包交付细节、或确认它到底回了什么。',
    {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '会话 id（从 doubao_chats 拿）；缺省=当前会话' },
        limit: { type: 'number', description: '最多读多少条消息，默认 30' },
      },
    },
    doRead,
  ),
  def(
    'coop_board',
    '共享任务板（DSH 与豆包的分工账本，SQLite）。action=list 看全部任务与统计；add 建任务；claim 领取；done 交付（result/files）；inbox 取豆包留给 DSH 的交接消息（读后置已读）。',
    {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'claim', 'done', 'inbox'], description: '默认 list' },
        task_id: { type: 'string', description: 'claim/done 用' },
        title: { type: 'string', description: 'add 用：一句话标题' },
        detail: { type: 'string', description: 'add 用：要求/背景' },
        owner: { type: 'string', enum: ['dsh', 'doubao', 'either'], description: 'add/claim 用：归属' },
        result: { type: 'string', description: 'done 用：交付内容/结论' },
        files: { type: 'string', description: 'done 用：交付文件路径（逗号分隔）' },
        ok: { type: 'boolean', description: 'done 用：是否成功（false=blocked）' },
      },
    },
    doBoard,
  ),
]

export function apply(ctx) {
  const disposers = TOOLS.map((tool) =>
    ctx.effect(() => ctx.tools.register(tool), `dsh-doubao-bridge: ${tool.name}`),
  )
  // 预热：插件挂载后异步检查/拉起桥服务，不阻塞宿主启动
  void ensureServer().catch(() => {})
  return () => {
    for (const d of disposers) {
      try {
        d?.()
      } catch {
        /* 忽略 */
      }
    }
  }
}

// 供自检脚本直接调用（不影响插件注册）
export { ensureServer, resolvePython }
