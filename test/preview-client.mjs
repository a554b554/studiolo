// Node fetch deliberately has no implicit browser cookie jar.
export async function previewClient(live) {
  const bootstrap=await fetch(live.url,{redirect:'manual'});
  if(bootstrap.status!==303)throw new Error('Preview bootstrap did not redirect: '+bootstrap.status);
  const cookies=(bootstrap.headers.getSetCookie?.()||[bootstrap.headers.get('set-cookie')]).filter(Boolean).map(value=>value.split(';')[0]);
  const base=new URL(bootstrap.headers.get('location'),live.url);
  const request=async(relative=base.href,options={})=>{
    const response=await fetch(new URL(relative,base),{...options,headers:{...options.headers,Cookie:cookies.join('; ')},redirect:options.redirect||'manual'});
    for(const cookie of response.headers.getSetCookie?.()||[]){const pair=cookie.split(';')[0],name=pair.split('=')[0];const i=cookies.findIndex(item=>item.startsWith(name+'='));if(i<0)cookies.push(pair);else cookies[i]=pair;}
    return response;
  };
  return {request,cookies,base:base.href};
}
