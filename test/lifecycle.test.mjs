import test from 'node:test';
import assert from 'node:assert/strict';
import {category,visibleItems} from '../public/lifecycle.js';
test('navigation keeps legacy items active and trash separate from archive',()=>{
 const records=[{id:'old'},{id:'archive',archivedAt:'date'},{id:'trash',archivedAt:'date',deletedAt:'later'}];
 assert.deepEqual(visibleItems(records).map(r=>r.id),['old']);
 assert.deepEqual(visibleItems(records,'archived').map(r=>r.id),['archive']);
 assert.deepEqual(visibleItems(records,'deleted').map(r=>r.id),['trash']);
 assert.equal(category({}), 'active');
});
