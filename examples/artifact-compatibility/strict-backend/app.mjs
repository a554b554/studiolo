document.querySelector('#script-status').textContent='外链 JavaScript 已运行；外链 CSS 已加载。';
document.querySelector('#form-output').textContent=new URL(location.href).searchParams.has('note')?'表单已提交：'+new URL(location.href).searchParams.get('note'):'';
document.querySelector('#cookie-button').addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;
  try{await fetch('/api/session',{method:'POST'});const data=await(await fetch('/api/session')).json();document.querySelector('#cookie-output').textContent=JSON.stringify(data,null,2);}
  catch(error){document.querySelector('#cookie-output').textContent=error.message;}
  finally{button.disabled=false;}
});
document.querySelector('#stream-button').addEventListener('click',event=>{
  const button=event.currentTarget;button.disabled=true;const list=document.querySelector('#stream-output');list.replaceChildren();let count=0;
  const stream=new EventSource('/events');
  stream.onmessage=event=>{const data=JSON.parse(event.data),item=document.createElement('li');item.textContent=data.label;list.append(item);if(++count===3){stream.close();button.disabled=false;}};
  stream.onerror=()=>{stream.close();button.disabled=false;};
});
