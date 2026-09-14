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
//   console  { ckey }                         console Selfty (build CI) : toutes les élèves, séries, pastilles 14 j, relances
//   rappel_traite { ckey, row, traite? }      console : coche « Traité le » d'une ligne relance / appel de l'onglet Rappels
//   console_key_init { ckey }                 pose la clé console (ScriptProperties CONSOLE_KEY) si elle n'existe pas encore
// La clé KEY ci-dessus est publique (page des élèves) : tout ce qui expose TOUTES les élèves exige CONSOLE_KEY.
//
// Étapes 2 et 3 (15/09/2026, voir README) :
//   GET/POST portail { t }                    portail perso (jeton de l'onglet Élèves) : vision, semaine k/27, engagements + faits,
//                                             bilan du vendredi (état + lien perso), intake, binôme, pratiques de la semaine, promo
//   POST public_set { t, public }             visible ou non dans le tableau de la promo
//   GET/POST promo                            score de la promo + tableau des élèves visibles (page de projection du lundi)
//   POST ?wh=<secret> (webhook Tally)         intake 81X5kk -> onglet Élèves (vision, Q12…) ; bilan 1AekPO -> onglet Bilans
//   POST wh_init { ckey }                     pose le secret du webhook et renvoie l'URL à brancher dans Tally
//   POST binome_set { ckey, email, binome }   binômes (les deux lignes), binome vide = défaire
//   POST vision_set { ckey, email, vision }   vision affichée en tête du portail
// Chaque heure : onglet « Résumé semaine » (lu par le mail du vendredi du script Contrats). À 9h : pratiques d'hier = Fait
// automatique sur l'action hebdo « pratiquer », mail à la binôme à 2 jours de silence.
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
  tabsEtape2(ss);
  SpreadsheetApp.openById(PRATIQUES_SHEET_ID);
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
  EL_CACHE = null;
  const q = (e && e.parameter) || {};
  const what = String(q.what || '');
  if (['done', 'skip', 'pause', 'note'].indexOf(what) >= 0) return pageAction(what, q);   // liens des mails : par jeton
  if (q.key !== KEY) return out({ ok: true, pong: true, v: 1 });
  try {
    if (what === 'portail') return out(portail(q));
    if (what === 'promo') return out(promo());
    if (what === 'setup') return out(setup());
    if (what === 'list') return out(list(q));
    if (what === 'tick') return out(chaqueHeure(q.h === undefined ? undefined : Number(q.h)));
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  }
  return out({ ok: true, pong: true, v: 1 });
}

function doPost(e) {
  EL_CACHE = null;
  let p = {};
  try { p = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad json' }); }
  const wh = e && e.parameter && e.parameter.wh;
  if (wh) {
    if (!P.getProperty('WH_SECRET') || wh !== P.getProperty('WH_SECRET') || p.eventType !== 'FORM_RESPONSE') return out({ ok: false, error: 'bad webhook' });
    try { return out(webhookTally(p)); } catch (err) { return out({ ok: false, error: String(err && err.message || err) }); }
  }
  if (p.key !== KEY) return out({ ok: false, error: 'bad key' });
  try {
    if (p.what === 'portail') return out(portail(p));
    if (p.what === 'public_set') return out(publicSet(p));
    if (p.what === 'promo') return out(promo());
    if (p.what === 'wh_init') return out(whInit(p));
    if (p.what === 'binome_set') return out(binomeSet(p));
    if (p.what === 'vision_set') return out(visionSet(p));
    if (p.what === 'programme_set') return out(programmeSet(p));
    if (p.what === 'dev_clear') return out(devClear(p));
    if (p.what === 'setup') return out(setup());
    if (p.what === 'list') return out(list(p));
    if (p.what === 'declare') return out(declare(p));
    if (p.what === 'done') return out(doneAction(p, 'page'));
    if (p.what === 'skip') return out(skipAction(p, 'page'));
    if (p.what === 'pause') return out(pauseAction(p));
    if (p.what === 'resume') return out(resumeAction(p));
    if (p.what === 'stop') return out(stopAction(p));
    if (p.what === 'tick') return out(chaqueHeure(p.h === undefined ? undefined : Number(p.h)));
    if (p.what === 'console_key_init') return out(consoleKeyInit(p));
    if (p.what === 'console') return out(consoleData(p));
    if (p.what === 'rappel_traite') return out(rappelTraite(p));
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
  tabsEtape2(ss);
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
  const lastDone = Object.keys(m).filter(k => m[k] === 'oui' && k <= ref).sort().pop() || '';
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
    try { ensureEleve({ email: email, prenom: prenom, whatsapp: whatsapp }, all.ss); } catch (err) { Logger.log('élève : ' + err); }
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
  try { r.resume = resumeSemaine(); } catch (e) { Logger.log('résumé : ' + e); }
  if (h === HEURE_BILAN) {
    try { r.pratiques = pratiquesFaites(); } catch (e) { Logger.log('pratiques : ' + e); }
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
    // déjà revenue : fait aujourd'hui, ou action hebdo déjà faite cette semaine
    if (c.today_state === 'fait') return;
    if (e.frequence === 'hebdo' && c.st(addDays(weekStart(t), (joursSet(e)[0] || 7) - 1)) === 'fait') return;
    const type = c.manques >= SEUIL_APPEL ? 'appel' : 'relance';
    const dejaEpisode = journal.some(r => r.type === type && String(r.id) === String(e.id) && String(r.date).slice(0, 10) > (c.lastDone || '0000'));
    // la binôme d'abord : un mail court à 2 jours, une fois par épisode
    const el = eleveDe(e.email, all.ss);
    const bin = el && el.binome ? eleveDe(el.binome, all.ss) : null;
    if (bin && type === 'relance' && !journal.some(r => r.type === 'binome' && String(r.id) === String(e.id) && String(r.date).slice(0, 10) > (c.lastDone || '0000'))) {
      try {
        mailBinome(e, c, bin);
        appendRow(all.shR, RA_KEYS, { date: t, type: 'binome', id: e.id, prenom: e.prenom, email: e.email, action: e.action, serie: c.serie, manques: c.manques, lien: bin.email, traite: '' });
      } catch (err) { Logger.log('binôme ' + e.id + ' : ' + err); }
    }
    if (dejaEpisode) return;
    const msg = type === 'appel'
      ? e.prenom + ', je t\'appelle 10 minutes cette semaine, quand ? Mardi 12h ou jeudi 18h ?'
      : 'Hello ' + e.prenom + ', c\'est Anaïs. Je vois deux jours sans ton action « ' + e.action + ' ». Je ne te demande pas pourquoi, je te demande juste : tu la fais aujourd\'hui ? Un mot et je te laisse tranquille 🌸';
    const lien = 'https://wa.me/' + (e.whatsapp ? String(e.whatsapp) : (el && el.whatsapp ? String(el.whatsapp) : '')) + '?text=' + encodeURIComponent(msg);
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
function cadre(blocs, pageUrl) {
  return '<div style="background:#FAEEEE;padding:24px 12px;font-family:Jost,Helvetica,Arial,sans-serif;color:#3A2A2A;font-size:16px;line-height:1.55">'
    + '<div style="max-width:560px;margin:0 auto;background:#FFFDFB;border:1px solid #EBD2D2;border-radius:16px;padding:26px 24px">'
    + '<img src="' + LOGO_URL + '" alt="Selfty Academy" style="height:34px;display:block;margin-bottom:18px">'
    + blocs.map(b => '<div style="margin:0 0 14px">' + b + '</div>').join('')
    + '<p style="margin:22px 0 0;color:#8A7070;font-size:13px">Selfty Academy · <a href="' + (pageUrl || PAGE_URL) + '" style="color:#7E5252">Ma page</a></p>'
    + '</div></div>';
}
function sendMail(to, subject, texte, blocs) {
  let page = PAGE_URL;
  try { page = portailUrl(to); } catch (e) { }
  MailApp.sendEmail({ to: to, name: MAIL_NAME, subject: subject, body: texte.replace(/__PAGE__/g, page) + '\n\nTa page : ' + page, htmlBody: cadre(blocs, page).replace(/__PAGE__/g, page) });
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
  const q12 = String((eleveDe(e.email) || {}).q12 || '').trim();
  const texte = e.prenom + ',\n\nHier, pas de « Fait » pour ' + e.action + '. Ta série de ' + n + ' ' + u + ' s\'est arrêtée.\n\n'
    + 'Ce n\'est pas grave. Ce qui compte, c\'est ce que tu fais aujourd\'hui : une série de ' + n + ' ' + u + ' prouve que tu sais le faire. Tu recommences à 1, avec ton record à ' + record + ' en ligne de mire.\n\n'
    + (q12 ? 'Une chose, quand même. Tu as écrit en arrivant : « ' + q12 + ' ». Est-ce que c\'est ça, hier ? Réponds à ce mail en un mot si oui. Je lis.\n\n' : 'Une chose, quand même. Qu\'est-ce qui s\'est passé, hier ? Réponds à ce mail en un mot. Je lis.\n\n')
    + 'Je reprends aujourd\'hui : ' + lien('done', e, t) + '\n\nAnaïs';
  const blocs = [
    '<p>' + esc(e.prenom) + ',</p>',
    '<p>Hier, pas de « Fait » pour <b>' + esc(e.action) + '</b>. Ta série de <b>' + n + ' ' + u + '</b> s\'est arrêtée.</p>',
    '<p>Ce n\'est pas grave. Ce qui compte, c\'est ce que tu fais aujourd\'hui : une série de ' + n + ' ' + u + ' prouve que tu sais le faire. Tu recommences à 1, avec ton record à ' + record + ' en ligne de mire.</p>',
    q12 ? '<p>Une chose, quand même. Tu as écrit en arrivant : « ' + esc(q12) + ' ». Est-ce que c\'est ça, hier ? Réponds à ce mail en un mot si oui. Je lis.</p>'
      : '<p>Une chose, quand même. Qu\'est-ce qui s\'est passé, hier ? Réponds à ce mail en un mot. Je lis.</p>',
    '<p style="margin:18px 0">' + bouton(lien('done', e, t), 'Je reprends aujourd\'hui ✓') + '</p>',
    '<p>Anaïs</p>',
  ];
  sendMail(e.email, subject, texte, blocs);
}

// 4.4 Le mail du lundi (complet, étape 2) : semaine k/27, bilan chiffré de la semaine passée, bilan du vendredi, engagement écrit
// vendredi, les 3 choses de la semaine (module de l'onglet Programme, Selfty Call, pratique de l'agenda des pratiques + binôme)
function mailSemaine(prenom, email, bilans, t) {
  const k = semaineProgramme(t);
  const dansProg = k >= 1 && k <= PROGRAMME_SEMAINES;
  const sem = dansProg ? 'Semaine ' + k + ' sur ' + PROGRAMME_SEMAINES : 'Nouvelle semaine';
  const subject = (dansProg ? 'Ta semaine ' + k + ' sur ' + PROGRAMME_SEMAINES : 'Ta semaine') + ', ' + prenom;
  const lignes = bilans.map(b => b.e.frequence === 'hebdo'
    ? 'action hebdo « ' + b.e.action + ' » ' + (b.x > 0 ? 'faite' : 'pas faite')
    : b.x + ' jour' + (b.x > 1 ? 's' : '') + ' sur ' + b.y + ' pour « ' + b.e.action + ' »' + (b.c.serie ? ' (série ' + b.c.serie + ')' : ''));
  let bil = null, pr = null, prat = [], bin = null;
  try { bil = bilanDe(email, isoWeekKey(addDays(t, -7))); } catch (e) { }
  try { pr = programmeSemaine(k); } catch (e) { }
  try { const ws = weekStart(t); prat = pratiquesDe(email, ws, addDays(ws, 6)); } catch (e) { }
  try { const el = eleveDe(email); bin = el && el.binome ? eleveDe(el.binome) : null; } catch (e) { }
  if (dansProg || bil) lignes.push('bilan du vendredi ' + (bil ? 'fait' : 'pas fait'));
  const choses = [];
  if (pr && pr.module) choses.push(String(pr.module) + (pr.note ? ' (' + String(pr.note) + ')' : ''));
  if (dansProg) choses.push(String((pr && pr.call) || SELFTY_CALL_DEFAUT));
  if (prat.length) {
    const c = prat[0], avec = c.email === email ? c.b_prenom : c.prenom;
    choses.push('Pratique ' + dateFr(c.date) + ' à ' + heureFr(c.heure) + (avec ? ' avec ' + avec : ''));
  } else if (dansProg || bin) {
    choses.push('Pratique à poser sur l\'agenda des pratiques' + (bin ? ', avec ' + bin.prenom + ' si elle est libre' : ''));
  }
  const engagement = bil && bil.engagement ? String(bil.engagement) : '';
  const texte = prenom + ',\n\n' + sem + '. La semaine dernière : ' + lignes.join(', ') + '.\n\n'
    + (engagement ? 'Ton engagement pour cette semaine (tu l\'as écrit vendredi) : « ' + engagement + ' ».\n\n' : '')
    + (choses.length ? 'Les ' + (choses.length > 1 ? choses.length + ' choses' : 'chose') + ' de la semaine : ' + choses.join(' · ') + '.\n\n' : '')
    + 'Une question pour commencer : qu\'est-ce qui rendrait cette semaine réussie, en une phrase ? Réponds à ce mail, je lis tout le lundi matin.\n\nAnaïs';
  const blocs = [
    '<p>' + esc(prenom) + ',</p>',
    '<p><b>' + sem + '.</b> La semaine dernière : ' + esc(lignes.join(', ')) + '.</p>',
    engagement ? '<p>Ton engagement pour cette semaine (tu l\'as écrit vendredi) : « <b>' + esc(engagement) + '</b> ».</p>' : '',
    choses.length ? '<p style="margin-bottom:4px">Les ' + (choses.length > 1 ? choses.length + ' choses' : 'chose') + ' de la semaine :</p><ul style="padding-left:20px;margin:0">' + choses.map(c => '<li>' + esc(c) + '</li>').join('') + '</ul>' : '',
    '<p>Une question pour commencer : qu\'est-ce qui rendrait cette semaine réussie, en une phrase ? Réponds à ce mail, je lis tout le lundi matin.</p>',
    '<p style="margin:18px 0">' + bouton('__PAGE__', 'Voir ma page', 'ghost') + '</p>',
    '<p>Anaïs</p>',
  ].filter(Boolean);
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
    + '\nTon premier rappel arrive ' + premier + ' à ' + heureFr(e.heure) + ', avec un seul bouton : « C\'est fait ».\n\nAnaïs';
  const blocs = [
    '<p>' + esc(e.prenom) + ',</p>',
    '<p>C\'est écrit, donc ça existe :</p>',
    '<ul style="padding-left:20px;margin:0"><li><b>' + esc(e.action) + '</b></li><li>' + esc(freqTxt(e)) + ', rappel à ' + esc(heureFr(e.heure)) + '</li>'
    + (e.pourquoi ? '<li>Pourquoi : ' + esc(e.pourquoi) + '</li>' : '') + (e.preuve ? '<li>Ta preuve : ' + esc(e.preuve) + '</li>' : '') + '</ul>',
    remplace ? '<p style="font-size:14.5px;color:#5C4646">Ton ancien engagement « ' + esc(remplace) + ' » passe dans ton historique.</p>' : '',
    '<p>Ton premier rappel arrive <b>' + esc(premier) + ' à ' + esc(heureFr(e.heure)) + '</b>, avec un seul bouton : « C\'est fait ».</p>',
    '<p style="margin:18px 0">' + bouton('__PAGE__', 'Voir ma page', 'ghost') + '</p>',
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
  try { PAGE_ELEVE = portailUrl(e.email, all.ss); } catch (err) { }
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
let PAGE_ELEVE = '';
function boutonPage(style) { return '<p class="act"><a class="b' + (style === 'ghost' ? ' ghost' : '') + '" href="' + (PAGE_ELEVE || PAGE_URL) + '">Voir ma page</a></p>'; }
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

// =====================================================================================================================
// ÉTAPES 2 ET 3 : portail perso, intake, bilan du vendredi, programme, binômes, score de promo, pratiques
// =====================================================================================================================
const PORTAIL_URL = 'https://selfty-academy.github.io/engagements/portail/';
const PROMO_URL = 'https://selfty-academy.github.io/engagements/promo/';
const INTAKE_FORM = '81X5kk';                       // Tally « Ton point de départ » (intake, 20 questions)
const EOW_FORM = '1AekPO';                          // Tally « Mon bilan de la semaine »
const PRATIQUES_SHEET_ID = '12VqHU7OFsSizRCEkN3eg9X6PwmPkj7tlmbCL1dW8NoU';   // Sheet « Pratiques Selfty » (même compte)
const PRATIQUES_URL = 'https://selfty-academy.github.io/pratiques/';
const SELFTY_CALL_DEFAUT = 'Selfty Call du samedi à 10h';                     // provisoire (agenda des calls)
const OBJECTIF_PROMO = 85;                          // % de la promo sur la semaine

const EL_TAB = 'Élèves';
const EL_HDR = ['E-mail', 'Prénom', 'WhatsApp', 'Jeton portail', 'Vision', 'Binôme', 'Visible promo', 'Intake le', 'Abandon (Q12)', 'Peur (Q11)',
  'Heures / semaine (Q14)', 'Moment dispo (Q17)', 'Jour calme (Q17)', 'Engagement déclaré (Q19)', 'Chiffre de fin (Q9)', 'Intake (réponses)', 'Créé le', 'MAJ'];
const EL_KEYS = ['email', 'prenom', 'whatsapp', 'jeton', 'vision', 'binome', 'public', 'intake_le', 'q12', 'q11', 'heures', 'moment', 'jour_calme', 'q19', 'q9', 'intake', 'created', 'updated'];
const BI_TAB = 'Bilans';
const BI_HDR = ['Date', 'Semaine', 'E-mail', 'Prénom', 'Engagement de la semaine suivante', 'Action hebdo faite', 'Jours manqués : pourquoi', 'Ce que ça a donné', 'Série (lien)', 'Jours (lien)', 'Note de la semaine', 'ID Tally'];
const BI_KEYS = ['date', 'semaine', 'email', 'prenom', 'engagement', 'hebdo', 'pourquoi', 'donne', 'serie', 'jours', 'note', 'sid'];
const PR_TAB = 'Programme';
const PR_HDR = ['Semaine', 'Du', 'Module de la semaine', 'Selfty Call', 'Note'];
const PR_KEYS = ['semaine', 'du', 'module', 'call', 'note'];
// Programme officiel (PDF « Le programme de la Selfty Academy », 09/09/2026) : une ligne par semaine du lundi 12/10/2026 au 12/04/2027.
// [module de la semaine, note]. Le Selfty Call est la colonne suivante (défaut SELFTY_CALL_DEFAUT, provisoire).
const PROGRAMME_CONTENU = [
  ['Module 01 · Vision et posture (ouvert le 10 octobre)', ''],
  ['Module 02 · Compétences fondamentales', ''],
  ['Module 03 · Le mental 1.0 : faire la lumière sur notre ombre', ''],
  ['Semaine d\'intégration, pas de nouveau module', 'Call questions-réponses sur la certification'],
  ['Module 04 · Le mental 2.0 : le parts work', ''],
  ['Module 05 · Les émotions et la somatique 1.0', ''],
  ['Module 06 · Maîtrise du passé', ''],
  ['Semaine d\'intégration, pas de nouveau module', 'Breathwork optionnel · call questions-réponses sur la certification'],
  ['Module 07 · Somatique 2.0 : inconscient et science du changement', 'Ouverture du Portail (pratique avec de vraies personnes hors école)'],
  ['Module 08 · L\'argent et la valeur personnelle', ''],
  ['Module 09 · Objectifs et action alignée', 'Fin de la Facilitation : examen écrit de certification'],
  ['Pause de fin d\'année', ''],
  ['Pause de fin d\'année', ''],
  ['Module 10 · Le business : orientation globale', ''],
  ['Module 11 · Vendre en étant au service', ''],
  ['Module 12 · Ton offre et tes tarifs', ''],
  ['Semaine d\'intégration, pas de nouveau module', 'Semaine non précisée dans le PDF, à confirmer par Anaïs'],
  ['Module 13 · Marketing : créer des clients', ''],
  ['Module 14 · Le business : jouer au jeu de la vie', 'Lancement du 60 jours challenge'],
  ['Sprint action · 60 jours challenge', ''],
  ['Sprint action · 60 jours challenge', ''],
  ['Sprint action · 60 jours challenge', ''],
  ['Sprint action · 60 jours challenge', 'Dépôt des séances enregistrées pour la certification'],
  ['Sprint action · 60 jours challenge', ''],
  ['Sprint action · 60 jours challenge', ''],
  ['Sprint action · 60 jours challenge', ''],
  ['Module 15 · Célébration', 'Selfty Call de célébration · certification remise dans les 3 mois'],
];
function programmeLignes() {
  const v = [];
  for (let k = 1; k <= PROGRAMME_SEMAINES; k++) {
    const c = PROGRAMME_CONTENU[k - 1] || ['', ''];
    v.push([String(k), addDays(PROGRAMME_DEBUT, (k - 1) * 7), c[0], SELFTY_CALL_DEFAUT, c[1]]);
  }
  return v;
}
// console / Alex : réécrit l'onglet Programme depuis PROGRAMME_CONTENU (garde le Selfty Call déjà saisi dans le Sheet)
function programmeSet(p) {
  if (!consoleOk(p)) return { ok: false, error: 'bad ckey' };
  const sh = tab(book(), PR_TAB, PR_HDR);
  const exist = rows(sh, PR_KEYS);
  const v = programmeLignes().map(r => { const e = exist.find(x => Number(x.semaine) === Number(r[0])); if (e && e.call && !p.reset_call) r[3] = String(e.call); return r; });
  sh.getRange(2, 1, v.length, PR_HDR.length).setNumberFormat('@').setValues(v);
  return { ok: true, semaines: v.length };
}
const RS_TAB = 'Résumé semaine';
const RS_HDR = ['E-mail', 'Prénom', 'Semaine', 'Jours faits', 'Jours prévus', 'Série', 'Action hebdo', 'Hebdo faite', 'Lien portail', 'MAJ'];
const RS_KEYS = ['email', 'prenom', 'semaine', 'x', 'y', 'serie', 'hebdo', 'hebdo_fait', 'portail', 'updated'];

function tabsEtape2(ss) {
  tab(ss, EL_TAB, EL_HDR);
  tab(ss, BI_TAB, BI_HDR);
  tab(ss, RS_TAB, RS_HDR);
  const pr = tab(ss, PR_TAB, PR_HDR);
  if (pr.getLastRow() < 2) {
    const v = programmeLignes();
    pr.getRange(2, 1, v.length, PR_HDR.length).setNumberFormat('@').setValues(v);
  }
}

// ISO 8601 « 2026-W41 » (même format que le script Contrats et la console)
function isoWeekKey(iso) {
  const x = new Date(String(iso).slice(0, 10) + 'T12:00:00Z');
  const day = x.getUTCDay() || 7; x.setUTCDate(x.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  return x.getUTCFullYear() + '-W' + ('0' + Math.ceil(((x - y0) / 86400000 + 1) / 7)).slice(-2);
}

// ---------- élèves ----------
let EL_CACHE = null;
function eleves(ss) {
  if (!EL_CACHE) EL_CACHE = rows(tab(ss || book(), EL_TAB, EL_HDR), EL_KEYS);
  return EL_CACHE;
}
function eleveDe(email, ss) { email = cleanEmail(email); return email ? eleves(ss).find(x => x.email === email) || null : null; }
function eleveParJeton(t, ss) { t = String(t || ''); return t.length >= 16 ? eleves(ss).find(x => String(x.jeton) === t) || null : null; }
// crée la fiche élève si besoin (déclaration, intake, console) et complète prénom / WhatsApp vides
function ensureEleve(o, ss) {
  ss = ss || book();
  const email = cleanEmail(o.email);
  if (!email) return null;
  const sh = tab(ss, EL_TAB, EL_HDR);
  let el = eleveDe(email, ss);
  if (!el) {
    el = { email: email, prenom: cleanName(o.prenom), whatsapp: cleanPhone(o.whatsapp), jeton: jeton() + jeton().slice(0, 8), vision: '', binome: '', public: 'non',
      intake_le: '', q12: '', q11: '', heures: '', moment: '', jour_calme: '', q19: '', q9: '', intake: '', created: stamp(), updated: stamp() };
    appendRow(sh, EL_KEYS, el);
    EL_CACHE = null;
    return eleveDe(email, ss);
  }
  const maj = {};
  if (!el.prenom && o.prenom) maj.prenom = cleanName(o.prenom);
  if (!el.whatsapp && cleanPhone(o.whatsapp)) maj.whatsapp = cleanPhone(o.whatsapp);
  if (!el.jeton) maj.jeton = jeton() + jeton().slice(0, 8);
  if (Object.keys(maj).length) { setCells(sh, EL_KEYS, el._row, maj); Object.assign(el, maj); }
  return el;
}
function portailUrl(email, ss) {
  const el = email ? ensureEleve({ email: email }, ss) : null;
  return el && el.jeton ? PORTAIL_URL + '?t=' + el.jeton : PAGE_URL;
}

// ---------- webhooks Tally (intake + bilan du vendredi) ----------
// URL du webhook = /exec?wh=<WH_SECRET> ; le secret est posé par what=wh_init (clé console). Idempotent par submissionId.
function tallyChamps(data) {
  const out = {};
  (data.fields || []).forEach(f => {
    let v = f.value;
    if (Array.isArray(v) && f.options) v = v.map(id => { const o = f.options.find(x => x.id === id); return o ? o.text : id; }).join(', ');
    else if (Array.isArray(v)) v = v.map(x => typeof x === 'object' ? (x.name || x.url || JSON.stringify(x)) : x).join(', ');
    else if (v && typeof v === 'object') v = JSON.stringify(v);
    if (v === null || v === undefined || v === '') return;
    const lab = String(f.label || f.key || '').trim();
    if (lab && out[lab] === undefined) out[lab] = String(v);
  });
  return out;
}
function commence(ch, debut) { const k = Object.keys(ch).find(x => x.indexOf(debut) === 0); return k ? ch[k] : ''; }
function webhookTally(p) {
  const d = p.data || {};
  const ch = tallyChamps(d);
  const sid = String(d.submissionId || d.responseId || '');
  const email = cleanEmail(ch.email || ch['E-mail']);
  const prenom = cleanName(ch.prenom || ch['Prénom']);
  const ss = book();
  tabsEtape2(ss);
  if (d.formId === INTAKE_FORM) {
    if (!email) return { ok: false, error: 'intake sans e-mail' };
    return withLock(() => {
      EL_CACHE = null;
      const el = ensureEleve({ email: email, prenom: prenom }, ss);
      const sh = tab(ss, EL_TAB, EL_HDR);
      const vision = commence(ch, '10. ');
      const maj = {
        intake_le: stamp(), q12: cleanText(commence(ch, '12. '), 500), q11: cleanText(commence(ch, '11. '), 500),
        heures: commence(ch, '14. '), moment: commence(ch, '17. '), jour_calme: commence(ch, 'Quel jour de la semaine'),
        q19: cleanText(commence(ch, '19. '), 500), q9: cleanText(commence(ch, '9. '), 200),
        intake: JSON.stringify(ch).slice(0, 45000),
      };
      if (vision) maj.vision = String(vision).slice(0, 2000);
      if (!el.prenom && prenom) maj.prenom = prenom;
      setCells(sh, EL_KEYS, el._row, maj);
      return { ok: true, form: 'intake', email: email };
    });
  }
  if (d.formId === EOW_FORM) {
    return withLock(() => {
      const sh = tab(ss, BI_TAB, BI_HDR);
      if (sid && rows(sh, BI_KEYS).some(r => String(r.sid) === sid)) return { ok: true, deja: true };
      const at = d.createdAt ? Utilities.formatDate(new Date(d.createdAt), TZ, "yyyy-MM-dd'T'HH:mm:ss") : stamp();
      appendRow(sh, BI_KEYS, {
        date: at, semaine: String(ch.semaine || isoWeekKey(at.slice(0, 10))), email: email, prenom: prenom,
        engagement: cleanText(commence(ch, 'L’action à laquelle tu t’engages'), 500), hebdo: commence(ch, 'Ton action hebdo'),
        pourquoi: cleanText(commence(ch, 'Ton action quotidienne cette semaine'), 500), donne: cleanText(commence(ch, 'Ce que ça a donné'), 500),
        serie: ch.serie || '', jours: ch.jours || '', note: commence(ch, 'Ta note globale'), sid: sid,
      });
      return { ok: true, form: 'bilan', email: email };
    });
  }
  return { ok: false, error: 'form inconnu' };
}
function whInit(p) {
  if (!consoleOk(p)) return { ok: false, error: 'bad ckey' };
  if (!P.getProperty('WH_SECRET')) P.setProperty('WH_SECRET', jeton() + jeton());
  tabsEtape2(book());
  return { ok: true, webhook: execUrl() + '?wh=' + P.getProperty('WH_SECRET') };
}

// ---------- programme / bilans / pratiques ----------
function programmeSemaine(k, ss) {
  if (!(k >= 1 && k <= PROGRAMME_SEMAINES)) return null;
  return rows(tab(ss || book(), PR_TAB, PR_HDR), PR_KEYS).find(r => Number(r.semaine) === k) || null;
}
function bilanDe(email, semaine, ss) {
  return rows(tab(ss || book(), BI_TAB, BI_HDR), BI_KEYS).filter(b => b.email === email && String(b.semaine) === semaine).pop() || null;
}
// créneaux de pratique d'une élève entre deux dates (proposés ou pris), hors annulés
function pratiquesDe(email, du, au) {
  try {
    const sh = SpreadsheetApp.openById(PRATIQUES_SHEET_ID).getSheetByName('Creneaux');
    if (!sh || sh.getLastRow() < 2) return [];
    const v = sh.getRange(2, 1, sh.getLastRow() - 1, 18).getValues();
    return v.map(r => ({ id: r[0], date: String(cell(r[2])).slice(0, 10), heure: r[3] instanceof Date ? Utilities.formatDate(r[3], TZ, 'HH:mm') : String(r[3]).slice(0, 5),
      prenom: r[5], email: String(r[6]).toLowerCase(), statut: String(r[11]), b_prenom: r[12], b_email: String(r[13]).toLowerCase() }))
      .filter(c => c.statut !== 'annulé' && c.date >= du && c.date <= au && (c.email === email || c.b_email === email));
  } catch (e) { Logger.log('pratiques : ' + e); return []; }
}
// 9h : une pratique d'hier = « Fait » automatique sur l'action hebdo si elle parle de pratique
function pratiquesFaites() {
  const all = loadAll(), y = addDays(today(), -1);
  let n = 0;
  let creneaux = [];
  try {
    const sh = SpreadsheetApp.openById(PRATIQUES_SHEET_ID).getSheetByName('Creneaux');
    if (sh && sh.getLastRow() > 1) creneaux = sh.getRange(2, 1, sh.getLastRow() - 1, 18).getValues()
      .map(r => ({ date: String(cell(r[2])).slice(0, 10), statut: String(r[11]), email: String(r[6]).toLowerCase(), b_email: String(r[13]).toLowerCase() }))
      .filter(c => c.date === y && c.statut !== 'annulé' && c.b_email);
  } catch (e) { Logger.log('pratiquesFaites : ' + e); return 0; }
  creneaux.forEach(c => [c.email, c.b_email].forEach(m => {
    all.engs.filter(e => e.email === m && e.statut === 'actif' && e.frequence === 'hebdo' && /pratiq/i.test(e.action)).forEach(e => {
      if (writeFait(all, e, y, 'oui', 'pratique', 'pratique entre pairs')) { n++; all.faits = rows(all.shF, FA_KEYS); }
    });
  }));
  return n;
}

// ---------- résumé de la semaine (lu par le mail du vendredi du script Contrats) ----------
function statsSemaine(e, c, ws, jusqu) {
  let x = 0, y = 0;
  for (let d = ws; d <= jusqu && d < addDays(ws, 7); d = addDays(d, 1)) { const s = c.st(d); if (s === 'fait') { x++; y++; } else if (s === 'rate' || s === 'passe') y++; }
  return { x: x, y: y };
}
function resumeSemaine() {
  const all = loadAll(), t = today(), ws = weekStart(t), sem = isoWeekKey(t);
  const par = {};
  all.engs.forEach(e => { if (e.statut === 'actif' || e.statut === 'pause') (par[e.email] = par[e.email] || []).push(e); });
  const out = Object.keys(par).map(email => {
    const engs = par[email];
    const jour = engs.find(e => e.frequence !== 'hebdo'), heb = engs.find(e => e.frequence === 'hebdo');
    let x = '', y = '', serie = '', hebdoFait = '';
    if (jour) { const c = calc(jour, faitsDe(all, jour.id), t); const s = statsSemaine(jour, c, ws, t); x = s.x; y = s.y; serie = c.serie; }
    if (heb) { const c = calc(heb, faitsDe(all, heb.id), t); hebdoFait = c.st(addDays(ws, (joursSet(heb)[0] || 7) - 1)) === 'fait' ? 'oui' : 'non'; }
    return [email, engs[0].prenom, sem, x, y, serie, heb ? heb.action : '', hebdoFait, portailUrl(email, all.ss), stamp()];
  });
  const sh = tab(all.ss, RS_TAB, RS_HDR);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, RS_HDR.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, RS_HDR.length).setNumberFormat('@').setValues(out.map(r => r.map(v => String(v))));
  return out.length;
}

// ---------- binômes ----------
// 2 jours de silence : un mail court à la binôme (une fois par épisode), avant le WhatsApp d'Anaïs
function mailBinome(e, c, binome) {
  const wa = e.whatsapp || (eleveDe(e.email) || {}).whatsapp || '';
  const msg = 'Hey ' + e.prenom + ', je vois que ta série s\'est arrêtée il y a deux jours. On tient ensemble ? Tu la fais aujourd\'hui, ton action ?';
  const url = 'https://wa.me/' + wa + '?text=' + encodeURIComponent(msg);
  const subject = e.prenom + ' a besoin de sa binôme';
  const texte = binome.prenom + ',\n\n' + e.prenom + ' est à 2 jours sans « Fait » sur son action. Un message de toi vaut plus que dix des miens.\n\nLui écrire sur WhatsApp : ' + url + '\n\nAnaïs';
  const blocs = [
    '<p>' + esc(binome.prenom) + ',</p>',
    '<p><b>' + esc(e.prenom) + '</b> est à 2 jours sans « Fait » sur son action. Un message de toi vaut plus que dix des miens.</p>',
    '<p style="margin:18px 0">' + bouton(url, 'Lui écrire sur WhatsApp') + '</p>',
    '<p style="font-size:14.5px;color:#5C4646">Tu ne vois ni son « pourquoi » ni ses notes : juste qu\'elle a décroché. Le message est prêt, modifie-le comme tu veux.</p>',
    '<p>Anaïs</p>',
  ];
  MailApp.sendEmail({ to: binome.email, name: MAIL_NAME, subject: subject, body: texte, htmlBody: cadre(blocs, portailUrl(binome.email)) });
}
function binomeSet(p) {
  if (!consoleOk(p)) return { ok: false, error: 'bad ckey' };
  const a = cleanEmail(p.email), b = p.binome ? cleanEmail(p.binome) : '';
  if (!a || (p.binome && !b) || a === b) return { ok: false, error: 'e-mails invalides' };
  return withLock(() => {
    const ss = book(); const sh = tab(ss, EL_TAB, EL_HDR);
    EL_CACHE = null;
    const ea = ensureEleve({ email: a, prenom: p.prenom }, ss);
    const eb = b ? ensureEleve({ email: b, prenom: p.prenom_binome }, ss) : null;
    // on défait les anciens liens des deux côtés
    eleves(ss).forEach(x => { if (x.binome && (x.binome === a || (b && x.binome === b) || x.email === a || (b && x.email === b))) setCells(sh, EL_KEYS, x._row, { binome: '' }); });
    setCells(sh, EL_KEYS, ea._row, { binome: b });
    if (eb) setCells(sh, EL_KEYS, eb._row, { binome: a });
    EL_CACHE = null;
    return { ok: true, email: a, binome: b };
  });
}
function visionSet(p) {
  if (!consoleOk(p)) return { ok: false, error: 'bad ckey' };
  const el = ensureEleve({ email: p.email, prenom: p.prenom });
  if (!el) return { ok: false, error: 'e-mail manquant' };
  setCells(tab(book(), EL_TAB, EL_HDR), EL_KEYS, el._row, { vision: String(p.vision || '').slice(0, 2000) });
  return { ok: true };
}

// ---------- portail perso (?t=jeton) ----------
function promoData(all, t) {
  const ws = weekStart(t), hier = addDays(t, -1);
  let x = 0, y = 0, series7 = 0;
  const lignes = [];
  const par = {};
  all.engs.forEach(e => { if ((e.statut === 'actif' || e.statut === 'pause') && e.frequence !== 'hebdo') (par[e.email] = par[e.email] || []).push(e); });
  Object.keys(par).forEach(email => {
    const e = par[email][0];
    const c = calc(e, faitsDe(all, e.id), t);
    // semaine en cours jusqu'à hier (le lundi : la semaine dernière entière)
    const du = isoDow(t) === 1 ? addDays(ws, -7) : ws, au = isoDow(t) === 1 ? addDays(ws, -1) : hier;
    const s = statsSemaine(e, c, du, au); x += s.x; y += s.y;
    if (c.serie >= 7) series7++;
    const el = eleveDe(email, all.ss);
    if (el && el.public === 'oui') lignes.push({ prenom: el.prenom || e.prenom, serie: c.serie, record: c.record, taux: c.total28 ? Math.round(100 * c.done28 / c.total28) : null });
  });
  lignes.sort((a, b) => b.serie - a.serie || (b.taux || 0) - (a.taux || 0));
  return { score: y ? Math.round(100 * x / y) : null, series7: series7, eleves: Object.keys(par).length, objectif: OBJECTIF_PROMO, tableau: lignes };
}
function portail(q) {
  const ss = book();
  tabsEtape2(ss);
  const el = eleveParJeton(q.t, ss);
  if (!el) return { ok: false, error: 'lien inconnu' };
  const all = loadAll(), t = today();
  const mine = all.engs.filter(e => e.email === el.email);
  const ids = mine.map(e => String(e.id));
  const k = semaineProgramme(t);
  // bilan : du vendredi au dimanche on regarde la semaine en cours, sinon la semaine dernière
  const semBilan = isoDow(t) >= 5 ? isoWeekKey(t) : isoWeekKey(addDays(t, -7));
  const jour = mine.find(e => e.statut !== 'terminé' && e.frequence !== 'hebdo');
  const heb = mine.find(e => e.statut !== 'terminé' && e.frequence === 'hebdo');
  let x = '', y = '', serie = '', hebFait = '';
  if (jour) { const c = calc(jour, faitsDe(all, jour.id), t); const s = statsSemaine(jour, c, weekStart(t), t); x = s.x; y = s.y; serie = c.serie; }
  if (heb) { const c = calc(heb, faitsDe(all, heb.id), t); hebFait = c.st(addDays(weekStart(t), (joursSet(heb)[0] || 7) - 1)) === 'fait' ? 'oui' : 'non'; }
  const e_ = encodeURIComponent;
  const bilanLien = 'https://tally.so/r/' + EOW_FORM + '?email=' + e_(el.email) + '&prenom=' + e_(el.prenom) + '&semaine=' + e_(semBilan)
    + '&serie=' + e_(serie) + '&jours=' + e_(x !== '' ? x + '/' + y : '') + '&hebdo=' + e_(hebFait);
  let binome = null;
  if (el.binome) {
    const b = eleveDe(el.binome, ss);
    const bj = all.engs.find(e => e.email === el.binome && (e.statut === 'actif' || e.statut === 'pause') && e.frequence !== 'hebdo');
    binome = { prenom: b ? b.prenom : '', whatsapp: b ? String(b.whatsapp || '') : '', serie: bj ? calc(bj, faitsDe(all, bj.id), t).serie : null, action: !!bj };
  }
  const pr = programmeSemaine(k, ss);
  const ws = weekStart(t);
  return {
    ok: true, today: t, email: el.email, prenom: el.prenom, whatsapp: String(el.whatsapp || ''), vision: el.vision || '',
    semaine: k, semaines: PROGRAMME_SEMAINES, programme_debut: PROGRAMME_DEBUT, module: pr ? pr.module : '', call: pr ? pr.call : SELFTY_CALL_DEFAUT,
    engagements: mine.map(pub),
    faits: all.faits.filter(f => ids.indexOf(String(f.id)) >= 0).map(f => ({ date: String(f.date).slice(0, 10), id: String(f.id), fait: f.fait, note: f.note || '' })),
    bilan: { semaine: semBilan, fait: !!bilanDe(el.email, semBilan, ss), lien: bilanLien },
    intake: { fait: !!el.intake_le, lien: 'https://tally.so/r/' + INTAKE_FORM + '?email=' + e_(el.email) + '&prenom=' + e_(el.prenom) },
    binome: binome, public: el.public === 'oui',
    pratiques: pratiquesDe(el.email, ws, addDays(ws, 6)).map(c => ({ date: c.date, heure: c.heure, avec: c.email === el.email ? (c.b_prenom || '') : c.prenom })),
    pratiques_url: PRATIQUES_URL,
    promo: promoData(all, t),
  };
}
// tests : supprime toutes les lignes d'un e-mail de test (Élèves, Bilans, Engagements, Faits, Rappels, Résumé semaine)
function devClear(p) {
  if (!consoleOk(p)) return { ok: false, error: 'bad ckey' };
  const email = cleanEmail(p.email);
  if (!email) return { ok: false, error: 'e-mail manquant' };
  return withLock(() => {
    const ss = book(), n = {};
    [[EL_TAB, EL_HDR, 1], [BI_TAB, BI_HDR, 3], [EN_TAB, EN_HDR, 4], [FA_TAB, FA_HDR, 2], [RA_TAB, RA_HDR, 5], [RS_TAB, RS_HDR, 1]].forEach(([name, hdr, col]) => {
      const sh = tab(ss, name, hdr); n[name] = 0;
      for (let r = sh.getLastRow(); r >= 2; r--) if (String(sh.getRange(r, col).getValue()).toLowerCase() === email) { sh.deleteRow(r); n[name]++; }
    });
    return { ok: true, supprimees: n };
  });
}
function publicSet(p) {
  const el = eleveParJeton(p.t);
  if (!el) return { ok: false, error: 'lien inconnu' };
  setCells(tab(book(), EL_TAB, EL_HDR), EL_KEYS, el._row, { public: p.public ? 'oui' : 'non' });
  return { ok: true, public: !!p.public };
}
function promo() {
  const all = loadAll(), t = today();
  const d = promoData(all, t);
  return { ok: true, today: t, semaine: semaineProgramme(t), semaines: PROGRAMME_SEMAINES, score: d.score, series7: d.series7, eleves: d.eleves, objectif: d.objectif, tableau: d.tableau };
}

// ---------- console Selfty (onglet Ambre suivi client) ----------
function consoleOk(p) {
  const k = P.getProperty('CONSOLE_KEY');
  return !!k && String(p.ckey || '') === k;
}
function consoleKeyInit(p) {
  if (P.getProperty('CONSOLE_KEY')) return { ok: false, error: 'clé console déjà posée' };
  const k = String(p.ckey || '');
  if (k.length < 24) return { ok: false, error: 'clé trop courte' };
  P.setProperty('CONSOLE_KEY', k);
  return { ok: true };
}
function consoleData(p) {
  if (!consoleOk(p)) return { ok: false, error: 'bad ckey' };
  const all = loadAll(), t = today();
  const par = {};
  all.engs.forEach(e => {
    const c = calc(e, faitsDe(all, e.id), t);
    const past = [];
    for (let i = 13; i >= 0; i--) { const d = addDays(t, -i); past.push({ d: d, s: c.st(d) }); }
    const x = pub(e);
    Object.assign(x, { serie: c.serie, record: c.record, done28: c.done28, total28: c.total28, manques: c.manques, lastDone: c.lastDone,
      today_state: c.today_state, pastilles: past, taux: c.total28 ? Math.round(100 * c.done28 / c.total28) : null });
    const el = par[e.email] = par[e.email] || { email: e.email, prenom: e.prenom, whatsapp: '', engagements: [] };
    if (e.whatsapp) el.whatsapp = String(e.whatsapp);
    el.prenom = e.prenom || el.prenom;
    el.engagements.push(x);
  });
  const lim = addDays(t, -45);
  const rappels = rows(all.shR, RA_KEYS)
    .filter(r => (r.type === 'relance' || r.type === 'appel') && String(r.date).slice(0, 10) >= lim)
    .map(r => ({ row: r._row, date: String(r.date).slice(0, 10), type: r.type, id: String(r.id), prenom: r.prenom, email: r.email,
      action: r.action, serie: r.serie, manques: r.manques, lien: r.lien, traite: String(r.traite || '').slice(0, 10) }));
  // fiches élèves (étape 2) : jeton du portail, vision, binôme, visibilité, intake ; y compris celles sans engagement
  EL_CACHE = null;
  tabsEtape2(all.ss);
  const bilans = rows(tab(all.ss, BI_TAB, BI_HDR), BI_KEYS);
  eleves(all.ss).forEach(el => {
    const x = par[el.email] = par[el.email] || { email: el.email, prenom: el.prenom, whatsapp: String(el.whatsapp || ''), engagements: [] };
    if (!x.whatsapp && el.whatsapp) x.whatsapp = String(el.whatsapp);
    let intake = null; try { intake = el.intake ? JSON.parse(el.intake) : null; } catch (e) { }
    Object.assign(x, { portail: el.jeton ? PORTAIL_URL + '?t=' + el.jeton : '', vision: el.vision || '', binome: el.binome || '', public: el.public === 'oui',
      intake_le: String(el.intake_le || '').slice(0, 10), q12: el.q12 || '', q11: el.q11 || '', heures: el.heures || '', moment: el.moment || '', jour_calme: el.jour_calme || '', q19: el.q19 || '', q9: el.q9 || '', intake: intake });
  });
  Object.keys(par).forEach(m => {
    par[m].bilans = bilans.filter(b => b.email === m).slice(-8).reverse().map(b => ({ date: String(b.date).slice(0, 10), semaine: b.semaine, engagement: b.engagement, hebdo: b.hebdo, pourquoi: b.pourquoi, donne: b.donne, serie: b.serie, jours: b.jours, note: b.note }));
    // semaine en cours (lundi -> aujourd'hui) pour le croisement avec le bilan
    const jour = all.engs.find(e => e.email === m && e.statut !== 'terminé' && e.frequence !== 'hebdo');
    const heb = all.engs.find(e => e.email === m && e.statut !== 'terminé' && e.frequence === 'hebdo');
    const ws = weekStart(t), wsP = addDays(ws, -7);
    if (jour) { const c = calc(jour, faitsDe(all, jour.id), t); par[m].semaineJours = statsSemaine(jour, c, ws, t); par[m].semainePrecJours = statsSemaine(jour, c, wsP, addDays(ws, -1)); }
    if (heb) { const c = calc(heb, faitsDe(all, heb.id), t); const j = (joursSet(heb)[0] || 7) - 1; par[m].hebdoFait = c.st(addDays(ws, j)) === 'fait'; par[m].hebdoPrecFait = c.st(addDays(wsP, j)) === 'fait'; }
  });
  return { ok: true, today: t, semaine: semaineProgramme(t), semaineIso: isoWeekKey(t), semainePrecIso: isoWeekKey(addDays(t, -7)),
    eleves: Object.keys(par).map(k => par[k]), rappels: rappels, promo: promoData(all, t), intake_form: 'https://tally.so/r/' + INTAKE_FORM };
}
function rappelTraite(p) {
  if (!consoleOk(p)) return { ok: false, error: 'bad ckey' };
  return withLock(() => {
    const all = loadAll();
    const row = parseInt(p.row, 10);
    if (!(row >= 2) || row > all.shR.getLastRow()) return { ok: false, error: 'ligne introuvable' };
    const type = String(all.shR.getRange(row, 2).getValue());
    if (type !== 'relance' && type !== 'appel') return { ok: false, error: 'ce n\'est pas une relance' };
    if (p.id && String(all.shR.getRange(row, 3).getValue()) !== String(p.id)) return { ok: false, error: 'la ligne a changé, recharge la console' };
    const val = p.traite === false ? '' : today();
    all.shR.getRange(row, RA_KEYS.indexOf('traite') + 1).setNumberFormat('@').setValue(val);
    return { ok: true, row: row, traite: val };
  });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
// déploiement 15/09 00:46
