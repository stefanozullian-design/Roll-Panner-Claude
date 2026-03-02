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

let _saveTimer    = null;
let _ignoreNext   = false;   // suppress echo from our own writes
let _onRemoteChange = null;  // callback → called when another client changes state

// ── SAVE (debounced 1.5s to avoid hammering Firestore) ──
export function firebaseSave(state) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      _ignoreNext = true;
      await setDoc(STATE_DOC, { payload: JSON.stringify(state) });
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

// ── LIVE LISTENER (optional — updates UI when another computer saves) ──
export function firebaseListen(callback) {
  _onRemoteChange = callback;
  return onSnapshot(STATE_DOC, (snap) => {
    if (_ignoreNext) { _ignoreNext = false; return; }
    if (snap.exists()) {
      try {
        const state = JSON.parse(snap.data().payload);
        if (state && _onRemoteChange) _onRemoteChange(state);
      } catch (err) {
        console.warn('[Firebase] parse error on snapshot:', err);
      }
    }
  });
}
