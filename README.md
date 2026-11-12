# dsh-biliread

DSH Desktop（DeepSeek Harness）插件，把 [astrbot_plugin_biliread](https://github.com/SodaCodeSave/astrbot_plugin_biliread) 改编成 Cordis 插件。**只提供一个工具 `biliread`**：给它 BV 号 / B 站链接 / b23.tv 短链，取字幕并交给 DSH 里配置的模型生成中文总结。

零第三方依赖，只用 Node 内置 `fetch` / `fs`（Node >= 22）。

## 目录与配置

配置与运行数据统一放插件自己的「家」，绝不写进插件包目录（装进 `node_modules` 后可能只读、升级会被覆盖）：

```
~/.dsh/plugins-data/dsh-biliread/config.json
```

Windows 即 `C:\Users\<你>\.dsh\plugins-data\dsh-biliread\config.json`；可用 `DSH_HOME` 改变根目录。文件不存在时插件首次加载会按默认值自动创建。

```json
{
  "bilibili": {
    "sessdata": "",
    "bili_jct": "",
    "sessdataRef": "",
    "biliJctRef": ""
  },
  "llm": "llm:deepseek-flash",
  "callMode": "auto",
  "maxSubtitleLength": 8000,
  "timeoutMs": 60000,
  "temperature": 0.3,
  "maxTokens": 1200,
  "preferChineseSubtitle": true,
  "systemPrompt": "…",
  "userPromptTemplate": "视频标题：《{title}》…字幕内容：\n{subtitle}…"
}
```

| 字段 | 说明 |
| --- | --- |
| `bilibili.sessdata` / `bili_jct` | B 站登录态。**AI 字幕必须带登录态**，`view` 接口的 `subtitle.list` 为空不代表没字幕。可在浏览器 F12 或 Cookie Editor 里取。也支持填 `sessdataRef` / `biliJctRef`，从 DSH 凭据服务读，避免明文。 |
| `llm` | `providerId:modelId`，例如 `llm:deepseek-flash`。**只写这一串**，不写 baseURL / apiKey。 |
| `callMode` | `auto`（默认，先直连、失败回退宿主）、`direct`（只直连）、`host`（只走 `ctx.llm.stream`）。 |
| `maxSubtitleLength` | 送进模型的字幕上限，防上下文溢出。 |
| `preferChineseSubtitle` | 优先选中文字幕，否则取第一条。 |

## LLM 怎么从 DSH 拉参数

以 `llm:deepseek-flash` 为例，插件在每次总结前做两步：

1. **拉 provider 信息**
   - `ctx.llm.listProviders()` / `listConfigurableProviders()`：确认 `llm` 在 DSH 里注册/声明过；
   - `ctx.llm.listModels('llm')` / `resolveModelInfo('llm','deepseek-flash')`：拉模型清单与元信息，顺手校验模型名；
   - 读 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里 `@deepseek-ai/dsh-llm-pi-ai` 组件的 `config.providers.llm`，拿到 `baseURL`、`api`、`apiKeyEnv`（示例中是 `YOUR_LLM_API_KEY`）；
   - `ctx.get('credentials').resolve(apiKeyEnv)` 取密钥 —— **密钥不写进 config.json，也不回显**。
2. **访问该提供商**：默认 `POST ${baseURL}/chat/completions`；若参数缺失或请求失败，`auto` 模式自动回退到 `ctx.llm.stream({ provider, model, ... })`，由宿主完成协议与鉴权。

本机实测对应配置：

```yaml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      llm:
        apiKeyEnv: YOUR_LLM_API_KEY
        api: openai-completions
        baseURL: https://api.example.com/v1
        models:
          - id: deepseek-flash
```

格式兼容 `provider/model` 与 `provider::model`，但推荐单冒号。若模型名不在 DSH 返回的清单里，工具会直接报「没有这个模型」并列出可用项。

## 安装

```powershell
# 本地开发安装（路径不要有中文/空格）
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add link:C:\path\to\dsh-biliread
```

或在 DSH 侧边栏 **插件 → Add plugin** 里填同一路径。安装后**重启客户端**（DSH 按路径缓存模块，改 `.js` 源码也要重启）。打包分发可用 `pnpm pack` 后 `add ./dsh-biliread-0.1.0.tgz`。

安装会把 `cordis.patch.yml` 合并进 profile：

```yaml
- insert:
    - id: dsh-biliread
      name: dsh-biliread
```

## 工具

只有一个 `biliread`：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `bvid` | 是 | `BV1854i6XEvC` / `https://www.bilibili.com/video/BV1854i6XEvC` / `https://b23.tv/...` / 含链接的一段文字 |
| `model` | 否 | 临时覆盖 `providerId:modelId` |
| `instruction` | 否 | 追加总结要求，例如「只列三条要点」 |

返回结构化对象，渲染成 Markdown：标题、UP、时长、字幕语言与长度、所用模型与通道，以及总结正文。失败时给出错误码和提示（常见：`NO_SUBTITLE` 无字幕、`BAD_INPUT` 解析不出 BV 号、provider 未找到）。

## 测试

```bash
# 环境变量只用于测试，不写入配置文件
export DSH_BILIREAD_SESSDATA='...'
export DSH_BILIREAD_BILI_JCT='...'
export DSH_BILIREAD_LLM_KEY='...'     # 直连模式下模拟 DSH 凭据服务
node test/smoke.mjs
```

冒烟测试覆盖：工具只注册一个且 schema 合规、链接/BV 号解析、有字幕视频的完整总结链路、无字幕视频的 `NO_SUBTITLE`、宿主 llm 回退通道。

## 注意事项

- 字幕清单走**带 WBI 签名的 `x/player/wbi/v2`**（与 `bilibili-api-python` 的 `get_subtitle` 一致）：AI 字幕只在这里返回，且 `subtitle_url` 带 `auth_key`。普通 `x/player/v2` 经常返回空列表，实测还可能给出不带签名的字幕 URL 导致内容串台，因此只在 WBI 请求失败时兜底。WBI 密钥取自 `x/web-interface/nav` 的 `wbi_img`，缓存 30 分钟。
- 不是所有视频都有字幕；UP 主没传 CC、B 站也没生成 AI 字幕时，工具返回明确提示，不会编造内容。
- `SESSDATA` 会过期；突然取不到 AI 字幕时先更新 Cookie。
- 请求过于频繁会触发 B 站风控；长视频建议调小 `maxSubtitleLength`。
- 直接读 profile YAML 只解析 `providers:` 子树，不引入 YAML 依赖；若 DSH 改了配置结构，以 `ctx.llm` 运行时服务的结果为准，并可用 `DSH_BILIREAD_BASE_URL` 临时兜底。

## 许可证与致谢

- 本项目是 [SodaCodeSave/astrbot_plugin_biliread](https://github.com/SodaCodeSave/astrbot_plugin_biliread) 的 DSH Desktop / Cordis 移植版，原始创意与实现版权归原作者 SodaCodeSave / AstrBot Plugin Authors 所有。
- 上游项目以 **AGPL-3.0**（GNU Affero General Public License v3.0）发布，本项目作为衍生作品沿用同一许可，以 **AGPL-3.0-only** 发布，详见 [LICENSE](LICENSE)。
- **AGPL 第 13 条要点**：如果你修改本程序并让它以网络服务的形式对其他用户提供交互，这些通过网络与程序交互的用户也有权获得该程序的完整源代码（对应源码需可从同一网络服务获取）。
- 本项目源码地址：<https://github.com/youkucola/dsh-biliread>，部署为网络服务时应向用户提供该地址或其镜像。
- 分发或修改本项目时，请保留上游版权声明与本许可声明，并同样以 AGPL-3.0-only 开放源代码。

