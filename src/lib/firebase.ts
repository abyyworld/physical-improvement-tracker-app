// The parts of the Firebase SDK the app uses, in one module so they load together, and only
// when someone signs in. Firestore "lite" is enough: the app reads and writes whole documents
// and keeps its own copy of the data, so it doesn't need Firestore's offline cache.

export { initializeApp } from 'firebase/app';
export {
  initializeAuth,
  indexedDBLocalPersistence,
  browserLocalPersistence,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  deleteUser,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  sendPasswordResetEmail,
} from 'firebase/auth';
export { getFirestore, doc, getDoc, writeBatch, setDoc, deleteDoc, runTransaction } from 'firebase/firestore/lite';
