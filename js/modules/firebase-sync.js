// ─────────────────────────────────────────────────────────────────────────────
// firebase-sync.js  —  Firestore backend for Roll Panner
// One shared database, no authentication.
// All state lives in: /app/state  (single document)
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getFirestore, doc, getDoc, setDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey:            "AIzaSyCxs2XHfS3Xj4IJdWWlhKgQ2OsENGVk2Zw",
  authDomain:        "inventory-roll.firebaseapp.com",
  projectId:         "inventory-roll",
  storageBucket:     "inventory-roll.firebasestorage.app",
  messagingSenderId: "935575596192",
  appId:             "1:935575596192:web:a56fb920aab7865ad3edc5"
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);
const STATE_DOC = doc(db, 'app', 'state');

// Unique ID for this browser tab — used to detect own writes
const MY_CLIENT_ID = Math.random().toString(36).slice(2);

let _saveTimer = null;
let _lastSavedWriteId = null;  // ignore snapshots with this writeId (our own echo)

// ── SAVE (debounced 1.5s to avoid hammering Firestore) ──
export function firebaseSave(state) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      const writeId = `${MY_CLIENT_ID}_${Date.now()}`;
      _lastSavedWriteId = writeId;
      await setDoc(STATE_DOC, { payload: JSON.stringify(state), writeId });
    } catch (err) {
      console.warn('[Firebase] save failed:', err);
    }
  }, 1500);
}

// ── LOAD (one-time read on startup) ──
export async function firebaseLoad() {
  try {
    const snap = await getDoc(STATE_DOC);
    if (snap.exists()) {
      const raw = snap.data().payload;
      return raw ? JSON.parse(raw) : null;
    }
    return null;
  } catch (err) {
    console.warn('[Firebase] load failed:', err);
    return null;
  }
}

// ── LIVE LISTENER — updates UI when another computer saves ──
export function firebaseListen(callback) {
  return onSnapshot(STATE_DOC, (snap) => {
    if (!snap.exists()) return;
    const data = snap.data();
    // Ignore snapshots caused by our own writes
    if (data.writeId && data.writeId === _lastSavedWriteId) return;
    try {
      const state = JSON.parse(data.payload);
      if (state) callback(state);
    } catch (err) {
      console.warn('[Firebase] parse error on snapshot:', err);
    }
  });
}
