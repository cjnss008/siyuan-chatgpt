# 思源笔记 · 本地连接

在 Windows 桌面通过本地 MCP 插件连接思源笔记。支持搜索笔记和块、读取 Markdown 或块源码，以及由用户确认后创建文档、追加内容、更新块。

当前版本：**1.0.1**。许可证：MIT。

## 使用要求

- Windows 桌面，以及支持本地插件和 stdio MCP 的宿主。
- Node.js **22 或更新版本**，`node` 可在 PATH 中调用。
- 本机运行思源笔记，HTTP API 默认地址为 `http://127.0.0.1:6806`。

服务在使用者自己的电脑运行。普通网页或手机无法直接启动本包中的 Windows 本地进程。此插件安装在 AI 桌面宿主中，不是思源内部插件。

## 安装

在支持以下命令的 Codex CLI 中添加仓库插件源：

```powershell
codex plugin marketplace add cjnss008/siyuan-chatgpt
```

重新启动桌面宿主，在插件目录中选择 **思源笔记本地连接** 插件源，安装 **思源笔记 · 本地连接**。

如果宿主版本未支持这些命令或插件源，请参照 [OpenAI 官方插件安装文档](https://developers.openai.com/plugins/build/plugins) 中的本地 marketplace 安装流程。仓库目录为：

```text
.agents/plugins/marketplace.json
plugins/siyuan-local/
  plugin.json
  mcp.json
  .codex-plugin/plugin.json
  .mcp.json
  server/
  skills/
  Configure.cmd
```

## 配置与测试

1. 启动思源笔记。
2. 在聊天中选择插件，请求“打开思源连接配置窗口”；插件调用 `siyuan_configure`。也可使用插件设置中的“配置地址和 API Token…”入口。
3. 配置窗口标题为 **SiYuan Local**。填写本机 API 地址，地址下方的 **API token** 输入框是密码框。
4. 从思源“设置 → 鉴权 → API token”获取 Token；旧版可能位于“关于”。将它粘贴到密码框，点击 **Confirm**。不要在聊天中发送 Token。
5. 请求“检查思源连接并列出笔记本”，验证连接与鉴权。

如果宿主不能显示窗口，从本仓库下载完整源码并解压，在资源管理器中双击 `plugins\siyuan-local\Configure.cmd`。脚本需要 PATH 中的 Node.js。不要让代理沙箱后台启动 GUI：沙箱桌面的窗口可能对用户不可见。

设置保存在 `%LOCALAPPDATA%\SiYuanChatGPT\settings.json`，Token 使用当前 Windows 用户的 DPAPI 加密。仓库不包含用户配置或 Token。API 地址仅支持 `localhost`、`127.0.0.1` 或 `[::1]`。

## 使用示例

- “搜索思源笔记里包含‘项目计划’的文档。”
- “读取这篇文档的全文。”
- “在指定笔记本的 `/工作/周报` 创建文档，先预览并让我确认。”

写入先生成预览，再由用户在确认界面批准；取消不会写入。更新容器块可能影响其子块；创建层级文档可能创建缺失的父文档。详细能力与限制见 [插件说明](plugins/siyuan-local/README.zh-CN.md)。

## 更新

```powershell
codex plugin marketplace upgrade
```

更新插件源后，在桌面宿主中更新插件并重新加载。版本以 `plugins/siyuan-local/plugin.json` 为准。

## 开发与验证

```powershell
cd plugins/siyuan-local
npm test
```

无 npm 运行依赖。自动化测试使用隔离配置和模拟 API，不写入真实思源笔记。1.0.1 的验证结果为 25 项测试中 24 项通过、1 项因受限进程无法使用桌面用户 DPAPI 而跳过。真实思源鉴权和笔记本列表读取已验证；新版原生弹窗显示仍需桌面宿主实测。完整记录见 [验证说明](plugins/siyuan-local/VALIDATION.md)。

1.0.1 新增聊天可调用的配置入口、可见交互启动与窗体恢复，并处理重复开窗及配置请求取消。发布前应在 Windows 桌面验证打开配置窗口、取消配置及只读连接。

## 反馈

请在 [GitHub Issues](https://github.com/cjnss008/siyuan-chatgpt/issues) 报告宿主版本、Windows 版本、Node.js 版本和错误信息。不要提交 Token、真实笔记或本机设置文件。
