import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentPool } from '../lib/agents.js'
import { FeishuBridge } from '../lib/bridge.js'
import { executeCommand, formatSessionList, parseCommand, shortSessionId } from '../lib/commands.js'

/**
 * /new 归档、/ss（/sessions）列会话、/use 切会话。
 *
 * 只用假的宿主服务：sessionQuery 给会话头与标题，workspaceRegistry 管归档，
 * agents 记录 resume / dispose。桥接用原型 + 假成员，不起长连接。
 */
const CWD = '/tmp'
const KEY = 'oc_1'
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

function makeAgent(id) {
  return {
    status: 'idle',
    session: { id },
    ctx: { on: () => () => {} },
    model: { current: () => ({ provider: 'p', model: 'm' }) },
  }
}

function makeHost(options = {}) {
  const calls = []
  const archived = [...(options.archived || [])]
  const liveAgents = options.liveAgents || new Map()
  const headers = options.headers || [
    { id: 'session-aaaa1111', cwd: CWD, createdAt: 1000 },
    { id: 'session-bbbb2222', cwd: CWD, createdAt: 3000 },
    { id: 'session-cccc3333', cwd: CWD, createdAt: 2000 },
    { id: 'session-dddd4444', cwd: '/elsewhere', createdAt: 4000 },
    { id: 'session-eeee5555', cwd: CWD, createdAt: 5000, origin: 'subagent', delegationDepth: 1 },
  ]
  const state = { failResume: false }
  const services = {
    sessionQuery: {
      listSessions: async () => headers.map((header) => ({ header })),
      readTitleSnapshots: async (ids) => ids.map((id) => ({
        sessionId: id,
        status: 'fulfilled',
        value: { title: { title: '标题-' + id.slice(8, 12) } },
      })),
      observeSession: async () => ({ events: [] }),
    },
    workspaceRegistry: {
      get archivedSessionIds() { return [...archived] },
      archiveSession: async (id) => { calls.push(['archive', id]); archived.push(id) },
      unarchiveSession: async (id) => { calls.push(['unarchive', id]); archived.splice(archived.indexOf(id), 1) },
      list: () => [],
    },
  }
  const ctx = {
    get: (name) => services[name],
    agents: {
      get: (id) => liveAgents.get(id),
      resume: async ({ resumeSessionId }) => {
        if (state.failResume) throw new Error('log damaged')
        calls.push(['resume', resumeSessionId])
        return { agent: makeAgent(resumeSessionId), dispose: async () => calls.push(['dispose', resumeSessionId]) }
      },
    },
  }
  const sessions = new Map([[KEY, { sessionId: 'session-aaaa1111', cwd: CWD }]])
  const store = {
    sessions,
    get: (key) => sessions.get(key),
    set: async (key, value) => { sessions.set(key, value) },
    delete: async (key) => { sessions.delete(key) },
  }
  const pool = new AgentPool({ ctx, config: { workdir: CWD }, store, log: silentLog, onFrame() {}, onIdle() {}, onError() {} })
  const current = makeAgent('session-aaaa1111')
  pool.attach(KEY, { agent: current, dispose: async () => calls.push(['dispose', 'session-aaaa1111']) }, 'session-aaaa1111')

  const bridge = Object.create(FeishuBridge.prototype)
  Object.assign(bridge, {
    agents: pool,
    store,
    log: silentLog,
    cards: new Map(),
    liveCards: new Set(),
    expectTurn: new Map(),
    sessionListings: new Map(),
    questions: { cancel() {} },
    settleReactions() {},
  })
  const run = async (text) => (await executeCommand(bridge, {}, KEY, parseCommand(text))).reply
  return { calls, archived, liveAgents, sessions, pool, bridge, current, state, run }
}

test('shortSessionId 去掉 session- 前缀取前 8 位', () => {
  assert.equal(shortSessionId('session-0123456789ab'), '01234567')
  assert.equal(shortSessionId(''), '')
})

test('/new 归档自己建的老会话', async () => {
  const { pool, calls, sessions } = makeHost()
  await pool.destroy(KEY)
  assert.deepEqual(calls, [['dispose', 'session-aaaa1111'], ['archive', 'session-aaaa1111']])
  assert.equal(sessions.has(KEY), false)
})

test('/new 不归档借用的网页会话', async () => {
  const { pool, calls } = makeHost()
  pool.release(KEY)
  pool.attach(KEY, { agent: makeAgent('session-aaaa1111') }, 'session-aaaa1111', { borrowed: true })
  await pool.destroy(KEY)
  assert.deepEqual(calls, [])
})

test('/new 时网页端仍开着老会话：跳过归档', async () => {
  const { pool, calls, liveAgents } = makeHost()
  liveAgents.set('session-aaaa1111', makeAgent('session-aaaa1111'))
  await pool.destroy(KEY)
  assert.ok(!calls.some(([kind]) => kind === 'archive'))
})

test('/ss 与 /sessions：只列同目录的顶层会话，按创建时间倒序并带标记', async () => {
  const { run, bridge } = makeHost({ archived: ['session-cccc3333'] })
  const reply = await run('/ss')
  assert.equal(await run('/sessions'), reply)
  assert.equal(await run('/SS'), reply)
  const list = bridge.sessionListings.get(KEY)
  assert.deepEqual(list.map((item) => item.sessionId), ['session-bbbb2222', 'session-cccc3333', 'session-aaaa1111'])
  assert.match(reply, /1\. 标题-bbbb/)
  assert.match(reply, /2\. 标题-cccc 【已归档】/)
  assert.match(reply, /3\. 标题-aaaa 【当前】/)
  assert.doesNotMatch(reply, /dddd|eeee/)
})

test('formatSessionList：空列表与超过 10 条的提示', () => {
  assert.equal(formatSessionList([]), '本工作区还没有会话。')
  const many = Array.from({ length: 12 }, (_, index) => ({
    sessionId: 'session-' + String(index).padStart(8, '0'),
    title: 't' + index,
    createdAt: 0,
    archived: false,
    current: false,
    live: false,
  }))
  const reply = formatSessionList(many)
  assert.match(reply, /10\. t9/)
  assert.doesNotMatch(reply, /11\. /)
  assert.match(reply, /另有 2 个更早的会话/)
})

test('/use：参数校验、编号越界、切到当前会话', async () => {
  const { run } = makeHost()
  assert.match(await run('/use'), /用法/)
  assert.match(await run('/use 1'), /先发 \/sessions/)
  await run('/ss')
  assert.match(await run('/use 9'), /没有编号 9/)
  assert.match(await run('/use 3'), /已经在用/)
})

test('/use：当前一轮在执行时拒绝切换', async () => {
  const { run, current, sessions } = makeHost()
  await run('/ss')
  current.status = 'running'
  assert.match(await run('/use 1'), /还在执行/)
  assert.equal(sessions.get(KEY).sessionId, 'session-aaaa1111')
})

test('/use：切到已归档会话会先取消归档，原会话释放但不归档', async () => {
  const { run, calls, sessions, archived } = makeHost({ archived: ['session-cccc3333'] })
  await run('/ss')
  const reply = await run('/use 2')
  assert.match(reply, /已切换到「标题-cccc」（cccc3333），并已取消归档/)
  assert.equal(sessions.get(KEY).sessionId, 'session-cccc3333')
  assert.deepEqual(calls, [['unarchive', 'session-cccc3333'], ['dispose', 'session-aaaa1111'], ['resume', 'session-cccc3333']])
  assert.deepEqual(archived, [])
})

test('/use：按 ID 前缀切到网页端开着的会话时直接借用', async () => {
  const { run, calls, pool, liveAgents } = makeHost()
  liveAgents.set('session-bbbb2222', makeAgent('session-bbbb2222'))
  await run('/use bbbb')
  assert.equal(pool.isBorrowed(KEY), true)
  assert.deepEqual(calls, [['dispose', 'session-aaaa1111']])
})

test('/use：其他目录、子 agent 会话切不到，前缀有歧义时提示', async () => {
  const { run } = makeHost({
    headers: [
      { id: 'session-aaaa1111', cwd: CWD, createdAt: 1 },
      { id: 'session-ab001111', cwd: CWD, createdAt: 2 },
      { id: 'session-ab002222', cwd: CWD, createdAt: 3 },
      { id: 'session-dddd4444', cwd: '/elsewhere', createdAt: 4 },
      { id: 'session-eeee5555', cwd: CWD, createdAt: 5, origin: 'subagent', delegationDepth: 1 },
    ],
  })
  assert.match(await run('/use dddd'), /没有 ID/)
  assert.match(await run('/use eeee'), /没有 ID/)
  assert.match(await run('/use ab00'), /有 2 个会话匹配/)
})

test('/use：恢复失败时退回原会话映射，不悄悄新建', async () => {
  const { run, state, sessions } = makeHost()
  state.failResume = true
  await run('/ss')
  const reply = await run('/use 1')
  assert.match(reply, /切换失败：log damaged/)
  assert.equal(sessions.get(KEY).sessionId, 'session-aaaa1111')
})
