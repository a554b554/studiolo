// Run this function with Playwright browser_run_code_unsafe filename. Uses a disposable tab.
async (page) => {
  const target = await page.context().newPage();
  const checks = [];
  const assert = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  try {
    await target.goto('http://127.0.0.1:4310/bridge.js');
    await target.setContent(`<!doctype html><html><head><style>body{margin:24px;font:18px Arial}button{background:red!important;font-size:24px!important}svg{display:block;margin:25px 0}#text{width:600px;user-select:text}#space{height:1000px}#scroll{height:80px;overflow:auto;border:1px solid}#scroll>div{height:350px;padding-top:180px}studio-selection-layer{transform:scale(.5);background:red}</style></head><body>
      <button id="normal" onclick="window.clicks++">Normal button</button><input id="input" placeholder="ordinary input"><p id="text">Alpha bravo charlie delta echo foxtrot golf hotel india juliet.</p>
      <ul id="repeated"><li>Distinct first row</li><li>Selected second row</li><li>Distinct third row</li></ul>
      <svg width="220" height="90"><rect id="shape" x="10" y="10" width="150" height="60" fill="blue"></rect></svg><section id="shadow-host"></section>
      <canvas id="canvas" width="200" height="90"></canvas><div id="scroll"><div><button id="scrolled">Scrolled button</button></div></div><div id="space"></div><button id="bottom">Bottom button</button>
      <script>window.clicks=0;window.events=[];window.__STUDIO_BRIDGE__={nonce:'bridge-test',parentOrigin:location.origin};window.addEventListener('message',e=>{if(e.data?.nonce==='bridge-test')events.push(e.data)});const s=document.querySelector('#shadow-host').attachShadow({mode:'open'});s.innerHTML='<button id="inside">Shadow action</button>';const c=document.querySelector('canvas').getContext('2d');c.fillStyle='orange';c.fillRect(0,0,200,90);</script></body></html>`);
    await target.addScriptTag({ url: 'http://127.0.0.1:4310/bridge.js' });
    const mode = async value => { await target.evaluate(value => postMessage({ type: 'studio:mode', nonce: 'bridge-test', enabled: value !== false, mode: value || 'element' }, location.origin), value); await target.waitForTimeout(30); };
    const selected = async () => { await target.waitForTimeout(40); return target.evaluate(() => events.filter(e => e.type === 'studio:selection').at(-1)?.anchor); };
    const command = async (type, payload) => { await target.evaluate(({type,payload}) => postMessage({type,nonce:'bridge-test',...payload},location.origin), {type,payload}); await target.waitForTimeout(60); };
    const selectionCount = () => target.evaluate(() => events.filter(e=>e.type==='studio:selection').length);

    await target.locator('#normal').click(); await target.locator('#input').fill('editable');
    assert(await target.evaluate(() => clicks === 1 && document.querySelector('#input').value === 'editable'), 'normal mode preserves button and input');
    await mode('element'); await target.locator('#normal').click();
    let anchor = await selected(); assert(anchor.selector === '#normal' && anchor.kind === 'element', 'element mode selects button');
    assert(await target.evaluate(() => clicks === 1), 'selection does not activate button');
    assert(anchor.outerHTML.includes('<button') && anchor.sourceHash && anchor.version === 2 && anchor.frame && anchor.viewport, 'selection records source, version, frame and viewport');
    assert(await target.evaluate(() => { const host=document.querySelector('studio-selection-layer');return host.shadowRoot===null&&getComputedStyle(host).pointerEvents==='none'&&getComputedStyle(host).transform==='none'; }), 'overlay is isolated from hostile page CSS');

    await target.evaluate(() => Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true}));
    try {
      const previousId=anchor.captureId;await mode('element');await target.locator('#normal').click();anchor=await selected();
      assert(anchor.captureId!==previousId&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(anchor.captureId),'private HTTP UUID fallback selects successfully without crypto.randomUUID');
    } finally { await target.evaluate(() => { delete crypto.randomUUID; }); }

    const touch=await target.context().newCDPSession(target);
    try {
      await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true});
      await mode('element');const beforeTouch=await selectionCount(), buttonBox=await target.locator('#normal').boundingBox();
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:buttonBox.x+buttonBox.width/2,y:buttonBox.y+buttonBox.height/2,id:1}]});
      await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      anchor=await selected();
      assert(await selectionCount()===beforeTouch+1&&anchor.selector==='#normal','touchstart cancellation still receives pointerup and selects exactly once');
      assert(await target.evaluate(()=>clicks===1),'touch selection does not activate the selected button');
    } finally { await touch.send('Emulation.setTouchEmulationEnabled',{enabled:false});await touch.detach(); }

    await mode('element'); await target.locator('#shape').click(); anchor = await selected();
    assert(anchor.fingerprint.tag === 'rect' && anchor.fingerprint.namespace.includes('svg'), 'SVG element selection keeps namespace; actual=' + JSON.stringify(anchor));
    await mode('element'); await target.locator('#shadow-host').locator('#inside').click(); anchor = await selected();
    assert(anchor.selector === '#inside' && anchor.shadowPath[0] === '#shadow-host', 'open Shadow DOM captures a traversable locator');
    await command('studio:anchors',{annotations:[{id:'shadow',anchor}]});
    assert(await target.evaluate(()=>events.some(e=>e.id==='shadow'&&e.anchorStatus==='attached')), 'open Shadow DOM anchor attaches');

    await mode('text'); const textBox = await target.locator('#text').boundingBox();
    await target.mouse.move(textBox.x+2,textBox.y+9);await target.mouse.down();await target.mouse.move(textBox.x+215,textBox.y+9,{steps:14});await target.mouse.up();
    anchor = await selected(); assert(anchor.kind === 'text' && anchor.text.length > 5 && anchor.textQuote?.exact === anchor.text, 'native text drag yields exact quote evidence');
    await command('studio:anchors',{annotations:[{id:'quote',anchor}]});
    await target.locator('#text').evaluate(el=>el.textContent='The selected quotation was removed.');await target.waitForTimeout(100);
    assert(await target.evaluate(()=>events.filter(e=>e.id==='quote'&&e.type==='studio:anchor-status').at(-1)?.anchorStatus==='orphaned'), 'removed text quote becomes orphaned even if its paragraph survives');

    await mode('region'); const cb = await target.locator('#canvas').boundingBox();
    await target.mouse.move(cb.x+10,cb.y+10);await target.mouse.down();await target.mouse.move(cb.x+100,cb.y+60,{steps:8});await target.mouse.up();anchor=await selected();
    assert(anchor.kind==='region'&&anchor.rect.width>80&&anchor.normalizedRect&&anchor.screenshot?.startsWith('data:image/png'), 'canvas region stores bounds and bitmap');
    await mode('element'); const before = await selectionCount(); await target.keyboard.press('Escape');await target.locator('#normal').click();
    assert(await selectionCount()===before && await target.evaluate(()=>events.some(e=>e.type==='studio:mode-exit')), 'Escape exits selection without creating another comment');

    await mode('element'); await target.locator('#repeated li').nth(1).click();anchor=await selected();
    await command('studio:anchors',{annotations:[{id:'row',anchor}]});
    await target.locator('#repeated li').nth(1).evaluate(el=>el.remove()); await target.waitForTimeout(100);
    assert(await target.evaluate(()=>events.filter(e=>e.id==='row'&&e.type==='studio:anchor-status').at(-1)?.anchorStatus==='orphaned'), 'deleted positional anchor is orphaned instead of rebound to neighbour');

    await target.locator('#repeated').evaluate(el=>el.innerHTML='<li>Identical row</li><li>Identical row</li>');
    await mode('element');await target.locator('#repeated li').nth(1).click();anchor=await selected();
    await command('studio:anchors',{annotations:[{id:'identical',anchor}]});
    assert(await target.evaluate(()=>events.filter(e=>e.id==='identical'&&e.type==='studio:anchor-status').at(-1)?.anchorStatus==='attached'), 'duplicate identical elements bind to the exact captured live node');

    await mode(false); await target.locator('#bottom').scrollIntoViewIfNeeded();await mode('element');await target.locator('#bottom').click();anchor=await selected();
    assert(anchor.viewport.scrollY>0&&anchor.documentRect.y>anchor.rect.y, 'scroll coordinates retain document and viewport positions');
    await command('studio:anchors',{annotations:[{id:'bottom',anchor}]});
    await target.evaluate(()=>{document.querySelector('#bottom').textContent='Edited while retaining element'});await target.waitForTimeout(100);
    assert(await target.evaluate(()=>events.filter(e=>e.id==='bottom'&&e.type==='studio:anchor-status').at(-1)?.anchorStatus==='attached'), 'live edited element keeps its existing anchor');
    await target.locator('#bottom').evaluate(el=>el.outerHTML='<button id="bottom">Changed title in newly rendered DOM</button>');
    await target.waitForTimeout(80);
    await command('studio:anchors',{annotations:[{id:'new-binding',anchor:{...anchor,captureId:'previous-page'}}]});
    assert(await target.evaluate(()=>events.filter(e=>e.id==='new-binding'&&e.type==='studio:anchor-status').at(-1)?.anchorStatus==='attached'), 'stable unique ID rebinds new DOM after text editing without prior live binding');
    return {passed:checks.length,checks};
  } finally { await target.close(); }
}
