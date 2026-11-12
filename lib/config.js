// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 配置：只认 $DSH_HOME/plugins-data/dsh-biliread/config.json。
 * 插件包目录可能只读（装进 node_modules 后），所以运行数据绝不写在包里。
 * 密钥不写死在代码里：可放 config.json，也可通过环境变量临时覆盖（便于测试）。
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const PLUGIN_ID = 'dsh-biliread'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function configPath(home = dshHome()) {
  return join(home, 'plugins-data', PLUGIN_ID, 'config.json')
}

export const DEFAULTS = Object.freeze({
  bilibili: {
    sessdata: '',
    bili_jct: '',
    // 可选：改用 DSH 凭据服务里的 ref 名，避免明文写进 config.json
    sessdataRef: '',
    biliJctRef: '',
  },
  // providerId:modelId —— 只写这一串，baseURL / apiKey / 模型清单都从 DSH 拉
  llm: 'llm:deepseek-flash',
  // auto = 先直连该提供商，缺参数或失败时回退宿主 llm 通道；direct / host = 强制
  callMode: 'auto',
  maxSubtitleLength: 8000,
  timeoutMs: 60000,
  temperature: 0.3,
  maxTokens: 1200,
  preferChineseSubtitle: true,
  systemPrompt: '你是一个中文视频内容总结助手。只依据给出的字幕内容总结，不编造画面或字幕里没有的信息。输出简洁、结构化的中文要点。',
  userPromptTemplate: '视频标题：《{title}》\nUP主：{owner}\n简介：{desc}\n字幕内容：\n{subtitle}\n\n请根据字幕内容总结这个视频的核心内容，保留关键信息。',
})

function readJson(file) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeConfigFile(value, home = dshHome()) {
  const file = configPath(home)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  return file
}

/** 合并默认配置 + 用户配置 + 环境变量覆盖。首次运行自动补出配置文件。 */
export function loadConfig({ create = true, home = dshHome() } = {}) {
  const file = configPath(home)
  if (create && !existsSync(file)) writeConfigFile(DEFAULTS, home)
  const raw = readJson(file)
  const cfg = {
    ...DEFAULTS,
    ...raw,
    bilibili: { ...DEFAULTS.bilibili, ...(raw.bilibili || {}) },
  }
  cfg.maxSubtitleLength = Math.max(500, Number(cfg.maxSubtitleLength) || DEFAULTS.maxSubtitleLength)
  cfg.timeoutMs = Math.max(1000, Number(cfg.timeoutMs) || DEFAULTS.timeoutMs)
  cfg.maxTokens = Math.max(64, Number(cfg.maxTokens) || DEFAULTS.maxTokens)
  cfg.temperature = Number.isFinite(Number(cfg.temperature)) ? Number(cfg.temperature) : DEFAULTS.temperature
  if (!['auto', 'direct', 'host'].includes(cfg.callMode)) cfg.callMode = 'auto'
  if (typeof cfg.llm !== 'string' || !cfg.llm.trim()) cfg.llm = DEFAULTS.llm

  const env = process.env
  if (env.DSH_BILIREAD_SESSDATA) cfg.bilibili.sessdata = env.DSH_BILIREAD_SESSDATA
  if (env.DSH_BILIREAD_BILI_JCT) cfg.bilibili.bili_jct = env.DSH_BILIREAD_BILI_JCT
  if (env.DSH_BILIREAD_LLM) cfg.llm = env.DSH_BILIREAD_LLM
  if (env.DSH_BILIREAD_CALL_MODE) cfg.callMode = env.DSH_BILIREAD_CALL_MODE
  // 仅测试/排障用：显式覆盖 provider 参数，正常情况一律从 DSH 拉
  cfg.llmApiKey = env.DSH_BILIREAD_LLM_KEY || ''
  cfg.llmBaseUrl = env.DSH_BILIREAD_BASE_URL || ''
  return cfg
}
