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
let _pendingState = null;  // queued state for retry
let _retryCount = 0;  // current retry attempt count
let _lastSaveError = null;  // track last save error for status reporting

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 5000]; // exponential backoff in ms
const INITIAL_DEBOUNCE = 1500;

// Callback for notifying UI of persistent save failures
let _onPersistentFailure = null;
export function setSaveFailureCallback(callback) {
  _onPersistentFailure = callback;
}

// Status check function for UI to display sync state
export function getSaveStatus() {
  return {
    isPending: _saveTimer !== null || _pendingState !== null,
    retryCount: _retryCount,
    lastError: _lastSaveError?.message || null,
    isFailed: _retryCount >= MAX_RETRIES
  };
}

// ── SAVE (debounced 1.5s with exponential backoff retry) ──
// Only syncs DATA — ui state (active tab, facility selection, mode) stays local per-computer
export function firebaseSave(state) {
  _pendingState = state;  // Queue this state for save

  if (_saveTimer) clearTimeout(_saveTimer);

  // Use shorter delay for retries, longer for initial save
  const delay = _retryCount > 0 ? RETRY_DELAYS[Math.min(_retryCount - 1, RETRY_DELAYS.length - 1)] : INITIAL_DEBOUNCE;

  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    await _performSave(_pendingState);
  }, delay);
}

async function _performSave(state) {
  try {
    // Strip ui from what we save — each computer navigates independently
    const { ui, ...dataOnly } = state;
    const writeId = `${MY_CLIENT_ID}_${Date.now()}`;
    _lastSavedWriteId = writeId;
    await setDoc(STATE_DOC, { payload: JSON.stringify(dataOnly), writeId });

    // Success — reset retry counter
    _retryCount = 0;
    _lastSaveError = null;
    _pendingState = null;
    console.log('[Firebase] save succeeded');
  } catch (err) {
    _lastSaveError = err;

    // Check if we should retry
    if (_retryCount < MAX_RETRIES) {
      _retryCount++;
      const nextDelay = RETRY_DELAYS[_retryCount - 1];
      console.warn(`[Firebase] save failed, retrying in ${nextDelay}ms (attempt ${_retryCount}/${MAX_RETRIES}):`, err.message);

      // Schedule retry
      _saveTimer = setTimeout(async () => {
        _saveTimer = null;
        await _performSave(_pendingState);
      }, nextDelay);
    } else {
      // All retries exhausted
      console.error('[Firebase] save failed after', MAX_RETRIES, 'retries:', err.message);
      _pendingState = null;

      // Notify UI of persistent failure
      if (_onPersistentFailure) {
        _onPersistentFailure(err);
      }
    }
  }
}

// ── LOAD (one-time read on startup) ──
export async function firebaseLoad() {
  try {
    // Add 5-second timeout to prevent hanging on bad Firebase config
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('Firebase load timeout (5s)')), 5000);
    });

    try {
      const snap = await Promise.race([getDoc(STATE_DOC), timeoutPromise]);
      clearTimeout(timeoutId); // Clean up timeout if getDoc succeeded
      if (snap.exists()) {
        const raw = snap.data().payload;
        return raw ? JSON.parse(raw) : null;
      }
      return null;
    } catch (err) {
      clearTimeout(timeoutId); // Clean up timeout if race timed out
      throw err;
    }
  } catch (err) {
    console.warn('[Firebase] load failed:', err.message || err);
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
