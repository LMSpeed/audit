# 发布 lmspeed-audit

[English](./releasing.md) · [简体中文](./releasing.zh-CN.md) · [Русский](./releasing.ru.md)

稳定版本标签 `vX.Y.Z` 触发 `.github/workflows/release.yml`。标签必须与 `package.json` 和 `ENGINE_VERSION` 一致。工作流验证包，在干净消费项目中安装 tarball，并在 Linux、macOS、Windows 的 Node.js 22 和 24 上检查便携命令后再发布下载。Release 不可变，重试复用原文件。

未配置首次发布令牌时，即使版本已存在，npm 任务也会验证 GitHub 到 npm 的 OIDC 交换。这可在不创建新公开版本的情况下检查 trusted publisher 是否仍可用。交换得到的凭据不会输出或持久化。

## 注册表

- npm：[`@lmspeed/audit`](https://www.npmjs.com/package/@lmspeed/audit)，公开并附带来源证明。首次发布需配置仓库 secret `NPM_TOKEN`，授权在 `@lmspeed` scope 下发布此包。包创建后，配置 [npm trusted publisher](https://docs.npmjs.com/trusted-publishers/)：组织 `LMSpeed`、仓库 `audit`、工作流 `release.yml`，不设置 environment。验证后移除令牌 secret；工作流使用 `id-token: write` 进行 OIDC。发布通过 `pnpm publish` 使用 Node.js 24 提供的 npm CLI（需要 npm >=11.5.1）。
- GitHub Packages：[`@lmspeed/audit`](https://github.com/lmspeed/audit/pkgs/npm/audit)，使用本仓库的 `GITHUB_TOKEN`。GitHub 要求包 scope 与仓库 owner 一致。两个注册表使用相同包名；只有使用 GitHub Packages 时才将 `@lmspeed` scope 指向该注册表。GitHub 首次创建的包默认私有，首次发布后需在包设置中改为 **Public**。即使公开的 GitHub npm 包，安装仍需 `read:packages` 令牌。参见 [GitHub 注册表文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)。

## Homebrew、Scoop 与下载

本仓库同时作为 Homebrew tap（`Formula/`）与 Scoop bucket（`bucket/`）。发布后，工作流将生成的准确 manifest 提交到 `main`。二者均指向带 SHA-256 校验和的版本化 Release 压缩包。便携包内含运行时依赖及全部许可声明，需要 Node.js >=22.12，安装时不下载代码。Homebrew 自动安装 Node.js；Scoop 依赖 `nodejs-lts`。这些是项目上游维护的 tap 与 bucket，不代表已收录于 Homebrew/core、Scoop main、winget 或 Chocolatey。

```sh
pnpm check
pnpm release:prepare
pnpm release:smoke
git tag vX.Y.Z
git push origin main vX.Y.Z
```

创建标签前更新英文、简中、俄文三份更新日志。需要重试注册表发布或安装器更新时，以现有标签手动触发 `release.yml`；已发布的注册表版本会跳过。不得替换已有 Release 资源或标签。已发布后的打包修复应同时增加包版本和引擎版本，再发布新标签。

包首页、注册表元数据、安装器首页及 README 均指向 [LMSpeed 在线审计](https://lmspeed.net/zh/audit)。LMSpeed 审计方法论区块提供仓库与各安装渠道链接。

## 仓库迁移

从 0.3.3 起，标准仓库为 [lmspeed/audit](https://github.com/lmspeed/audit)。现有 Release 与资源保持不可变；旧仓库 URL 由 GitHub 重定向。0.3.3 之前的 GitHub Packages 版本仍在旧包名 `@nexmoe/lmspeed-audit` 下；新版本在两个注册表均使用 `@lmspeed/audit`。

已有 Homebrew 用户可依次执行 `brew uninstall lmspeed-audit`、`brew untap nexmoe/lmspeed-audit`，再按 README 中的新 tap／安装命令切换。已有 Scoop 用户可移除 `lmspeed` bucket 后按新仓库 URL 重新添加；已安装应用仍可使用。
