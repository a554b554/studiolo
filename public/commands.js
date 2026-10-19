import {t} from './i18n.js';
// Slash commands in the composer. Platform commands run in the browser or the queue; native
// ones come from the connected CLI (Claude lists its own; Codex has the fixed set below).
export const platformCommands=()=>[
  {name:'help',description:t('显示可用命令')},
  {name:'stop',description:t('停止当前执行，保留原生会话')},
  {name:'clear',description:t('清空上下文，下一条消息开始新的原生会话')},
  {name:'model',hint:t('<模型>'),description:t('切换下一条消息使用的模型')},
  {name:'effort',hint:'<low|medium|high|xhigh|max>',description:t('切换 reasoning effort')},
  {name:'mode',hint:'<auto|cli|plan|write>',description:t('切换执行权限')},
  {name:'rename',hint:t('<标题>'),description:t('重命名当前对话')},
  {name:'new',description:t('在当前项目新建对话')},
  {name:'status',description:t('显示原生会话状态')},
];
export const codexCommands=()=>[
  {name:'compact',description:t('压缩当前对话上下文')},
  {name:'review',hint:'[base <branch> | commit <sha> | <instructions>]',description:t('审查当前改动')},
  {name:'skills',description:t('列出可用 skills')},
  {name:'mcp',description:t('列出 MCP 服务器状态')},
];
// Same rule as the server: "/name args" at the start; a path such as /usr/bin is not a command.
export function parseSlash(text){
  const match=/^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*))?$/.exec(String(text??'').trim());
  return match?{name:match[1].toLowerCase(),args:(match[2]||'').trim()}:null;
}
export function mergeCommands(platform,native=[]){
  const seen=new Set(platform.map(c=>c.name));
  return [...platform,...native.filter(c=>c&&typeof c.name==='string'&&!seen.has(c.name))];
}
// Autocomplete popup bound to a textarea. `commands()` returns the current list.
export function createSlashMenu({textarea,menu,commands,onSubmit}){
  let items=[],selected=0,forced=false;
  const typed=()=>/^\/([\w:-]*)$/.exec(textarea.value);
  const hide=()=>{menu.hidden=true;menu.replaceChildren();items=[];forced=false;};
  const complete=(command,{submit=true}={})=>{
    textarea.value=`/${command.name}${command.hint?' ':''}`;
    // The input event keeps the draft in sync; it reopens the list, so hide afterwards.
    textarea.dispatchEvent(new Event('input',{bubbles:true}));hide();textarea.focus();
    textarea.setSelectionRange(textarea.value.length,textarea.value.length);
    if(submit&&!command.hint)onSubmit();
  };
  const render=()=>{
    menu.replaceChildren();
    items.forEach((command,index)=>{
      const row=document.createElement('div');row.className='slash-item';row.setAttribute('role','option');row.setAttribute('aria-selected',String(index===selected));
      const name=document.createElement('span');name.className='slash-name';name.textContent=`/${command.name}${command.hint?' '+command.hint:''}`;
      const description=document.createElement('span');description.className='slash-description';description.textContent=command.description||'';
      row.append(name,description);
      row.addEventListener('mousedown',event=>{event.preventDefault();complete(command);});
      menu.append(row);
    });
    menu.hidden=!items.length;
    menu.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});
  };
  const update=()=>{
    const match=typed();
    if(!match&&!forced)return hide();
    const prefix=match?match[1].toLowerCase():'';
    items=commands().filter(c=>c.name.toLowerCase().startsWith(prefix)).slice(0,14);
    if(!items.length)return hide();
    selected=Math.min(selected,items.length-1);render();
  };
  // Keyboard handling while the popup is open; returns true when the key was consumed.
  const handleKey=event=>{
    if(menu.hidden)return false;
    if(event.key==='ArrowDown'){selected=(selected+1)%items.length;render();return true;}
    if(event.key==='ArrowUp'){selected=(selected-1+items.length)%items.length;render();return true;}
    if(event.key==='Tab'){complete(items[selected],{submit:false});return true;}
    if(event.key==='Enter'&&!event.shiftKey){complete(items[selected]);return true;}
    if(event.key==='Escape'){hide();return true;}
    return false;
  };
  const showAll=()=>{forced=true;selected=0;update();};
  textarea.addEventListener('input',()=>{forced=false;selected=0;update();});
  textarea.addEventListener('blur',()=>setTimeout(hide,120));
  return {update,hide,handleKey,showAll,isOpen:()=>!menu.hidden};
}
