import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {t,setLanguage,getLanguage} from '../public/i18n.js';
import {english} from '../public/translations.js';
import {conversationItems,agentLabel} from '../public/conversation.js';

test('interface language changes labels but preserves opaque message content and template parameters',()=>{
 const messages=[{id:'u',role:'user',text:'设置 {count} <h1>中文</h1>'},{id:'a',role:'assistant',text:'已完成',profileId:'claude',model:'claude-fable-5-1'}];
 const snapshot=structuredClone(messages);
 setLanguage('en',false);
 assert.equal(t('设置'),'Settings');assert.equal(t('回复：{text}',{text:messages[0].text}),'Reply: '+messages[0].text);
 assert.equal(t('constructor'),'constructor');assert.equal(t('unknown label'),'unknown label');
 assert.equal(t('{count} 个文件夹',{count:2}),'2 folders');
 const projected=conversationItems(messages);
 assert.deepEqual(projected.filter(x=>x.kind==='message').map(x=>x.message.text),messages.map(x=>x.text));
 assert.deepEqual(messages,snapshot);assert.match(agentLabel(messages[1]),/Fable 5.1.*CLI default/);
 setLanguage('zh-CN',false);assert.equal(t('设置'),'设置');assert.match(agentLabel(messages[1]),/CLI 默认/);
 setLanguage('unsupported',false);assert.equal(getLanguage(),'zh-CN');
});
test('translation templates preserve all parameter names',()=>{
 const slots=s=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();
 for(const [zh,en] of Object.entries(english))assert.deepEqual(slots(en),slots(zh),zh);
});
test('both interface shells have language settings and all marked labels have translations',async()=>{
 for(const file of ['index.html','artifact.html']){
  const html=await fs.readFile(new URL('../public/'+file,import.meta.url),'utf8');
  assert.match(html,/data-language-picker/);
  for(const match of html.matchAll(/data-i18n(?:-[\w-]+)?="([^"]+)"/g))assert.ok(english[match[1]],match[1]);
 }
 const i18n=await fs.readFile(new URL('../public/i18n.js',import.meta.url),'utf8');
 assert.doesNotMatch(i18n,/fetch\(|postMessage\(|contentDocument|contentWindow/);
});
