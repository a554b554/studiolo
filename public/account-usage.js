import {api} from './api.js';
import {t,getLanguage,onLanguageChange} from './i18n.js';
import {authLabel,loginErrors} from './accounts.js';
// Quota panel in the sidebar: the accounts of one host (the host chosen in the composer, or any
// host picked here) with their remaining quota. Sign-in and management live in accounts.js.
const el=(tag,className,text)=>{const node=document.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
const percent=value=>`${Math.round(value*10)/10}%`;
const errors={cli_missing:'未安装 CLI',quota_unavailable:'此账号未提供额度',not_logged_in:'未登录',quota_read_failed:'读取失败，请检查登录和网络后重试'};
const date=value=>value?new Date(value).toLocaleString(getLanguage(),{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):t('尚未开始计时');
function bar(row,label){
  const value=row?.remainingPercent;
  if(value===null||value===undefined){const track=el('div','quota-meter quota-unknown');track.setAttribute('aria-label',`${label} · ${t('暂无额度数据')}`);return track;}
  const meter=el('div','quota-meter');meter.setAttribute('role','progressbar');meter.setAttribute('aria-label',`${label} · ${t('剩余额度')}`);meter.setAttribute('aria-valuemin','0');meter.setAttribute('aria-valuemax','100');meter.setAttribute('aria-valuenow',String(value));
  if(value<=10)meter.classList.add('quota-low');else if(value<=25)meter.classList.add('quota-warning');
  const fill=el('span','quota-fill');fill.style.width=`${value}%`;meter.append(fill);return meter;
}
const period=row=>row?.windowDurationMins===10080?t('周额度'):row?.windowDurationMins===300?t('五小时额度'):row?.windowDurationMins?t('{hours} 小时额度',{hours:Math.round(row.windowDurationMins/60*10)/10}):t('其他额度');

export function initAccountUsage({hosts=()=>[],localHostId,openAccounts=()=>{}}={}){
  const root=document.querySelector('#account-usage');if(!root)return {setHost(){},reload(){}};
  let hostId=localHostId,data=null,busy=false,failed=false,generation=0;
  const head=el('div','quota-head'),title=el('h2',''),hostSelect=el('select','quota-host'),refresh=el('button','quiet quota-refresh','↻');refresh.type='button';
  hostSelect.setAttribute('aria-label',t('执行电脑'));head.append(title,hostSelect,refresh);
  const rows=el('div','quota-rows'),foot=el('div','quota-footer'),updated=el('span','quota-updated'),manage=el('button','quiet quota-manage'),details=el('button','quiet quota-details');manage.type=details.type='button';foot.append(updated,manage,details);root.append(head,rows,foot);
  const dialog=el('dialog','quota-dialog');dialog.id='usage-dialog';dialog.setAttribute('aria-labelledby','usage-heading');
  const dialogHead=el('div','dialog-head'),heading=el('h2',''),close=el('button','quiet','×');heading.id='usage-heading';close.type='button';
  const dialogRefresh=el('button','quiet quota-refresh','↻');dialogRefresh.type='button';dialogHead.append(heading,dialogRefresh,close);
  const content=el('div','dialog-body quota-dialog-body');dialog.append(dialogHead,content);document.body.append(dialog);
  close.onclick=()=>dialog.close();dialog.onclick=event=>{if(event.target===dialog){const b=dialog.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)dialog.close();}};
  details.onclick=()=>{renderDetails();dialog.showModal();};refresh.onclick=dialogRefresh.onclick=()=>load(true);
  manage.onclick=()=>{dialog.close();openAccounts(hostId);};
  const hostName=()=>hosts().find(h=>h.id===hostId)?.name||data?.hostName||hostId;
  const signIn=account=>{dialog.close();openAccounts(hostId,account.id);};
  function renderDetails(){
    content.replaceChildren();
    content.append(el('p','quota-machine',t('{host} 上的账号',{host:hostName()})),el('p','small muted',t('显示账号整体额度，包含在其他聊天和设备上的使用。进度条表示剩余。')));
    if(failed)content.append(el('p','quota-error',t('读取失败，请检查登录和网络后重试')));
    if(!data){content.append(el('p','muted',t(busy?'正在读取额度…':'暂无额度数据')));return;}
    if(!data.accounts.length)content.append(el('p','muted',t('这台电脑还没有账号。')));
    for(const account of data.accounts){
      const card=el('section','quota-account'),header=el('div','quota-account-head');header.append(el('h3','',account.label),el('span','quota-plan',account.plan||account.identity?.plan||authLabel(account.family,account.auth)));card.append(header);
      if(account.identity?.email)card.append(el('p','small muted',account.identity.email));
      if(account.status!=='ok')card.append(el('p','quota-error',t(errors[account.error]||loginErrors[account.error]||'暂无额度数据')));
      if(account.status==='stale')card.append(el('p','small muted',t('上次成功读取：{time}',{time:date(account.updatedAt)})));
      if(!account.windows?.length&&account.status==='ok')card.append(el('p','muted',account.auth==='api_key'?t('API 账号按用量计费，没有额度窗口。'):t('暂无额度数据')));
      for(const row of account.windows||[]){
        const item=el('div','quota-window'),line=el('div','quota-line');
        const label=account.family==='codex'||row.id.startsWith('scoped_')?`${row.label} · ${period(row)}`:t(row.label);
        line.append(el('strong','',label),el('span','',row.remainingPercent===null?'—':t('剩余 {percent}',{percent:percent(row.remainingPercent)})));item.append(line,bar(row,label));
        item.append(el('p','small muted',`${t('已用 {percent}',{percent:row.usedPercent===null?'—':percent(row.usedPercent)})} · ${t('重置：{time}',{time:date(row.resetsAt)})}`));
        if(row.remainingDollars!==null&&row.remainingDollars!==undefined)item.append(el('p','small muted',t('剩余金额：{amount}',{amount:`USD ${row.remainingDollars} / ${row.limitDollars??'—'}`})));
        card.append(item);
      }
      const credits=account.credits;
      if(credits){
        const section=el('div','quota-extra');section.append(el('strong','',t('额外额度')));
        if(credits.balance!==undefined)section.append(el('p','',credits.unlimited?t('不限额'):t('余额：{amount}',{amount:credits.balance===null?'—':`${Number.isFinite(Number(credits.balance))?Number(credits.balance).toLocaleString(getLanguage(),{maximumFractionDigits:2}):credits.balance} credits`})));
        else{section.append(el('p','',t(credits.enabled?'已启用':'未启用')));if(credits.used!==null&&credits.used!==undefined)section.append(el('p','',t('已用 {used} / 上限 {limit}',{used:`${credits.currency||''} ${credits.used.toFixed(2)}`,limit:credits.limit===null?'—':`${credits.currency||''} ${credits.limit.toFixed(2)}`})));}
        card.append(section);
      }
      if(account.resetCredits){card.append(el('p','quota-extra',t('可用额度重置：{count} 次',{count:account.resetCredits.availableCount??'—'})));for(const credit of account.resetCredits.items||[])card.append(el('p','small muted',`${credit.title||t('额度重置')} · ${t(credit.status==='available'?'可用':credit.status||'未知')} · ${t('到期：{time}',{time:date(credit.expiresAt)})}`));}
      if(account.updatedAt&&account.status==='ok')card.append(el('p','small muted',t('更新时间：{time}',{time:date(account.updatedAt)})));
      if(account.error==='not_logged_in'||account.status==='unavailable'){const button=el('button','primary',t('登录'));button.type='button';button.onclick=()=>signIn(account);card.append(button);}
      content.append(card);
    }
  }
  function render(){
    title.textContent=t('账号额度');heading.textContent=t('Usage 详情');details.textContent=t('详细 Usage');manage.textContent=t('管理账号');close.setAttribute('aria-label',t('关闭'));
    const current=hostSelect.value;hostSelect.replaceChildren();
    for(const h of hosts())hostSelect.add(new Option(h.name||h.id,h.id));
    if(Array.from(hostSelect.options).some(o=>o.value===hostId))hostSelect.value=hostId;else if(current)hostSelect.value=current;
    hostSelect.hidden=hostSelect.options.length<2;
    for(const button of [refresh,dialogRefresh]){button.disabled=busy;button.classList.toggle('is-refreshing',busy);button.title=button.ariaLabel=t('刷新额度');}
    root.setAttribute('aria-busy',String(busy));rows.replaceChildren();
    if(!data)rows.append(el('p','small muted',t(busy?'正在读取额度…':failed?'读取失败，请检查登录和网络后重试':'暂无额度数据')));
    if(data&&!data.accounts.length){const button=el('button','quota-row quota-empty');button.type='button';button.append(el('span','',t('{host} 还没有账号，点击添加',{host:hostName()})));button.onclick=()=>openAccounts(hostId);rows.append(button);}
    for(const account of data?.accounts||[]){
      const row=el('button','quota-row');row.type='button';
      const signedOut=account.error==='not_logged_in';
      row.onclick=()=>{if(signedOut)signIn(account);else{renderDetails();dialog.showModal();}};
      const line=el('div','quota-line'),value=account.summary?.remainingPercent;
      line.append(el('strong','',account.label),el('span','quota-value',value===null||value===undefined?'—':percent(value)));row.append(line,bar(account.summary,account.label));
      const kind=account.auth==='api_key'?'API':t(account.summaryWindow==='five_hour'?'五小时额度':'周额度');
      row.append(el('span','quota-caption',`${kind} · ${t(signedOut?'未登录 · 点击登录':account.status==='stale'?'上次数据':account.status==='unavailable'?'暂不可用':value===null||value===undefined?(account.auth==='api_key'?'按用量计费':'暂无额度数据'):'剩余')}`));
      rows.append(row);
    }
    updated.textContent=busy?t('刷新中…'):failed?t('刷新失败'):data?t('读取于 {time}',{time:date(data.checkedAt)}):'';
    if(dialog.open)renderDetails();
  }
  async function load(refresh=false){
    if(busy)return;busy=true;render();const version=++generation,target=hostId;
    const url=target===localHostId?'/api/account-usage':`/api/hosts/${encodeURIComponent(target)}/account-usage`;
    try{const result=await api(`${url}${refresh?'?refresh=1':''}`);if(version!==generation)return;data=result;failed=false;}
    catch{if(version!==generation)return;failed=true;}
    finally{if(version===generation){busy=false;render();}}
  }
  hostSelect.onchange=()=>{hostId=hostSelect.value;data=null;failed=false;generation++;busy=false;void load();};
  onLanguageChange(render);void load();
  return {
    // Follow the composer: the panel shows the accounts of the machine a message would run on.
    setHost(id){if(!id||id===hostId||!hosts().some(h=>h.id===id))return;hostId=id;data=null;failed=false;generation++;busy=false;void load();},
    reload(){generation++;busy=false;void load(true);},
  };
}
