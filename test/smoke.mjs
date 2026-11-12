/**
 * 冒烟测试：不装进 DSH，用 mock ctx 直接跑插件代码。
 * 需要网络（B 站 + 模型接口）。密钥全部由环境变量临时提供，不写入任何文件。
 *
 *   DSH_BILIREAD_SESSDATA / DSH_BILIREAD_BILI_JCT
 *   DSH_BILIREAD_LLM_KEY  （模拟 DSH 凭据服务返回的 CSSMAPI_API_KEY）
 *   DSH_HOME             （默认 ~/.dsh，用于读 profile 的 provider 配置）
 */
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { configPath, loadConfig } from '../lib/config.js'
import { resolveBvid } from '../lib/bilibili.js'
import { parseModelSpec, readProviderFromDsh } from '../lib/provider.js'

process.env.DSH_HOME ||= join(homedir(), '.dsh')
const HOME = process.env.DSH_HOME
const HAS_COOKIE = Boolean(process.env.DSH_BILIREAD_SESSDATA)
const HAS_KEY = Boolean(process.env.DSH_BILIREAD_LLM_KEY)

const registered = []
const ctx = {
  inject: (_deps, fn) => fn(ctx),
  effect: (fn) => fn(),
  tools: {
    register: (def) => {
      registered.push(def)
      return () => {}
    },
  },
  get: (name) => {
    if (name === 'llm') return ctx.llm
    if (name === 'credentials') {
      return { resolve: async (ref) => ({ value: process.env.DSH_BILIREAD_LLM_KEY || '', ref }) }
    }
    return undefined
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  llm: {
    listProviders: () => [{ id: 'cssmapi', name: 'cssmapi' }],
    listConfigurableProviders: () => [{ provider: 'cssmapi', settingsPath: [] }],
    listModels: async () => [{ id: 'deepseek-flash' }, { id: 'glm-5.3-flash' }],
    resolveModelInfo: async () => ({ contextWindow: 1000000, inputModalities: ['text'] }),
    stream: async function* () {
      yield { type: 'text-delta', text: '[host 通道模拟总结] 字幕已收到，宿主 llm 调用成功。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
}

const results = []
function check(label, fn) {
  try {
    const detail = fn()
    results.push(`PASS  ${label}${detail ? ` -> ${detail}` : ''}`)
  } catch (error) {
    results.push(`FAIL  ${label} -> ${error.message}`)
    process.exitCode = 1
  }
}

function skip(label, why) {
  results.push(`SKIP  ${label} -> ${why}`)
}

async function main() {
  console.log('DSH_HOME =', HOME)
  console.log('config.json =', configPath(HOME))
  console.log('Cookie/Key 由环境变量提供：', HAS_COOKIE, HAS_KEY, '\n')

  // 1. 插件挂载与单个工具
  apply(ctx)
  check('只注册一个工具，且名为 biliread', () => {
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'biliread')
    assert.equal(registered[0].parameters.type, 'object')
    assert.ok(Array.isArray(registered[0].parameters.required))
    assert.equal(typeof registered[0].output.render, 'function')
    assert.notEqual(registered[0].output.schema?.type, 'json')
    assert.ok(registered[0].timeoutMs > 0)
    return `timeoutMs=${registered[0].timeoutMs}`
  })
  const tool = registered[0]

  // 2. 纯函数
  check('解析 providerId:modelId', () => {
    assert.deepEqual(parseModelSpec('cssmapi:deepseek-flash'), { provider: 'cssmapi', model: 'deepseek-flash' })
    assert.deepEqual(parseModelSpec('cssmapi/deepseek-flash'), { provider: 'cssmapi', model: 'deepseek-flash' })
  })
  try {
    assert.equal(await resolveBvid('BV1854i6XEvC'), 'BV1854i6XEvC')
    assert.equal(await resolveBvid('https://www.bilibili.com/video/BV1854i6XEvC'), 'BV1854i6XEvC')
    assert.equal(await resolveBvid('看看这个 https://www.bilibili.com/video/BV1854i6XEvC?p=1 挺好'), 'BV1854i6XEvC')
    results.push('PASS  从完整链接 / BV 号 / 含链接文字解析 BVID')
  } catch (error) {
    results.push(`FAIL  从完整链接 / BV 号解析 BVID -> ${error.message}`)
    process.exitCode = 1
  }

  // 3. 从 DSH profile 拉 provider 信息
  const providerInfo = readProviderFromDsh(HOME, 'cssmapi')
  check('从 DSH profile 拉取 cssmapi 提供商信息', () => {
    assert.ok(providerInfo, '未在 cordis.patch.yml 里找到 providers.cssmapi')
    assert.ok(providerInfo.baseURL, '缺 baseURL')
    assert.equal(providerInfo.apiKeyEnv, 'CSSMAPI_API_KEY')
    assert.ok((providerInfo.models || []).includes('deepseek-flash'))
    return `baseURL=${providerInfo.baseURL}, api=${providerInfo.api}, models=${(providerInfo.models || []).length}`
  })

  // 4. 有字幕视频：完整链路（直连提供商）
  if (HAS_COOKIE && HAS_KEY) {
    process.env.DSH_BILIREAD_CALL_MODE = 'direct'
    try {
      const r = await tool.execute({ bvid: 'BV1854i6XEvC', instruction: '用两句话概括' })
      assert.equal(r.ok, true, r.error)
      assert.ok(r.summary && r.summary.length > 30)
      assert.equal(r.provider, 'cssmapi')
      assert.equal(r.model, 'deepseek-flash')
      assert.equal(r.mode, 'direct')
      assert.ok(r.subtitle.rawLength > 0)
      results.push(`PASS  有字幕视频直连总结 -> 《${r.title}》字幕 ${r.subtitle.rawLength} 字符, 摘要 ${r.summary.length} 字符`)
      console.log('\n----- 直连总结预览 -----\n' + r.summary.slice(0, 500) + '\n------------------------\n')
    } catch (error) {
      results.push(`FAIL  有字幕视频直连总结 -> ${error.message}`)
      process.exitCode = 1
    }
  } else {
    skip('有字幕视频直连总结', '缺 Cookie 或 LLM key')
  }

  // 5. 无字幕视频：明确报错，不编造
  if (HAS_COOKIE) {
    try {
      const r = await tool.execute({ bvid: 'BV1bbnN6nE31' })
      assert.equal(r.ok, false)
      assert.equal(r.code, 'NO_SUBTITLE')
      results.push(`PASS  无字幕视频返回 NO_SUBTITLE -> ${r.error}`)
    } catch (error) {
      results.push(`FAIL  无字幕视频 -> ${error.message}`)
      process.exitCode = 1
    }
  } else {
    skip('无字幕视频', '缺 Cookie')
  }

  // 6. host 通道
  process.env.DSH_BILIREAD_CALL_MODE = 'host'
  try {
    const r = await tool.execute({ bvid: 'BV1854i6XEvC' })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.mode, 'host')
    assert.ok(r.summary.includes('host 通道模拟总结'))
    results.push('PASS  host 模式走 ctx.llm.stream')
  } catch (error) {
    results.push(`FAIL  host 模式 -> ${error.message}`)
    process.exitCode = 1
  }

  // 7. auto 模式：直连失败自动回退 host
  process.env.DSH_BILIREAD_CALL_MODE = 'auto'
  process.env.DSH_BILIREAD_BASE_URL = 'http://127.0.0.1:1/v1' // 立即连接失败
  try {
    const r = await tool.execute({ bvid: 'BV1854i6XEvC' })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.mode, 'host')
    assert.ok(r.fallbackFrom)
    results.push(`PASS  auto 直连失败回退 host -> ${String(r.fallbackFrom).slice(0, 90)}`)
  } catch (error) {
    results.push(`FAIL  auto 回退 -> ${error.message}`)
    process.exitCode = 1
  } finally {
    delete process.env.DSH_BILIREAD_BASE_URL
  }

  // 8. render 输出
  check('output.render 产出文本块', () => {
    const blocks = tool.output.render({}, { ok: false, code: 'NO_SUBTITLE', error: '暂无字幕', hint: '换个视频' })
    assert.equal(blocks[0].type, 'text')
    assert.ok(blocks[0].text.includes('暂无字幕'))
  })

  console.log('\n================ 测试结果 ================')
  for (const line of results) console.log(line)
  console.log('==========================================')
  console.log('配置文件：', configPath(HOME), '\n当前 callMode：', loadConfig().callMode)
}

main().catch(error => {
  console.error('测试脚本异常：', error)
  process.exitCode = 1
})
