/** 会话 ID 的短写：去掉 session- 前缀取前 8 位 */
export function shortSessionId(sessionId) {
  return String(sessionId || '').replace(/^session-/, '').slice(0, 8)
}

/** /sessions 一次最多列多少条 */
const SESSION_LIST_LIMIT = 10

const TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * 把会话列表排成飞书文本：编号、标题、标记、创建时间、短 ID。
 * @param {Array<{ sessionId: string, title: string, createdAt: number, archived: boolean, current: boolean, live: boolean }>} list
 */
export function formatSessionList(list) {
  if (!list || list.length === 0) return '本工作区还没有会话。'
  const lines = list.slice(0, SESSION_LIST_LIMIT).map((item, index) => {
    const tags = [item.current ? '当前' : '', item.archived ? '已归档' : '', item.live ? '网页端打开中' : '']
      .filter(Boolean)
      .map((tag) => '【' + tag + '】')
      .join('')
    const when = item.createdAt ? TIME_FORMAT.format(new Date(item.createdAt)) : '时间未知'
    return (index + 1) + '. ' + item.title + (tags ? ' ' + tags : '') + '\n    ' + when + ' · ' + shortSessionId(item.sessionId)
  })
  const more = list.length > SESSION_LIST_LIMIT
    ? '\n另有 ' + (list.length - SESSION_LIST_LIMIT) + ' 个更早的会话，可用 /use <会话 ID 前几位> 切换。'
    : ''
  return '本工作区的会话（按创建时间倒序）：\n' + lines.join('\n') + '\n\n发 /use <编号> 切换；切走的会话不会归档，已归档的切过去会自动取消归档。' + more
}

/**
 * 斜杠命令解析与执行（/help /new /sessions /use /stop /status /cwd /whoami）。
 * 命令只在插件内部处理，不会进入 agent，避免污染会话上下文。
 */

/** @returns {{ name: string, args: string } | undefined} */
export function parseCommand(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed.startsWith('/')) return undefined
  const parts = trimmed.split(/\s+/)
  const head = parts[0].slice(1)
  if (!head) return undefined
  return { name: head.toLowerCase(), args: parts.slice(1).join(' ').trim() }
}

export const HELP_TEXT = [
  '我可以把消息转发给 DeepSeek Harness 会话，并把回复流式写回这张卡片。',
  '',
  '/new            开启新会话（老会话自动归档，上下文不再续接）',
  '/ss             列出本工作区的会话（带编号；/sessions 同义）',
  '/use <编号|ID>  切到另一条会话继续聊（原会话不归档）',
  '/stop           中断当前这一轮',
  '/status        查看会话 ID、工作目录、模型与运行状态',
  '/cwd <目录>     设置本会话的工作目录（下一次 /new 或新建会话时生效）',
  '/whoami        查看你的 open_id / chat_id（配置白名单时用得上）',
  '/help           查看本说明',
  '',
  '直接发消息就是提问；群聊里需要 @ 我。',
].join('\n')

/**
 * @param {object} host 桥接对象（bridge 实现这些方法）
 * @param {object} message 归一化后的飞书消息
 * @param {string} key 会话键
 * @param {{ name: string, args: string }} command
 * @returns {Promise<{ reply?: string } | undefined>}
 */
export async function executeCommand(host, message, key, command) {
  switch (command.name) {
    case 'help':
    case '?':
      return { reply: HELP_TEXT }

    case 'new':
      await host.newSession(key)
      return { reply: '已开启新会话。下一条消息会在新的上下文里执行。' }

    case 'sessions':
    case 'ss':
      return { reply: formatSessionList(await host.listSessions(key)) }

    case 'use':
      return { reply: await host.switchSession(key, command.args) }

    case 'stop': {
      const stopped = await host.stopTurn(key)
      return { reply: stopped ? '已请求中断当前这一轮。' : '当前没有正在运行的轮次。' }
    }

    case 'status': {
      const status = host.describeStatus(key)
      return {
        reply: [
          '会话：' + (status.sessionId || '（还没有，下一条消息会新建）'),
          '工作目录：' + status.cwd,
          '状态：' + status.status,
          '模型：' + status.model,
        ].join('\n'),
      }
    }

    case 'cwd': {
      const changed = await host.setWorkdir(key, command.args)
      return { reply: changed }
    }

    case 'whoami':
      return {
        reply: [
          'open_id：' + (message.senderOpenId || '（未知）'),
          'chat_id：' + message.chatId,
          'chat_type：' + message.chatType,
        ].join('\n'),
      }

    default:
      return { reply: '未知命令：/' + command.name + '\n\n' + HELP_TEXT }
  }
}
