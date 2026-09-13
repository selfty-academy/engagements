// Pont « Engagements Selfty » : système d'accountability des élèves de la Selfty Academy (étape 1 : « le rappel qui marche »).
// Exécuté par le compte selfty.academy (les mails partent de cette adresse, nom « Anaïs, Selfty Academy »).
// Données dans le Google Sheet « Engagements Selfty » (onglets Engagements + Faits + Rappels) créé par what=setup.
// Aucune donnée personnelle dans ce code.
//
// doGet  ?key=…&what=setup            crée le Sheet + installe le déclencheur horaire (à ouvrir UNE fois dans un navigateur
//                                     connecté à selfty.academy@gmail.com : c'est là que l'autorisation OAuth se fait)
// doGet  ?key=…&what=list&email=…     engagements + faits de cet e-mail (JSON)
// doGet  ?key=…&what=tick&h=9         lance à la main ce que ferait le déclencheur à l'heure h (test)
// doGet  ?what=done&id=…&jeton=…&d=AAAA-MM-JJ     bouton « C'est fait » du mail (page HTML de confirmation)
// doGet  ?what=skip&id=…&jeton=…&d=…              bouton « Pas aujourd'hui » du mail
// doGet  ?what=pause&id=…&jeton=…[&jours=1..7]    bouton « Mettre en pause » du mail (page de choix, puis pause)
// doGet  ?what=note&id=…&jeton=…&d=…&note=…       noter sa preuve en un mot après le clic
// doPost { key, what, … } :
//   list     { email }
//   declare  { prenom, email, whatsapp?, action, frequence (quotidien|jours|hebdo), jours ("1,2,3" lundi=1), heure ("07:00"), pourquoi, preuve }
//   done     { id, email, d?, note? }         d = aujourd'hui (défaut) ou hier
//   skip     { id, email, d? }                « pas aujourd'hui » (ne casse pas la série, compte dans le taux)
//   pause    { id, email, jours (1..7) }      pause déclarée : neutre pour la série, 2 pauses max par engagement
//   resume   { id, email }                    fin de pause anticipée
//   stop     { id, email }                    engagement terminé (reste dans l'historique)
//   tick     { h? }                           comme le GET tick
//   mail_test { to }
//   setup    {}
//
// Déclencheur : chaqueHeure (toutes les heures). À chaque passage : reprise des pauses échues, rappels dont l'heure
// choisie = heure courante (idempotent par jour : colonne « Dernier rappel »), à 9h le mail « série cassée » et les
// relances WhatsApp préremplies (onglet Rappels, jamais envoyées automatiquement), le lundi à 7h le mail de la semaine.
//
// Déploiement : clasp --user selfty (compte selfty.academy), voir README. Jamais `clasp deploy` après le premier
// (nouvelle URL) : `clasp redeploy <deploymentId> --user selfty`.

// À exécuter une fois dans l'éditeur si l'autorisation par l'URL /exec ne passe pas (Sheets, Drive, mail, déclencheurs)
function autoriser() {
  const ss = book();
  tab(ss, EN_TAB, EN_HDR);
  tab(ss, FA_TAB, FA_HDR);
  tab(ss, RA_TAB, RA_HDR);
  ScriptApp.getProjectTriggers();
  MailApp.getRemainingDailyQuota();
  Logger.log('OK ' + ss.getUrl());
}

const KEY = 'engagements-e1f019f1c9cbf72a9e75b5b8';
const P = PropertiesService.getScriptProperties();
const TZ = 'Europe/Paris';
const PAGE_URL = 'https://selfty-academy.github.io/engagements/';
const LOGO_URL = 'https://selfty-academy.github.io/console/contrat/logo.png';
const MAIL_NAME = 'Anaïs, Selfty Academy';
const SHEET_NAME = 'Engagements Selfty';
const PROGRAMME_DEBUT = '2026-10-12';    // lundi de la semaine 1 du programme (rentrée le 10/10/2026)
const PROGRAMME_SEMAINES = 27;
const HEURE_BILAN = 9;                   // série cassée + relances
const HEURE_LUNDI = 7;                   // mail du lundi
const SERIE_MIN_CASSE = 3;               // mail de casse seulement si la série était ≥ 3
const SEUIL_RELANCE = 2;                 // jours de silence avant la relance WhatsApp d'Anaïs
const SEUIL_APPEL = 5;                   // jours de silence avant la proposition d'appel
const PAUSE_MAX_JOURS = 7;
const PAUSE_MAX = 2;

const EN_TAB = 'Engagements';
const EN_HDR = ['ID', 'Créé le', 'Prénom', 'E-mail', 'WhatsApp', 'Action', 'Fréquence', 'Jours', 'Heure du rappel', 'Pourquoi', 'Preuve',
  'Statut', 'Pause du', 'Pause jusqu\'au', 'Pauses', 'Jeton', 'Début', 'Fin', 'Dernier rappel', 'MAJ'];
const EN_KEYS = ['id', 'created', 'prenom', 'email', 'whatsapp', 'action', 'frequence', 'jours', 'heure', 'pourquoi', 'preuve',
  'statut', 'pause_du', 'pause_jusqu', 'pauses', 'jeton', 'debut', 'fin', 'dernier_rappel', 'updated'];
const FA_TAB = 'Faits';
const FA_HDR = ['Date', 'E-mail', 'ID engagement', 'Fait', 'Heure du clic', 'Source', 'Note'];
const FA_KEYS = ['date', 'email', 'id', 'fait', 'at', 'source', 'note'];
const RA_TAB = 'Rappels';
const RA_HDR = ['Date', 'Type', 'ID engagement', 'Prénom', 'E-mail', 'Action', 'Série', 'Jours manqués', 'Message / lien', 'Traité le'];
const RA_KEYS = ['date', 'type', 'id', 'prenom', 'email', 'action', 'serie', 'manques', 'lien', 'traite'];

const FREQUENCES = ['quotidien', 'jours', 'hebdo'];

// ---------- entrées ----------
function doGet(e) {
  const q = (e && e.parameter) || {};
  const what = String(q.what || '');
  if (['done', 'skip', 'pause', 'note'].indexOf(what) >= 0) return pageAction(what, q);   // liens des mails : par jeton
  if (q.key !== KEY) return out({ ok: true, pong: true, v: 1 });
  try {
    if (what === 'setup') return out(setup());
    if (what === 'list') return out(list(q));
    if (what === 'tick') return out(chaqueHeure(q.h === undefined ? undefined : Number(q.h)));
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
  return out({ ok: true, pong: true, v: 1 });
}

function doPost(e) {
  let p = {};
  try { p = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  if (p.key !== KEY) return out({ ok: false, error: 'bad key' });
  try {
    if (p.what === 'setup') return out(setup());
    if (p.what === 'list') return out(list(p));
    if (p.what === 'declare') return out(declare(p));
    if (p.what === 'done') return out(doneAction(p, 'page'));
    if (p.what === 'skip') return out(skipAction(p, 'page'));
    if (p.what === 'pause') return out(pauseAction(p));
    if (p.what === 'resume') return out(resumeAction(p));
    if (p.what === 'stop') return out(stopAction(p));
    if (p.what === 'tick') return out(chaqueHeure(p.h === undefined ? undefined : Number(p.h)));
    if (p.what === 'mail_test') {
      const to = cleanEmail(p.to);
      if (!to) return out({ ok: false, error: 'e-mail manquant' });
      sendMail(to, 'Test : Engagements Selfty', 'Le pont des engagements fonctionne.', ['<p>Le pont des engagements fonctionne.</p>']);
      return out({ ok: true, quota: MailApp.getRemainingDailyQuota() });
    }
    return out({ ok: false, error: 'unknown what' });
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------- setup ----------
function setup() {
  const ss = book();
  tab(ss, EN_TAB, EN_HDR);
  tab(ss, FA_TAB, FA_HDR);
  tab(ss, RA_TAB, RA_HDR);
  const def = ss.getSheetByName('Feuille 1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  installTriggers();
  return {
    ok: true, sheet_url: ss.getUrl(), sheet_id: ss.getId(), exec_url: execUrl(),
    triggers: ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()),
    mail_quota: MailApp.getRemainingDailyQuota(),
  };
}

function book() {
  let id = P.getProperty('SHEET_ID');
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recréé ci-dessous */ } }
  const ss = SpreadsheetApp.create(SHEET_NAME);
  P.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function tab(ss, name, hdr) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn() < hdr.length) {
    sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
  }
  return sh;
}

// Un seul déclencheur : toutes les heures (les anciens sont supprimés d'abord)
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('chaqueHeure').timeBased().everyHours(1).create();
}

function execUrl() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

// ---------- lecture ----------
function rows(sh, keys) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  const v = sh.getRange(2, 1, last - 1, keys.length).getValues();
  return v.filter(r => r[0] !== '').map((r, i) => {
    const o = { _row: i + 2 };
    keys.forEach((k, j) => { o[k] = cell(r[j]); });
    return o;
  });
}
function cell(x) {
  if (x instanceof Date) return Utilities.formatDate(x, TZ, "yyyy-MM-dd'T'HH:mm:ss");
  return x;
}
function stamp() { return Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd'T'HH:mm:ss"); }
function today() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowH() { return Number(Utilities.formatDate(new Date(), TZ, 'H')); }
function cleanEmail(s) { s = String(s || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ''; }
function cleanName(s) { return String(s || '').trim().replace(/\s+/g, ' ').slice(0, 40); }
function cleanText(s, n) { return String(s || '').trim().replace(/\s+/g, ' ').slice(0, n || 300); }
function cleanPhone(s) {
  let d = String(s || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '33' + d.slice(1);
  return /^\d{8,15}$/.test(d) ? d : '';
}
function isoOk(d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')); }

function setCells(sh, keys, row, obj) {
  Object.keys(obj).forEach(k => {
    const i = keys.indexOf(k);
    if (i >= 0) sh.getRange(row, i + 1).setNumberFormat('@').setValue(obj[k]);
  });
  const u = keys.indexOf('updated');
  if (u >= 0) sh.getRange(row, u + 1).setNumberFormat('@').setValue(stamp());
}
function appendRow(sh, keys, obj) {
  const r = keys.map(k => obj[k] === undefined || obj[k] === null ? '' : obj[k]);
  sh.appendRow(r);
  sh.getRange(sh.getLastRow(), 1, 1, keys.length).setNumberFormat('@');
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------- dates (identiques côté page) ----------
function addDays(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isoDow(iso) { const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z').getUTCDay(); return d === 0 ? 7 : d; }   // lundi = 1
function weekStart(iso) { return addDays(iso, 1 - isoDow(iso)); }
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const JOURS_COURT = ['', 'L', 'M', 'M', 'J', 'V', 'S', 'D'];
const JOURS_ISO = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
function dateFr(iso) {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  return JOURS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MOIS[d.getUTCMonth()];
}
function heureFr(h) { return String(h).slice(0, 5).replace(':00', 'h').replace(':', 'h'); }
function semaineProgramme(iso) { return Math.floor((new Date(iso + 'T12:00:00Z') - new Date(PROGRAMME_DEBUT + 'T12:00:00Z')) / 86400000 / 7) + 1; }

// ---------- calcul des séries (même logique dans index.html) ----------
function joursSet(e) {
  if (e.frequence === 'quotidien') return [1, 2, 3, 4, 5, 6, 7];
  return String(e.jours || '').split(',').map(Number).filter(n => n >= 1 && n <= 7);
}
function scheduled(e, d) {
  if (d < String(e.debut).slice(0, 10)) return false;
  if (e.fin && d > String(e.fin).slice(0, 10)) return false;
  return joursSet(e).indexOf(isoDow(d)) >= 0;
}
// date -> oui | non | pause (un « Fait » hebdo est rattaché au jour prévu de sa semaine)
function etatMap(e, faits) {
  const m = {};
  const jour = joursSet(e)[0] || 7;
  faits.forEach(f => {
    let d = String(f.date).slice(0, 10);
    if (e.frequence === 'hebdo') d = addDays(weekStart(d), jour - 1);
    const v = String(f.fait);
    if (m[d] === 'oui') return;
    if (v === 'oui' || !m[d] || (v === 'pause' && m[d] === 'non')) m[d] = v;
  });
  return m;
}
// ref = « aujourd'hui » du calcul. États : fait | rate | passe (pas aujourd'hui) | pause | attente (aujourd'hui, pas encore) | avenir | hors
function calc(e, faits, ref) {
  const m = etatMap(e, faits);
  const st = d => !scheduled(e, d) ? 'hors' : m[d] === 'oui' ? 'fait' : m[d] === 'pause' ? 'pause' : m[d] === 'non' ? 'passe'
    : d > ref ? 'avenir' : d === ref ? 'attente' : 'rate';
  const debut = String(e.debut).slice(0, 10);
  let serie = 0, d, guard = 0;
  if (st(ref) === 'fait') serie++;
  d = addDays(ref, -1);
  while (guard++ < 400 && d >= debut) { const s = st(d); if (s === 'fait') serie++; else if (s === 'rate') break; d = addDays(d, -1); }
  let record = 0, run = 0, done28 = 0, total28 = 0;
  const lim28 = addDays(ref, -27);
  for (let x = debut, g = 0; x <= ref && g < 400; x = addDays(x, 1), g++) {
    const s = st(x);
    if (s === 'fait') { run++; if (run > record) record = run; } else if (s === 'rate') run = 0;
    if (x >= lim28 && (s === 'fait' || s === 'rate' || s === 'passe')) { total28++; if (s === 'fait') done28++; }
  }
  let manques = 0; d = addDays(ref, -1); guard = 0;
  while (guard++ < 400 && d >= debut) { const s = st(d); if (s === 'rate') manques++; else if (s !== 'hors' && s !== 'avenir') break; d = addDays(d, -1); }
  const lastDone = Object.keys(m).filter(k => m[k] === 'oui').sort().pop() || '';
  return { serie: serie, record: Math.max(record, serie), manques: manques, done28: done28, total28: total28, lastDone: lastDone,
    pending: st(ref) === 'attente', today_state: st(ref), st: st };
}
// grille des 4 dernières semaines (lundi → dimanche), semaine courante en bas
function grille(e, faits, ref) {
  const c = calc(e, faits, ref), out = [];
  const start = addDays(weekStart(ref), -21);
  for (let w = 0; w < 4; w++) {
    const row = [];
    for (let i = 0; i < 7; i++) { const d = addDays(start, w * 7 + i); row.push({ d: d, s: c.st(d) }); }
    out.push(row);
  }
  return out;
}
function unite(e, n) { return e.frequence === 'hebdo' ? (n > 1 ? 'semaines' : 'semaine') : (n > 1 ? 'jours' : 'jour'); }
function freqTxt(e) {
  const j = joursSet(e);
  if (e.frequence === 'quotidien' || j.length === 7) return 'tous les jours';
  if (e.frequence === 'hebdo') return 'chaque ' + JOURS_ISO[j[0] || 7];
  return 'les ' + j.map(n => JOURS_ISO[n]).join(', ');
}

// ---------- données ----------
function loadAll() {
  const ss = book();
  return {
    ss: ss,
    shE: tab(ss, EN_TAB, EN_HDR), shF: tab(ss, FA_TAB, FA_HDR), shR: tab(ss, RA_TAB, RA_HDR),
    engs: rows(tab(ss, EN_TAB, EN_HDR), EN_KEYS),
    faits: rows(tab(ss, FA_TAB, FA_HDR), FA_KEYS),
  };
}
function faitsDe(all, id) { return all.faits.filter(f => String(f.id) === String(id)); }
function findEng(all, id) { return all.engs.find(e => String(e.id) === String(id)) || null; }
function pub(e) {
  return { id: e.id, created: e.created, prenom: e.prenom, action: e.action, frequence: e.frequence, jours: String(e.jours || ''),
    heure: String(e.heure || '').slice(0, 5), pourquoi: e.pourquoi || '', preuve: e.preuve || '', statut: e.statut,
    pause_du: String(e.pause_du || '').slice(0, 10), pause_jusqu: String(e.pause_jusqu || '').slice(0, 10), pauses: Number(e.pauses) || 0,
    debut: String(e.debut || '').slice(0, 10), fin: String(e.fin || '').slice(0, 10) };
}

function list(p) {
  const email = cleanEmail(p.email);
  if (!email) return { ok: false, error: 'e-mail manquant' };
  const all = loadAll();
  const mine = all.engs.filter(e => e.email === email);
  const ids = mine.map(e => String(e.id));
  const lim = addDays(today(), -60);
  return {
    ok: true, today: today(),
    engagements: mine.map(pub),
    faits: all.faits.filter(f => ids.indexOf(String(f.id)) >= 0 && String(f.date).slice(0, 10) >= lim)
      .map(f => ({ date: String(f.date).slice(0, 10), id: String(f.id), fait: f.fait, note: f.note || '' })),
  };
}

// ---------- déclaration ----------
function declare(p) {
  const prenom = cleanName(p.prenom), email = cleanEmail(p.email);
  if (!prenom || !email) return { ok: false, error: 'prénom ou e-mail manquant' };
  const action = cleanText(p.action, 160);
  if (action.length < 3) return { ok: false, error: 'décris ton action' };
  const frequence = FREQUENCES.indexOf(p.frequence) >= 0 ? p.frequence : 'quotidien';
  let jours = String(p.jours || '').split(',').map(Number).filter(n => n >= 1 && n <= 7);
  jours = jours.filter((n, i) => jours.indexOf(n) === i).sort();
  if (frequence === 'quotidien') jours = [1, 2, 3, 4, 5, 6, 7];
  if (frequence === 'jours' && !jours.length) return { ok: false, error: 'choisis au moins un jour' };
  if (frequence === 'hebdo') { if (jours.length !== 1) return { ok: false, error: 'choisis le jour où c\'est fait au plus tard' }; }
  let h = parseInt(String(p.heure || '7').slice(0, 2), 10); if (isNaN(h) || h < 5 || h > 22) h = 7;
  const heure = (h < 10 ? '0' : '') + h + ':00';
  const pourquoi = cleanText(p.pourquoi, 300), preuve = cleanText(p.preuve, 160), whatsapp = cleanPhone(p.whatsapp);
  return withLock(() => {
    const all = loadAll();
    const t = today();
    // un seul engagement quotidien (ou « certains jours ») et un seul hebdo par élève : l'ancien passe en « terminé »
    const kind = x => x.frequence === 'hebdo' ? 'hebdo' : 'jour';
    let remplace = '';
    all.engs.filter(e => e.email === email && (e.statut === 'actif' || e.statut === 'pause') && kind(e) === kind({ frequence: frequence })).forEach(e => {
      setCells(all.shE, EN_KEYS, e._row, { statut: 'terminé', fin: t });
      remplace = e.action;
    });
    const id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const e = { id: id, created: stamp(), prenom: prenom, email: email, whatsapp: whatsapp, action: action, frequence: frequence, jours: jours.join(','),
      heure: heure, pourquoi: pourquoi, preuve: preuve, statut: 'actif', pause_du: '', pause_jusqu: '', pauses: 0, jeton: jeton(), debut: t, fin: '',
      dernier_rappel: '', updated: stamp() };
    appendRow(all.shE, EN_KEYS, e);
    let mail = false;
    try { mailPose(e, remplace); mail = true; } catch (err) { Logger.log('mail pose : ' + err); }
    return { ok: true, id: id, engagement: pub(e), remplace: remplace, mail: mail };
  });
}
function jeton() { return Utilities.getUuid().replace(/-/g, '').slice(0, 20); }

// ---------- fait / pas aujourd'hui / pause / stop ----------
function mine(all, p) {
  const email = cleanEmail(p.email);
  const e = findEng(all, p.id);
  if (!e || !email || e.email !== email) throw new Error('engagement introuvable');
  return e;
}
function byJeton(all, q) {
  const e = findEng(all, q.id);
  if (!e || !q.jeton || String(e.jeton) !== String(q.jeton)) return null;
  return e;
}
// date acceptée pour un « Fait » : aujourd'hui, hier (jusqu'à minuit), et pour un hebdo n'importe quel jour de la semaine en cours
function dateAcceptee(e, d, t) {
  if (!isoOk(d)) return false;
  if (d > t) return false;
  if (d === t || d === addDays(t, -1)) return true;
  if (e.frequence === 'hebdo' && weekStart(d) === weekStart(t)) return true;
  return false;
}
function writeFait(all, e, d, val, source, note) {
  const ex = all.faits.filter(f => String(f.id) === String(e.id) && String(f.date).slice(0, 10) === d);
  const done = ex.find(f => String(f.fait) === 'oui');
  if (done) { if (note) setCells(all.shF, FA_KEYS, done._row, { note: note }); return false; }
  if (ex.length && val !== 'oui') return false;             // déjà un « non » ou une pause ce jour-là
  if (ex.length) { setCells(all.shF, FA_KEYS, ex[0]._row, { fait: 'oui', at: stamp(), source: source, note: note || ex[0].note || '' }); return true; }
  appendRow(all.shF, FA_KEYS, { date: d, email: e.email, id: e.id, fait: val, at: stamp(), source: source, note: note || '' });
  return true;
}
function doneAction(p, source) {
  return withLock(() => {
    const all = loadAll();
    const e = source === 'mail' ? byJeton(all, p) : mine(all, p);
    if (!e) throw new Error('lien invalide');
    if (e.statut === 'terminé') throw new Error('cet engagement est terminé');
    const t = today();
    const d = p.d ? String(p.d).slice(0, 10) : t;
    if (!dateAcceptee(e, d, t)) return { ok: false, error: 'Ce lien concernait le ' + dateFr(d) + ' : un « Fait » se pose le jour même ou le lendemain avant minuit.' };
    if (!scheduled(e, d) && e.frequence !== 'hebdo') return { ok: false, error: 'Rien de prévu le ' + dateFr(d) + ' pour cet engagement.' };
    const neuf = writeFait(all, e, d, 'oui', source, cleanText(p.note, 200));
    all.faits = rows(all.shF, FA_KEYS);
    const c = calc(e, faitsDe(all, e.id), t);
    return { ok: true, id: e.id, d: d, neuf: neuf, serie: c.serie, record: c.record, done28: c.done28, total28: c.total28, grille: grille(e, faitsDe(all, e.id), t), engagement: pub(e) };
  });
}
function skipAction(p, source) {
  return withLock(() => {
    const all = loadAll();
    const e = source === 'mail' ? byJeton(all, p) : mine(all, p);
    if (!e) throw new Error('lien invalide');
    const t = today();
    const d = p.d ? String(p.d).slice(0, 10) : t;
    if (!dateAcceptee(e, d, t)) return { ok: false, error: 'Ce lien concernait le ' + dateFr(d) + '.' };
    writeFait(all, e, d, 'non', source, cleanText(p.note, 200));
    all.faits = rows(all.shF, FA_KEYS);
    const c = calc(e, faitsDe(all, e.id), t);
    return { ok: true, id: e.id, d: d, serie: c.serie, record: c.record };
  });
}
function pauseAction(p, source) {
  return withLock(() => {
    const all = loadAll();
    const e = source === 'mail' ? byJeton(all, p) : mine(all, p);
    if (!e) throw new Error('lien invalide');
    if (e.statut === 'terminé') throw new Error('cet engagement est terminé');
    if (e.statut === 'pause') return { ok: true, deja: true, jusqu: String(e.pause_jusqu).slice(0, 10) };
    if ((Number(e.pauses) || 0) >= PAUSE_MAX) return { ok: false, error: 'Tu as déjà utilisé tes ' + PAUSE_MAX + ' pauses sur le programme.' };
    let n = parseInt(p.jours, 10); if (isNaN(n) || n < 1) n = 1; if (n > PAUSE_MAX_JOURS) n = PAUSE_MAX_JOURS;
    const t = today(), fin = addDays(t, n - 1);
    for (let i = 0; i < n; i++) writeFait(all, e, addDays(t, i), 'pause', source, '');
    setCells(all.shE, EN_KEYS, e._row, { statut: 'pause', pause_du: t, pause_jusqu: fin, pauses: (Number(e.pauses) || 0) + 1 });
    return { ok: true, id: e.id, du: t, jusqu: fin, jours: n, reprise: addDays(fin, 1) };
  });
}
function resumeAction(p) {
  return withLock(() => {
    const all = loadAll();
    const e = mine(all, p);
    if (e.statut !== 'pause') return { ok: true };
    const t = today();
    // les jours de pause à venir (et aujourd'hui) sont retirés
    all.faits.filter(f => String(f.id) === String(e.id) && String(f.fait) === 'pause' && String(f.date).slice(0, 10) >= t)
      .sort((a, b) => b._row - a._row).forEach(f => all.shF.deleteRow(f._row));
    setCells(all.shE, EN_KEYS, e._row, { statut: 'actif', pause_jusqu: addDays(t, -1) });
    return { ok: true };
  });
}
function stopAction(p) {
  return withLock(() => {
    const all = loadAll();
    const e = mine(all, p);
    if (e.statut === 'terminé') return { ok: true };
    setCells(all.shE, EN_KEYS, e._row, { statut: 'terminé', fin: today() });
    return { ok: true };
  });
}

// ---------- déclencheur horaire ----------
function chaqueHeure(hForce) {
  const h = (hForce === undefined || isNaN(hForce)) ? nowH() : hForce;
  const t = today();
  const r = { ok: true, h: h, date: t, reprises: 0, rappels: 0, casses: 0, relances: 0, lundi: 0 };
  try { r.reprises = reprisePauses(); } catch (e) { Logger.log('reprises : ' + e); }
  try { r.rappels = rappelsHeure(h); } catch (e) { Logger.log('rappels : ' + e); }
  if (h === HEURE_BILAN) {
    try { r.casses = serieCassee(); } catch (e) { Logger.log('casse : ' + e); }
    try { r.relances = relances(); } catch (e) { Logger.log('relances : ' + e); }
  }
  if (h === HEURE_LUNDI && isoDow(t) === 1) { try { r.lundi = mailLundi(); } catch (e) { Logger.log('lundi : ' + e); } }
  return r;
}

function reprisePauses() {
  const all = loadAll(), t = today();
  let n = 0;
  all.engs.forEach(e => {
    if (e.statut === 'pause' && String(e.pause_jusqu).slice(0, 10) < t) { setCells(all.shE, EN_KEYS, e._row, { statut: 'actif' }); n++; }
  });
  return n;
}

// Rappels de l'heure courante (rattrapage possible sur l'heure suivante), jamais deux fois le même jour
function rappelsHeure(h) {
  const all = loadAll(), t = today();
  let n = 0;
  all.engs.forEach(e => {
    if (e.statut !== 'actif') return;
    const hr = parseInt(String(e.heure).slice(0, 2), 10);
    if (isNaN(hr) || h < hr || h > hr + 1) return;
    if (String(e.dernier_rappel).slice(0, 10) === t) return;
    if (!scheduled(e, t)) return;
    const c = calc(e, faitsDe(all, e.id), t);
    if (!c.pending) return;
    try {
      mailRappel(e, c, t);
      setCells(all.shE, EN_KEYS, e._row, { dernier_rappel: t });
      appendRow(all.shR, RA_KEYS, { date: t, type: 'rappel', id: e.id, prenom: e.prenom, email: e.email, action: e.action, serie: c.serie, manques: c.manques, lien: '', traite: '' });
      n++;
    } catch (err) { Logger.log('rappel ' + e.id + ' : ' + err); }
  });
  return n;
}

// Mail « ta série s'est arrêtée hier » : à 9h, si hier était prévu, pas fait, et que la série d'avant-hier était ≥ 3
function serieCassee() {
  const all = loadAll(), t = today(), y = addDays(t, -1);
  const deja = rows(all.shR, RA_KEYS).filter(r => r.type === 'casse' && String(r.date).slice(0, 10) === t).map(r => String(r.id));
  let n = 0;
  all.engs.forEach(e => {
    if (e.statut !== 'actif' || deja.indexOf(String(e.id)) >= 0) return;
    if (!scheduled(e, y)) return;
    const f = faitsDe(all, e.id);
    const c = calc(e, f, t);
    if (c.st(y) !== 'rate') return;
    const avant = calc(e, f, addDays(y, -1));
    if (avant.serie < SERIE_MIN_CASSE) return;
    try {
      mailCasse(e, avant.serie, avant.record, t);
      appendRow(all.shR, RA_KEYS, { date: t, type: 'casse', id: e.id, prenom: e.prenom, email: e.email, action: e.action, serie: avant.serie, manques: 1, lien: '', traite: '' });
      n++;
    } catch (err) { Logger.log('casse ' + e.id + ' : ' + err); }
  });
  return n;
}

// Relance humaine : à 2 jours de silence, une ligne « relance » dans Rappels avec le WhatsApp prérempli pour Anaïs
// (une seule fois par épisode, c'est-à-dire jusqu'au prochain Fait) ; à 5 jours, une ligne « appel ».
function relances() {
  const all = loadAll(), t = today();
  const journal = rows(all.shR, RA_KEYS);
  let n = 0;
  all.engs.forEach(e => {
    if (e.statut !== 'actif') return;
    const c = calc(e, faitsDe(all, e.id), t);
    if (c.manques < SEUIL_RELANCE) return;
    const type = c.manques >= SEUIL_APPEL ? 'appel' : 'relance';
    const dejaEpisode = journal.some(r => r.type === type && String(r.id) === String(e.id) && String(r.date).slice(0, 10) > (c.lastDone || '0000'));
    if (dejaEpisode) return;
    const msg = type === 'appel'
      ? e.prenom + ', je t\'appelle 10 minutes cette semaine, quand ? Mardi 12h ou jeudi 18h ?'
      : 'Hello ' + e.prenom + ', c\'est Anaïs. Je vois deux jours sans ton action « ' + e.action + ' ». Je ne te demande pas pourquoi, je te demande juste : tu la fais aujourd\'hui ? Un mot et je te laisse tranquille 🌸';
    const lien = 'https://wa.me/' + (e.whatsapp ? String(e.whatsapp) : '') + '?text=' + encodeURIComponent(msg);
    appendRow(all.shR, RA_KEYS, { date: t, type: type, id: e.id, prenom: e.prenom, email: e.email, action: e.action, serie: c.serie, manques: c.manques, lien: lien, traite: '' });
    n++;
  });
  return n;
}

// Mail du lundi 7h : une fois par élève ayant au moins un engagement actif
function mailLundi() {
  const all = loadAll(), t = today();
  const deja = rows(all.shR, RA_KEYS).filter(r => r.type === 'lundi' && String(r.date).slice(0, 10) === t).map(r => r.email);
  const par = {};
  all.engs.forEach(e => { if (e.statut === 'actif' || e.statut === 'pause') (par[e.email] = par[e.email] || []).push(e); });
  let n = 0;
  Object.keys(par).forEach(email => {
    if (deja.indexOf(email) >= 0) return;
    const engs = par[email];
    const lundiPrec = addDays(weekStart(t), -7), dimPrec = addDays(weekStart(t), -1);
    const bilans = engs.map(e => {
      const c = calc(e, faitsDe(all, e.id), t);
      let x = 0, y = 0;
      for (let d = lundiPrec; d <= dimPrec; d = addDays(d, 1)) { const s = c.st(d); if (s === 'fait') { x++; y++; } else if (s === 'rate' || s === 'passe') y++; }
      return { e: e, c: c, x: x, y: y };
    });
    try {
      mailSemaine(engs[0].prenom, email, bilans, t);
      appendRow(all.shR, RA_KEYS, { date: t, type: 'lundi', id: engs.map(e => e.id).join(' '), prenom: engs[0].prenom, email: email, action: '', serie: '', manques: '', lien: '', traite: '' });
      n++;
    } catch (err) { Logger.log('lundi ' + email + ' : ' + err); }
  });
  return n;
}

// ---------- mails ----------
function lien(what, e, d, extra) {
  return execUrl() + '?what=' + what + '&id=' + encodeURIComponent(e.id) + '&jeton=' + encodeURIComponent(e.jeton) + (d ? '&d=' + d : '') + (extra || '');
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function bouton(url, label, style) {
  const bg = style === 'ghost' ? '#FFFDFB' : '#966868', col = style === 'ghost' ? '#7E5252' : '#FFFDFB';
  return '<a href="' + esc(url) + '" style="display:inline-block;background:' + bg + ';color:' + col + ';border:1px solid #966868;border-radius:999px;padding:12px 22px;font-weight:600;text-decoration:none;margin:4px 6px 4px 0">' + label + '</a>';
}
function cadre(blocs) {
  return '<div style="background:#FAEEEE;padding:24px 12px;font-family:Jost,Helvetica,Arial,sans-serif;color:#3A2A2A;font-size:16px;line-height:1.55">'
    + '<div style="max-width:560px;margin:0 auto;background:#FFFDFB;border:1px solid #EBD2D2;border-radius:16px;padding:26px 24px">'
    + '<img src="' + LOGO_URL + '" alt="Selfty Academy" style="height:34px;display:block;margin-bottom:18px">'
    + blocs.map(b => '<div style="margin:0 0 14px">' + b + '</div>').join('')
    + '<p style="margin:22px 0 0;color:#8A7070;font-size:13px">Selfty Academy · <a href="' + PAGE_URL + '" style="color:#7E5252">Mes engagements</a></p>'
    + '</div></div>';
}
function sendMail(to, subject, texte, blocs) {
  MailApp.sendEmail({ to: to, name: MAIL_NAME, subject: subject, body: texte + '\n\n' + PAGE_URL, htmlBody: cadre(blocs) });
}
function phraseSerie(n, record, e) {
  const u = unite(e, n);
  if (n === 0) return 'Aujourd\'hui, tu commences. Le jour 1 est le seul qui ne dépend que de toi.';
  if (n >= 30 && e.frequence !== 'hebdo') return 'Un mois. Ce n\'est plus une action, c\'est qui tu es.';
  if (n === record) return 'C\'est ton record. Demain, tu le dépasses.';
  if (n % 7 === 0 && e.frequence !== 'hebdo') return n + ' jours. Une semaine de plus que celle que tu croyais possible.';
  if (n <= 6) return 'Les premiers ' + u + ' sont les plus chers. Tiens.';
  return n + ' ' + u + '. Tu tiens. Continue.';
}

// 4.1 Le rappel quotidien (à l'heure choisie)
function mailRappel(e, c, t) {
  const n = c.serie, u = unite(e, n);
  const subject = e.prenom + ', ton action du jour · série ' + n + ' 🔥';
  const ps = phraseSerie(n, c.record, e);
  const texte = e.prenom + ',\n\nAujourd\'hui, c\'est : ' + e.action + '.\n\n'
    + (e.pourquoi ? 'Tu l\'as posée parce que : « ' + e.pourquoi + ' ».\n\n' : '')
    + 'Série en cours : ' + n + ' ' + u + '. ' + ps + '\n\n'
    + 'C\'est fait : ' + lien('done', e, t) + '\n\n'
    + 'Pas aujourd\'hui ? Dis-le, ça vaut mieux qu\'un silence : ' + lien('skip', e, t) + ' · Mettre en pause : ' + lien('pause', e, '') + '\n\n'
    + (e.preuve ? 'Ta preuve pour aujourd\'hui : ' + e.preuve + '. Tu peux la noter en un mot après avoir cliqué.\n\n' : '')
    + 'Anaïs';
  const blocs = [
    '<p>' + esc(e.prenom) + ',</p>',
    '<p>Aujourd\'hui, c\'est : <b>' + esc(e.action) + '</b>.</p>',
    e.pourquoi ? '<p>Tu l\'as posée parce que : « ' + esc(e.pourquoi) + ' ».</p>' : '',
    '<p>Série en cours : <b>' + n + ' ' + u + '</b>. ' + esc(ps) + '</p>',
    '<p style="margin:18px 0">' + bouton(lien('done', e, t), 'C\'est fait ✓') + '</p>',
    '<p style="font-size:14.5px;color:#5C4646">Pas aujourd\'hui ? Dis-le, ça vaut mieux qu\'un silence : ' + bouton(lien('skip', e, t), 'Pas aujourd\'hui', 'ghost') + bouton(lien('pause', e, ''), 'Mettre en pause', 'ghost') + '</p>',
    e.preuve ? '<p style="font-size:14.5px;color:#5C4646">Ta preuve pour aujourd\'hui : ' + esc(e.preuve) + '. Tu peux la noter en un mot après avoir cliqué.</p>' : '',
    '<p>Anaïs</p>',
  ].filter(Boolean);
  sendMail(e.email, subject, texte, blocs);
}

// 4.2 Le mail de série cassée
function mailCasse(e, n, record, t) {
  const u = unite(e, n);
  const subject = e.prenom + ', ta série de ' + n + ' ' + u + ' s\'est arrêtée hier';
  const texte = e.prenom + ',\n\nHier, pas de « Fait » pour ' + e.action + '. Ta série de ' + n + ' ' + u + ' s\'est arrêtée.\n\n'
    + 'Ce n\'est pas grave. Ce qui compte, c\'est ce que tu fais aujourd\'hui : une série de ' + n + ' ' + u + ' prouve que tu sais le faire. Tu recommences à 1, avec ton record à ' + record + ' en ligne de mire.\n\n'
    + 'Une chose, quand même. Qu\'est-ce qui s\'est passé, hier ? Réponds à ce mail en un mot. Je lis.\n\n'
    + 'Je reprends aujourd\'hui : ' + lien('done', e, t) + '\n\nAnaïs';
  const blocs = [
    '<p>' + esc(e.prenom) + ',</p>',
    '<p>Hier, pas de « Fait » pour <b>' + esc(e.action) + '</b>. Ta série de <b>' + n + ' ' + u + '</b> s\'est arrêtée.</p>',
    '<p>Ce n\'est pas grave. Ce qui compte, c\'est ce que tu fais aujourd\'hui : une série de ' + n + ' ' + u + ' prouve que tu sais le faire. Tu recommences à 1, avec ton record à ' + record + ' en ligne de mire.</p>',
    '<p>Une chose, quand même. Qu\'est-ce qui s\'est passé, hier ? Réponds à ce mail en un mot. Je lis.</p>',
    '<p style="margin:18px 0">' + bouton(lien('done', e, t), 'Je reprends aujourd\'hui ✓') + '</p>',
    '<p>Anaïs</p>',
  ];
  sendMail(e.email, subject, texte, blocs);
}

// 4.4 Le mail du lundi (version étape 1 : bilan du vendredi, engagement de la semaine et « 3 choses » arrivent à l'étape 2)
function mailSemaine(prenom, email, bilans, t) {
  const k = semaineProgramme(t);
  const sem = k >= 1 && k <= PROGRAMME_SEMAINES ? 'Semaine ' + k + ' sur ' + PROGRAMME_SEMAINES : 'Nouvelle semaine';
  const subject = (k >= 1 && k <= PROGRAMME_SEMAINES ? 'Ta semaine ' + k + ' sur ' + PROGRAMME_SEMAINES : 'Ta semaine') + ', ' + prenom;
  const lignes = bilans.map(b => b.e.frequence === 'hebdo'
    ? 'action hebdo « ' + b.e.action + ' » ' + (b.x > 0 ? 'faite' : 'pas faite')
    : b.x + ' jour' + (b.x > 1 ? 's' : '') + ' sur ' + b.y + ' pour « ' + b.e.action + ' »' + (b.c.serie ? ' (série ' + b.c.serie + ')' : ''));
  const texte = prenom + ',\n\n' + sem + '. La semaine dernière : ' + lignes.join(', ') + '.\n\n'
    + 'Une question pour commencer : qu\'est-ce qui rendrait cette semaine réussie, en une phrase ? Réponds à ce mail, je lis tout le lundi matin.\n\nAnaïs';
  const blocs = [
    '<p>' + esc(prenom) + ',</p>',
    '<p><b>' + sem + '.</b> La semaine dernière : ' + esc(lignes.join(', ')) + '.</p>',
    '<p>Une question pour commencer : qu\'est-ce qui rendrait cette semaine réussie, en une phrase ? Réponds à ce mail, je lis tout le lundi matin.</p>',
    '<p style="margin:18px 0">' + bouton(PAGE_URL, 'Voir mes engagements', 'ghost') + '</p>',
    '<p>Anaïs</p>',
  ];
  sendMail(email, subject, texte, blocs);
}

// Mail « Ton engagement est posé » (à la déclaration)
function mailPose(e, remplace) {
  const t = today();
  const premier = scheduled(e, t) && parseInt(String(e.heure).slice(0, 2), 10) > nowH() ? 'aujourd\'hui' : prochainJour(e, addDays(t, 1));
  const subject = e.prenom + ', ton engagement est posé';
  const texte = e.prenom + ',\n\nC\'est écrit, donc ça existe :\n\n'
    + '• ' + e.action + '\n• ' + freqTxt(e) + ', rappel à ' + heureFr(e.heure) + '\n'
    + (e.pourquoi ? '• Pourquoi : ' + e.pourquoi + '\n' : '') + (e.preuve ? '• Ta preuve : ' + e.preuve + '\n' : '')
    + (remplace ? '\nTon ancien engagement « ' + remplace + ' » passe dans ton historique.\n' : '')
    + '\nTon premier rappel arrive ' + premier + ' à ' + heureFr(e.heure) + ', avec un seul bouton : « C\'est fait ». Ta page : ' + PAGE_URL + '\n\nAnaïs';
  const blocs = [
    '<p>' + esc(e.prenom) + ',</p>',
    '<p>C\'est écrit, donc ça existe :</p>',
    '<ul style="padding-left:20px;margin:0"><li><b>' + esc(e.action) + '</b></li><li>' + esc(freqTxt(e)) + ', rappel à ' + esc(heureFr(e.heure)) + '</li>'
    + (e.pourquoi ? '<li>Pourquoi : ' + esc(e.pourquoi) + '</li>' : '') + (e.preuve ? '<li>Ta preuve : ' + esc(e.preuve) + '</li>' : '') + '</ul>',
    remplace ? '<p style="font-size:14.5px;color:#5C4646">Ton ancien engagement « ' + esc(remplace) + ' » passe dans ton historique.</p>' : '',
    '<p>Ton premier rappel arrive <b>' + esc(premier) + ' à ' + esc(heureFr(e.heure)) + '</b>, avec un seul bouton : « C\'est fait ».</p>',
    '<p style="margin:18px 0">' + bouton(PAGE_URL, 'Voir mes engagements', 'ghost') + '</p>',
    '<p>Anaïs</p>',
  ].filter(Boolean);
  sendMail(e.email, subject, texte, blocs);
}
function prochainJour(e, from) {
  for (let i = 0; i < 8; i++) { const d = addDays(from, i); if (scheduled(e, d)) return i === 0 ? 'demain' : dateFr(d); }
  return 'bientôt';
}

// ---------- pages HTML des liens du mail ----------
function pageAction(what, q) {
  const all = loadAll();
  const e = byJeton(all, q);
  if (!e) return htmlPage('Lien invalide', '<h1>Ce lien n\'est plus valide</h1><p>Ouvre ta page pour poser ton « Fait ».</p>' + boutonPage());
  try {
    if (what === 'pause') {
      if (!q.jours) {
        const restantes = PAUSE_MAX - (Number(e.pauses) || 0);
        if (restantes <= 0) return htmlPage('Pause', '<h1>Plus de pause disponible</h1><p>Tu as utilisé tes ' + PAUSE_MAX + ' pauses sur le programme. Un « Pas aujourd\'hui » reste possible.</p>' + boutonPage());
        const choix = [1, 2, 3, 4, 5, 6, 7].map(n => '<a class="b" href="' + esc(lien('pause', e, '', '&jours=' + n)) + '">' + n + ' jour' + (n > 1 ? 's' : '') + '</a>').join('');
        return htmlPage('Pause', '<h1>Mettre « ' + esc(e.action) + ' » en pause</h1><p>À partir d\'aujourd\'hui, pour combien de jours ? Une pause déclarée ne casse pas ta série. Il te reste ' + restantes + ' pause' + (restantes > 1 ? 's' : '') + ' sur ' + PAUSE_MAX + '.</p><div class="choix">' + choix + '</div>' + boutonPage('ghost'));
      }
      const r = pauseAction(q, 'mail');
      if (!r.ok) return htmlPage('Pause', '<h1>Pas de pause possible</h1><p>' + esc(r.error) + '</p>' + boutonPage());
      return htmlPage('Pause posée', '<h1>Pause posée jusqu\'au ' + esc(dateFr(r.jusqu || r.deja && e.pause_jusqu)) + '</h1><p>Ton prochain rappel arrivera à la reprise. Reviens quand tu veux sur ta page pour reprendre plus tôt.</p>' + boutonPage());
    }
    if (what === 'skip') {
      const r = skipAction(q, 'mail');
      if (!r.ok) return htmlPage('Pas aujourd\'hui', '<h1>Trop tard pour ce lien</h1><p>' + esc(r.error) + '</p>' + boutonPage());
      return htmlPage('Noté', '<h1>Noté, merci de l\'avoir dit.</h1><p>Un « Pas aujourd\'hui » dit à temps ne coûte que le jour : ta série reste à <b>' + r.serie + '</b>. Demain, on reprend.</p>' + boutonPage());
    }
    if (what === 'note') {
      const r = doneAction({ id: q.id, jeton: q.jeton, d: q.d, note: q.note }, 'mail');
      if (!r.ok) return htmlPage('Note', '<h1>Impossible de noter</h1><p>' + esc(r.error) + '</p>' + boutonPage());
      return htmlPage('Noté', '<h1>C\'est noté.</h1><p>« ' + esc(cleanText(q.note, 200)) + ' » est dans ton historique du ' + esc(dateFr(r.d)) + '.</p>' + boutonPage());
    }
    // done
    const r = doneAction(q, 'mail');
    if (!r.ok) return htmlPage('Fait', '<h1>Trop tard pour ce lien</h1><p>' + esc(r.error) + '</p>' + boutonPage());
    const u = unite(e, r.serie);
    const titre = r.neuf ? 'Fait. ' + r.serie + ' ' + u + '.' : 'Déjà fait ce jour-là. Série : ' + r.serie + ' ' + u + '.';
    const ps = phraseSerie(r.serie, r.record, e);
    const noteForm = '<form class="note" method="get" action="' + esc(execUrl()) + '"><input type="hidden" name="what" value="note"><input type="hidden" name="id" value="' + esc(e.id) + '"><input type="hidden" name="jeton" value="' + esc(e.jeton) + '"><input type="hidden" name="d" value="' + esc(r.d) + '">'
      + '<input name="note" maxlength="200" placeholder="' + esc(e.preuve ? 'Ta preuve : ' + e.preuve : 'Un mot sur aujourd\'hui (facultatif)') + '"><button type="submit">Noter</button></form>';
    return htmlPage('Fait', '<h1>' + esc(titre) + '</h1><p>' + esc(ps) + '</p><p class="mini">Record : ' + r.record + ' ' + unite(e, r.record) + ' · ' + r.done28 + ' sur ' + r.total28 + ' ces 4 dernières semaines</p>'
      + grilleHtml(r.grille) + noteForm + boutonPage());
  } catch (err) {
    return htmlPage('Erreur', '<h1>Ça n\'a pas marché</h1><p>' + esc(String(err && err.message || err)) + '</p>' + boutonPage());
  }
}
function boutonPage(style) { return '<p class="act"><a class="b' + (style === 'ghost' ? ' ghost' : '') + '" href="' + PAGE_URL + '">Voir ma page</a></p>'; }
function grilleHtml(g) {
  const col = { fait: '#4C7A5E', rate: '#D9B4B4', passe: '#E7D9C3', pause: '#B9C8DE', attente: '#FFFDFB', avenir: '#F6EEEE', hors: '#F6EEEE' };
  const brd = { attente: '2px solid #966868', hors: '1px dashed #EBD2D2', avenir: '1px solid #EBD2D2' };
  return '<div class="g"><div class="gh">' + ['L', 'M', 'M', 'J', 'V', 'S', 'D'].map(x => '<span>' + x + '</span>').join('') + '</div>'
    + g.map(row => '<div class="gr">' + row.map(c => '<i title="' + c.d + '" style="background:' + col[c.s] + ';border:' + (brd[c.s] || '1px solid transparent') + '"></i>').join('') + '</div>').join('')
    + '</div><p class="leg"><i style="background:#4C7A5E"></i>fait <i style="background:#D9B4B4"></i>manqué <i style="background:#E7D9C3"></i>pas ce jour-là <i style="background:#B9C8DE"></i>pause</p>';
}
function htmlPage(title, inner) {
  const html = '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(title) + ' · Selfty</title>'
    + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&family=Jost:wght@400;500;600&display=swap">'
    + '<style>body{margin:0;background:#FAEEEE;color:#3A2A2A;font:16px/1.5 Jost,system-ui,sans-serif}.w{max-width:440px;margin:0 auto;padding:28px 18px}img{height:34px;display:block;margin-bottom:18px}'
    + 'h1{font:600 26px/1.15 "Playfair Display",Georgia,serif;margin:0 0 10px}p{margin:0 0 12px}.mini{color:#8A7070;font-size:13.5px}'
    + '.b{display:inline-block;background:#966868;color:#FFFDFB;border:1px solid #966868;border-radius:999px;padding:12px 22px;font-weight:600;text-decoration:none;margin:4px 6px 4px 0}.b.ghost{background:#FFFDFB;color:#7E5252}'
    + '.choix{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 16px}.choix .b{padding:10px 16px}.act{margin-top:18px}'
    + '.g{background:#FFFDFB;border:1px solid #EBD2D2;border-radius:14px;padding:12px;margin:14px 0 6px}.gh{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;text-align:center;font-size:11px;color:#8A7070;margin-bottom:4px}'
    + '.gr{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:6px}.gr i{display:block;aspect-ratio:1;border-radius:8px}.leg{font-size:12px;color:#8A7070}.leg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin:0 4px 0 8px;vertical-align:-1px}'
    + '.note{display:flex;gap:6px;margin:14px 0}.note input{flex:1;min-width:0;border:1px solid #EBD2D2;border-radius:10px;padding:10px 12px;font:15px Jost,sans-serif;background:#FFFDFB}.note button{background:#3A2A2A;color:#FFFDFB;border:0;border-radius:10px;padding:10px 14px;font:500 15px Jost,sans-serif}</style></head>'
    + '<body><div class="w"><img src="' + LOGO_URL + '" alt="Selfty Academy">' + inner + '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title + ' · Selfty').addMetaTag('viewport', 'width=device-width, initial-scale=1').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
