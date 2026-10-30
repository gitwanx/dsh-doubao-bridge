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
import { existsSync } from 'node:fs'
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
    await new Promise((r) => setTimeout(r, 500))
    await ensureServer().catch(() => {})
    return jsonFetchOnce(path, opts)
  }
}

async function ping(timeoutMs = 1500) {
  try {
    const { status } = await jsonFetch('/health', { timeoutMs })
    return status === 200
  } catch {
    return false
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
    const python = process.env.DOUBAO_BRIDGE_PYTHON || 'python'
    try {
      const child = spawn(python, [server], {
        cwd: dir,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      child.unref()
    } catch (error) {
      return { ok: false, started: false, detail: `启动桥服务失败：${String(error?.message ?? error)}` }
    }
    // 等服务就绪（豆包冷启动 + CDP 连接大约 5-15s）
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      if (await ping(1000)) return { ok: true, started: true, detail: '桥服务已启动' }
    }
    return { ok: false, started: true, detail: '桥服务启动超时（40s），看 %LOCALAPPDATA%\\DSHDoubaoBridge\\server.log' }
  })().finally(() => {
    ensuring = null
  })
  return ensuring
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
  const [{ data: st }] = await Promise.all([jsonFetch('/status', { timeoutMs: 120000 })])
  return textOf({
    ok: true,
    bridge: ready,
    doubao: { logged_in: st.logged_in, cdp_port: st.port, page: st.page },
    board: st.board,
    hint: st.logged_in ? undefined : '豆包未登录：打开桥接豆包窗口点「登录」（登录态是本机设备级的，通常自动完成）',
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
  const started = await jsonFetch('/coop/dispatch', { method: 'POST', body: { task_id: tid, timeout } })
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
  return {
    name,
    description,
    parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute,
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
