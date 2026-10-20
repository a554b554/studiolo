import {api,post} from './api.js';
import {t,onLanguageChange} from './i18n.js';
// Hosts and their accounts: register an account on a host, sign it in (Claude subscription code,
// Claude API key, Codex device code, Codex API key), refresh its models, rename, sign out, remove.
// Everything runs on the host that owns the account; this page only relays through
// /api/hosts/<id>/accounts when that host is not the one serving the page.
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const FAMILY_LABEL={claude:'Claude Code',codex:'Codex'};
const AUTHS={claude:[['oauth','Claude 订阅登录'],['api_key','Anthropic API key']],codex:[['chatgpt','ChatGPT 登录'],['api_key','OpenAI API key']]};
export const authLabel=(family,auth)=>t((AUTHS[family]||[]).find(([id])=>id===auth)?.[1]||auth||'');
export const loginErrors={cli_missing:'未安装 CLI',login_unsupported:'此账号不支持网页登录',login_start_failed:'无法启动登录流程',login_code_invalid:'授权码不完整，请复制页面上的完整代码',login_expired:'登录会话已过期，请重新开始',login_busy:'登录流程正在进行',login_timeout:'验证超时，请重新开始',login_failed:'登录失败',api_key_invalid:'请输入有效的 API key',api_key_rejected:'API key 未被接受，请检查后重试',not_logged_in:'未登录',refresh_failed:'无法读取账号信息，请检查 CLI 是否可用',device_code_unsupported:'此 Codex 版本不支持设备码登录，请升级 Codex',account_not_found:'账号不存在'};

export function initAccounts({hosts,localHostId,onChange=()=>{}}){
  const dialog=el('dialog','accounts-dialog');dialog.id='accounts-dialog';
  const head=el('div','dialog-head'),heading=el('h2',''),hostSelect=el('select','accounts-host'),close=el('button','quiet','×');close.type='button';close.onclick=()=>dialog.close();
  hostSelect.setAttribute('aria-label',t('主机'));head.append(heading,hostSelect,close);
  const body=el('div','dialog-body accounts-body'),list=el('div','accounts-list'),addSection=el('section','accounts-add');
  body.append(list,addSection);dialog.append(head,body);document.body.append(dialog);
  dialog.onclick=event=>{if(event.target===dialog){const b=dialog.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)dialog.close();}};
  let hostId=localHostId,data=null,busy=false,error=null,focusAccount=null;
  const flows={};const pending=new Set();
  const base=()=>hostId===localHostId?'/api':`/api/hosts/${encodeURIComponent(hostId)}`;
  const hostName=()=>hosts().find(h=>h.id===hostId)?.name||hostId;
  const fail=e=>{error=t(loginErrors[e.message]||e.message||String(e));render();};
  async function load(){
    busy=true;error=null;render();
    try{data=await api(`${base()}/accounts`);}catch(e){data=null;error=t(loginErrors[e.message]||e.message);}
    finally{busy=false;render();}
  }
  const changed=()=>{onChange(hostId);return load();};
  async function act(key,fn){if(pending.has(key))return;pending.add(key);render();try{await fn();}catch(e){fail(e);}finally{pending.delete(key);render();}}
  // Sign-in flows by account id. Device-code flows are polled until the host reports the outcome.
  // Callers run this inside act('login:<id>') or act('create'); it must not take the 'login:<id>'
  // key itself, or the button's own act() would make it return before doing anything.
  async function startLogin(account,apiKey){
    const popup=account.auth==='oauth'?window.open('','_blank'):null;
    flows[account.id]={status:'starting'};render();
    try{
      const flow=await post(`${base()}/accounts/${encodeURIComponent(account.id)}/login`,apiKey!==undefined?{apiKey}:{});
      flows[account.id]={...flow,code:''};
      if(flow.kind==='oauth'&&popup&&!popup.closed){popup.opener=null;popup.location.href=flow.url;}else popup?.close();
      if(flow.status==='ok'){delete flows[account.id];await changed();return;}
      if(flow.kind==='device_code')poll(account.id,flow.id);
    }catch(e){popup?.close();flows[account.id]={status:'failed',error:e.message};}
  }
  async function poll(accountId,flowId){
    while(flows[accountId]?.id===flowId){
      await new Promise(r=>setTimeout(r,2500));
      if(flows[accountId]?.id!==flowId)return;
      try{const status=await api(`${base()}/accounts/${encodeURIComponent(accountId)}/login/${encodeURIComponent(flowId)}`);
        if(status.status==='ok'){delete flows[accountId];await changed();return;}
        Object.assign(flows[accountId],status);if(status.status==='failed'){render();return;}render();
      }catch(e){flows[accountId]={status:'failed',error:e.status===404?'login_expired':e.message};render();return;}
    }
  }
  async function submitCode(account){
    const state=flows[account.id];if(state?.status!=='waiting_code')return;
    state.status='verifying';state.error=null;render();
    try{
      const result=await post(`${base()}/accounts/${encodeURIComponent(account.id)}/login/${encodeURIComponent(state.id)}/code`,{code:state.code});
      if(result.status==='ok'){delete flows[account.id];await changed();return;}
      if(result.status==='waiting_code')Object.assign(state,{status:'waiting_code',error:result.error});
      else flows[account.id]={status:'failed',error:result.error,detail:result.detail};
    }catch(e){
      if(e.message==='login_code_invalid')Object.assign(state,{status:'waiting_code',error:e.message});
      else flows[account.id]={status:'failed',error:e.status===404?'login_expired':e.message};
    }
    render();
  }
  function cancelLogin(account){const state=flows[account.id];delete flows[account.id];if(state?.id)api(`${base()}/accounts/${encodeURIComponent(account.id)}/login/${encodeURIComponent(state.id)}`,{method:'DELETE'}).catch(()=>{});render();}
  function flowPanel(account){
    const state=flows[account.id],box=el('div','account-flow');
    if(!state)return null;
    if(state.status==='starting'){box.append(el('p','small muted',t('正在启动登录…')));return box;}
    if(state.status==='verifying'){box.append(el('p','small muted',t('正在验证并读取账号信息…')));return box;}
    if(state.status==='failed'){box.append(el('p','quota-error',t(loginErrors[state.error]||state.error||'登录失败')+(state.detail?` · ${state.detail}`:'')));const retry=el('button','quiet',t('重试'));retry.type='button';retry.onclick=()=>{delete flows[account.id];render();};box.append(retry);return box;}
    if(state.kind==='device_code'){
      const steps=el('ol','account-steps'),first=el('li',''),link=el('a','',t('打开登录页面'));link.href=state.url;link.target='_blank';link.rel='noopener noreferrer';first.append(link);
      const second=el('li','');second.append(document.createTextNode(t('输入一次性代码：')),el('code','account-code',state.userCode||''));
      steps.append(first,second,el('li','',t('完成登录后，这里会自动更新。')));
      const cancel=el('button','quiet',t('取消'));cancel.type='button';cancel.onclick=()=>cancelLogin(account);
      box.append(steps,cancel);return box;
    }
    // Claude subscription: open the sign-in page, paste the code shown afterwards.
    const verifying=state.status==='verifying',steps=el('ol','account-steps'),first=el('li',''),link=el('a','',t('打开 Claude 登录页面'));
    link.href=state.url;link.target='_blank';link.rel='noopener noreferrer';first.append(link);
    steps.append(first,el('li','',t('登录后，复制页面显示的授权码并粘贴到这里。')));
    const form=el('form','account-form'),input=el('input','');
    Object.assign(input,{type:'text',value:state.code||'',autocomplete:'off',spellcheck:false,disabled:verifying,placeholder:t('授权码')});input.setAttribute('aria-label',t('授权码'));input.dataset.authInput=account.id;
    input.oninput=()=>{state.code=input.value;};
    const submit=el('button','primary',t(verifying?'正在验证…':'提交'));submit.type='submit';submit.disabled=verifying;
    const cancel=el('button','quiet',t('取消'));cancel.type='button';cancel.disabled=verifying;cancel.onclick=()=>cancelLogin(account);
    form.onsubmit=event=>{event.preventDefault();void submitCode(account);};form.append(input,submit,cancel);
    box.append(steps,form);if(state.error)box.append(el('p','quota-error',t(loginErrors[state.error]||state.error)));
    return box;
  }
  function keyForm(account,{create=false}={}){
    const form=el('form','account-form'),input=el('input','');
    Object.assign(input,{type:'password',autocomplete:'off',spellcheck:false,placeholder:account.family==='claude'?'sk-ant-…':'sk-…'});input.setAttribute('aria-label','API key');
    const submit=el('button','primary',t(create?'保存并登录':'登录'));submit.type='submit';
    form.onsubmit=event=>{event.preventDefault();const key=input.value.trim();if(!key)return;input.value='';void act('login:'+account.id,()=>startLogin(account,key));};
    form.append(input,submit);
    const note=el('p','small muted',t('API key 只保存在该电脑的账号目录里，不会同步，也不会再显示。'));
    const wrap=el('div','account-flow');wrap.append(form,note);return wrap;
  }
  function accountRow(account){
    const card=el('section','account-card');card.dataset.accountId=account.id;
    const head=el('div','account-head'),title=el('div','account-title');
    title.append(el('strong','',account.label),el('span','badge',FAMILY_LABEL[account.family]||account.family),el('span','badge',authLabel(account.family,account.auth)));
    head.append(title);card.append(head);
    const identity=[account.identity?.email&&account.identity.email!==account.label?account.identity.email:null,account.identity?.plan||null].filter(Boolean).join(' · ');
    const signedIn=account.status==='signed_in';
    const status=el('p','small account-status',signedIn?t('已登录')+(identity?` · ${identity}`:''):account.error&&account.status!=='signed_out'?t(account.error):t('未登录'));
    if(!signedIn)status.classList.add('muted');card.append(status);
    const models=account.models?.length?t('{count} 个模型 · 读取于 {time}',{count:account.models.length,time:account.modelsCheckedAt?new Date(account.modelsCheckedAt).toLocaleString():'—'}):t('尚无模型列表');
    card.append(el('p','small muted',models+(account.models?.length?` · ${account.models.slice(0,6).map(m=>m.label||m.id).join(', ')}${account.models.length>6?' …':''}`:'')));
    if(account.lastError)card.append(el('p','quota-error',t(loginErrors[account.lastError]||account.lastError)));
    if(account.seed?.linked?.length||account.seed?.copied?.length)card.append(el('p','small muted',t('配置来自 {from}：复制 {copied}；链接 {linked}',{from:account.seed.from,copied:account.seed.copied.join(', ')||'—',linked:account.seed.linked.join(', ')||'—'})));
    const flow=flowPanel(account);
    if(flow)card.append(flow);
    else if(account.auth==='api_key'&&!signedIn)card.append(keyForm(account));
    const actions=el('div','account-actions'),key=k=>pending.has(k+':'+account.id);
    const button=(label,k,fn,className='quiet')=>{const b=el('button',className,t(label));b.type='button';b.disabled=key(k)||Boolean(flow);b.onclick=()=>act(k+':'+account.id,fn);actions.append(b);};
    if(account.auth!=='api_key')button(signedIn?'重新登录':'登录','login',()=>startLogin(account),signedIn?'quiet':'primary');
    button('刷新模型','refresh',async()=>{await post(`${base()}/accounts/${encodeURIComponent(account.id)}/refresh`);await changed();});
    button('重命名','rename',async()=>{const label=prompt(t('新的账号名称'),account.label);if(label===null||!label.trim()||label.trim()===account.label)return;await api(`${base()}/accounts/${encodeURIComponent(account.id)}`,{method:'PATCH',body:{label:label.trim()}});await changed();});
    if(signedIn)button('退出登录','logout',async()=>{if(!confirm(t('退出登录后，使用该账号的对话需要重新登录才能继续。确认退出 {name}？',{name:account.label})))return;await post(`${base()}/accounts/${encodeURIComponent(account.id)}/logout`);await changed();});
    button('移除','remove',async()=>{if(!confirm(t('移除账号会删除它在该电脑上的登录信息和目录；绑定它的对话可改用其他账号继续。确认移除 {name}？',{name:account.label})))return;await api(`${base()}/accounts/${encodeURIComponent(account.id)}`,{method:'DELETE'});await changed();},'quiet danger');
    card.append(actions);
    return card;
  }
  function addForm(){
    addSection.replaceChildren(el('h3','',t('添加账号')));
    const form=el('form','account-add-form'),family=el('select',''),auth=el('select',''),label=el('input',''),keyInput=el('input','');
    for(const [id,name] of Object.entries(FAMILY_LABEL))family.add(new Option(name,id));
    const fillAuth=()=>{auth.replaceChildren();for(const [id,name] of AUTHS[family.value])auth.add(new Option(t(name),id));keyWrap.hidden=auth.value!=='api_key';};
    family.onchange=fillAuth;auth.onchange=()=>{keyWrap.hidden=auth.value!=='api_key';};
    Object.assign(label,{placeholder:t('名称（可选，例如 Claude 工作）'),maxLength:60});label.setAttribute('aria-label',t('名称'));
    Object.assign(keyInput,{type:'password',autocomplete:'off',spellcheck:false,placeholder:'API key'});keyInput.setAttribute('aria-label','API key');
    const keyWrap=el('label','account-key');keyWrap.append(el('span','','API key'),keyInput);
    const wrap=(text,control)=>{const l=el('label','');l.append(el('span','',t(text)),control);return l;};
    const submit=el('button','primary',t('添加并登录'));submit.type='submit';
    form.append(wrap('类型',family),wrap('登录方式',auth),wrap('名称',label),keyWrap,submit);fillAuth();
    form.onsubmit=event=>{
      event.preventDefault();
      const payload={family:family.value,auth:auth.value,label:label.value.trim()},apiKey=auth.value==='api_key'?keyInput.value.trim():undefined;
      if(auth.value==='api_key'&&!apiKey){keyInput.focus();return;}
      void act('create',async()=>{
        const account=await post(`${base()}/accounts`,payload);
        label.value='';keyInput.value='';focusAccount=account.id;await changed();
        await startLogin(account,apiKey);
      });
    };
    const note=el('p','small muted',t('账号属于所选电脑：登录信息保存在那台电脑的 ~/.studio-local/accounts/ 下，与本机 ~/.claude、~/.codex 分开；skills、插件和设置会从默认目录继承。'));
    addSection.append(form,note);
  }
  function render(){
    heading.textContent=t('主机与账号');
    const current=hostSelect.value;hostSelect.replaceChildren();
    for(const h of hosts())hostSelect.add(new Option(`${h.name||h.id}${h.local?t('（本机）'):''}`,h.id));
    if(!Array.from(hostSelect.options).some(o=>o.value===hostId))hostId=localHostId;
    hostSelect.value=hostId;if(current!==hostId&&current)hostSelect.value=hostId;
    list.replaceChildren();
    list.append(el('p','small muted',t('{host} 上的账号。每台电脑单独登录；对话发送时先选电脑，再选该电脑上的账号。',{host:hostName()})));
    if(error)list.append(el('p','quota-error',error));
    if(busy&&!data)list.append(el('p','muted',t('正在读取…')));
    for(const account of data?.accounts||[])list.append(accountRow(account));
    if(data&&!data.accounts.length)list.append(el('p','muted',t('这台电脑还没有账号。')));
    if(!addSection.childNodes.length)addForm();
    if(focusAccount){list.querySelector(`[data-account-id="${CSS.escape(focusAccount)}"]`)?.scrollIntoView({block:'nearest'});focusAccount=null;}
  }
  hostSelect.onchange=()=>{hostId=hostSelect.value;data=null;void load();};
  onLanguageChange(()=>{addSection.replaceChildren();render();});
  return {
    open(target=hostId,accountId=null){hostId=target||localHostId;focusAccount=accountId;data=null;render();dialog.showModal();void load();},
    refresh(){if(dialog.open)void load();},
    dialog,
  };
}
