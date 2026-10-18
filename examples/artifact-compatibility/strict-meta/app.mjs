document.querySelector('#meta-script-status').textContent='外链脚本已运行，Meta CSP 保持启用。';
let count=0;
document.querySelector('#meta-button').addEventListener('click',()=>{document.querySelector('#meta-output').textContent=String(++count);});
