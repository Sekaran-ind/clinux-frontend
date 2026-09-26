import 'fake-indexeddb/auto';
import { createIndexedDbCollection } from './src/data/indexedDbCollectionFactory.js';

const c = createIndexedDbCollection('repro-key-' + Date.now(), { getKey: r => r.id });
console.log('immediately after create, has():', c.has('a'));
c.insert({ id: 'a', v: 1 });
console.log('immediately after insert, get():', c.get('a'));
await new Promise(r => setTimeout(r, 0));
console.log('after one macrotask tick, get():', c.get('a'));
await new Promise(r => setTimeout(r, 50));
console.log('after 50ms, get():', c.get('a'));
