import { t, onLanguageChange } from './i18n.js';
export function category(item) { return item?.deletedAt ? 'deleted' : item?.archivedAt ? 'archived' : 'active'; }
export function visibleItems(items, mode = 'active') { return (items || []).filter(item=>category(item)===mode); }

let closeMenu;
onLanguageChange(()=>closeMenu?.());
// One menu at a time, placed by `place(menu)`; focus returns to `owner`. An action may be disabled,
// with `hint` saying why. A pointer press on `toggle` is left to its own click handler.
function openMenu(label, actions, place, {owner, toggle, onClose}={}) {
  closeMenu?.();
  const menu=document.createElement('div');menu.className='context-menu';menu.tabIndex=-1;menu.setAttribute('role','menu');menu.setAttribute('aria-label',t('{label}操作',{label}));
  const cleanup=()=>{menu.remove();document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',keyboard);window.removeEventListener('resize',cleanup);window.removeEventListener('blur',cleanup);closeMenu=null;onClose?.();};
  const outside=e=>{if(!menu.contains(e.target)&&!toggle?.contains(e.target))cleanup();};
  const keyboard=e=>{
    const buttons=[...menu.querySelectorAll('button:not(:disabled)')],index=buttons.indexOf(document.activeElement);
    if(e.key==='Escape'){e.preventDefault();cleanup();owner?.focus();}
    else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}
    else if(e.key==='Tab')cleanup();
  };
  for(const action of actions){const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.textContent=action.label;if(action.danger){button.className='danger';button.title=t('删除后无法在平台恢复');}if(action.disabled){button.disabled=true;if(action.hint)button.title=action.hint;}button.onclick=()=>{cleanup();owner?.focus();action.run();};menu.append(button);}
  document.body.append(menu);place(menu);
  (menu.querySelector('button:not(:disabled)')||menu).focus();closeMenu=cleanup;
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',keyboard);window.addEventListener('resize',cleanup);window.addEventListener('blur',cleanup);
}
export function moreButton(label, actions) {
  const trigger=document.createElement('button');trigger.type='button';trigger.className='more-button';trigger.textContent='⋯';
  trigger.setAttribute('aria-label',t('{label}的更多操作',{label}));trigger.setAttribute('aria-haspopup','menu');trigger.setAttribute('aria-expanded','false');
  trigger.addEventListener('click',()=>{
    const wasOpen=trigger.getAttribute('aria-expanded')==='true';closeMenu?.();if(wasOpen)return;
    openMenu(label,actions,menu=>{const rect=trigger.getBoundingClientRect();menu.style.left=`${Math.max(8,Math.min(rect.right-menu.offsetWidth,innerWidth-menu.offsetWidth-8))}px`;menu.style.top=`${Math.max(8,Math.min(rect.bottom+4,innerHeight-menu.offsetHeight-8))}px`;},{owner:trigger,toggle:trigger,onClose:()=>trigger.setAttribute('aria-expanded','false')});
    trigger.setAttribute('aria-expanded','true');
  });return trigger;
}
// A right-click menu at the pointer; from the keyboard (Shift+F10, the menu key) under the element.
export function contextMenu(event, label, actions) {
  event.preventDefault();const owner=event.currentTarget,rect=owner.getBoundingClientRect(),keyboard=!event.clientX&&!event.clientY;
  const x=keyboard?rect.left+12:event.clientX,y=keyboard?rect.bottom:event.clientY;
  openMenu(label,actions,menu=>{menu.style.left=`${Math.max(8,Math.min(x,innerWidth-menu.offsetWidth-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,innerHeight-menu.offsetHeight-8))}px`;},{owner});
}
