import test from 'node:test'
import assert from 'node:assert/strict'
import { FeishuBridge } from '../lib/bridge.js'

/**
 * stop() 的隔离与停止后的事件入口。
 *
 * 只用原型 + 假成员，不起长连接。重点：任意一步抛错（典型是插件卸载时宿主上下文失活），
 * 后面的步骤 —— 尤其是 wsClient.close() —— 仍然要执行，否则会留下僵尸长连接。
 */
function fakeBridge(overrides) {
  const calls = []
  const warnings = []
  const bridge = Object.create(FeishuBridge.prototype)
  bridge.stopped = false
  bridge.cards = new Map([['oc_1', { dispose: () => calls.push('card.dispose') }]])
  bridge.log = {
    debug() {},
    info() {},
    warn: (message, detail) => warnings.push([message, detail]),
    error() {},
  }
  bridge.stopCardWatchdog = () => calls.push('watchdog')
  bridge.setConnection = (state) => calls.push('status:' + state)
  bridge.questions = { cancelAll: () => calls.push('questions') }
  bridge.finishLiveCards = async () => calls.push('live-cards')
  bridge.reactions = { clear: async () => calls.push('reactions') }
  bridge.offSessionEvent = () => calls.push('session-event')
  bridge.agents = { disposeAll: () => calls.push('agents') }
  bridge.wsClient = { close: async () => calls.push('ws.close') }
  bridge.store = { save: async () => calls.push('store.save') }
  Object.assign(bridge, typeof overrides === 'function' ? overrides(calls) : overrides || {})
  return { bridge, calls, warnings }
}

test('stop() 正常路径：按顺序执行全部清理步骤', async () => {
  const { bridge, calls, warnings } = fakeBridge()
  await bridge.stop()
  assert.equal(bridge.stopped, true)
  assert.deepEqual(calls, [
    'watchdog',
    'status:stopped',
    'questions',
    'live-cards',
    'reactions',
    'session-event',
    'card.dispose',
    'agents',
    'ws.close',
    'store.save',
  ])
  assert.equal(bridge.offSessionEvent, undefined)
  assert.equal(bridge.cards.size, 0)
  assert.equal(warnings.length, 0)
})

test('stop() 某一步抛错（上下文已失活）时，仍然关闭长连接并保存状态', async () => {
  const { bridge, calls, warnings } = fakeBridge((log) => ({
    agents: {
      disposeAll: () => {
        log.push('agents')
        throw new Error('cannot get required service "agents" in inactive context')
      },
    },
    finishLiveCards: async () => {
      log.push('live-cards')
      throw new Error('network down')
    },
  }))
  await bridge.stop()
  assert.ok(calls.includes('ws.close'), '长连接必须被关闭')
  assert.ok(calls.includes('store.save'), '会话映射必须落盘')
  assert.deepEqual(warnings.map(([, detail]) => detail.step), ['live-cards', 'agents'])
})

test('stop() 之后 onEvent 不再处理任何事件', async () => {
  const { bridge } = fakeBridge()
  let queued = 0
  bridge.queue = { run: () => { queued += 1; return Promise.resolve() } }
  bridge.seen = new Set()
  bridge.remember = () => {}
  bridge.isDuplicateContent = () => false
  bridge.reactions.markPending = () => Promise.resolve()
  await bridge.stop()
  bridge.onEvent({
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
      message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: '{"text":"hi"}' },
    },
  })
  assert.equal(queued, 0)
})
