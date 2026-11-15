import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { FeishuApi, fileNameFromDisposition } from '../lib/feishu-api.js'
import { decodeToPcm, materializeResources, pcmToWave, sniffImageType, transcribeAudio } from '../lib/resources.js'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

/** dsh 语音识别对 WAV 的校验规则（与 dsh-experimental-speech-to-text 的 validateWave 一致） */
function assertCanonicalWave(audio) {
  const data = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
  assert.equal(data.toString('ascii', 0, 4), 'RIFF')
  assert.equal(data.toString('ascii', 8, 12), 'WAVE')
  assert.equal(data.toString('ascii', 12, 16), 'fmt ')
  assert.equal(data.readUInt32LE(16), 16)
  assert.equal(data.readUInt16LE(20), 1)
  assert.equal(data.readUInt16LE(22), 1)
  assert.equal(data.readUInt32LE(24), 16000)
  assert.equal(data.readUInt32LE(28), 32000)
  assert.equal(data.readUInt16LE(32), 2)
  assert.equal(data.readUInt16LE(34), 16)
  assert.equal(data.toString('ascii', 36, 40), 'data')
  assert.equal(data.readUInt32LE(4), data.length - 8)
  assert.equal(data.readUInt32LE(40), data.length - 44)
}

function makeAttachments() {
  const saved = []
  return {
    saved,
    saveImage: async (input) => {
      saved.push(['image', input.mediaType, input.name])
      return { attachmentId: 'img-' + saved.length, mediaType: input.mediaType, bytes: input.data.length, width: 1, height: 1 }
    },
    saveFile: async (input) => {
      saved.push(['file', input.name])
      return { attachmentId: 'file-' + saved.length, name: input.name, bytes: input.data.length }
    },
  }
}

function makeApi(table) {
  const calls = []
  return {
    calls,
    downloadResource: async (messageId, key, type, options) => {
      calls.push([messageId, key, type, options && options.maxBytes])
      const entry = table[key]
      if (entry instanceof Error) throw entry
      return { data: entry, contentType: 'application/octet-stream', fileName: '' }
    },
  }
}

test('sniffImageType 识别 png / jpeg，其余返回 undefined', () => {
  assert.equal(sniffImageType(PNG), 'image/png')
  assert.equal(sniffImageType(JPEG), 'image/jpeg')
  assert.equal(sniffImageType(Uint8Array.from([1, 2, 3])), undefined)
})

test('pcmToWave 生成 dsh 语音识别接受的规范 WAV（奇数字节被截掉）', () => {
  const wave = pcmToWave(Uint8Array.from([1, 2, 3, 4, 5]))
  assert.equal(wave.byteLength, 48)
  assertCanonicalWave(wave)
})

test('fileNameFromDisposition 优先 filename*，其次 filename', () => {
  assert.equal(fileNameFromDisposition("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"), '报告.pdf')
  assert.equal(fileNameFromDisposition('attachment; filename="a.txt"'), 'a.txt')
  assert.equal(fileNameFromDisposition(null), '')
})

test('downloadResource：带 token 请求资源接口，返回字节与文件名', async () => {
  const requests = []
  const api = new FeishuApi({
    appId: 'cli_x',
    appSecret: 's',
    log: silentLog,
    fetchImpl: async (url, init) => {
      requests.push([url, init.method, init.headers && init.headers.Authorization])
      if (url.endsWith('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1', expire: 7200 }), { status: 200 })
      }
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="p.png"' } })
    },
  })
  const result = await api.downloadResource('om_1', 'img_1', 'image', { maxBytes: 1024 })
  assert.deepEqual([...result.data], [...PNG])
  assert.equal(result.fileName, 'p.png')
  assert.equal(requests[1][0], 'https://open.feishu.cn/open-apis/im/v1/messages/om_1/resources/img_1?type=image')
  assert.equal(requests[1][2], 'Bearer t-1')
})

test('downloadResource：JSON 错误体抛 FeishuApiError，超过上限也拒绝', async () => {
  const api = new FeishuApi({
    appId: 'cli_x',
    appSecret: 's',
    log: silentLog,
    fetchImpl: async (url) => {
      if (url.endsWith('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-1', expire: 7200 }), { status: 200 })
      }
      if (url.includes('bad')) {
        return new Response(JSON.stringify({ code: 234003, msg: 'File not in msg.' }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      return new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    },
  })
  await assert.rejects(() => api.downloadResource('om_1', 'bad', 'file'), /File not in msg/)
  await assert.rejects(() => api.downloadResource('om_1', 'big', 'file', { maxBytes: 1024 }), /大小上限/)
})

test('materializeResources：图片进 image 块，文件进 file 块，下载失败只留一行说明', async () => {
  const attachments = makeAttachments()
  const api = makeApi({ img_1: PNG, file_1: Uint8Array.from([1, 2, 3]), gone: new Error('File not in msg.') })
  const message = {
    messageId: 'om_1',
    resources: [
      { kind: 'image', key: 'img_1', downloadType: 'image' },
      { kind: 'file', key: 'file_1', downloadType: 'file', name: '报告.pdf' },
      { kind: 'file', key: 'gone', downloadType: 'file' },
    ],
  }
  const result = await materializeResources({ api, attachments, message, config: { maxResourceBytes: 4096 }, log: silentLog })
  assert.deepEqual(result.blocks.map((block) => block.type), ['image', 'file'])
  assert.equal(result.blocks[1].attachment.name, '报告.pdf')
  assert.deepEqual(result.notes, ['[附件下载失败（file）：File not in msg.]'])
  assert.equal(api.calls[0][3], 4096)
})

test('materializeResources：识别不了的图片格式退回文件附件并说明', async () => {
  const attachments = makeAttachments()
  const api = makeApi({ img_x: Uint8Array.from([1, 2, 3, 4]) })
  const message = { messageId: 'om_1', resources: [{ kind: 'image', key: 'img_x', downloadType: 'image' }] }
  const result = await materializeResources({ api, attachments, message, config: {}, log: silentLog })
  assert.deepEqual(result.blocks.map((block) => block.type), ['file'])
  assert.equal(result.notes.length, 1)
})

test('materializeResources：语音经 ffmpeg 解码 + dsh 语音识别转成文字', async () => {
  const attachments = makeAttachments()
  const api = makeApi({ file_a: Uint8Array.from([9, 9, 9]) })
  const resolved = []
  const speech = {
    resolve: (request) => {
      resolved.push(request)
      return { audio: request.audio }
    },
    transcribe: async () => ({ text: ' 你好飞书 ', audioSeconds: 1, inferenceSeconds: 0.1 }),
  }
  const decode = async (data, options) => {
    assert.equal(options.ffmpegPath, '/usr/bin/ffmpeg')
    return new Uint8Array(3200)
  }
  const message = { messageId: 'om_1', resources: [{ kind: 'audio', key: 'file_a', downloadType: 'file', durationMs: 2600 }] }
  const result = await materializeResources({
    api, attachments, speech, decode, message, config: { ffmpegPath: '/usr/bin/ffmpeg' }, log: silentLog,
  })
  assert.deepEqual(result.blocks, [])
  assert.deepEqual(result.notes, ['[语音消息，约 3 秒，转写如下]\n你好飞书'])
  assertCanonicalWave(resolved[0].audio)
})

test('materializeResources：没有语音识别服务或 ffmpeg 时附上原始录音并说明原因', async () => {
  for (const [speech, ffmpegPath, reason] of [
    [undefined, 'ffmpeg', /没有启用语音识别服务/],
    [{ resolve: () => ({}), transcribe: async () => ({ text: 'x' }) }, '', /未配置 ffmpeg 路径/],
  ]) {
    const attachments = makeAttachments()
    const api = makeApi({ file_a: Uint8Array.from([9]) })
    const message = { messageId: 'om_1', resources: [{ kind: 'audio', key: 'file_a', downloadType: 'file' }] }
    const result = await materializeResources({ api, attachments, speech, message, config: { ffmpegPath }, log: silentLog })
    assert.deepEqual(attachments.saved, [['file', 'feishu-voice.opus']])
    assert.equal(result.blocks[0].type, 'file')
    assert.match(result.notes[0], reason)
  }
})

test('materializeResources：没有附件存储服务时不下载，只说明', async () => {
  const api = makeApi({})
  const message = { messageId: 'om_1', resources: [{ kind: 'image', key: 'img_1', downloadType: 'image' }] }
  const result = await materializeResources({ api, attachments: undefined, message, config: {}, log: silentLog })
  assert.deepEqual(result.blocks, [])
  assert.equal(api.calls.length, 0)
  assert.equal(result.notes.length, 1)
})

test('transcribeAudio：识别服务报错时向上抛出', async () => {
  const speech = { resolve: () => ({}), transcribe: async () => { throw new Error('model not prepared') } }
  await assert.rejects(
    () => transcribeAudio(Uint8Array.from([1]), { speech, ffmpegPath: 'ffmpeg', decode: async () => new Uint8Array(4) }),
    /model not prepared/,
  )
})

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

test('decodeToPcm：真实 ffmpeg 把音频解码成 16 kHz 单声道 PCM', { skip: !hasFfmpeg && '本机没有 ffmpeg' }, async () => {
  // 先用 ffmpeg 生成 0.5 秒 opus，再解码回 PCM：16000 × 0.5 × 2 字节左右
  const generated = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5',
    '-c:a', 'libopus', '-f', 'ogg', 'pipe:1',
  ])
  if (generated.status !== 0) return
  const pcm = await decodeToPcm(new Uint8Array(generated.stdout), { ffmpegPath: 'ffmpeg' })
  assert.ok(pcm.byteLength > 14000 && pcm.byteLength < 18000, String(pcm.byteLength))
  assertCanonicalWave(pcmToWave(pcm))
})

test('decodeToPcm：找不到 ffmpeg 时给出明确错误', async () => {
  await assert.rejects(
    () => decodeToPcm(Uint8Array.from([1]), { ffmpegPath: '/nonexistent/ffmpeg' }),
    /找不到 ffmpeg/,
  )
})
