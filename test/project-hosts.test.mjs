import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactHome,runHosts,migrateProject} from '../public/project-hosts.js';

const hosts=[{id:'win',name:'Desktop',url:'http://desktop:4310'},{id:'mini',name:'Mini',url:'http://mini:4310'},{id:'mac',name:'MacBook'}];

test('artifacts of another server open on that server',()=>{
  assert.equal(artifactHome({ownerHostId:'mini'},hosts,'win')?.url,'http://mini:4310');
  assert.equal(artifactHome({ownerHostId:'win'},hosts,'win'),null);
  // Artifacts stay on the owner however many machines may run the project.
  assert.equal(artifactHome({ownerHostId:'win',allowedHostIds:['mini']},hosts,'win'),null);
  // A server without an address, or an unknown one, leaves them here.
  assert.equal(artifactHome({ownerHostId:'mac'},hosts,'win'),null);
  assert.equal(artifactHome({ownerHostId:'gone'},hosts,'win'),null);
  assert.equal(artifactHome(null,hosts,'win'),null);
});

test('a project runs on its owner and the machines allowed in its settings; sync-era projects keep their ready copies',()=>{
  assert.deepEqual(runHosts({ownerHostId:'win'}),['win']);
  assert.deepEqual(runHosts({ownerHostId:'win',allowedHostIds:['mini','win']}),['win','mini']);
  assert.equal(runHosts({}),null);
  // Before 0.2.5 a synced project ran on every ready copy; that becomes its allow list, and the file-sync fields go.
  const legacy=migrateProject({ownerHostId:'win',sync:{enabled:true,commit:'auto'},replicas:{win:{state:'ready',version:'v1'},mini:{state:'ready',version:'v1'},mac:{state:'adding',version:null}},head:{id:'v1'},diverged:{heads:[]}});
  assert.deepEqual(legacy.allowedHostIds,['mini']);assert.deepEqual(runHosts(legacy),['win','mini']);
  assert.equal(legacy.sync,undefined);assert.equal(legacy.head,undefined);assert.equal(legacy.diverged,undefined);assert.equal(legacy.replicas.win.version,undefined);
  assert.deepEqual(migrateProject({ownerHostId:'win',sync:{enabled:false},replicas:{mini:{state:'ready'}}}).allowedHostIds,[]);
});
