// Keep host forms small: a long transcript can hide the host's approval controls.
export class HostRequests {
  constructor(send,{timeout=60000}={}) {this.send=send;this.timeout=timeout;this.seq=0;this.pending=new Map();}
  request(method,params,{signal}={}) {
    if(signal?.aborted)return Promise.reject(new Error('请求已取消，本次未写入。'));
    const id=`siyuan-${++this.seq}`;
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.pending.delete(id);};
      const fail=error=>{cleanup();reject(error);};
      const abort=()=>fail(new Error('请求已取消，本次未写入。'));
      const timer=setTimeout(()=>fail(new Error('宿主确认界面等待超时，本次未写入。请重新准备预览并使用独立窗口（confirmationUi=native）。')),this.timeout);
      this.pending.set(id,{resolve:value=>{cleanup();resolve(value);},fail});
      signal?.addEventListener('abort',abort,{once:true});
      try {this.send({id,method,params});}catch(error){fail(error);}
    });
  }
  settle(response) {
    const p=this.pending.get(response.id);if(!p)return false;
    if(response.error)p.fail(new Error('确认界面失败，本次未写入。'));else p.resolve(response.result);
    return true;
  }
  close() {for(const p of [...this.pending.values()])p.fail(new Error('连接关闭，本次未写入。'));}
}

export function createConfirmation({nativeConfirm,request,getCapabilities}) {
  return async(message,{ui='native',summary,signal}={})=>{
    // This Windows-local plugin owns a scrollable native dialog with fixed buttons.
    // Do not trust advertised form support as proof the host can render long forms.
    if(ui==='native')return nativeConfirm(message,{signal});
    const el=getCapabilities().elicitation;
    if(!el || !(el.form || Object.keys(el).length===0))throw new Error('宿主不支持确认表单；请重新准备并使用独立窗口。');
    if(typeof summary!=='string'||summary.length>2000)throw new Error('确认摘要无效，本次未写入。');
    const r=await request('elicitation/create',{mode:'form',message:summary,requestedSchema:{type:'object',properties:{confirm:{type:'boolean',title:'我已核对目标和写入内容，确认写入',default:false}},required:['confirm']}},{signal});
    // Decline, cancellation and timeout never launch a second dialog or approve.
    return r?.action==='accept' && r.content?.confirm===true;
  };
}
