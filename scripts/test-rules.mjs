// Checks firestore.rules against the Firestore emulator: what each person may read and write, and
// that the database refuses anything that isn't sealed the way the app seals it. Needs Java.
//
//   npx -y firebase-tools@13.35.1 emulators:exec --only firestore --project demo-arise "node scripts/test-rules.mjs"
//
// Signed-in people are simulated with the emulator's mock sign-in tokens (no Auth emulator needed).

import { initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, deleteDoc, doc, getDoc, getDocs, collection, getFirestore, setDoc, setLogLevel } from 'firebase/firestore/lite';

setLogLevel('silent'); // the refusals below are expected; this script says what each one was
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-arise';

let apps = 0;
function as(uid) {
  const app = initializeApp({ projectId: PROJECT, apiKey: 'demo' }, `app${apps++}`);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, host, Number(port), uid ? { mockUserToken: { sub: uid, user_id: uid } } : {});
  return db;
}

let failed = 0;
let passed = 0;
async function expectAllowed(name, p) {
  try {
    await p;
    passed++;
    console.log(`  ok    allowed: ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  should be allowed: ${name} (${err.code || err.message})`);
  }
}
async function expectDenied(name, p) {
  try {
    await p;
    failed++;
    console.log(`  FAIL  should be refused: ${name}`);
  } catch (err) {
    if (err.code === 'permission-denied') {
      passed++;
      console.log(`  ok    refused: ${name}`);
    } else {
      failed++;
      console.log(`  FAIL  refused for another reason: ${name} (${err.code || err.message})`);
    }
  }
}

const alice = as('alice');
const bob = as('bob');
const nobody = as(null);

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64 = (n) => Array.from({ length: n }, (_, i) => B64[(i * 7 + 3) % 64]).join('');
const ID = 'A'.repeat(20) + '_-' + 'z9'.repeat(10) + 'x'; // 43 characters of base64url
const pack = (extra = {}) => ({ v: 1, iv: b64(16), ct: `${b64(100)}==`, updated: Date.now(), ...extra });
const life = (db, uid, id) => doc(db, 'users', uid, 'life', id);

console.log('The life log (users/{uid}/life/{id})');
await expectAllowed('the owner writes the key', setDoc(life(alice, 'alice', 'key'), pack()));
await expectAllowed('the owner writes the index', setDoc(life(alice, 'alice', 'index'), pack()));
await expectAllowed('the owner writes a part with a 43-character id', setDoc(life(alice, 'alice', ID), pack()));
await expectAllowed('the owner updates a part', setDoc(life(alice, 'alice', ID), pack({ ct: b64(400) })));
await expectAllowed('a part of exactly 700,000 characters', setDoc(life(alice, 'alice', ID), pack({ ct: b64(700000) })));
await expectAllowed('the owner reads a part', getDoc(life(alice, 'alice', ID)));
await expectAllowed('the owner lists their life log', getDocs(collection(alice, 'users', 'alice', 'life')));

await expectDenied('someone else reads it', getDoc(life(bob, 'alice', ID)));
await expectDenied('someone else lists it', getDocs(collection(bob, 'users', 'alice', 'life')));
await expectDenied('someone else writes into it', setDoc(life(bob, 'alice', ID), pack()));
await expectDenied('someone else deletes from it', deleteDoc(life(bob, 'alice', ID)));
await expectDenied('nobody signed in reads it', getDoc(life(nobody, 'alice', ID)));
await expectDenied('nobody signed in lists it', getDocs(collection(nobody, 'users', 'alice', 'life')));
await expectDenied('nobody signed in writes it', setDoc(life(nobody, 'alice', ID), pack()));

console.log('Only the sealed shape');
await expectDenied('plain data', setDoc(life(alice, 'alice', ID), { title: 'Searched "knee pain"' }));
await expectDenied('an extra field', setDoc(life(alice, 'alice', ID), pack({ title: 'Searched' })));
await expectDenied('no updated', setDoc(life(alice, 'alice', ID), { v: 1, iv: b64(16), ct: b64(100) }));
await expectDenied('no ct', setDoc(life(alice, 'alice', ID), { v: 1, iv: b64(16), updated: 1 }));
await expectDenied('another version', setDoc(life(alice, 'alice', ID), pack({ v: 2 })));
await expectDenied('an IV of the wrong length', setDoc(life(alice, 'alice', ID), pack({ iv: b64(24) })));
await expectDenied('an IV that is not base64', setDoc(life(alice, 'alice', ID), pack({ iv: 'not base64 at all' })));
await expectDenied('ciphertext that is not base64', setDoc(life(alice, 'alice', ID), pack({ ct: 'Hello, this is plain text.' })));
await expectDenied('empty ciphertext', setDoc(life(alice, 'alice', ID), pack({ ct: '' })));
await expectDenied('ciphertext over 700,000 characters', setDoc(life(alice, 'alice', ID), pack({ ct: b64(700001) })));
await expectDenied('updated that is not a whole number', setDoc(life(alice, 'alice', ID), pack({ updated: 'today' })));
for (const bad of ['meta', 'part0', 'e:2026-10', ID.slice(1), `${ID}A`, `${ID.slice(1)}.`]) {
  await expectDenied(`a document named "${bad}"`, setDoc(life(alice, 'alice', bad), pack()));
}
await expectDenied('reading a document with another name', getDoc(life(alice, 'alice', 'meta')));

console.log('Deleting');
await expectAllowed('the owner deletes a part', deleteDoc(life(alice, 'alice', ID)));
await expectAllowed('the owner deletes the index and the key', Promise.all([deleteDoc(life(alice, 'alice', 'index')), deleteDoc(life(alice, 'alice', 'key'))]));

console.log('The rest, as before');
const arise = (db, uid, id) => doc(db, 'users', uid, 'arise', id);
await expectAllowed('the main copy: meta', setDoc(arise(alice, 'alice', 'meta'), { rev: 'r1', parts: 1, enc: 1, iv: b64(16), schema: 3 }));
await expectAllowed('the main copy: a part', setDoc(arise(alice, 'alice', 'part0'), { rev: 'r1', ct: b64(100) }));
await expectDenied('the main copy: plain data', setDoc(arise(alice, 'alice', 'part0'), { rev: 'r1', ct: b64(100), journal: 'secret' }));
await expectDenied('the main copy: someone else', getDoc(arise(bob, 'alice', 'meta')));
await expectDenied('a folder that is not allowed', setDoc(doc(alice, 'users', 'alice', 'other', 'x'), pack()));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
