/* KAAX — cuentas, roles y equipos sobre Firebase.
 * Si config.firebase está vacío, la app cae a modo local (cuentas de config.users).
 * Modelo de datos en Firestore:
 *   users/{uid}   : email, name, role('admin'|'tecnico'), status('pendiente'|'activo'), teamId, requestedTeamId
 *   teams/{id}    : name, ownerUid, createdAt
 *   teams/{id}/sessions/{sid} : sesiones compartidas del equipo
 *   adminKeys/{sha256}        : documentos vacíos; el cliente NUNCA los lee, solo las reglas
 */
window.KaaxAuth = (() => {
"use strict";
const CFG = window.KAAX_CONFIG;
let fb = null, user = null, profile = null, listeners = [], ready = false;
const pending = new Set();   // ids de sesiones escritas sin confirmar en el servidor

// `profile` nace en null, así que el chequeo anterior (`!== undefined`) siempre
// era cierto y disparaba a los suscriptores antes de que init() supiera nada.
const on = (fn) => { listeners.push(fn); if (ready) fn(user, profile); };
const emit = () => listeners.forEach(fn => fn(user, profile));
const enabled = () => !!(CFG.firebase && CFG.firebase.apiKey && !CFG.firebase.apiKey.startsWith("PEGA"));

async function init() {
  if (!enabled()) { ready = true; emit(); return false; }
  let appM, authM, dbM;
  try {
    [appM, authM, dbM] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"),
    ]);
  } catch (e) {
    // Sin internet y sin el SDK en caché: la app sigue, en modo local.
    console.warn("Firebase no disponible sin conexión:", e.message);
    ready = true; emit(); return false;
  }
  const app = appM.initializeApp(CFG.firebase);
  // Caché persistente: sin esto, nada de lo que captures en el agua sobrevive
  // a un recargar de página, y cada lectura offline falla en vez de responder.
  let db;
  try {
    db = dbM.initializeFirestore(app, {
      localCache: dbM.persistentLocalCache({ tabManager: dbM.persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn("Caché persistente no disponible (¿modo incógnito?):", e.message);
    db = dbM.getFirestore(app);
  }
  fb = { auth: authM.getAuth(app), db, a: authM, d: dbM };
  // La sesión iniciada se guarda en IndexedDB, así el login sobrevive al campo.
  try { await authM.setPersistence(fb.auth, authM.browserLocalPersistence); } catch {}
  return new Promise((res) => {
    authM.onAuthStateChanged(fb.auth, async (u) => {
      user = u;
      try { profile = u ? await loadProfile(u.uid) : null; }
      catch (e) { console.warn("Perfil desde caché falló:", e.message); profile = null; }
      ready = true; emit(); res(true);
    });
  });
}

/** Corta o restablece la red de Firestore. Cortarla a propósito evita que cada
 *  escritura offline espere un timeout largo; lo pendiente queda en IndexedDB. */
async function setNetwork(on) {
  if (!fb) return false;
  try { on ? await fb.d.enableNetwork(fb.db) : await fb.d.disableNetwork(fb.db); return true; }
  catch (e) { console.warn("setNetwork:", e.message); return false; }
}

/** Espera a que todo lo encolado llegue al servidor. Devuelve cuántas subió. */
async function flushQueue() {
  if (!fb) return 0;
  const n = pending.size;
  await fb.d.enableNetwork(fb.db);
  await fb.d.waitForPendingWrites(fb.db);
  pending.clear();
  return n;
}
const pendingCount = () => pending.size;

const uref = (uid) => fb.d.doc(fb.db, "users", uid);
async function loadProfile(uid) { const s = await fb.d.getDoc(uref(uid)); return s.exists() ? { uid, ...s.data() } : null; }

async function sha256(t) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, "0")).join(""); }

async function signInGoogle() { await fb.a.signInWithPopup(fb.auth, new fb.a.GoogleAuthProvider()); }
async function signInEmail(email, pass) { await fb.a.signInWithEmailAndPassword(fb.auth, email, pass); }
async function signUpEmail(email, pass) { await fb.a.createUserWithEmailAndPassword(fb.auth, email, pass); }
async function signOut() { await fb.a.signOut(fb.auth); }
async function reset(email) { await fb.a.sendPasswordResetEmail(fb.auth, email); }

/** Crea el perfil tras el registro. role 'admin' exige la clave secreta (validada por reglas). */
async function createProfile({ name, role, adminKey, teamName, requestedTeamId }) {
  const doc = { email: user.email, name: name || user.displayName || user.email, role, createdAt: Date.now() };
  if (role === "admin") {
    doc.adminKeyHash = await sha256((adminKey || "").trim());
    doc.status = "activo";
    await fb.d.setDoc(uref(user.uid), doc);
    const t = await fb.d.addDoc(fb.d.collection(fb.db, "teams"), { name: teamName || ("Equipo de " + doc.name), ownerUid: user.uid, createdAt: Date.now() });
    await fb.d.updateDoc(uref(user.uid), { teamId: t.id });
  } else {
    doc.status = "pendiente"; doc.requestedTeamId = requestedTeamId || "";
    await fb.d.setDoc(uref(user.uid), doc);
  }
  profile = await loadProfile(user.uid); emit();
}

async function listTeams() {
  const q = await fb.d.getDocs(fb.d.collection(fb.db, "teams"));
  return q.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function requestTeam(teamId) { await fb.d.updateDoc(uref(user.uid), { requestedTeamId: teamId, status: "pendiente" }); profile = await loadProfile(user.uid); emit(); }

/** Admin: solicitudes pendientes y miembros de su equipo. */
async function teamMembers() {
  const tid = profile.teamId; if (!tid) return { pending: [], active: [] };
  const col = fb.d.collection(fb.db, "users");
  const [p, a] = await Promise.all([
    fb.d.getDocs(fb.d.query(col, fb.d.where("requestedTeamId", "==", tid), fb.d.where("status", "==", "pendiente"))),
    fb.d.getDocs(fb.d.query(col, fb.d.where("teamId", "==", tid), fb.d.where("status", "==", "activo"))),
  ]);
  const map = (s) => s.docs.map(d => ({ uid: d.id, ...d.data() }));
  return { pending: map(p), active: map(a) };
}
async function approve(uid) { await fb.d.updateDoc(uref(uid), { status: "activo", teamId: profile.teamId, requestedTeamId: "" }); }
async function reject(uid) { await fb.d.updateDoc(uref(uid), { status: "rechazado", requestedTeamId: "" }); }
async function removeMember(uid) { await fb.d.updateDoc(uref(uid), { status: "pendiente", teamId: "" }); }
async function renameTeam(name) { await fb.d.updateDoc(fb.d.doc(fb.db, "teams", profile.teamId), { name }); }
async function teamName() { if (!profile?.teamId) return ""; const s = await fb.d.getDoc(fb.d.doc(fb.db, "teams", profile.teamId)); return s.exists() ? s.data().name : ""; }

/** Sesiones compartidas del equipo. */
function pushSession(s) {
  if (!fb || !profile?.teamId) return false;
  const id = String(s.id);
  pending.add(id);
  // NO await: sin red, setDoc() no resuelve hasta que el servidor confirme, y
  // eso puede ser horas. La escritura sí entra ya en la caché local (IndexedDB)
  // y Firestore la reenvía sola en cuanto vuelve la conexión.
  fb.d.setDoc(fb.d.doc(fb.db, "teams", profile.teamId, "sessions", id), s)
    .then(() => pending.delete(id))
    .catch(e => console.warn("sesión encolada, se reintentará:", e.message));
  return true;
}
async function pullSessions() {
  if (!fb || !profile?.teamId) return null;
  const q = await fb.d.getDocs(fb.d.collection(fb.db, "teams", profile.teamId, "sessions"));
  return q.docs.map(d => d.data()).sort((a, b) => a.start - b.start);
}
async function deleteSession(id) { if (fb && profile?.teamId) await fb.d.deleteDoc(fb.d.doc(fb.db, "teams", profile.teamId, "sessions", String(id))); }

return { enabled, init, on, setNetwork, flushQueue, pendingCount,
         signInGoogle, signInEmail, signUpEmail, signOut, reset, createProfile,
         listTeams, requestTeam, teamMembers, approve, reject, removeMember, renameTeam, teamName,
         pushSession, pullSessions, deleteSession,
         get user() { return user; }, get profile() { return profile; } };
})();
