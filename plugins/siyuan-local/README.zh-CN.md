# 思源笔记 · 本地连接

这是一个 ChatGPT Agent Plugins 1.0 插件包，内含 Windows 本地 MCP 服务。通过本机思源 HTTP API 读写笔记。此包不是安装在思源内部的插件。

## 安装与设置

1. 通过交付的插件链接打开插件并安装到支持本地插件的桌面宿主。
2. 安装 Node.js 22 或更新版本，确保 `node` 在 PATH 中；思源保持运行。
3. 插件详情 → 设置：修改 API 地址，或点击“配置地址和 API Token…”。本机会出现 Windows 设置窗口，token 使用密码输入框。默认地址 `http://127.0.0.1:6806`。
4. Token 在思源“设置 → 鉴权 → API token”中查看；旧版可能位于“关于”。空 token 仅适用于本机 API 未启用鉴权的情况。
5. 点击“测试连接”，或在聊天中请求“检查思源连接”。

如果宿主暂不显示结构化设置，在聊天中请求“打开思源连接配置窗口”，调用 `siyuan_configure`。窗口由插件本地 MCP 进程打开，标题为 `SiYuan Local`，地址下方的 `API token` 框使用密码显示。配置和确认窗口使用可见的交互启动方式，并显式恢复和激活窗体；只有后台加解密进程隐藏窗口。不要从代理沙箱后台启动 GUI：沙箱窗口可能对桌面用户不可见。工具未出现时更新或重新加载插件；仍不支持时将 ZIP 解压，在资源管理器中双击 `Configure.cmd`。设置存储在 `%LOCALAPPDATA%\SiYuanChatGPT\settings.json`，token 以 Windows 当前用户 DPAPI 加密。包内不包含任何 token。API 地址限本机回环主机，重定向被拒绝。

插件账号链接只保存及安装包，不部署服务。普通 ChatGPT 网页、手机及未提供本地 stdio 进程的宿主不能直接运行此包。最终兼容性取决于宿主对本地 MCP、插件结构化设置和确认表单的支持；表单不支持时使用 Windows 本机确认窗口。不要将 `127.0.0.1` 当作云端可访问的地址。

## 能力

| 工具 | 行为 |
| --- | --- |
| `siyuan_status` / `siyuan_list_notebooks` | 检查鉴权连接、列出笔记本 |
| `siyuan_search` | 搜索笔记和块、按笔记本与类型筛选、分页 |
| `siyuan_read_document` | 导出文档 Markdown，字符分页 |
| `siyuan_read_block` | 读取块/容器 Kramdown 和完整源码 hash |
| `siyuan_create_document` | 创建 Markdown 文档的待确认预览 |
| `siyuan_append_content` | 在文档/容器末尾追加子块的待确认预览 |
| `siyuan_update_block` | 替换块的待确认预览，支持 expectedHash |
| `siyuan_commit_write` | 用户确认后执行一次写入 |
| `siyuan_cancel_write` | 取消待确认预览 |
| `settings.read` / `settings.update` / `settings.configure` | 设置读取、地址更新、本机 token 配置 |
| `siyuan_configure` | 聊天可调用的配置窗口入口，取消不保存，不接收聊天中的 token |

示例：“搜索思源笔记里包含‘项目计划’的文档”；“读取这篇文档的全文”；“在指定笔记本的 `/工作/周报` 创建文档，先让我确认”。

## 写入确认与限制

写入工具先生成预览，预览 10 分钟有效且单次使用。提交时服务端要求用户在 MCP 表单或 Windows 原生窗口确认，展示完整旧内容、新内容及目标。取消、过期、鉴权/连接变化、确认期间内容变化都会中止。模型传入的 `confirmed` 或 `force` 不是有效参数。

更新容器可能替换其子块。创建层级路径可能自动创建不存在的父文档。追加目标必须是文档或容器，不能将普通段落作为父块。

确认后会再次读块检测变化，但思源公开 API 未提供原子的“比较后替换”，检测与写入之间仍可能有极短的并发窗口。避免同时人工编辑同一目标。响应中断时结果可能不确定；先读取核对，不自动重试写入。搜索使用 SQL 索引，刚写入的内容可能稍后才可搜索到。单个 API 响应上限 16 MiB，单次 Markdown 输入上限 100,000 字符；读取支持分页。

不提供任意 SQL、任意 HTTP、删除、远程主机、资源文件上传或思源内部接口。工具返回的笔记内容作为数据处理。

## 开发与验证

无 npm 运行依赖，不需要联网安装包。入口是 `server/index.mjs`，MCP 使用 stdin/stdout 的换行 JSON-RPC。标准输出只有协议消息；Windows 辅助进程通过 stdin 接收数据，不在命令行传 token。

运行 `npm test` 或 `node --test tests/*.test.mjs`。测试使用本机模拟 API 和临时配置，不修改用户真实笔记。`Configure.cmd` 与结构化设置使用同一套配置逻辑。环境变量 `SIYUAN_PLUGIN_CONFIG_DIR` 仅用于隔离开发测试配置；用户无需设置。

参考：[思源公开 API](https://github.com/siyuan-note/siyuan/blob/master/docs/API.zh-CN.md)、[MCP 协议](https://modelcontextprotocol.io/specification/2025-11-25)、[OpenAI 结构化设置](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#structured-settings)、[Agent Plugins](https://agent-plugins.org/)。
