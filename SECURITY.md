# 安全策略 / Security Policy

## 报告漏洞

请不要在公开 Issue 中披露安全漏洞。请通过 GitHub 的 [私密漏洞报告](https://github.com/MMSFus/chatgpt-media-gateway/security/advisories/new) 提交，内容包括影响范围、复现步骤和受影响版本。我们会尽快确认并处理。

Please do not disclose vulnerabilities in public issues. Report them privately through [GitHub Security Advisories](https://github.com/MMSFus/chatgpt-media-gateway/security/advisories/new) with the impact, reproduction steps and affected version.

## 支持的版本

只有 `main` 分支的最新提交会获得安全修复。

Only the latest commit on `main` receives security fixes.

## 部署建议

- `ADMIN_KEY`、`API_KEY` 使用足够长的随机值，二者不要相同。
- `DATA_ENCRYPTION_KEY` 用 `openssl rand -hex 32` 生成并妥善备份；丢失后已存的 token 和代理凭据无法解密。
- 服务默认只监听 `127.0.0.1`。对外提供服务时放在 TLS 反向代理之后，只有在代理会覆盖 `X-Forwarded-Proto` 时才设置 `TRUST_PROXY=1`。
- 不要把 `.env` 和 `data/` 目录提交到仓库或打进镜像。
