/**
 * `providerId:modelId` -> DSH 里的真实提供商参数。
 *
 * 例如 cssmapi:deepseek-flash：
 *   1) ctx.llm 的 listProviders / listConfigurableProviders / listModels / resolveModelInfo
 *      确认这个 provider 在 DSH 里注册过，并拉到模型清单与模型元信息；
 *   2) profile 的 cordis.patch.yml 里 `@deepseek-ai/dsh-llm-pi-ai` 组件
 *      config.providers.cssmapi 提供 apiKeyEnv / api / baseURL；
 *   3) ctx.get('credentials').resolve(apiKeyEnv) 取到密钥（不落盘、不回显）。
 * 然后 llm.js 才会去访问这个提供商。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './config.js'

export function parseModelSpec(spec) {
  const raw = String(spec || '').trim()
  let provider = ''
  let model = ''
  if (raw.includes('::')) {
    const [p, ...rest] = raw.split('::')
    provider = p
    model = rest.join('::')
  } else if (raw.includes(':')) {
    const [p, ...rest] = raw.split(':')
    provider = p
    model = rest.join(':')
  } else if (raw.includes('/')) {
    const [p, ...rest] = raw.split('/')
    provider = p
    model = rest.join('/')
  }
  provider = provider.trim()
  model = model.trim()
  if (!provider || !model) {
    throw new Error(`LLM 规格需为 providerId:modelId（例如 cssmapi:deepseek-flash），当前为：${raw || '(空)'}`)
  }
  return { provider, model }
}

export function getLlm(ctx) {
  try {
    return ctx?.llm || ctx?.get?.('llm') || null
  } catch {
    return null
  }
}

function idOf(entry) {
  if (!entry) return ''
  if (typeof entry === 'string') return entry
  return String(entry.provider || entry.id || entry.name || '')
}

/** 只解析 providers: 子树，不引入 YAML 依赖（够用且不会因 schema 变动整包崩）。 */
export function parseProviderFromYaml(text, providerId) {
  const lines = String(text || '').split(/\r?\n/)
  const clean = v => String(v ?? '').replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '')
  const matches = []
  let inBlock = false
  let baseIndent = 0
  let childIndent = null
  let current = null
  let inModels = false

  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    const indent = (line.match(/^\s*/) || [''])[0].length
    const t = line.trim()

    if (!inBlock) {
      if (/^providers:\s*(?:#.*)?$/.test(t)) {
        inBlock = true
        baseIndent = indent
        childIndent = null
        current = null
        inModels = false
      }
      continue
    }
    if (indent <= baseIndent) {
      inBlock = false
      current = null
      inModels = false
      childIndent = null
      // 同一个文件里可能连续出现多个 providers: 块
      if (/^providers:\s*(?:#.*)?$/.test(t)) {
        inBlock = true
        baseIndent = indent
      }
      continue
    }
    if (childIndent === null) childIndent = indent
    if (indent === childIndent) {
      const m = t.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
      current = m ? { id: m[1], models: [] } : null
      if (current && current.id === providerId) matches.push(current)
      inModels = false
      continue
    }
    if (!current || indent < childIndent) continue
    if (/^models:\s*(?:#.*)?$/.test(t)) {
      inModels = true
      continue
    }
    const item = t.match(/^-\s*id:\s*(.+)$/)
    if (item && inModels) {
      current.models.push(clean(item[1]))
      continue
    }
    const kv = t.match(/^([A-Za-z_][\w-]*):\s*(.*)$/)
    if (kv) {
      // models 列表项里的 name/contextWindow 等缩进字段不影响 inModels，
      // 否则第二个 "- id: ..." 会被漏掉。只有遇到新的 provider 或退出块才重置。
      if (!inModels) current[kv[1]] = clean(kv[2])
    }
  }
  return matches[0] || null
}

export function profilePatchFiles(home = dshHome()) {
  const files = []
  const root = join(home, 'cordis.patch.yml')
  if (existsSync(root)) files.push(root)
  const profiles = join(home, 'profiles')
  try {
    for (const ent of readdirSync(profiles, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const file = join(profiles, ent.name, 'cordis.patch.yml')
      if (existsSync(file)) files.push(file)
    }
  } catch {
    // profiles 目录不存在就算了
  }
  return files
}

export function readProviderFromDsh(home, providerId) {
  for (const file of profilePatchFiles(home)) {
    try {
      const hit = parseProviderFromYaml(readFileSync(file, 'utf8'), providerId)
      if (hit) return { ...hit, sourceFile: file }
    } catch {
      // 单个 patch 读不动不影响其它文件
    }
  }
  return null
}

async function maybe(value) {
  if (value === undefined || value === null) return null
  return await value
}

/** 第一步：从 DSH 拉取 provider 信息（运行时服务 + profile 配置）。 */
export async function fetchProviderInfo(ctx, providerId, modelId, home = dshHome()) {
  const llm = getLlm(ctx)
  const patch = readProviderFromDsh(home, providerId) || {}
  const out = {
    providerId,
    modelId,
    registered: false,
    declared: false,
    providerMeta: null,
    modelInfo: null,
    modelIds: [],
    patch,
  }

  try {
    const providers = (await maybe(llm?.listProviders?.())) || []
    out.registered = providers.some(p => idOf(p) === providerId)
  } catch { /* 服务不可用时降级到 patch */ }

  try {
    const configurable = (await maybe(llm?.listConfigurableProviders?.())) || []
    const hit = configurable.find(p => idOf(p) === providerId)
    out.declared = Boolean(hit)
    out.providerMeta = hit || null
  } catch { /* 同上 */ }

  try {
    const models = (await maybe(llm?.listModels?.(providerId))) || []
    out.modelIds = models
      .map(m => (typeof m === 'string' ? m : (m?.id || m?.model || '')))
      .filter(Boolean)
  } catch { /* 同上 */ }

  try {
    out.modelInfo = await maybe(llm?.resolveModelInfo?.(providerId, modelId))
  } catch { /* 同上 */ }

  for (const id of patch.models || []) if (!out.modelIds.includes(id)) out.modelIds.push(id)
  return out
}

export async function resolveApiKey(ctx, apiKeyEnv, fallback = '') {
  if (!apiKeyEnv) return fallback
  try {
    const credentials = ctx?.get?.('credentials') || ctx?.credentials
    const resolved = await credentials?.resolve?.(apiKeyEnv)
    const value = typeof resolved === 'string'
      ? resolved
      : (resolved?.value || resolved?.secret || resolved?.apiKey || '')
    if (value) return String(value)
  } catch { /* 回退环境变量 */ }
  return process.env[apiKeyEnv] || fallback
}

/** 第二步：把「DSH 里查到的东西」组装成可直接访问的目标。 */
export async function resolveTarget(ctx, cfg, spec, home = dshHome()) {
  const { provider, model } = parseModelSpec(spec || cfg.llm)
  const info = await fetchProviderInfo(ctx, provider, model, home)
  const apiKeyEnv = info.patch.apiKeyEnv || info.providerMeta?.apiKeyEnv || ''
  const baseURL = String(cfg.llmBaseUrl || info.patch.baseURL || info.providerMeta?.baseURL || '').replace(/\/+$/, '')
  const apiKey = await resolveApiKey(ctx, apiKeyEnv, cfg.llmApiKey || '')
  return {
    ...info,
    apiKeyEnv,
    baseURL,
    apiKey,
    api: info.patch.api || info.providerMeta?.api || 'openai-completions',
  }
}
