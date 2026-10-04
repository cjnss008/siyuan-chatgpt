import {captureChatPage} from './capture.js';
const el=id=>document.getElementById(id);let snapshot=null;
el('capture').addEventListener('click',async()=>{
  snapshot=null;el('capture').disabled=true;el('preview').hidden=true;el('verified').checked=false;el('download').disabled=true;el('status').textContent='正在滚动读取历史，请保持面板打开…';
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('未找到当前标签页。');
    const result=await chrome.scripting.executeScript({target:{tabId:tab.id},func:captureChatPage});
    snapshot=result[0]?.result;if(!snapshot)throw new Error('页面未返回抓取结果。');
    el('count').textContent=`${snapshot.title} · ${snapshot.messages.length} 条消息 · ${snapshot.images.length} 个图片文件`;
    el('first').textContent=snapshot.messages[0].text;el('last').textContent=snapshot.messages.at(-1).text;el('preview').hidden=false;
    const missing=snapshot.images.filter(i=>i.error);el('status').textContent=missing.length?'无法完整导出图片：'+missing.map(i=>`${i.name}：${i.error}`).join('；'):'已读取文字和图片文件。请核对首尾消息后导出。';
  } catch(e){el('status').textContent=e.message;}
  finally{el('capture').disabled=false;}
});
el('verified').addEventListener('change',()=>{el('download').disabled=!el('verified').checked||!snapshot||snapshot.images.some(i=>i.error);});
el('download').addEventListener('click',async()=>{
  if(!snapshot||!el('verified').checked||snapshot.images.some(i=>i.error))return;
  const value={...snapshot,coverage:'page-text-user-verified'};
  const data=JSON.stringify(value,null,2);if(new TextEncoder().encode(data).length>144*1024*1024){el('status').textContent='记录超过 144 MiB，未导出。';return;}
  el('download').disabled=true;
  const objectUrl=URL.createObjectURL(new Blob([data],{type:'application/json'}));
  try{await chrome.downloads.download({url:objectUrl,filename:`SiYuanChatCaptures/chat-${snapshot.conversationId}-${Date.now()}.json`,saveAs:true});el('status').textContent='导出后，在桌面聊天中让思源插件导入这个 JSON 文件并保存原文或摘要。';}
  catch(e){el('status').textContent=e.message;}
  finally{setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);el('download').disabled=false;}
});
