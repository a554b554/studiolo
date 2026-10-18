import test from 'node:test';
import assert from 'node:assert/strict';
import {markdown,safeLink,resolvePath,isMarkdownPath,slug} from '../public/markdown.js';

// Minimal DOM sink: test the renderer's output tree, not browser HTML parsing.
function documentSink() {
 const el = tag => ({tag,children:[],attributes:{},append(...nodes){this.children.push(...nodes);},setAttribute(k,v){this.attributes[k]=String(v);}});
 return {createElement:el,createDocumentFragment:()=>el('fragment'),createTextNode:text=>({tag:'#text',text})};
}
const flatten = node => [node,...(node.children||[]).flatMap(flatten)];
const escape = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;');
const serialize = node => node.tag==='#text' ? escape(node.text) : node.tag==='fragment' ? node.children.map(serialize).join('') :
 `<${node.tag}${node.className?` class="${node.className}"`:''}${Object.entries(node.attributes).map(([k,v])=>` ${k}="${v}"`).join('')}>${node.textContent!==undefined?escape(node.textContent):node.children.map(serialize).join('')}</${node.tag}>`;
test('assistant Markdown produces headings, emphasis, lists, code and tables',()=>{
 const nodes=flatten(markdown('## Summary\n**Done** and `code`.\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```html\n<script>literal</script>\n```',documentSink()));
 for(const tag of ['h3','strong','code','ul','li','table','th','td','pre']) assert.ok(nodes.some(n=>n.tag===tag),tag);
 assert.ok(nodes.some(n=>n.tag==='code' && n.textContent==='<script>literal</script>'));
});
test('untrusted replies cannot inject HTML or executable links',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,test','file:///C:/secret','vbscript:msgbox(1)']) assert.equal(safeLink(url),null);
 for(const url of ['https://example.com','http://127.0.0.1:4310/','/artifact.html','mailto:a@example.com']) assert.equal(safeLink(url),url);
 const nodes=flatten(markdown('<img src=x onerror=alert(1)>\n[bad](javascript:alert) [good](https://example.com)',documentSink()));
 assert.ok(!nodes.some(n=>['img','script'].includes(n.tag)));
 const links=nodes.filter(n=>n.tag==='a');assert.equal(links.length,1);assert.equal(links[0].attributes.rel,'noopener noreferrer');
});
test('project Markdown files render as documents with anchors, tasks, nesting and callouts',()=>{
 const html=serialize(markdown('---\ntitle: Notes\n---\n# Title\n\nsoft\nwrap and hard  \nbreak\n\n## Setup *guide*\n\n- [x] done\n- [ ] todo\n  - nested\n\n> [!WARNING]\n> Careful\n\n| L | C |\n|:--|:-:|\n| a \\| b | c |\n\n<!-- hidden -->\n\n```js\nconst x = 1;\n```',documentSink(),{file:'notes/a.md'}));
 assert.match(html,/<pre class="front-matter"><code>title: Notes<\/code><\/pre>/);
 assert.match(html,/<h1 id="md-title">Title<\/h1>/);
 assert.match(html,/<p>soft\nwrap and hard<br><\/br>break<\/p>/);
 assert.match(html,/<h2 id="md-setup-guide">Setup <em>guide<\/em><\/h2>/);
 assert.match(html,/<li class="task"><input type="checkbox" disabled="" checked=""><\/input>done<\/li>/);
 assert.match(html,/todo<ul><li>nested<\/li><\/ul>/);
 assert.match(html,/<blockquote class="callout callout-warning"><p class="callout-title">Warning<\/p><p>Careful<\/p><\/blockquote>/);
 assert.match(html,/<td>a \| b<\/td><td style="text-align:center">c<\/td>/);
 assert.match(html,/<pre data-lang="js"><code class="language-js">const x = 1;<\/code><\/pre>/);
 assert.doesNotMatch(html,/hidden/);
});
test('document links stay inside the project and remote images are never fetched',()=>{
 const html=serialize(markdown('[s](#Setup-Guide) [o](../docs/b.md#Usage) [up](../../x.md) [bad](javascript:alert(1)) ![p](img/p.png) ![r](https://example.com/t.png) ![d](data:image/png;base64,AAAA) [ref][r]\n\n[r]: https://example.com/ref "Ref"',documentSink(),{file:'notes/a.md',image:p=>'/raw?path='+p}));
 assert.match(html,/<a href="#setup-guide" data-anchor="setup-guide">s<\/a>/);
 assert.match(html,/<a href="#" data-file="docs\/b.md" data-anchor="usage">o<\/a>/);
 assert.match(html,/<span>up<\/span>/);
 assert.match(html,/<span>bad<\/span>/);
 assert.match(html,/<img src="\/raw\?path=notes\/img\/p.png" alt="p" loading="lazy">/);
 assert.match(html,/<img src="data:image\/png;base64,AAAA"/);
 assert.doesNotMatch(html,/<img src="https:/);
 assert.match(html,/<a class="image-link" href="https:\/\/example.com\/t.png"/);
 assert.match(html,/href="https:\/\/example.com\/ref" target="_blank" rel="noopener noreferrer" title="Ref">ref<\/a>/);
 // Chat replies keep shifted headings and never load images, project or remote.
 const chat=serialize(markdown('# Reply\n![p](img/p.png) <!-- kept -->',documentSink()));
 assert.match(chat,/^<h2>Reply<\/h2>/);assert.doesNotMatch(chat,/<img|id=/);assert.match(chat,/&lt;!-- kept -->/);
});
test('relative paths resolve against the file and cannot leave the project',()=>{
 assert.equal(resolvePath('docs/guide/a.md','../b.md'),'docs/b.md');
 assert.equal(resolvePath('a.md','./img/x%20y.png?raw=1#top'),'img/x y.png');
 assert.equal(resolvePath('docs/a.md','/README.md'),'README.md');
 assert.equal(resolvePath('a.md','../outside.md'),null);
 assert.equal(resolvePath('a.md','%E0%A4%A'),null);
 assert.ok(isMarkdownPath('docs/README.MD'));assert.ok(!isMarkdownPath('a.md.txt'));
 assert.equal(slug('Setup *guide* — 中文 `v2`'),'setup-guide--中文-v2');
});
