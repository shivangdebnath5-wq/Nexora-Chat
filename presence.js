// presence.js — real-time online/offline presence via Firebase Realtime
// Database, using the standard `.info/connected` + `onDisconnect()`
// pattern. This is additive-only: it reuses the SAME Firebase app already
// initialized in index.html's <script type="module"> block (via getApp(),
// not a second initializeApp()), and does not touch Firestore, chats,
// Hubs, Pinterest, GIPHY, or any existing UI/rendering code. It writes
// presence data to Realtime Database only — nothing here reads from or
// changes what's already on screen.
//
// Requirements on the Firebase project itself (can't be done from this
// file — see the security rules note near the bottom):
//   1. Realtime Database must be enabled for this project (Firebase
//      Console → Build → Realtime Database → Create Database). If it
//      isn't, getDatabase() below throws and this module just logs a
//      warning and stays inactive — it will not break anything else.
//   2. RTDB rules need to allow a signed-in user to write their own
//      connection entries (see the JSON near the bottom of this file).
//
// Data shape written here:
//   /status/{uid}/connections/{connectionId} = { online: true, lastChanged: <server time> }
// A user counts as online as long as ANY connection entry exists under
// their uid — this is what makes multiple tabs/devices work correctly:
// closing one tab only removes that tab's own entry (via onDisconnect),
// leaving the others (and "online" status) intact. This module doesn't
// render that anywhere; it's the data for a future UI to read.

import { getApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getDatabase, ref, onValue, onDisconnect, push, set, remove, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";

// script.js (classic, non-module) loads and runs before index.html's
// Firebase <script type="module"> block actually executes (module scripts
// are deferred until after the whole document has parsed), and this file
// is reached via a dynamic import() from script.js — so the default app
// may not exist yet the instant this module starts running. Poll briefly
// for it instead of assuming an exact load order.
function waitForFirebaseApp(retries = 50, delayMs = 100) {
  return new Promise((resolve, reject) => {
    (function attempt(remaining) {
      try {
        resolve(getApp());
      } catch (err) {
        if (remaining <= 0) { reject(err); return; }
        setTimeout(() => attempt(remaining - 1), delayMs);
      }
    })(retries);
  });
}

(async () => {
  let app;
  try {
    app = await waitForFirebaseApp();
  } catch (err) {
    console.warn('Presence: Firebase app never became available, skipping presence tracking.', err.message);
    return;
  }

  const auth = getAuth(app);

  let db;
  try {
    db = getDatabase(app);
  } catch (err) {
    // Most likely cause: Realtime Database isn't enabled for this project
    // yet (no databaseURL could be resolved). Presence simply stays off —
    // nothing else in the app depends on it.
    console.warn('Presence: Realtime Database unavailable, skipping presence tracking.', err.message);
    return;
  }

  let connectedListenerUnsub = null;
  let myConnectionRef = null;

  onAuthStateChanged(auth, (user) => {
    // Tear down the previous user's connection tracking first (covers
    // sign-out and switching accounts), so a stale "online" entry never
    // lingers under the wrong uid.
    if (connectedListenerUnsub) { connectedListenerUnsub(); connectedListenerUnsub = null; }
    if (myConnectionRef) { remove(myConnectionRef).catch(() => {}); myConnectionRef = null; }

    if (!user) return; // signed out — nothing to track

    const myConnectionsRef = ref(db, `/status/${user.uid}/connections`);
    const connectedRef = ref(db, '.info/connected');

    connectedListenerUnsub = onValue(connectedRef, (snap) => {
      if (snap.val() !== true) return; // this fires on every (re)connect, including reconnect after a drop

      // A fresh push() key per connection is what makes multi-tab/device
      // presence correct — see the file header for why.
      myConnectionRef = push(myConnectionsRef);
      onDisconnect(myConnectionRef).remove();
      set(myConnectionRef, { online: true, lastChanged: serverTimestamp() });
    });
  });
})();

// --- Realtime Database security rules needed for this to work -----------
// Add/merge this in Firebase Console → Realtime Database → Rules. It lets
// any signed-in user read presence data (for a future "is my friend
// online" UI) but only write to their own uid's connection entries:
//
// {
//   "rules": {
//     "status": {
//       "$uid": {
//         ".read": "auth != null",
//         "connections": {
//           ".write": "auth != null && auth.uid === $uid"
//         }
//       }
//     }
//   }
// }