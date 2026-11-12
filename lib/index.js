/**
 * dsh-biliread —— DSH Desktop 插件入口。
 *
 * 只注册一个工具：biliread。
 * 由 AstrBot 插件 astrbot_plugin_biliread 改编：
 *   - 去掉 AstrBot 的 Star / FunctionTool / filter 依赖，改走 Cordis + ctx.tools.register
 *   - 配置搬到 $DSH_HOME/plugins-data/dsh-biliread/config.json
 *   - LLM 不再写死 baseURL/key，改成 providerId:modelId 从 DSH 拉取
 */
import { loadConfig, configPath } from './config.js'
import { readVideo } from './bilibili.js'
import { summarize } from './llm.js'

export const name = 'dsh-biliread'
export const inject = ['tools']

function durationText(sec) {
  const s = Number(sec) || 0
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function renderResult(v) {
  if (!v || !v.ok) {
    const lines = [`**biliread 失败**：${v?.error || '未知错误'}`]
    if (v?.code) lines.push(`错误码：\`${v.code}\``)
    if (v?.hint) lines.push(`提示：${v.hint}`)
    lines.push(`配置文件：\`${configPath()}\``)
    return lines.join('\n\n')
  }
  const head = [
    `## 《${v.title}》`,
    `- UP：${v.owner}　时长：${durationText(v.duration)}　BV：\`${v.bvid}\``,
    `- 字幕：${v.subtitle.lanDoc || v.subtitle.lan || '未知'}（${v.subtitle.rawLength} 字符${v.subtitle.truncated ? '，已截断' : ''}）`,
    `- 总结模型：\`${v.provider}:${v.model}\`　通道：${v.mode === 'direct' ? '直连提供商' : 'DSH 宿主 llm'}`,
  ]
  if (v.fallbackFrom) head.push(`- 直连失败已回退：${v.fallbackFrom}`)
  return `${head.join('\n')}\n\n### 总结\n\n${v.summary}`
}

export function apply(ctx) {
  const bootCfg = loadConfig()

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'biliread',
      description:
        '读取并总结一个哔哩哔哩视频。传入 BV 号、完整视频链接、b23.tv 短链，或含链接的一段文字；'
        + '自动获取视频字幕（含需登录态的 AI 字幕），再交给 DSH 中配置的模型生成中文总结。'
        + '视频没有字幕时会明确返回原因，不做内容猜测。',
      parameters: {
        type: 'object',
        properties: {
          bvid: {
            type: 'string',
            description: 'BV 号 / B 站视频链接 / b23.tv 短链 / 含链接的文字，例如 BV1854i6XEvC',
          },
          model: {
            type: 'string',
            description: '可选，覆盖配置里的模型，格式 providerId:modelId，例如 cssmapi:deepseek-flash',
          },
          instruction: {
            type: 'string',
            description: '可选，额外的总结要求，例如「只列三条要点」',
          },
        },
        required: ['bvid'],
      },
      // 裸 register：output.schema 用注解型 schema，不能用 { type: 'json' }
      output: {
        schema: {
          description: '总结结果对象：{ ok, bvid, title, owner, duration, subtitle, provider, model, mode, summary }；失败时 { ok:false, code, error, hint }',
        },
        render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
      },
      isConcurrencySafe: () => true,
      timeoutMs: bootCfg.timeoutMs,
      execute: async (args) => {
        const cfg = loadConfig() // 每次调用重读，改配置不用重启 DSH
        let video = null
        try {
          video = await readVideo(args?.bvid, cfg)
          const res = await summarize(ctx, cfg, video, {
            model: args?.model,
            instruction: args?.instruction,
          })
          return {
            ok: true,
            bvid: video.info.bvid,
            title: video.info.title,
            owner: video.info.owner,
            duration: video.info.duration,
            subtitle: {
              lan: video.subtitle.lan,
              lanDoc: video.subtitle.lanDoc,
              rawLength: video.subtitle.rawLength,
              truncated: video.subtitle.truncated,
            },
            provider: res.target.providerId,
            model: res.target.modelId,
            mode: res.mode,
            fallbackFrom: res.fallbackFrom,
            summary: res.text,
          }
        } catch (error) {
          return {
            ok: false,
            code: error?.code || 'ERROR',
            error: error?.message || String(error),
            hint: error?.hint || null,
            bvid: video?.info?.bvid || null,
            title: video?.info?.title || null,
          }
        }
      },
    }))
  })
}
