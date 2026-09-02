# Paseo GitHub Workbench

[English](README.md)

GitHub Workbench 是一个 [Paseo](https://github.com/getpaseo/paseo) 插件，让你无需离开 Paseo，即可处理 GitHub Issue 和拉取请求（Pull Request）。

它会汇集你的账户或所选仓库中的资源，以紧凑的工作台形式展示 GitHub 状态；并能为某个 Issue 或拉取请求创建或重新打开对应的 Paseo 工作区。

## 截图

### 账户工作台

![显示 GitHub 拉取请求和 Issue 的账户工作台](1.png)

### 项目工作台

![按所选仓库筛选的项目工作台](2.png)

## 功能

- 列出某个账户或仓库中处于打开状态的 GitHub Issue 和拉取请求。
- 显示标签、指派人、里程碑、评论、审查结论、可合并性和检查状态。
- 支持刷新单个资源，并清晰提示身份验证、速率限制及 GitHub CLI 失败问题。
- 在系统浏览器中打开 GitHub 链接。
- 为 Issue 和拉取请求创建或复用本地工作区与 Git worktree。
- 提供全局工作台、项目面板和 Command Center 入口。
- 支持英文和简体中文。

## 环境要求

- Paseo 0.7 或更高版本。
- 在运行 Paseo 守护进程的机器上安装 [GitHub CLI](https://cli.github.com/)（`gh`）。
- 已为需要查看其资源的 GitHub 账户完成 `gh auth login`。访问私有仓库需要具有相应仓库权限的令牌。
- 已安装 Git，以使用工作区和 worktree 功能。

## 已知限制

- GitHub Workbench 仅支持 GitHub，并依赖 Paseo 守护进程宿主机上的 GitHub CLI（`gh`）；暂不支持其他代码托管平台。

## 安装

直接从 GitHub 安装：

    paseo plugin add AllenReder/paseo-github-workbench --ref main

然后打开 Paseo 的插件设置：如有需要先启用插件功能，再启用 **GitHub Workbench**。插件属于受信任代码：其服务端代码会在 Paseo 守护进程宿主机上运行，并可使用该用户的权限调用 `gh` 和 `git`。

查看插件状态、日志或更新已跟踪的安装：

    paseo plugin status
    paseo plugin logs paseo-github-workbench
    paseo plugin update paseo-github-workbench

本地开发时，克隆本仓库，用 Bun 安装开发依赖并运行以下检查；随后使用 Paseo CLI 安装目录源码：

    bun install --frozen-lockfile
    bun run check
    bun run typecheck
    bun run test
    paseo plugin install /absolute/path/to/paseo-github-workbench

## 开发

    bun run check
    bun run typecheck
    bun run test

插件公开的宿主契约在本地由 `paseo-plugin.d.ts` 表示。升级所支持的 Paseo 版本时，请使用匹配版本的 Paseo CLI 重新生成该文件。

## 安全

报告漏洞前请先阅读 [SECURITY.md](SECURITY.md)。请勿在公开 Issue 中包含令牌、私有仓库内容或个人数据。

## 贡献

欢迎提交错误报告、有针对性的改进与文档修复。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

Apache-2.0。详见 [LICENSE](LICENSE)。
