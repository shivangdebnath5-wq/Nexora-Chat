// presence.js — real-time online/offline presence via Firebase Realtime
// Database, using the standard `.info/connected` + `onDisconnect()`
// pattern. This is additive-only: it reuses the SAME Firebase app already
// initialized in index.html's <script type="module"> block (via getApp(),
// not a second initializeApp()), and does not touch chats, Hubs,
// Pinterest, GIPHY, or any existing UI/rendering code. It writes presence
// data to Realtime Database only — nothing here changes what's already on
// screen; index.html's own getUserPresence()/getBadgeStatusForUser() call
// into the small read API below (window.ensurePresenceSubscription /
// window.isUserOnlineRTDB) to actually paint badges, exactly the "future
// UI" this file originally left for.
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
// leaving the others (and "online" status) intact.
//
// Read side (added below the original write-side IIFE): the UI only knows
// usernames, but RTDB presence is keyed by uid, so a small Firestore lookup
// on the already-public usernames/{username} doc (no rule changes needed —
// it's already `allow read: if true`) resolves username -> uid once per
// username, then an RTDB listener on /status/{uid}/connections keeps
// window.isUserOnlineRTDB(username) live-updated forever after.

import { getApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getDatabase, ref, onValue, onDisconnect, push, set, remove, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

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

  // --- Read side: username -> live online/offline, for the friends list /
  // chat header / self status badge in index.html. Entirely separate from
  // the write-side above (different uid, other people's presence), sharing
  // only `app`/`db`.
  const firestore = getFirestore(app);
  const usernameToUid = new Map();  // username -> uid, resolved once, never changes
  const onlineCache = new Map();    // username -> true/false, live via RTDB listener below
  const trackedUsernames = new Set(); // usernames a listener has already been started for

  async function resolveUidForUsername(username) {
    if (usernameToUid.has(username)) return usernameToUid.get(username);
    try {
      const snap = await getDoc(doc(firestore, 'usernames', username.toLowerCase()));
      const uid = snap.exists() ? snap.data().uid : null;
      if (uid) usernameToUid.set(username, uid);
      return uid;
    } catch (err) {
      console.warn(`Presence: could not resolve uid for @${username}`, err.message);
      return null;
    }
  }

  // Idempotent — safe to call every time a badge for `username` renders.
  // Starts (once) an RTDB listener that keeps isUserOnlineRTDB(username)
  // live-updated, and notifies window.onPresenceChange (if index.html has
  // defined it) so the already-drawn badge can repaint without a full
  // re-render.
  window.ensurePresenceSubscription = function (username) {
    if (!username || trackedUsernames.has(username)) return;
    trackedUsernames.add(username);
    resolveUidForUsername(username).then((uid) => {
      if (!uid) return;
      const connectionsRef = ref(db, `/status/${uid}/connections`);
      onValue(connectionsRef, (snap) => {
        const isOnline = snap.exists() && snap.hasChildren();
        const prev = onlineCache.get(username);
        onlineCache.set(username, isOnline);
        if (prev !== isOnline && typeof window.onPresenceChange === 'function') {
          window.onPresenceChange(username, isOnline);
        }
      }, (err) => console.warn(`Presence: listener error for @${username}`, err.message));
    });
  };

  // true/false once resolved; null while the uid lookup / first RTDB
  // snapshot is still in flight (caller decides how to treat "not yet known").
  window.isUserOnlineRTDB = function (username) {
    return onlineCache.has(username) ? onlineCache.get(username) === true : null;
  };
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