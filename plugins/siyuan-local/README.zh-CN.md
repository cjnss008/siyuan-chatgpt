# 思源笔记 · 本地连接

这是一个 ChatGPT Agent Plugins 1.0 插件包，内含 Windows 本地 MCP 服务。通过本机思源 HTTP API 读写笔记。此包不是安装在思源内部的插件。

## 安装与设置

1. 通过交付的插件链接打开插件并安装到支持本地插件的桌面宿主。
2. 安装 Node.js 22 或更新版本，确保 `node` 在 PATH 中；思源保持运行。
3. 插件详情 → 设置：修改 API 地址，或点击“配置地址和 API Token…”。本机会出现 Windows 设置窗口，token 使用密码输入框。默认地址 `http://127.0.0.1:6806`。
4. Token 在思源“设置 → 鉴权 → API token”中查看；旧版可能位于“关于”。空 token 仅适用于本机 API 未启用鉴权的情况。
5. 点击“测试连接”，或在聊天中请求“检查思源连接”。

如果宿主暂不显示结构化设置，在聊天中请求“打开思源连接配置窗口”，调用 `siyuan_configure`。窗口由插件本地 MCP 进程打开，标题为 `SiYuan Local`，地址下方的 `API token` 框使用密码显示。配置和确认窗口使用可见的交互启动方式，并显式恢复和激活窗体；只有后台加解密进程隐藏窗口。不要从代理沙箱后台启动 GUI：沙箱窗口可能对桌面用户不可见。工具未出现时更新或重新加载插件；仍不支持时将 ZIP 解压，在资源管理器中双击 `Configure.cmd`。设置存储在 `%LOCALAPPDATA%\SiYuanChatGPT\settings.json`，token 以 Windows 当前用户 DPAPI 加密。包内不包含任何 token。API 地址限本机回环主机，重定向被拒绝。

插件账号链接只保存及安装包，不部署服务。普通 ChatGPT 网页、手机及未提供本地 stdio 进程的宿主不能直接运行此包。需要宿主支持本地 MCP 和 Windows 桌面窗口；写入默认使用独立本机确认窗口，不依赖宿主的审批表单。不要将 `127.0.0.1` 当作云端可访问的地址。

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
| `siyuan_read_write_preview` | 分页读取待确认的完整原内容、新内容及目标 |
| `siyuan_cancel_write` | 取消待确认预览 |
| `settings.read` / `settings.update` / `settings.configure` | 设置读取、地址更新、本机 token 配置 |
| `siyuan_configure` | 聊天可调用的配置窗口入口，取消不保存，不接收聊天中的 token |
| `siyuan_capture_current_chat` | 读取当前 Codex 完整持久化文字，或导入当前网页扩展抓取文件 |
| `siyuan_ingest_chat_page` | CLI 不可用时直接导入桌面宿主 read_thread 原始分页 |
| `siyuan_read_captured_chat` | 分页读取不可变聊天快照用于核对或总结 |
| `siyuan_save_captured_chat` | 将快照原文或摘要生成新建/追加预览，仍需确认 |

## 当前聊天归档（1.2.0）

在 Codex 桌面聊天中请求“抓取当前聊天完整文字，保留原文保存到指定思源笔记本”。插件按当前窗口的可信 threadId 使用官方 `codex app-server` 的 `thread/read(includeTurns=true)`；找不到 CLI 时，可由桌面宿主 `read_thread` 从第一页到最后一页直接导入原始响应。不能猜测最近的聊天，也不使用共享 MCP 进程启动时的旧聊天 ID。CLI 可通过 `SIYUAN_CODEX_EXECUTABLE` 指定绝对路径。

Edge/Chrome 中的 ChatGPT 网页需要安装 [配套浏览器扩展](browser-extension/README.zh-CN.md)。它通过用户点击临时读取当前页面，滚动收集文字，再显示首尾供用户核对。导出 JSON 后，把所选文件绝对路径交给本机插件导入并生成思源保存预览。没有 ChatGPT 登录凭据读取、后台标签页监控或私有接口抓取。

原文保存直接使用服务器内的不可变快照，逐条保留文字、空格和换行，不让模型重新拼写。摘要保存先分页读完快照再总结，标记“摘要”并记录来源 hash。支持新建文档和追加；仍由用户确认后才写入。

“完整文字”范围是当前聊天中的用户与助手消息。Codex 从持久化历史读取；网页仅收集当前选中分支的渲染文字，需要人工核对首尾，不能证明后台历史完整。系统提示、隐藏推理、工具内部文字输出、非图片附件文件、折叠详情和其他分支不自动复制。尚未完成的回复只能保存抓取时已持久化的快照。思源会按 Markdown 渲染文字，界面排版不保证一致。快照一小时过期、进程重启后消失，上限 8 MiB；缺失、截断或超限会报错，不静默丢段。

示例：“搜索思源笔记里包含‘项目计划’的文档”；“读取这篇文档的全文”；“在指定笔记本的 `/工作/周报` 创建文档，先让我确认”。

## 图片归档（1.2.0）

默认保存文字和图片文件。Codex 从当前聊天中明确的本机图片附件、正文 Markdown/HTML 图片引用及 imageGeneration 显示项读取图片，不读取任意其他文件。网页扩展只下载当前聊天消息里的图片，不读取登录凭据；同源图片由浏览器当前会话访问，跨源请求不携带凭据。网页图片加入对应消息下方，只保证页面可下载的版本；页面若仅提供缩略图，不能保证原始分辨率。已过期、被移除、跨源限制或历史只提供 fileId 而无图片字节的图片不能恢复。

图片原始字节和 SHA-256 保存在内存快照中，不缩放、不重新编码，相同内容只上传一次。默认 includeImages=true，任何已发现图片缺失都会停止完整保存，明确报告缺失项；只有用户明确只要文字才使用 includeImages=false，并标注未复制图片。摘要模式保留全部原聊天图片作为附录。

保存预览列出图片数量、大小和校验值；确认后调用公开 /api/asset/upload（Multipart，/assets/）上传资源，并将正文图片引用改成 assets/...。取消确认不会上传图片或正文。图片上传与正文写入不是同一事务：上传或正文请求中断时可能留下资源，返回已知资源路径和结果状态，不能自动重试。正文成功后需读取核对图片引用。

支持 PNG、JPEG、GIF、WebP、BMP、TIFF、AVIF；其他格式报错。单图上限 20 MiB，图片总量 100 MiB、来源最多 200 个，聊天文字 8 MiB，含图片的网页 JSON 文件 144 MiB；超限报错，不静默截断。网页旧版导出不包含图片，需要重新用 1.2.0 扩展导出。

## 写入确认与限制

1.1.2 修复 Windows PowerShell 5.1 下窗口标题和按钮中文乱码：脚本使用 ASCII 源码，通过 Unicode 码位构造中文标签，不依赖 UTF-8 BOM 是否在上传、安装或 Git 中保留。正文 JSON 仍按 UTF-8 接收。

1.1.1 修复长聊天确认卡住：旧版会把整篇记录发送到宿主 MCP 表单，可能只显示正文而看不到确认控件。现在默认打开独立 Windows“思源笔记 · 写入确认”窗口，全文在可滚动区域，确认/取消按钮固定在底部；两分钟无操作会关闭且不写入。取消工具请求也会关闭本机窗口、释放写入锁，不需要重启应用。实际桌面显示效果仍需在用户宿主验证。

写入工具先生成预览，预览 10 分钟有效且单次使用。超过 4,000 字符的完整预览只返回摘要并标记 previewTruncated；用 `siyuan_read_write_preview` 分页核对全文，原文快照和实际写入内容不截断。默认 `siyuan_commit_write` 或显式 `confirmationUi=native` 使用独立窗口。备用 `confirmationUi=host` 只显示最多 2,000 字符的摘要，需要先核对完整预览，一分钟无响应返回未写入错误；不自动改用另一个窗口。取消、过期、鉴权/连接变化、确认期间内容变化都会中止。模型传入的 `confirmed` 或 `force` 不是有效参数。

更新容器可能替换其子块。创建层级路径可能自动创建不存在的父文档。追加目标必须是文档或容器，不能将普通段落作为父块。

确认后会再次读块检测变化，但思源公开 API 未提供原子的“比较后替换”，检测与写入之间仍可能有极短的并发窗口。避免同时人工编辑同一目标。响应中断时结果可能不确定；先读取核对，不自动重试写入。搜索使用 SQL 索引，刚写入的内容可能稍后才可搜索到。单个 API 响应上限 16 MiB，单次 Markdown 输入上限 100,000 字符；读取支持分页。

不提供任意 SQL、通用 HTTP、删除、通用文件上传或思源内部接口。图片上传只服务于当前聊天归档。工具返回的笔记内容作为数据处理。

## 开发与验证

无 npm 运行依赖，不需要联网安装包。入口是 `server/index.mjs`，MCP 使用 stdin/stdout 的换行 JSON-RPC。标准输出只有协议消息；Windows 辅助进程通过 stdin 接收数据，不在命令行传 token。

运行 `npm test` 或 `node --test tests/*.test.mjs`。测试使用本机模拟 API 和临时配置，不修改用户真实笔记。`Configure.cmd` 与结构化设置使用同一套配置逻辑。环境变量 `SIYUAN_PLUGIN_CONFIG_DIR` 仅用于隔离开发测试配置；用户无需设置。

参考：[思源公开 API](https://github.com/siyuan-note/siyuan/blob/master/docs/API.zh-CN.md)、[MCP 协议](https://modelcontextprotocol.io/specification/2025-11-25)、[OpenAI 结构化设置](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#structured-settings)、[Agent Plugins](https://agent-plugins.org/)。
