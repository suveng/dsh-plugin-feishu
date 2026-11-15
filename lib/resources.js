/**
 * 把飞书消息里的资源（图片 / 文件 / 语音 / 视频）转成 dsh 的消息内容。
 *
 * - 图片：经 `ctx.attachments.saveImage` 存成图片附件，作为 image 块交给模型（支持看图的模型直接看）；
 *   附件存储拒收的格式退回成文件附件。
 * - 文件 / 视频：经 `ctx.attachments.saveFile` 原样保存，作为 file 块交给模型；
 *   dsh 会把它投影成一个只读路径，模型可以用自己的工具打开。
 * - 语音：dsh 挂了语音识别服务（`speechToText`，例如官方的语音输入组合包）且本机能找到 ffmpeg 时，
 *   先用 ffmpeg 把飞书的 opus 转成 16 kHz 单声道 PCM，再交给 dsh 识别，转写文字进正文；
 *   任一条件不满足或识别失败，就把原始录音作为文件附上，并在正文里说明原因。
 *
 * 任何一步失败都只降级成正文里的一行说明，不丢整条消息。
 */
import { spawn } from 'node:child_process'

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 120000
/** 16 kHz × 16 bit × 单声道 */
const SAMPLE_RATE = 16000
const BYTE_RATE = SAMPLE_RATE * 2

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/**
 * 按文件头识别附件存储支持的位图格式；识别不了返回 undefined。
 * @param {Uint8Array} data
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|undefined}
 */
export function sniffImageType(data) {
  if (!data || data.length < 12) return undefined
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}

/**
 * 给 16 kHz 单声道 PCM16 加上标准 44 字节 WAV 头。
 *
 * 为什么自己拼：dsh 的语音识别只收「规范」WAV（头恰好 44 字节、长度字段一致）。
 * ffmpeg 写管道时无法回填长度，写文件又可能带 LIST 元数据块，两种都会被拒。
 *
 * @param {Uint8Array} pcm
 * @returns {Uint8Array}
 */
export function pcmToWave(pcm) {
  const length = pcm.byteLength - (pcm.byteLength % 2)
  const out = Buffer.alloc(44 + length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(SAMPLE_RATE, 24)
  out.writeUInt32LE(BYTE_RATE, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(length, 40)
  Buffer.from(pcm.buffer, pcm.byteOffset, length).copy(out, 44)
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

/**
 * 用 ffmpeg 把任意音频解码成 16 kHz 单声道 PCM16（stdin 进、stdout 出，不落临时文件）。
 * @param {Uint8Array} data
 * @param {{ ffmpegPath: string, timeoutMs?: number }} options
 * @returns {Promise<Uint8Array>}
 */
export function decodeToPcm(data, options) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(options.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(SAMPLE_RATE),
        'pipe:1',
      ], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      reject(error)
      return
    }
    const chunks = []
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs || DEFAULT_TRANSCRIBE_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000) })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error.code === 'ENOENT' ? new Error('找不到 ffmpeg（' + options.ffmpegPath + '）') : error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error('ffmpeg 解码失败' + (stderr ? '：' + stderr.trim().split('\n').slice(-1)[0] : '')))
        return
      }
      resolve(new Uint8Array(Buffer.concat(chunks)))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  })
}

/**
 * 语音转写：ffmpeg 解码 -> 拼 WAV -> dsh 语音识别服务。
 * @param {Uint8Array} data 飞书原始录音（opus）
 * @param {{ speech: any, decode?: Function, ffmpegPath: string, timeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export async function transcribeAudio(data, options) {
  const speech = options.speech
  if (!speech || typeof speech.resolve !== 'function' || typeof speech.transcribe !== 'function') {
    throw new Error('dsh 没有启用语音识别服务')
  }
  if (!options.ffmpegPath) throw new Error('未配置 ffmpeg 路径')
  const decode = options.decode || decodeToPcm
  const timeoutMs = options.timeoutMs || DEFAULT_TRANSCRIBE_TIMEOUT_MS
  const pcm = await decode(data, { ffmpegPath: options.ffmpegPath, timeoutMs })
  if (pcm.byteLength < 2) throw new Error('录音里没有可识别的音频')
  const spec = speech.resolve({ audio: pcmToWave(pcm) })
  const transcript = await speech.transcribe(spec, AbortSignal.timeout(timeoutMs))
  return String((transcript && transcript.text) || '').trim()
}

/**
 * 下载并转换一条入站消息的全部资源。
 *
 * @param {{ api: any, attachments: any, speech?: any, decode?: Function, message: any, config: any, log: any }} options
 * @returns {Promise<{ blocks: object[], notes: string[] }>} blocks 跟在正文后；notes 拼进正文
 */
export async function materializeResources(options) {
  const { api, attachments, message, config, log } = options
  const blocks = []
  const notes = []
  const resources = Array.isArray(message && message.resources) ? message.resources : []
  if (resources.length === 0) return { blocks, notes }
  if (!attachments || typeof attachments.saveFile !== 'function') {
    notes.push('[收到 ' + resources.length + ' 个附件，但当前 dsh 没有附件存储服务，无法读取]')
    return { blocks, notes }
  }
  const maxBytes = Number(config && config.maxResourceBytes) || DEFAULT_MAX_BYTES

  for (const resource of resources) {
    let downloaded
    try {
      downloaded = await api.downloadResource(message.messageId, resource.key, resource.downloadType, { maxBytes })
    } catch (error) {
      log.warn('下载飞书资源失败', { kind: resource.kind, error: String(error) })
      notes.push('[附件下载失败（' + resource.kind + '）：' + describe(error) + ']')
      continue
    }
    try {
      await convertResource({ ...options, resource, downloaded, blocks, notes })
    } catch (error) {
      log.warn('保存飞书资源失败', { kind: resource.kind, error: String(error) })
      notes.push('[附件保存失败（' + resource.kind + '）：' + describe(error) + ']')
    }
  }
  return { blocks, notes }
}

async function convertResource(options) {
  const { attachments, resource, downloaded, config, log, blocks, notes } = options
  const { data } = downloaded

  if (resource.kind === 'image') {
    const mediaType = sniffImageType(data)
    if (mediaType && typeof attachments.saveImage === 'function') {
      try {
        const ref = await attachments.saveImage({ data, mediaType, name: 'feishu-image.' + EXTENSIONS[mediaType] })
        blocks.push({ type: 'image', attachment: ref })
        return
      } catch (error) {
        log.warn('图片附件存储失败，改为文件附件', { error: String(error) })
      }
    }
    const ref = await attachments.saveFile({ data, name: downloaded.fileName || 'feishu-image' })
    blocks.push({ type: 'file', attachment: ref })
    notes.push('[这张图片无法直接交给模型查看，已作为文件附上]')
    return
  }

  if (resource.kind === 'audio') {
    const seconds = resource.durationMs ? Math.round(resource.durationMs / 1000) : 0
    const label = '[语音消息' + (seconds ? '，约 ' + seconds + ' 秒' : '')
    try {
      const text = await transcribeAudio(data, {
        speech: options.speech,
        decode: options.decode,
        ffmpegPath: String((config && config.ffmpegPath) || '').trim(),
      })
      notes.push(label + '，转写如下]\n' + (text || '（没有识别到语音内容）'))
      log.info('语音已转写', { seconds, chars: text.length })
    } catch (error) {
      log.warn('语音未转写，改为附上原始录音', { error: String(error) })
      const ref = await attachments.saveFile({ data, name: 'feishu-voice.opus' })
      blocks.push({ type: 'file', attachment: ref })
      notes.push(label + '，未转写：' + describe(error) + '；原始录音已作为文件附上]')
    }
    return
  }

  // 文件与视频：原样保存，模型拿到的是可读的只读路径
  const name = resource.name || downloaded.fileName || 'feishu-file'
  const ref = await attachments.saveFile({ data, name })
  blocks.push({ type: 'file', attachment: ref })
}

function describe(error) {
  return String((error && error.message) || error)
}
