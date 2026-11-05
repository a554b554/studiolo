import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactHome} from '../public/project-hosts.js';

const hosts=[{id:'win',name:'Desktop',url:'http://desktop:4310'},{id:'mini',name:'Mini',url:'http://mini:4310'},{id:'mac',name:'MacBook'}];

test('artifacts of another server open on that server',()=>{
  assert.equal(artifactHome({ownerHostId:'mini'},hosts,'win')?.url,'http://mini:4310');
  assert.equal(artifactHome({ownerHostId:'win'},hosts,'win'),null);
  // A synced project's artifacts run where its sync settings say.
  assert.equal(artifactHome({ownerHostId:'win',sync:{enabled:true,artifactHostId:'mini'}},hosts,'win')?.id,'mini');
  // A server without an address, or an unknown one, leaves them here.
  assert.equal(artifactHome({ownerHostId:'mac'},hosts,'win'),null);
  assert.equal(artifactHome({ownerHostId:'gone'},hosts,'win'),null);
  assert.equal(artifactHome(null,hosts,'win'),null);
});
