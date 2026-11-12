// SPDX-License-Identifier: AGPL-3.0-only

/**
 * B 站读取链路，用原生 fetch 重写，零第三方依赖。
 * 链路：输入解析 -> view(标题/aid/cid/简介) -> player/wbi/v2(字幕清单) -> 字幕 JSON -> 纯文本
 *
 * 关键坑（实测）：AI 字幕只在带 WBI 签名 + SESSDATA 登录态的
 * `x/player/wbi/v2` 里返回，且字幕 URL 带 auth_key；普通 `x/player/v2`
 * 经常返回空列表，甚至会给出不带签名的字幕 URL 导致内容串台。
 * view 接口的 subtitle.list 为空也不能作为「没有字幕」的依据。
 */
import { createHash } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const BVID_RE = /BV[a-zA-Z0-9]{10,12}/
const WBI_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

export class BilireadError extends Error {
  constructor(message, code = 'UNKNOWN', extra = {}) {
    super(message)
    this.name = 'BilireadError'
    this.code = code
    Object.assign(this, extra)
  }
}

function cookieHeader(cfg) {
  const b = cfg?.bilibili || {}
  const parts = []
  if (b.sessdata) parts.push(`SESSDATA=${b.sessdata}`)
  if (b.bili_jct) parts.push(`bili_jct=${b.bili_jct}`)
  return parts.join('; ')
}

async function request(url, { cookie = '', timeoutMs = 15000, json = true } = {}) {
  const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new BilireadError(`B 站请求失败：HTTP ${res.status} ${url.split('?')[0]}`, 'HTTP')
  return json ? res.json() : res.text()
}

/* ------------------------------- WBI 签名 ------------------------------- */
let wbiCache = null // { mixin, at }，img_key/sub_key 每天轮换，缓存 30 分钟足够

function wbiMixin(imgKey, subKey) {
  const raw = imgKey + subKey
  return WBI_TAB.map(i => raw[i]).join('').slice(0, 32)
}

async function getWbiMixin(cookie, timeoutMs) {
  if (wbiCache && Date.now() - wbiCache.at < 30 * 60 * 1000) return wbiCache.mixin
  const nav = await request('https://api.bilibili.com/x/web-interface/nav', { cookie, timeoutMs })
  const img = nav?.data?.wbi_img?.img_url
  const sub = nav?.data?.wbi_img?.sub_url
  if (!img || !sub) throw new BilireadError('拿不到 WBI 密钥（nav 接口无 wbi_img）', 'WBI')
  const imgKey = img.split('/').pop().replace(/\.png$/, '')
  const subKey = sub.split('/').pop().replace(/\.png$/, '')
  const mixin = wbiMixin(imgKey, subKey)
  if (mixin.length !== 32) throw new BilireadError('WBI 密钥长度异常', 'WBI')
  wbiCache = { mixin, at: Date.now() }
  return mixin
}

function wbiQuery(params) {
  const clean = {}
  for (const [key, value] of Object.entries(params)) {
    clean[key] = String(value).replace(/[!'()*]/g, '')
  }
  return Object.keys(clean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(clean[k])}`)
    .join('&')
}

/* ----------------------------- 输入 / 视频信息 ----------------------------- */
/** 支持：BV 号、完整 B 站链接、b23.tv 短链、含链接的一整段文字。 */
export async function resolveBvid(input, { timeoutMs = 15000 } = {}) {
  const text = String(input || '').trim()
  if (!text) throw new BilireadError('bvid 不能为空', 'BAD_INPUT')
  const direct = text.match(BVID_RE)
  if (direct) return direct[0]

  let url = /^https?:\/\//i.test(text) ? text : `https://${text}`
  if (!/b23\.tv|bilibili\.com/i.test(url)) {
    throw new BilireadError(`无法从输入中解析 BV 号：${text.slice(0, 120)}`, 'BAD_INPUT')
  }

  // 短链跟随重定向，每一步都先看有没有 BV 号
  for (let i = 0; i < 10; i++) {
    const hit = url.match(BVID_RE)
    if (hit) return hit[0]
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const loc = res.headers.get('location')
    if (!loc) break
    url = new URL(loc, url).toString()
  }
  const last = url.match(BVID_RE)
  if (last) return last[0]
  throw new BilireadError(`解析短链失败，未找到 BV 号：${text.slice(0, 120)}`, 'BAD_INPUT')
}

async function getVideoInfo(bvid, cfg) {
  const d = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    cookie: cookieHeader(cfg), timeoutMs: cfg.timeoutMs,
  })
  if (d?.code !== 0 || !d?.data) {
    throw new BilireadError(`B 站视频信息接口返回 ${d?.code ?? '?'}: ${d?.message || '无数据'}`, 'BILI_API')
  }
  const v = d.data
  return {
    bvid,
    aid: v.aid,
    title: v.title || '未知标题',
    cid: v.cid || v.pages?.[0]?.cid,
    owner: v.owner?.name || '未知',
    duration: v.duration ?? 0,
    desc: (v.desc || '').slice(0, 500),
    hasLogin: Boolean(cfg?.bilibili?.sessdata),
  }
}

/* --------------------------------- 字幕 --------------------------------- */
async function getSubtitle(bvid, cid, aid, cfg) {
  const cookie = cookieHeader(cfg)
  let d = null

  // 主路径：WBI 签名 + 登录态，AI 字幕在这里
  try {
    const mixin = await getWbiMixin(cookie, cfg.timeoutMs)
    const params = {
      aid,
      cid,
      isGaiaAvoided: 'false',
      web_location: '1315873',
      wts: Math.floor(Date.now() / 1000),
    }
    const query = wbiQuery(params)
    const wRid = createHash('md5').update(mixin + query).digest('hex')
    const d2 = await request(`https://api.bilibili.com/x/player/wbi/v2?${query}&w_rid=${wRid}`, {
      cookie, timeoutMs: cfg.timeoutMs,
    })
    if (d2?.code === 0) d = d2
  } catch {
    // 网络/签名拿不到时才回退到未签名接口；WBI 明确返回空字幕时不回退，
    // 避免普通接口给出不带 auth_key 的字幕 URL 导致内容串台。
  }

  if (!d) {
    d = await request(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`, {
      cookie, timeoutMs: cfg.timeoutMs,
    })
  }
  if (d?.code !== 0) {
    throw new BilireadError(`字幕清单接口返回 ${d?.code}: ${d?.message || ''}`, 'BILI_API')
  }

  const list = d?.data?.subtitle?.subtitles || []
  if (!list.length) return null
  const isChinese = s => /^(zh|ai-zh)/i.test(String(s.lan || ''))
  const target = (cfg.preferChineseSubtitle && list.find(isChinese)) || list[0]
  const rawUrl = target.subtitle_url || ''
  if (!rawUrl) return null
  return {
    lan: target.lan || '',
    lanDoc: target.lan_doc || target.lan || '',
    // 保留完整 auth_key 参数，缺了它可能拿到别的缓存内容
    url: rawUrl.startsWith('//') ? `https:${rawUrl}` : (rawUrl.startsWith('http') ? rawUrl : `https:${rawUrl}`),
  }
}

async function downloadSubtitle(url, cfg) {
  const d = await request(url, { timeoutMs: cfg.timeoutMs })
  const body = Array.isArray(d?.body) ? d.body : []
  return body.map(item => String(item?.content ?? '')).filter(Boolean).join('\n')
}

/** 完整读取。无字幕时抛 NO_SUBTITLE，并带上标题与排障提示。 */
export async function readVideo(input, cfg) {
  const bvid = await resolveBvid(input, { timeoutMs: cfg.timeoutMs })
  const info = await getVideoInfo(bvid, cfg)
  if (!info.cid) throw new BilireadError(`视频《${info.title}》缺少 cid`, 'BILI_API', { info })

  const sub = await getSubtitle(bvid, info.cid, info.aid, cfg)
  if (!sub) {
    throw new BilireadError(
      `视频《${info.title}》暂无可用字幕，无法生成总结。`,
      'NO_SUBTITLE',
      { info, hint: info.hasLogin ? '该视频确实没有 CC/AI 字幕' : '未配置 SESSDATA；B 站 AI 字幕需要登录态，请在 config.json 里填写 bilibili.sessdata / bili_jct' },
    )
  }

  const raw = await downloadSubtitle(sub.url, cfg)
  if (!raw.trim()) throw new BilireadError(`视频《${info.title}》字幕内容为空。`, 'EMPTY_SUBTITLE', { info })

  const max = cfg.maxSubtitleLength
  const truncated = raw.length > max
  const text = truncated ? `${raw.slice(0, max)}\n...(后续内容已省略)` : raw
  return { info, subtitle: { text, rawLength: raw.length, truncated, lan: sub.lan, lanDoc: sub.lanDoc } }
}
