# 思源笔记 · 本地连接

在 Windows 桌面通过本地 MCP 插件连接思源笔记。支持搜索笔记和块、读取 Markdown 或块源码，以及由用户确认后创建文档、追加内容、更新块。

当前版本：**1.1.1**。许可证：MIT。支持当前聊天文字抓取及原文/摘要归档；修复长记录审批没有按钮、等待挂起的问题。

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
- “抓取当前 Codex 聊天完整文字，原文保存到指定笔记本的 `/聊天记录/项目讨论`。”
- “读完抓取的聊天，将结论、操作和待办压缩成摘要后追加到这篇思源文档。”

写入先生成预览，再由用户在确认界面批准；取消不会写入。更新容器块可能影响其子块；创建层级文档可能创建缺失的父文档。详细能力与限制见 [插件说明](plugins/siyuan-local/README.zh-CN.md)。

## 抓取当前窗口的聊天

**Codex 桌面：**在当前聊天选中插件，指定保存目的地并要求抓取。插件按当前窗口的可信 ID 使用官方 `thread/read(includeTurns=true)`，CLI 不可用时由宿主 `read_thread` 逐页传入原始响应。不会恢复聊天或启动新的回复。

**ChatGPT 网页（Edge / Chrome）：**先安装本仓库 [browser-extension 配套扩展](plugins/siyuan-local/browser-extension/README.zh-CN.md)，在需要保存的对话里点击“抓取当前对话”，核对最早和最后一条消息，再导出 JSON。在本机桌面宿主里让思源插件导入这个 JSON，保存原文或摘要。配套扩展是需要手动加载的源码包，尚未上架浏览器扩展商店。

原文使用不可变快照，保留文字、空格和换行；摘要由 AI 读完快照后整理，保存时注明来源与摘要标识。抓取后仍需确认才写入思源。无需将 ChatGPT 密码、Cookie 或 API 凭据交给插件。

范围为用户和助手的文字记录。Codex 使用完整持久化历史；网页抓取当前选中分支的渲染文字，需人工核对首尾，无法保证后台原始 Markdown、折叠详情、附件文件或其他分支完整。快照只在内存中保留一小时，上限 8 MiB；超限或缺失会报错，不静默截断。

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

无 npm 运行依赖。自动化测试使用隔离配置和模拟 API，不写入真实思源笔记。1.1.1 自动化验证为 40 项测试中 39 项通过、1 项因受限进程无法使用桌面用户 DPAPI 而跳过。默认使用独立 Windows 确认窗口，正文滚动、按钮固定可见，取消和超时会释放等待；备用宿主表单只显示短摘要。长记录实际写入保持完整。当前 Codex 聊天曾通过宿主原始历史导入实测，53 条文字消息逐条核对一致；本机独立 app-server 在沙箱中未返回历史，使用宿主导入后备入口。浏览器扩展的滚动、顺序、缺失检测已用模拟 DOM 验证，真实 ChatGPT 页面的兼容性仍需安装后实测。1.1.1 原生弹窗显示仍需桌面宿主实测。完整记录见 [验证说明](plugins/siyuan-local/VALIDATION.md)。

1.0.1 新增聊天可调用的配置入口、可见交互启动与窗体恢复，并处理重复开窗及配置请求取消。发布前应在 Windows 桌面验证打开配置窗口、取消配置及只读连接。

## 反馈

请在 [GitHub Issues](https://github.com/cjnss008/siyuan-chatgpt/issues) 报告宿主版本、Windows 版本、Node.js 版本和错误信息。不要提交 Token、真实笔记或本机设置文件。
