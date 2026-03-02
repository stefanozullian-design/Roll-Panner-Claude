// ─────────────────────────────────────────────────────────────────────────────
// firebase-sync.js  —  Firestore backend for Roll Panner
// One shared database, no authentication.
// All state lives in: /app/state  (single document)
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import { getFirestore, doc, getDoc, setDoc, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';

// Read Firebase config from window.FIREBASE_CONFIG (loaded from config.js)
// For security: credentials should never be hardcoded in source
let firebaseConfig = window.FIREBASE_CONFIG;

if (!firebaseConfig) {
  console.error('[Firebase] FIREBASE_CONFIG not found. Please create a config.js file with your Firebase credentials.');
  console.error('[Firebase] See config.example.js for the required format.');
  // Provide minimal fallback to prevent complete failure (though this won't work without valid credentials)
  firebaseConfig = {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: ''
  };
}

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);
const STATE_DOC = doc(db, 'app', 'state');

// Unique ID for this browser tab — used to detect own writes
const MY_CLIENT_ID = Math.random().toString(36).slice(2);

let _saveTimer = null;
let _lastSavedWriteId = null;  // ignore snapshots with this writeId (our own echo)

// ── SAVE (debounced 1.5s to avoid hammering Firestore) ──
// Only syncs DATA — ui state (active tab, facility selection, mode) stays local per-computer
export function firebaseSave(state) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    try {
      // Strip ui from what we save — each computer navigates independently
      const { ui, ...dataOnly } = state;
      const writeId = `${MY_CLIENT_ID}_${Date.now()}`;
      _lastSavedWriteId = writeId;
      await setDoc(STATE_DOC, { payload: JSON.stringify(dataOnly), writeId });
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
