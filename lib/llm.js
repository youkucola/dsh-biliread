// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 总结调用：先 resolveTarget() 从 DSH 拉到 provider 参数，再访问该提供商。
 * - direct: 自己 POST ${baseURL}/chat/completions（用 DSH 凭据服务给的 key）
 * - host:   交给 ctx.llm.stream({provider, model})，由宿主完成协议与鉴权
 * - auto:   先 direct，缺参数或失败自动回退 host
 */
import { randomUUID } from 'node:crypto'
import { resolveTarget, getLlm } from './provider.js'

export function buildPrompt(cfg, video, instruction) {
  const map = {
    title: video.info.title,
    owner: video.info.owner,
    desc: video.info.desc,
    subtitle: video.subtitle.text,
  }
  let prompt = String(cfg.userPromptTemplate || '').replace(
    /\{(title|owner|desc|subtitle)\}/g,
    (_all, key) => String(map[key] ?? ''),
  )
  if (instruction && String(instruction).trim()) {
    prompt += `\n\n补充要求：${String(instruction).trim()}`
  }
  return prompt
}

async function callDirect(target, prompt, cfg) {
  if (!target.baseURL || !target.apiKey) {
    throw new Error(`direct 模式缺少参数：baseURL=${target.baseURL ? '已取到' : '未取到'}，apiKey=${target.apiKey ? '已取到' : '未取到'}`)
  }
  if (target.api && target.api !== 'openai-completions') {
    throw new Error(`provider ${target.providerId} 的协议是 ${target.api}，直连只支持 openai-completions，请用 host 模式`)
  }
  const res = await fetch(`${target.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: target.modelId,
      messages: [
        { role: 'system', content: cfg.systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `HTTP ${res.status}`
    throw new Error(`提供商 ${target.providerId} 返回错误：${msg}`)
  }
  const choice = data?.choices?.[0]?.message || {}
  const text = choice.content || choice.reasoning_content || ''
  if (!String(text).trim()) throw new Error(`提供商 ${target.providerId} 返回空内容`)
  return String(text).trim()
}

async function callHost(ctx, target, prompt, cfg) {
  const llm = getLlm(ctx)
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('DSH 没有可用的 llm 服务，且直连参数不完整')
  }
  const stream = llm.stream({
    provider: target.providerId,
    model: target.modelId,
    system: cfg.systemPrompt,
    messages: [{
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: 'dsh-biliread' },
    }],
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
  })
  let text = ''
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') text += chunk.text || ''
    if (chunk?.type === 'finish' && chunk?.reason?.kind === 'error') {
      const f = chunk.reason.failure || {}
      throw new Error(`宿主模型报错：${f.message || f.code || '未知错误'}`)
    }
  }
  if (!text.trim()) throw new Error('宿主 llm 通道返回空内容')
  return text.trim()
}

export async function summarize(ctx, cfg, video, { model, instruction } = {}) {
  const target = await resolveTarget(ctx, cfg, model)
  if (!target.registered && !target.declared && !target.baseURL) {
    throw new Error(`DSH 里找不到 provider "${target.providerId}"，请检查 config.json 的 llm 配置与 DSH 模型设置`)
  }
  if (target.modelIds.length && !target.modelIds.includes(target.modelId)) {
    throw new Error(`provider "${target.providerId}" 里没有模型 "${target.modelId}"；可用：${target.modelIds.slice(0, 12).join(', ')}`)
  }

  const prompt = buildPrompt(cfg, video, instruction)
  const errors = []
  const canDirect = Boolean(target.baseURL && target.apiKey)
  const tryDirect = cfg.callMode === 'direct' || (cfg.callMode === 'auto' && canDirect)

  if (tryDirect) {
    if (!canDirect && cfg.callMode === 'direct') {
      throw new Error(`direct 模式需要 baseURL 与 apiKey：apiKeyEnv=${target.apiKeyEnv || '(未声明)'}，baseURL=${target.baseURL || '(未声明)'}`)
    }
    try {
      const text = await callDirect(target, prompt, cfg)
      return { text, target, mode: 'direct', fallbackFrom: null }
    } catch (error) {
      if (cfg.callMode === 'direct') throw error
      errors.push(error.message || String(error))
    }
  }

  const text = await callHost(ctx, target, prompt, cfg)
  return { text, target, mode: 'host', fallbackFrom: errors[0] || null }
}
