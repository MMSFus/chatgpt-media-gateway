# ChatGPT Media Gateway

[![CI](https://github.com/MMSFus/chatgpt-media-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/MMSFus/chatgpt-media-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node.js 24+](https://img.shields.io/badge/node-%3E%3D24-339933)

面向自托管场景的 ChatGPT 语音与图片 API 网关，对外提供 OpenAI 风格的 `/v1/images/*` 和 `/v1/audio/*` 接口。项目只提供管理员控制台，调用方通过 API 使用服务，不包含终端用户工作台。

A self-hosted gateway that exposes ChatGPT web image and voice features through OpenAI-style `/v1/images/*` and `/v1/audio/*` endpoints. Documentation is in Chinese.

> [!WARNING]
> 本项目调用 ChatGPT 网页端内部接口，不是 OpenAI 官方 API，与 OpenAI 无关。使用可能违反 OpenAI 服务条款并导致账号受限，风险由使用者自行承担。仅供学习研究，请只接入你有权使用的账号。使用前请阅读 [免责声明](DISCLAIMER.md)。
>
> This project uses internal ChatGPT web endpoints, not the official OpenAI API, and is not affiliated with OpenAI. Use may violate OpenAI's terms and get accounts restricted, at your own risk. Read the [disclaimer](DISCLAIMER.md) before use.

## 运行

要求 Node.js 24 或更新版本。SQLite 使用 Node 内置的 `node:sqlite`；图像按目标尺寸压缩使用 `sharp@0.35.5`。本地安装依赖使用 `npm ci`。

```sh
npm ci
cp .env.example .env   # 填写 ADMIN_KEY、API_KEY，并用 openssl rand -hex 32 生成 DATA_ENCRYPTION_KEY
npm start
```

`ADMIN_KEY`、`API_KEY` 和 32 字节十六进制 `DATA_ENCRYPTION_KEY` 都必须设置。项目目录中的 `.env` 会在启动时读取，已存在的进程环境变量优先。默认监听 `127.0.0.1:8080`，数据库位于 `./data/gateway.sqlite`。对外提供服务时，应由 TLS 反向代理保护连接。

启动后访问 `http://127.0.0.1:8080/admin` 打开管理控制台。管理员密钥和调用方密钥不同；账号 token 与代理 URL 使用 AES-256-GCM 加密后存入 SQLite，数据库文件权限设为仅当前用户读写。请求日志仅记录路径、账号 ID、状态码、耗时和错误摘要，不保存提示词或上传文件。

### Docker

```sh
cp .env.example .env   # 同上，填写必填项
docker compose up -d --build
```

示例 `compose.yml` 只在 `127.0.0.1:8080` 上发布端口，数据保存在 `./data`（镜像内以 uid 1000 的 `node` 用户运行，宿主目录需对其可写）。请妥善备份 `DATA_ENCRYPTION_KEY`，丢失后已存的 token 和代理凭据无法解密。

## API

所有接口都要求 `Authorization: Bearer $API_KEY`。

| 路径 | 请求格式 | 当前行为 |
| --- | --- | --- |
| `POST /v1/images/generations` | JSON | 接受任意 `gpt-image-*` 模型名（省略时默认为 `gpt-image-2`）；`n` 为 1–4，`response_format` 支持 `url` 和 `b64_json`；`size` 支持 `auto`、`WxH`、`W:H`，`quality` 支持 `auto`、`low`、`medium`、`high`、`standard`、`hd` |
| `POST /v1/images/edits` | multipart 或 JSON | 参考图编辑；接受 1–4 张 PNG/JPEG/WebP，每张不超过 20 MB，沿用 generations 的图片参数校验 |
| `POST /v1/audio/speech` | JSON | 文本转语音，返回音频二进制 |
| `POST /v1/audio/transcriptions` | multipart | 音频转写，支持 `json`、`text`、`verbose_json`；上传文件不超过 50 MB |
| `POST /v1/audio/translations` | multipart | 当前仅转写音频，不保证翻译为英文；不接受 `language` 字段 |
| `GET /v1/models` | - | 返回当前公开的图片、TTS 和转写模型别名 |

### 生图后处理

对 `/images/generations` 和 `/images/edits` 生效，路径前缀从左到右决定处理顺序；`SR` 是腾讯云数据万象超分，`CR` 是腾讯云 tiia 清晰度增强。每个 SR 步骤读取当前图片的 PNG/JPEG/WebP 像素尺寸，并以请求中的 `WxH` 目标计算 `r = max(目标宽/当前宽, 目标高/当前高)`：`r <= 1.25` 跳过，`1.25 < r <= 2` 使用 `magnify=2`，`r > 2` 使用最大值 `magnify=4`。输出可能大于目标，不会缩小；重复 SR 会基于前一步输出重新计算。缺少像素目标（未传、空值、`auto` 或 `W:H`）时跳过所有 SR，因为原生输出约为 1K。跳过的步骤不会调用腾讯云或上传文件，因此不产生 SR 费用。前缀可重复，最多四步，大小写必须严格匹配：

| 路径 | 步骤 |
| --- | --- |
| `/v1/images/generations` | 只生图，保持原行为 |
| `/SR/v1/images/generations` | 生图 → 超分 |
| `/CR/v1/images/generations` | 生图 → 清晰度增强 |
| `/SR/CR/v1/images/generations` | 生图 → 超分 → 清晰度增强 |
| `/CR/SR/v1/images/generations` | 生图 → 清晰度增强 → 超分 |

其他前缀和带前缀的音频、模型路径返回 404；超过四步返回 400。每一步接收上一步的图片字节，任一步失败都返回 502 `upstream_error`，包含步骤、腾讯云错误码和消息、RequestId，不返回原图或部分结果。没有完整配置时带前缀请求返回 503，普通 `/v1` 请求不受影响。`b64_json` 返回最终图像的 base64；`url` 会将结果保存在 `DATA_DIR/files/`，返回基于请求 Host 的绝对 `/files/<uuid>.<ext>` 地址，文件一小时后清理。该下载路由不要求 API 密钥，只接受严格 UUID 文件名。

需要的可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `TENCENTCLOUD_SECRET_ID` | 腾讯云 SecretId |
| `TENCENTCLOUD_SECRET_KEY` | 腾讯云 SecretKey |
| `TENCENT_COS_BUCKET` | COS Bucket，格式为 `BucketName-APPID` |
| `TENCENT_REGION` | 腾讯云地域，可省略，默认 `ap-guangzhou` |

给子账号授予 `tiia:EnhanceImage`，以及 COS/数据万象所需的 `cos:PutObject`、`cos:GetObject`、`cos:DeleteObject`、`ci:CreateSuperResolutionJob` 权限。超分费用参考为每次 0.006 元；清晰度增强按腾讯云 tiia 当前计费规则另计，请以腾讯云控制台为准。

除用于图像解码、Lanczos3 重采样和编码的 `sharp@0.35.5` 外，项目不依赖其他直接 npm 包。这里使用 Node 内置 `node:crypto` 实现 TC3 和 COS v5 请求签名，避免引入腾讯云 SDK 及其依赖体积。腾讯云路由由全局设置 `tencentProxyId` 控制：未设置或 `null` 时沿用全局出口代理链，`direct` 时直连，指定代理 ID 时从该代理开始并跟随其下一跳，不叠加全局出口；ChatGPT 账号代理和默认代理不会用于腾讯云请求。

生图示例：

```sh
curl http://127.0.0.1:8080/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-image-2","prompt":"雨夜中的红色小船","n":1,"response_format":"url"}'
```

编辑接口的 multipart 字段为 `image`/`image[]`、`prompt`、`model`、`n`、`size`、`quality`、`response_format`。JSON 可使用 `images: [{"image_url":"data:image/png;base64,..."}]`，或将 `image` 设为 data URL、纯 base64 字符串或其数组。为避免 SSRF，不接受 `http(s)` 图片 URL；`mask` 尚不支持，传入会返回 400。

`size` 未传、为空或为 `auto` 时不添加尺寸说明。`WxH`（`x` 大小写均可，宽高各为 1–8192 的正整数）和 `W:H`（正整数）会按宽高比映射到最接近的常用比例：`1:1`、`4:3`、`3:4`、`3:2`、`2:3`、`16:9`、`9:16`、`21:9`、`9:21`；距离按宽高比对数差计算。`quality` 未传、为空或为 `auto` 时不添加质量说明；`low`、`medium`、`high` 分别映射为低、中、高，`standard` 等同 `medium`，`hd` 等同 `high`，且大小写不敏感。尺寸和质量说明会以空行追加到提示词后，作为给模型的文字提示；它们不保证输出的像素尺寸或质量档位。

语音合成示例：

```sh
curl http://127.0.0.1:8080/v1/audio/speech \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"tts-1","input":"你好。","voice":"alloy","response_format":"mp3"}' \
  --output speech.mp3
```

转写示例：

```sh
curl http://127.0.0.1:8080/v1/audio/transcriptions \
  -H "Authorization: Bearer $API_KEY" \
  -F 'file=@audio.mp3' -F 'language=zh' -F 'response_format=json'
```

当前接受任意大小写不敏感的 `gpt-image-` 前缀模型名，模型名目前不会映射到上游：所有请求仍使用 `auto` 与 `picture_v2`，实际对话模型由 ChatGPT 的 `auto` 路由决定（2026-11-05 观测到 `model_slug: gpt-6`），图像模型名不会由上游返回。图片响应会缓冲上游 SSE 后再处理，不向调用方提供流式图片进度。SSE 结束后网关会轮询 conversation 明细（最多 120 秒）等待异步图片结果；支持 `file-service://` 与 `sediment://` 引用，分别通过文件下载和 conversation 附件接口解析。`size` 和 `quality` 会映射为追加在提示词后的说明，只是给模型的提示，不保证输出的像素尺寸或质量档位。TTS 使用 assistant 消息承载 `input` 原文后请求上游合成；`flac`、`wav`、`pcm` 请求会映射为上游 AAC，返回的实际格式以 `Content-Type` 为准。`/v1/audio/translations` 当前复用上游转写端点，实际输出是识别到的原语言文本，并未实现英文翻译。

## 账号与代理

管理员控制台支持添加、停用、删除和轮换 access token，并为每个账号指定代理。路由顺序是：全局出口代理及其下一跳 → 账号代理（若未指定则使用默认代理）→ 该代理的下一跳。代理链中若已包含某个节点，不会重复连接。没有配置全局出口时，从账号/默认代理开始；未配置账号/默认代理时则从全局出口开始；两者都未配置时直连。

调度按账号当前 in-flight 数选择负载最低者，同负载时轮询；每账号的并发上限由账号的 `concurrency` 决定（默认 1）。账号错误包括 ChatGPT 上游非 2xx、网络/代理/TLS/超时错误、SSE 或响应解析失败、force_login 以及图片轮询失败。每次错误增加连续错误计数并默认冷却 10 分钟；默认连续 3 次后自动停用。冷却结束会恢复 ready 但保留计数，成功请求或管理员重新启用/轮换 token 会清零。参数校验 4xx 和 SR/CR 后处理错误不计入账号错误。当前上游响应没有稳定的内容政策拒绝标记，因此无法可靠地区分这类拒绝与普通生成失败；无法区分的拒绝按账号错误计数。每个请求默认最多尝试 3 个不同账号；编辑重试会在新账号上重新上传参考图。账号满载时默认最多排队 60 秒，等待队列默认上限 100，超时或队列已满返回 503。

`PUT /api/admin/settings` 可部分更新以下数值设置，未提供的值保持原值；非法值返回 400：

| 设置 | 默认值 | 范围 | 含义 |
| --- | ---: | ---: | --- |
| `cooldownMinutes` | 10 | 0–1440 | 账号错误冷却分钟数；0 表示不冷却 |
| `maxConsecutiveErrors` | 3 | 0–100 | 达到次数自动停用；0 表示不自动停用 |
| `maxAttempts` | 3 | 1–10 | 单请求最多尝试的不同账号数 |
| `queueTimeoutSeconds` | 60 | 0–600 | 满载排队最长时间；0 表示不排队 |
| `maxQueue` | 100 | 0–10000 | 等待队列上限 |

账号的 `concurrency` 是每账号独立的并发上限，默认 1，可在新增或更新账号时设置为 1–5。调度器按 `inFlight/concurrency` 最低优先分配，并列轮询；调低上限不会中断进行中的请求，调高会立即唤醒队列。512 MB 容器应结合启用账号的并发总量与图像流量保守配置。

对于 `/v1/images/generations`、`/v1/images/edits` 及其 SR/CR 前缀路径，`size=WxH` 会启用初始图片尺寸检查：原图比例与目标相差不超过约 2% 且至少一个边大于目标时，按 cover 居中裁剪并缩至精确目标尺寸；其余图片保持原样。比例请求（如 `16:9`）和未指定尺寸不会触发下载或压缩。压缩后的图片再按 URL 顺序进入 SR/CR 处理链。

Docker 镜像构建需复制 `package.json`、`package-lock.json` 后在镜像内运行 `npm ci --omit=dev`，再复制 `src/`、`public/` 等运行文件；Node 24 Alpine 的安装应保留 npm 可选依赖，以安装匹配 musl 的 sharp 二进制包。仓库根目录的 `Dockerfile` 和 `compose.yml` 是可直接使用的示例。

`PUT /api/admin/settings` 接受部分对象并保留未提供的旧值。设置形状为 `{ defaultProxyId, exitProxyId, tencentProxyId }`：前两项是代理 ID 或 `null`；`tencentProxyId` 是 `null`（跟随出口链）、`direct`（直连）或代理 ID。`POST /api/admin/proxy-test` 传入 `{"target":"tencent"}` 可测试当前腾讯云链路。

**批量导入**（控制台「批量导入」页）：上传 `.txt`/`.csv` 或粘贴文本，按行解析。可以整行作为 token，也可以按分隔符（`----`、Tab、逗号、`|`、`:`、`;`、空格或自定义）拆分后选择 token 所在列和可选的名称列。载入时自动猜测格式和 eyJ 开头的 token 列。空值、本批重复和不像 JWT 的值会跳过（后者可关闭）。导入在浏览器里逐条调用 `POST /api/admin/accounts`，每行显示结果；网关不对比已存账号（token 加密存储），同一页面会话内导入过的 token 不会重复提交。

**工作台**（控制台默认页）：用 `API_KEY` 直接调用 `/v1/images/generations`（可组合 SR/CR 前缀链）和 `/v1/audio/speech`，显示状态码、耗时、实际图片宽高和大小，可试听和下载。API Key 只保存在当前标签页的 sessionStorage。

代理 URL 支持 `http://`、`https://`、`socks5://`、`socks5h://`，可带用户名和密码。`socks5://` 在本机解析目标域名，`socks5h://` 由代理解析。代理节点的下一跳可在控制台中组合；控制台提供当前链路测试。

## 上游协议边界

服务直接调用 ChatGPT HTTP 接口，不启动浏览器进程。生图前会读取首页 PoW 脚本引用，生成 legacy Sentinel 信号并处理 proof-of-work 和已知格式的 Turnstile `dx`。协议实现参考 `basketikun/chatgpt2api` 的 MIT 代码；求解器无法解出 Turnstile 时会按参考实现以空 token 继续 finalize，Arkose challenge 则不支持。ChatGPT access token 并非官方发布的图片或音频 API 凭证，内部接口也可能变化。

本地 `npm test` 使用模拟上游验证 API、凭证加密、SSE/音频处理、图片编辑上传、代理链和合成 Turnstile 挑战，并覆盖参考实现中的 requirements 信号、PoW nonce 字段及 Turnstile 输出指令语义，包括求解失败时以空 token 继续 finalize。2026-11-05 已用真实账号验证 `n=1` 图片 URL 与 `b64_json`（成功保存 PNG），并验证真实 TTS 输出及随后的转写；转写结果与送入 TTS 的英文句子一致。`/v1/audio/translations` 仍复用转写端点，未实现英文翻译。流式输出和自动刷新 access token 目前未实现。

## 许可证

本项目以 [MIT 许可证](LICENSE) 发布，使用前请阅读 [免责声明](DISCLAIMER.md)。第三方代码和依赖的许可证见 [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私密报告。
