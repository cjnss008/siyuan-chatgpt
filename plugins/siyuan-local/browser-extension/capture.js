// Injected into the active tab. Reads the DOM and downloads only message image URLs.
export async function captureChatPage(options={}) {
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,options.pollMs??ms));
  const start=Date.now(),maxMs=options.maxMs??90000;
  const url=new URL(location.href);
  if(url.protocol!=='https:'||!['chatgpt.com','chat.openai.com'].includes(url.hostname))throw new Error('请打开当前 ChatGPT 网页对话后再抓取。');
  const conversationId=url.pathname.match(/\/c\/([a-zA-Z0-9_-]{8,100})(?:\/|$)/)?.[1];
  if(!conversationId)throw new Error('请打开已保存的具体对话；暂不支持临时聊天或首页。');
  const main=document.querySelector('main');if(!main)throw new Error('未找到聊天正文。');
  if(document.querySelector('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="停止生成"]'))throw new Error('当前回复仍在生成，请等待完成后抓取。');
  const initial=main.querySelector('[data-message-author-role="user"], [data-message-author-role="assistant"]');
  if(!initial)throw new Error('当前页面没有可读取的聊天消息。');
  let scroller=initial.parentElement;
  while(scroller&&!(scroller.scrollHeight>scroller.clientHeight+20&&/auto|scroll/.test(getComputedStyle(scroller).overflowY)))scroller=scroller.parentElement;
  scroller??=document.scrollingElement;
  const savedTop=scroller.scrollTop,messages=new Map(),warnings=new Set(),images=[],imageCache=new Map();let imageBytes=0;
  const guard=()=>{if(location.href!==url.href)throw new Error('抓取期间切换了对话，已停止。');if(Date.now()-start>maxMs)throw new Error('抓取超时；未导出不完整记录。请加载历史后重试。');};
  const captureImage=async img=>{
    const link=img.closest('a'),href=link?.href;
    const source=href&&(/\.(png|jpe?g|gif|webp|bmp|tiff?|avif)(?:[?#]|$)/i.test(href)||link.hasAttribute('download'))?href:(img.getAttribute('src')||img.currentSrc||'');
    if(imageCache.has(source))return imageCache.get(source);
    if(imageCache.size>=200)throw new Error('图片引用超过 200 个；未截断。');
    let image;
    try {
      guard();if(!source)throw new Error('页面缺少图片地址。');
      const u=new URL(source,location.href);if(!['https:','blob:','data:'].includes(u.protocol)||u.username||u.password)throw new Error('页面图片地址无效。');
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);let bytes;
      try {
        const r=await fetch(u.href,{credentials:u.origin===url.origin?'same-origin':'omit',signal:controller.signal,redirect:'error'});
        if(!r.ok)throw new Error('图片链接已失效或无法从页面下载。');
        if(Number(r.headers.get('content-length'))>20*1024*1024)throw new Error('图片超过 20 MiB。');
        const reader=r.body.getReader(),chunks=[];let size=0;
        while(true){guard();const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>20*1024*1024){await reader.cancel();throw new Error('图片超过 20 MiB。');}chunks.push(value);}
        bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      } finally{clearTimeout(timer);}
      if(!bytes.length)throw new Error('图片为空。');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
      const existing=images.find(i=>i.id===digest);if(existing){imageCache.set(source,digest);return digest;}
      if(imageBytes+bytes.length>100*1024*1024)throw new Error('图片总量超过 100 MiB。');
      // Byte chunks avoid spreading a large image into the JavaScript call stack.
      let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
      image={id:digest,name:img.getAttribute('alt')||'网页图片',base64:btoa(binary),bytes:bytes.length};imageBytes+=bytes.length;
    } catch(e){image={id:`missing-${images.length}`,name:img.getAttribute('alt')||'网页图片',error:e.name==='AbortError'?'图片下载超时。':e.message};}
    images.push(image);imageCache.set(source,image.id);return image.id;
  };
  const collect=async()=>{
    guard();
    for(const node of main.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')) {
      if(node.closest('[aria-hidden="true"]'))continue;
      const role=node.getAttribute('data-message-author-role');
      const turn=node.closest('[data-testid^="conversation-turn-"]');
      const orderValue=turn?.getAttribute('data-testid')?.match(/conversation-turn-(\d+)$/)?.[1];
      const order=orderValue===undefined?NaN:Number(orderValue);
      if(!Number.isSafeInteger(order))throw new Error('网页结构已变化，无法核对消息顺序；未导出。');
      const messageId=node.getAttribute('data-message-id')??`${conversationId}-${order}-${role}`;
      const content=node.querySelector('.markdown, .whitespace-pre-wrap')??node;
      const text=content.innerText;
      if(typeof text!=='string')throw new Error('消息正文无法读取。');
      const attachments=[];
      for(const img of node.querySelectorAll('img')) {
        if(img.closest('[aria-hidden="true"]')||/avatar|头像/i.test(img.getAttribute('alt')??''))continue;
        attachments.push({type:'image',name:img.getAttribute('alt')??'',imageId:await captureImage(img)});
      }
      messages.set(messageId,{id:messageId,role,text,attachments,order});
    }
    if(Array.from(messages.values()).reduce((n,m)=>n+m.text.length,0)>4000000)throw new Error('当前聊天过大；请分段导出。');
  };
  const stableBoundary=async bottom=>{
    let stable=0,last='';
    while(stable<4) {
      guard();scroller.scrollTop=bottom?scroller.scrollHeight:0;await wait(750);await collect();
      const fingerprint=JSON.stringify([messages.size,scroller.scrollHeight,Array.from(messages.keys()).sort()]);
      const reached=bottom?Math.abs(scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop)<5:scroller.scrollTop<5;
      stable=reached&&fingerprint===last?stable+1:0;last=fingerprint;
    }
  };
  try {
    await collect();await stableBoundary(false);
    while(scroller.scrollTop+scroller.clientHeight<scroller.scrollHeight-5) {
      guard();await collect();const before=scroller.scrollTop;scroller.scrollTop+=Math.max(100,Math.floor(scroller.clientHeight*0.65));await wait(250);await collect();
      if(scroller.scrollTop===before)throw new Error('无法滚动聊天正文，未导出。');
    }
    await stableBoundary(true);guard();await collect();
    if(document.querySelector('[data-testid="stop-button"],button[aria-label="Stop generating"],button[aria-label="停止生成"]'))throw new Error('抓取期间开始生成新回复，请等待完成后重试。');
    const sorted=Array.from(messages.values()).sort((a,b)=>a.order-b.order);
    const orders=[...new Set(sorted.map(m=>m.order))];
    if(orders.some((n,i)=>i>0&&n!==orders[i-1]+1))throw new Error('发现缺失的聊天轮次；未导出。请加载完整历史后重试。');
    if(sorted[0]?.role!=='user')throw new Error('首条不是用户消息，可能尚未加载完整历史。');
    warnings.add('抓取当前选中分支的页面文字；网页排版、折叠内容、工具详情和其他分支不属于文字原文。');
    if(images.length)warnings.add('网页图片保存页面可下载的文件；若页面只提供缩略图，无法保证原始分辨率。');
    return {schema:'siyuan-chat-capture/v1',source:'chatgpt-web',conversationId,title:document.title.replace(/\s*[-–]\s*ChatGPT\s*$/,''),capturedAt:new Date().toISOString(),coverage:'page-text-unverified',imageCoverage:'original-files',images,messages:sorted.map(({order,...m})=>m),warnings:[...warnings]};
  } finally {scroller.scrollTop=savedTop;}
}
