import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStudio} from '../src/server.mjs';

test('machine usage API requires authentication and forwards explicit refresh without creating projects',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'studio-quota-'));let reads=[];
 const app=await createStudio({stateDir:dir,projectRoot:path.join(dir,'projects'),port:0,previewPort:0,token:'test-usage-only',runner:{profiles:async()=>[],close:async()=>{}},accountUsage:{get:async options=>{reads.push(options);return {accounts:[{id:'claude1',status:'ok',summary:{remainingPercent:75}}]};}}});
 t.after(async()=>{await app.close();await fs.rm(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.port}`;
 assert.equal((await fetch(base+'/api/account-usage')).status,401);assert.equal(reads.length,0);
 const response=await fetch(base+'/api/account-usage?refresh=1',{headers:{Authorization:'Bearer test-usage-only'}});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const result=await response.json();assert.equal(result.hostId,app.hostId);assert.equal(result.accounts[0].summary.remainingPercent,75);assert.deepEqual(reads,[{refresh:true}]);assert.deepEqual(await app.store.listProjects(),[]);
 assert.equal((await fetch(base+'/api/account-usage',{headers:{Authorization:'Bearer test-usage-only',Origin:'https://outside.test'}})).status,403);
});
