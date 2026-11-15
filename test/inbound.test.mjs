import test from 'node:test'
import assert from 'node:assert/strict'
import {
  conversationKey,
  extractItemText,
  extractResources,
  extractText,
  flattenPost,
  normalizeEvent,
  stripMentions,
} from '../lib/inbound.js'

const BOT = 'ou_bot'

function textEvent(overrides) {
  const message = Object.assign(
    {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '你好' }),
      create_time: '1700000000000',
    },
    overrides && overrides.message,
  )
  const sender = Object.assign(
    { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    overrides && overrides.sender,
  )
  return { schema: '2.0', event: { message, sender } }
}

test('单聊文本消息被归一化成 message', () => {
  const result = normalizeEvent(textEvent(), { botOpenId: BOT, requireMentionInGroup: true })
  assert.equal(result.kind, 'message')
  assert.equal(result.messageId, 'om_1')
  assert.equal(result.chatId, 'oc_1')
  assert.equal(result.chatType, 'p2p')
  assert.equal(result.senderOpenId, 'ou_user')
  assert.equal(result.text, '你好')
  assert.equal(result.createdAt, 1700000000000)
})

test('缺 message 的事件被忽略', () => {
  assert.equal(normalizeEvent({}, {}).reason, 'no-message')
  assert.equal(normalizeEvent(undefined, {}).reason, 'no-message')
  assert.equal(normalizeEvent({ event: { message: { message_id: 'x' } } }, {}).reason, 'no-message')
})

test('机器人自己发的消息被忽略，避免自问自答', () => {
  const raw = textEvent({ sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot' } } })
  assert.equal(normalizeEvent(raw, { botOpenId: BOT }).reason, 'sender-app')
})

test('群聊未 @ 机器人时忽略', () => {
  const raw = textEvent({ message: { chat_type: 'group' } })
  assert.equal(normalizeEvent(raw, { botOpenId: BOT, requireMentionInGroup: true }).reason, 'no-mention')
})

test('群聊关闭 requireMentionInGroup 时不 @ 也处理', () => {
  const raw = textEvent({ message: { chat_type: 'group' } })
  const result = normalizeEvent(raw, { botOpenId: BOT, requireMentionInGroup: false })
  assert.equal(result.kind, 'message')
})

test('群聊 @ 机器人后取正文并去掉占位符', () => {
  const raw = textEvent({
    message: {
      chat_type: 'group',
      content: JSON.stringify({ text: '@_user_1 帮我看看构建日志' }),
      mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: '机器人' }],
    },
  })
  const result = normalizeEvent(raw, { botOpenId: BOT, requireMentionInGroup: true })
  assert.equal(result.kind, 'message')
  assert.equal(result.text, '帮我看看构建日志')
})

test('不支持的消息类型返回 unsupported 并带上类型', () => {
  const raw = textEvent({ message: { message_type: 'sticker', content: JSON.stringify({ file_key: 'f' }) } })
  const result = normalizeEvent(raw, {})
  assert.equal(result.reason, 'unsupported-sticker')
  assert.equal(result.messageType, 'sticker')
  assert.equal(result.chatId, 'oc_1')
})

test('空白正文被忽略', () => {
  const raw = textEvent({ message: { content: JSON.stringify({ text: '   ' }) } })
  assert.equal(normalizeEvent(raw, {}).reason, 'empty-text')
})

test('content 不是合法 JSON 时返回空文本', () => {
  assert.equal(extractText({ message_type: 'text', content: '{bad' }), '')
  assert.equal(extractText({ message_type: 'image', content: '{}' }), '')
})

test('stripMentions 去掉所有占位符并压缩空白', () => {
  const text = stripMentions('@_user_1  看下   @_user_2 这个', [
    { key: '@_user_1' },
    { key: '@_user_2' },
  ])
  assert.equal(text, '看下 这个')
})

test('stripMentions 保留换行，条目边界不丢', () => {
  const text = stripMentions('@_user_1 1. 甲\n2. 乙\n\n\n3. 丙', [{ key: '@_user_1' }])
  assert.equal(text, '1. 甲\n2. 乙\n\n3. 丙')
})

test('会话键区分同一群的不用话题', () => {
  assert.equal(conversationKey({ chatId: 'oc_1', threadId: '' }), 'oc_1')
  assert.equal(conversationKey({ chatId: 'oc_1', threadId: 'omt_9' }), 'oc_1:omt_9')
})
function postEvent(overrides) {
  const message = Object.assign(
    {
      message_id: 'om_post',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'post',
      content: JSON.stringify({
        title: '',
        content: [[{ tag: 'text', text: '第一段' }], [{ tag: 'text', text: '第二段' }]],
      }),
      create_time: '1700000000000',
    },
    overrides && overrides.message,
  )
  const sender = { sender_type: 'user', sender_id: { open_id: 'ou_user' } }
  return { schema: '2.0', event: { message, sender } }
}

test('富文本消息（post）归一化成文本', () => {
  const result = normalizeEvent(postEvent(), {})
  assert.equal(result.kind, 'message')
  assert.equal(result.messageId, 'om_post')
  // 段落之间必须保留换行：用户按条目写的内容不能被压成一大段
  assert.equal(result.text, '第一段\n第二段')
})

test('富文本标题并入正文', () => {
  const raw = postEvent({
    message: {
      content: JSON.stringify({
        title: '待办',
        content: [[{ tag: 'text', text: '1. 甲' }], [{ tag: 'text', text: '2. 乙' }]],
      }),
    },
  })
  assert.equal(normalizeEvent(raw, {}).text, '待办\n1. 甲\n2. 乙')
})

test('富文本里的 @ 节点不进正文，@ 机器人 后仍能取到指令', () => {
  const raw = postEvent({
    message: {
      chat_type: 'group',
      content: JSON.stringify({
        content: [
          [{ tag: 'at', user_id: '@_user_1' }, { tag: 'text', text: ' 看下构建日志' }],
        ],
      }),
      mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: '机器人' }],
    },
  })
  const result = normalizeEvent(raw, { botOpenId: BOT, requireMentionInGroup: true })
  assert.equal(result.kind, 'message')
  assert.equal(result.text, '看下构建日志')
})

test('富文本同一段落内的多个片段直接拼接', () => {
  const raw = postEvent({
    message: {
      content: JSON.stringify({
        content: [[
          { tag: 'text', text: '看这个链接' },
          { tag: 'a', text: '文档', href: 'https://example.com' },
        ]],
      }),
    },
  })
  assert.equal(normalizeEvent(raw, {}).text, '看这个链接文档')
})

test('富文本只有图片时作为带资源的消息投递', () => {
  const raw = postEvent({
    message: { content: JSON.stringify({ content: [[{ tag: 'img', image_key: 'img_x' }]] }) },
  })
  const result = normalizeEvent(raw, {})
  assert.equal(result.kind, 'message')
  assert.equal(result.text, '')
  assert.deepEqual(result.resources, [{ kind: 'image', key: 'img_x', downloadType: 'image' }])
})

test('富文本既没有文字也没有图片时返回 unsupported-post-empty', () => {
  const raw = postEvent({
    message: { content: JSON.stringify({ content: [[{ tag: 'emotion', emoji_type: 'SMILE' }]] }) },
  })
  const result = normalizeEvent(raw, {})
  assert.equal(result.reason, 'unsupported-post-empty')
  assert.equal(result.messageType, 'post')
  assert.equal(result.chatId, 'oc_1')
})

test('富文本 content 解析不出文字时用 content_v2 兜底', () => {
  const post = { title: '', content: [], content_v2: [[{ tag: 'text', text: 'v2 正文' }]] }
  assert.equal(flattenPost(post), 'v2 正文')
})

test('富文本 content 不是合法 JSON 时返回空文本', () => {
  assert.equal(extractText({ message_type: 'post', content: '{bad' }), '')
  assert.equal(extractText({ message_type: 'post', content: '{}' }), '')
})

test('富文本列表项各自成行', () => {
  const raw = postEvent({
    message: {
      content: JSON.stringify({
        content: [[
          { tag: 'li', content: [{ tag: 'text', text: '甲' }] },
          { tag: 'li', content: [{ tag: 'text', text: '乙' }] },
        ]],
      }),
    },
  })
  assert.equal(normalizeEvent(raw, {}).text, '甲\n乙')
})

test('事件带出被引用消息 id 与话题根 id', () => {
  const raw = textEvent({ message: { parent_id: 'om_parent', root_id: 'om_root' } })
  const result = normalizeEvent(raw, {})
  assert.equal(result.parentId, 'om_parent')
  assert.equal(result.rootId, 'om_root')
})

test('extractItemText 兼容 msg_type + body.content 形态', () => {
  const text = { msg_type: 'text', body: { content: JSON.stringify({ text: '被引用的话' }) } }
  assert.deepEqual(extractItemText(text), { messageType: 'text', text: '被引用的话' })

  const post = {
    msg_type: 'post',
    body: {
      content: JSON.stringify({ content: [[{ tag: 'text', text: '甲' }], [{ tag: 'text', text: '乙' }]] }),
    },
  }
  assert.deepEqual(extractItemText(post), { messageType: 'post', text: '甲\n乙' })

  assert.deepEqual(extractItemText({ msg_type: 'image', body: { content: '{}' } }), {
    messageType: 'image',
    text: '',
  })
  assert.deepEqual(extractItemText(undefined), { messageType: '', text: '' })
})

test('图片 / 文件 / 语音 / 视频消息登记资源 key，正文为空', () => {
  const cases = [
    ['image', { image_key: 'img_1' }, [{ kind: 'image', key: 'img_1', downloadType: 'image' }]],
    ['file', { file_key: 'file_1', file_name: '报告.pdf' }, [{ kind: 'file', key: 'file_1', downloadType: 'file', name: '报告.pdf' }]],
    ['audio', { file_key: 'file_a', duration: 3200 }, [{ kind: 'audio', key: 'file_a', downloadType: 'file', durationMs: 3200 }]],
    ['media', { file_key: 'file_v', image_key: 'img_v', file_name: 'clip.mp4' }, [{ kind: 'file', key: 'file_v', downloadType: 'file', name: 'clip.mp4' }]],
  ]
  for (const [type, content, expected] of cases) {
    const result = normalizeEvent(textEvent({ message: { message_type: type, content: JSON.stringify(content) } }), {})
    assert.equal(result.kind, 'message', type)
    assert.equal(result.text, '', type)
    assert.equal(result.messageType, type)
    assert.deepEqual(result.resources, expected, type)
  }
})

test('纯文字消息的 resources 为空数组', () => {
  assert.deepEqual(normalizeEvent(textEvent(), {}).resources, [])
})

test('富文本：文字与内嵌图片同时保留，多语言包里重复的图片只算一次', () => {
  const post = {
    zh_cn: { title: '看图', content: [[{ tag: 'text', text: '这张' }, { tag: 'img', image_key: 'img_2' }], [{ tag: 'media', file_key: 'file_m' }]] },
    en_us: { content: [[{ tag: 'img', image_key: 'img_2' }]] },
  }
  const result = normalizeEvent(postEvent({ message: { content: JSON.stringify(post) } }), {})
  assert.equal(result.text, '看图\n这张')
  assert.deepEqual(result.resources, [
    { kind: 'image', key: 'img_2', downloadType: 'image' },
    { kind: 'file', key: 'file_m', downloadType: 'file', name: 'video.mp4' },
  ])
})

test('资源 content 缺 key 或不是 JSON 时不登记资源', () => {
  assert.deepEqual(extractResources({ message_type: 'image', content: '{}' }), [])
  assert.deepEqual(extractResources({ message_type: 'file', content: '{bad' }), [])
  assert.deepEqual(extractResources(null), [])
})
