import {createHash} from 'node:crypto';

// Field-level changes preserve unrelated work when offline replicas reconnect.
// A causal sequence followed by UUID gives every replica the same conflict order.
const collections = new Set(['sessions','messages','runs','artifacts','annotations']);
// Journal file names are immutable identities, so two replicas with equal digests hold the
// same events and can skip exchanging the full name lists.
export const journalDigest = names => createHash('sha256').update(names.join('\n')).digest('hex');
const plain = x => x && typeof x === 'object' && !Array.isArray(x);
// Structural equality with JSON.stringify semantics (key order, dropped undefined members,
// non-finite numbers as null). Serializing both sides at every recursion level cost
// tens of milliseconds per commit on large projects; this walks each value once.
const jsonKind = v => v === undefined || typeof v === 'function' || typeof v === 'symbol' ? 'omit'
  : v === null ? 'null' : typeof v === 'number' ? (Number.isFinite(v) ? 'number' : 'null')
  : typeof v === 'string' || typeof v === 'boolean' ? typeof v
  : typeof v !== 'object' ? 'other' : Array.isArray(v) ? 'array' : typeof v.toJSON === 'function' ? 'other' : 'object';
const jsonKeys = o => Object.keys(o).filter(k => jsonKind(o[k]) !== 'omit');
export function jsonEqual(a, b) {
  if (a === b) return true;
  const kind = jsonKind(a);
  if (kind !== jsonKind(b)) return false;
  switch (kind) {
    case 'omit': case 'null': return true;
    case 'number': case 'string': case 'boolean': return a === b;
    case 'array': {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) { const x = jsonKind(a[i]) === 'omit' ? null : a[i], y = jsonKind(b[i]) === 'omit' ? null : b[i]; if (!jsonEqual(x, y)) return false; }
      return true;
    }
    case 'object': {
      const ka = jsonKeys(a), kb = jsonKeys(b);
      if (ka.length !== kb.length) return false;
      for (let i = 0; i < ka.length; i++) { if (ka[i] !== kb[i] || !jsonEqual(a[ka[i]], b[kb[i]])) return false; }
      return true;
    }
    default: return JSON.stringify(a) === JSON.stringify(b);
  }
}
export function changes(before, after, location = []) {
  if (jsonEqual(before, after)) return [];
  if (location.length === 1 && collections.has(location[0])) {
    const a = Object.fromEntries((before || []).map(x => [x.id,x]));
    const b = Object.fromEntries((after || []).map(x => [x.id,x]));
    return [...new Set([...Object.keys(a),...Object.keys(b)])].flatMap(id => changes(a[id],b[id],[...location,id]));
  }
  if (plain(before) && plain(after)) return [...new Set([...Object.keys(before),...Object.keys(after)])].flatMap(key => changes(before[key],after[key],[...location,key]));
  return [{path:location,...(after === undefined ? {remove:true} : {value:after})}];
}
export function applyChanges(state, patch) {
  for (const op of patch) {
    if (!Array.isArray(op.path) || !op.path.length || op.path.some(k => typeof k !== 'string' || ['__proto__','prototype','constructor'].includes(k))) throw new Error('Invalid journal change');
    let target=state;
    for(let i=0;i<op.path.length-1;i++) {
      const key=op.path[i];
      if (i===1 && collections.has(op.path[0])) {
        const record=target.find(x=>x.id===key);
        // A deleted record cannot be resurrected by a concurrent field update.
        if(!record){target=null;break;} target=record;
      } else target=target[key] ||= {};
    }
    if(!target)continue;
    const key=op.path.at(-1);
    if(op.path.length===2 && collections.has(op.path[0])) {
      const index=target.findIndex(x=>x.id===key);
      if(op.remove){if(index>=0)target.splice(index,1);}
      else if(index<0){const previous=op.value.continuationOf?target.findIndex(x=>x.id===op.value.continuationOf):-1;if(previous>=0)target.splice(previous+1,0,structuredClone(op.value));else target.push(structuredClone(op.value));}else target[index]=structuredClone(op.value);
    } else if(op.remove)delete target[key];else target[key]=structuredClone(op.value);
  }
  return state;
}
export function sessionBinding(state, id) {
  const session=state.sessions.find(s=>s.id===id);
  if(!session)return null;
  const last=state.runs.findLast(r=>r.sessionId===id);
  return {...session,hostId:session.hostId||last?.hostId,profileId:session.profileId||last?.profileId,model:session.model||session.selection?.model||last?.model};
}
