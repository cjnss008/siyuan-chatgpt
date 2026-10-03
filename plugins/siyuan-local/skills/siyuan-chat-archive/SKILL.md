---
name: siyuan-chat-archive
description: 用户要抓取当前 Codex 桌面或 ChatGPT 网页聊天完整文字记录，保留原文或总结压缩后保存到本机思源笔记时使用。
---

# 当前聊天抓取与归档

先明确当前窗口、保存原文还是摘要，以及思源目的地。抓取不写入思源；保存沿用预览与用户确认。不要用当前模型上下文、read_thread 的摘要、屏幕片段或模型回忆冒充完整聊天。

## Codex 桌面

1. 从当前聊天的可信宿主信息取得 threadId；可在当前任务的 shell 中读取 CODEX_THREAD_ID。不要通过“最近聊天”、其他线程的标题、MCP 的匿名 openai/session 或共享 MCP 服务启动环境猜测当前窗口。
2. 调用 siyuan_capture_current_chat，source=codex，threadId 为取得的当前 ID。它通过官方 Codex app-server thread/read(includeTurns=true) 读取完整持久化历史，不恢复聊天，不启动模型回复。
3. 如果本机 CLI 不可用而宿主提供 read_thread，使用原始响应分页导入。每页 turnLimit=10、includeOutputs=false、maxOutputCharsPerItem=20000。直接将工具返回的完整 JSON 文本传入 siyuan_ingest_chat_page 的 pageJson；不能由模型重新拼写消息。第一页不传 captureId/requestCursor；之后传上一步的 captureId 和 nextCursor，并用这个 nextCursor 读取宿主下一页。直到 ready=true，使用最后返回的 captureId。
4. 有代码编排工具时，让代码在工具之间直接传递原始响应，不把原始 JSON 打印回模型再转写。工具命名按宿主实际发现的名称。出现截断、分页游标不一致、未加载 items 或无法读到最早一页时停止，不宣称抓取完整。

## ChatGPT 网页（Edge / Chrome）

需要安装本包 browser-extension/ 中的“思源聊天抓取”配套扩展。它只在用户点击后读取当前标签页，不访问登录凭据，不读取后台标签页，不调用私有聊天接口。

1. 引导用户在需要保存的具体 ChatGPT 对话中点击扩展，再点击“抓取当前对话”。扩展滚动读取上下历史，收集当前选中分支的文字；抓取期间保持面板打开，等待回复生成结束。
2. 用户核对扩展显示的最早、最后一条消息，勾选确认并导出 JSON。不能替用户勾选。未核对或发现缺失轮次时不能作为完整记录保存。
3. 取得用户选定的导出 JSON 绝对路径，调用 siyuan_capture_current_chat，source=chatgpt-web，captureFile 为该文件。不能随意选择 Downloads 里“最新”文件。远程宿主不能通过路径读取本机文件，需在同一电脑的本地插件宿主运行。

## 保存

- 返回 messageCount、coverage、warnings、hash，说明抓取范围。范围是用户与助手文字；系统提示、隐藏推理、工具内部输出、附件文件、未选中的其他分支不在原文范围内。原始文字保留空格和换行，思源会按 Markdown 渲染。当前尚未结束的回复只能保存抓取时已持久化的快照；说明此限制。
- 原文：调用 siyuan_save_captured_chat(mode=original,captureId=...)，不传 summaryMarkdown。服务器直接使用不可变快照，避免模型改写、漏段和长文本工具参数截断。
- 摘要：用 siyuan_read_captured_chat 分页读完快照，直到 nextOffset=null，再总结。保留结论、关键事实、代码或操作、未解决问题和待办；明确标记摘要。调用 siyuan_save_captured_chat(mode=summary,summaryMarkdown=...)。
- 新建明确 notebook/path；追加明确 parentId，不能默认选择笔记本或混用目的地。
- 保存工具仅返回待确认预览。按照 siyuan-notes 的写入流程展示目的地与内容，再调用 siyuan_commit_write。用户拒绝后停止。成功后读块核对，不自动重试不确定的写入。
- 快照只保存在插件进程内存中，一小时过期；重新加载后需重新抓取。上限 8 MiB，超限报错，不静默截断。
