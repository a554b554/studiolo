import { t, onLanguageChange } from './i18n.js';
export function category(item) { return item?.deletedAt ? 'deleted' : item?.archivedAt ? 'archived' : 'active'; }
export function visibleItems(items, mode = 'active') { return (items || []).filter(item=>category(item)===mode); }

let closeMenu;
onLanguageChange(()=>closeMenu?.());
export function moreButton(label, actions) {
  const trigger=document.createElement('button');trigger.type='button';trigger.className='more-button';trigger.textContent='⋯';
  trigger.setAttribute('aria-label',t('{label}的更多操作',{label}));trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
  trigger.addEventListener('click',()=>{
    const wasOpen=trigger.getAttribute('aria-expanded')==='true';closeMenu?.();if(wasOpen)return;
    const menu=document.createElement('div');menu.className='context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',t('{label}操作',{label}));
    const cleanup=()=>{menu.remove();trigger.setAttribute('aria-expanded','false');document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keyboard);window.removeEventListener('resize',cleanup);closeMenu=null;};
    const outside=e=>{if(!menu.contains(e.target)&&!trigger.contains(e.target))cleanup();};
    const keyboard=e=>{
      const buttons=[...menu.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);
      if(e.key==='Escape'){e.preventDefault();cleanup();trigger.focus();}
      else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}
      else if(e.key==='Tab')cleanup();
    };
    for(const action of actions){const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=action.label;if(action.danger){button.className='danger';button.title=t('删除后无法在平台恢复');}button.onclick=()=>{cleanup();trigger.focus();action.run();};menu.append(button);}
    document.body.append(menu);const rect=trigger.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(rect.right-menu.offsetWidth,innerWidth-menu.offsetWidth-8))}px`;menu.style.top=`${Math.max(8,Math.min(rect.bottom+4,innerHeight-menu.offsetHeight-8))}px`;
    trigger.setAttribute('aria-expanded','true');menu.querySelector('button')?.focus();closeMenu=cleanup;
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',keyboard);window.addEventListener('resize',cleanup);
  });return trigger;
}
