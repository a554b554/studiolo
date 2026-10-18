import { label } from './module-value.js';
document.querySelector('#module-state').textContent = label;
let count = 0;
document.querySelector('#module-action').onclick = () => { document.querySelector('#module-result').textContent = String(++count); };
document.querySelector("#fullscreen")?.addEventListener("click",async()=>{try{await document.documentElement.requestFullscreen();document.querySelector("#fullscreen-state").textContent="已全屏"}catch(error){document.querySelector("#fullscreen-state").textContent=error.message}});
