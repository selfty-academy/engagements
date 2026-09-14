// Test local du pont Engagements, sans Google : Sheets, MailApp, propriétés et verrous simulés en mémoire.
// node pont/test-local.js   (aucun réseau, aucun mail réel ; les données sont fictives)
const fs = require('fs'), vm = require('vm'), path = require('path'), crypto = require('crypto');

// ---------- simulacres Apps Script ----------
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
  getValues() { const o = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.get(this.r + i, this.c + j)); o.push(row); } return o; }
  getValue() { return this.sh.get(this.r, this.c); }
  setValues(v) { v.forEach((row, i) => row.forEach((x, j) => this.sh.set(this.r + i, this.c + j, x))); return this; }
  setValue(x) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, x); return this; }
  clearContent() { return this.setValue(''); }
  setNumberFormat() { return this; } setFontWeight() { return this; } setBackground() { return this; } setDataValidation() { return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.d = []; }
  get(r, c) { return (this.d[r - 1] || [])[c - 1] ?? ''; }
  set(r, c, x) { while (this.d.length < r) this.d.push([]); this.d[r - 1][c - 1] = x; }
  getLastRow() { let n = this.d.length; while (n > 0 && !(this.d[n - 1] || []).some(x => x !== '' && x !== undefined)) n--; return n; }
  getLastColumn() { return Math.max(0, ...this.d.map(r => r.length)); }
  getMaxRows() { return Math.max(1000, this.d.length); }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  appendRow(v) { this.d.splice(this.getLastRow(), 0, v.slice()); }
  deleteRow(r) { this.d.splice(r - 1, 1); }
  setFrozenRows() { } setName(n) { this.name = n; return this; } setColumnWidth() { } setColumnWidths() { }
  getName() { return this.name; }
}
class Book {
  constructor(id, name) { this.id = id; this.name = name; this.sheets = [new Sheet('Feuille 1')]; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getId() { return this.id; }
  addEditor() { }
}
const BOOKS = {};
const MAILS = [];
const PROPS = {};
const TZ_FMT = (date, fmt) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(date).map(x => [x.type, x.value]));
  return fmt.replace(/'T'/g, 'T').replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second)
    .replace(/\bH\b/, String(Number(p.hour))).replace(/\bu\b/, String(((date.getUTCDay() + 6) % 7) + 1));
};
const ctx = {
  console, JSON, Math, Date, String, Number, Array, Object, RegExp, encodeURIComponent, decodeURIComponent, parseInt, isNaN, Error,
  SpreadsheetApp: {
    create: n => { const id = 'book' + Object.keys(BOOKS).length; return (BOOKS[id] = new Book(id, n)); },
    openById: id => { if (!BOOKS[id]) throw new Error('introuvable ' + id); return BOOKS[id]; },
  },
  MailApp: { sendEmail: o => MAILS.push(o), getRemainingDailyQuota: () => 100 },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => PROPS[k] ?? null, setProperty: (k, v) => { PROPS[k] = v; } }) },
  LockService: { getScriptLock: () => ({ waitLock() { }, tryLock() { return true; }, releaseLock() { } }) },
  ScriptApp: { getService: () => ({ getUrl: () => 'https://exec.test/exec' }), getProjectTriggers: () => [], deleteTrigger() { }, newTrigger: () => ({ timeBased: () => ({ everyHours: () => ({ create() { } }) }) }) },
  ContentService: { createTextOutput: s => ({ s, setMimeType() { return this; } }), MimeType: { JSON: 'json' } },
  HtmlService: { createHtmlOutput: h => ({ h, setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } }), XFrameOptionsMode: { ALLOWALL: 1 } },
  Utilities: { formatDate: (d, tz, f) => TZ_FMT(d, f), getUuid: () => crypto.randomUUID() },
  Logger: { log: (...a) => console.log('  [log]', ...a) },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.js'), 'utf8'), ctx);
const run = code => vm.runInContext(code, ctx);
const J = o => JSON.parse(o.s);
let ok = 0, ko = 0;
const check = (lab, cond, extra) => { if (cond) { ok++; console.log('  ✓ ' + lab); } else { ko++; console.log('  ✗ ' + lab, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)); } };

// ---------- données fictives ----------
const today = run('today()');
const add = (n) => run(`addDays('${today}', ${n})`);
const pratiques = BOOKS['12VqHU7OFsSizRCEkN3eg9X6PwmPkj7tlmbCL1dW8NoU'] = new Book('12VqHU7OFsSizRCEkN3eg9X6PwmPkj7tlmbCL1dW8NoU', 'Pratiques Selfty');
const cr = pratiques.insertSheet('Creneaux');
cr.appendRow(['ID', 'Créé le', 'Date', 'Heure', 'Durée (min)', 'Prénom', 'E-mail', 'Rôle', 'Thème', 'Lien visio', 'Note', 'Statut', 'Prénom inscrite', 'E-mail inscrite', 'Rôle inscrite', 'Inscrite le', 'Rappel envoyé', 'MAJ']);
cr.appendRow(['c1', '', add(-1), '18:00', 60, 'Julia', 'julia@test.fr', 'coach', '', '', '', 'ouvert', 'Marc', 'marc@test.fr', 'coachee', '', '', '']);
cr.appendRow(['c2', '', run(`addDays(weekStart('${today}'), 3)`), '12:30', 45, 'Julia', 'julia@test.fr', 'coach', '', '', '', 'ouvert', '', '', '', '', '', '']);

console.log('1. setup + clé console + webhook');
const setup = J(run(`doPost({ postData: { contents: JSON.stringify({ key: KEY, what: 'setup' }) } })`));
check('setup ok', setup.ok, setup);
run(`consoleKeyInit({ ckey: 'ck-test-0123456789abcdefghijkl' })`);
const wh = J(run(`doPost({ postData: { contents: JSON.stringify({ key: KEY, what: 'wh_init', ckey: 'ck-test-0123456789abcdefghijkl' }) } })`));
check('wh_init renvoie une URL', wh.ok && /\?wh=/.test(wh.webhook), wh);
const secret = wh.webhook.split('wh=')[1];
const ss = Object.values(BOOKS).find(b => b.name === 'Engagements Selfty');
check('onglets Élèves / Bilans / Programme / Résumé semaine créés', ['Élèves', 'Bilans', 'Programme', 'Résumé semaine'].every(n => ss.getSheetByName(n)));
check('Programme prérempli 27 semaines', ss.getSheetByName('Programme').getLastRow() === 28);

console.log('2. déclarations (Julia quotidien 14 j d\'historique, Marc hebdo « pratiquer »)');
const dj = J(run(`doPost({ postData: { contents: JSON.stringify({ key: KEY, what: 'declare', prenom: 'Julia', email: 'julia@test.fr', whatsapp: '06 11 22 33 44', action: '20 min de prospection', frequence: 'quotidien', heure: '08:00', pourquoi: 'ma première cliente', preuve: 'le message' }) } })`));
const dm = J(run(`doPost({ postData: { contents: JSON.stringify({ key: KEY, what: 'declare', prenom: 'Marc', email: 'marc@test.fr', action: 'Pratiquer une séance avec ma binôme', frequence: 'hebdo', jours: '5', heure: '18:00', pourquoi: 'progresser' }) } })`));
check('déclarations ok + mails « posé »', dj.ok && dm.ok && MAILS.length === 2, MAILS.map(m => m.subject));
check('mail « posé » pointe vers le portail', /engagements\/portail\/\?t=/.test(MAILS[0].htmlBody));
// historique : Julia a démarré il y a 14 jours, faite 10 jours d'affilée puis 2 jours de silence
const shE = ss.getSheetByName('Engagements'), shF = ss.getSheetByName('Faits');
shE.set(2, 17, add(-14)); shE.set(3, 17, add(-14));
for (let n = 12; n >= 3; n--) shF.appendRow([add(-n), 'julia@test.fr', dj.id, 'oui', '', 'page', '']);
check('fiches élèves créées avec jeton', run(`(EL_CACHE = null, eleves().length)`) === 2);

console.log('3. webhooks Tally');
const intake = { eventType: 'FORM_RESPONSE', data: { formId: '81X5kk', submissionId: 'S1', fields: [
  { label: 'email', type: 'HIDDEN_FIELDS', value: 'julia@test.fr' }, { label: 'prenom', type: 'HIDDEN_FIELDS', value: 'Julia' },
  { label: '10. Ta vision, telle que tu l’as dite pendant ton appel avec Anaïs : écris-la, et complète-la si elle a bougé.', type: 'TEXTAREA', value: 'Accompagner 5 femmes par mois, depuis chez moi.' },
  { label: '12. Ce qui t’a fait abandonner ou ralentir la dernière fois que tu t’es engagée dans quelque chose ?', type: 'TEXTAREA', value: 'la fatigue du soir' },
  { label: '14. Combien d’heures par semaine tu peux vraiment consacrer à l’école, hors calls ?', type: 'MULTIPLE_CHOICE', value: ['o2'], options: [{ id: 'o1', text: 'Moins de 2 h' }, { id: 'o2', text: '2 à 4 h' }] },
] } };
const wi = J(run(`doPost({ parameter: { wh: '${secret}' }, postData: { contents: ${JSON.stringify(JSON.stringify(intake))} } })`));
check('intake -> onglet Élèves (vision, Q12, heures)', wi.ok && run(`(EL_CACHE = null, eleveDe('julia@test.fr').vision)`) === 'Accompagner 5 femmes par mois, depuis chez moi.' && run(`eleveDe('julia@test.fr').heures`) === '2 à 4 h', wi);
const bad = J(run(`doPost({ parameter: { wh: 'faux' }, postData: { contents: ${JSON.stringify(JSON.stringify(intake))} } })`));
check('webhook avec mauvais secret refusé', !bad.ok);
const semPrec = run(`isoWeekKey(addDays('${today}', -7))`);
const bilan = { eventType: 'FORM_RESPONSE', data: { formId: '1AekPO', submissionId: 'B1', createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), fields: [
  { label: 'email', type: 'HIDDEN_FIELDS', value: 'marc@test.fr' }, { label: 'prenom', type: 'HIDDEN_FIELDS', value: 'Marc' }, { label: 'semaine', type: 'HIDDEN_FIELDS', value: semPrec },
  { label: 'L’action à laquelle tu t’engages pour la semaine prochaine', type: 'TEXTAREA', value: 'Proposer ma séance découverte à 2 personnes' },
  { label: 'Ton action hebdo : faite ?', type: 'MULTIPLE_CHOICE', value: ['h1'], options: [{ id: 'h1', text: 'Oui' }] },
] } };
run(`doPost({ parameter: { wh: '${secret}' }, postData: { contents: ${JSON.stringify(JSON.stringify(bilan))} } })`);
const again = J(run(`doPost({ parameter: { wh: '${secret}' }, postData: { contents: ${JSON.stringify(JSON.stringify(bilan))} } })`));
check('bilan -> onglet Bilans, doublon ignoré', again.deja && ss.getSheetByName('Bilans').getLastRow() === 2);

console.log('4. binômes');
const bs = J(run(`doPost({ postData: { contents: JSON.stringify({ key: KEY, what: 'binome_set', ckey: 'ck-test-0123456789abcdefghijkl', email: 'julia@test.fr', binome: 'marc@test.fr' }) } })`));
check('binome_set lie les deux fiches', bs.ok && run(`(EL_CACHE = null, eleveDe('marc@test.fr').binome)`) === 'julia@test.fr');

console.log('5. déclencheur de 9h : pratiques, casse, relances + mail binôme');
MAILS.length = 0;
const tick9 = J(run(`doGet({ parameter: { key: KEY, what: 'tick', h: '9' } })`));
check('pratique d\'hier = Fait sur l\'action hebdo de Marc et Julia (Julia n\'a pas d\'hebdo)', tick9.pratiques === 1, tick9);
check('relance de Julia écrite (2 jours) avec son numéro', ss.getSheetByName('Rappels').d.some(r => r[1] === 'relance' && /wa\.me\/33611223344/.test(r[8])));
const mb = MAILS.find(m => m.to === 'marc@test.fr');
check('mail à la binôme (Marc) avec WhatsApp de Julia', mb && /a besoin de sa binôme/.test(mb.subject) && /wa\.me\/33611223344/.test(mb.htmlBody), MAILS.map(m => m.to + ' ' + m.subject));
const tick9b = J(run(`doGet({ parameter: { key: KEY, what: 'tick', h: '9' } })`));
check('pas de doublon au passage suivant', tick9b.relances === 0 && ss.getSheetByName('Rappels').d.filter(r => r[1] === 'binome').length === 1, [tick9b, ss.getSheetByName('Rappels').d.map(r => r.slice(0, 3))]);
check('résumé semaine écrit (lien portail)', ss.getSheetByName('Résumé semaine').getLastRow() === 3 && /portail/.test(ss.getSheetByName('Résumé semaine').get(2, 9)));

console.log('6. mail de casse avec la réponse 12 de l\'intake');
MAILS.length = 0;
run(`mailCasse(findEng(loadAll(), '${dj.id}'), 10, 10, today())`);
check('casse cite « la fatigue du soir »', /la fatigue du soir/.test(MAILS[0].htmlBody) && /la fatigue du soir/.test(MAILS[0].body));

console.log('7. mail du lundi complet');
MAILS.length = 0;
run(`(function(){ const all = loadAll(), t = today(); const e = findEng(all, '${dm.id}'); const c = calc(e, faitsDe(all, e.id), t); mailSemaine('Marc', 'marc@test.fr', [{ e, c, x: 1, y: 1 }], t); })()`);
const ml = MAILS[0];
check('lundi : bilan du vendredi fait + engagement écrit', /bilan du vendredi fait/.test(ml.body) && /Proposer ma séance découverte/.test(ml.body), ml.body);
check('lundi : pratique de la semaine avec Julia', /Pratique .* avec Julia/.test(ml.body), ml.body);
check('lundi : bouton vers le portail', /portail\/\?t=/.test(ml.htmlBody) && !/__PAGE__/.test(ml.htmlBody));

console.log('8. portail + promo + visibilité');
const jet = run(`eleveDe('julia@test.fr').jeton`);
let po = J(run(`doGet({ parameter: { key: KEY, what: 'portail', t: '${jet}' } })`));
check('portail : vision, engagements, faits, binôme Marc, bilan lien perso', po.ok && po.vision && po.engagements.length === 1 && po.faits.length >= 10 && po.binome.prenom === 'Marc' && /tally\.so\/r\/1AekPO\?email=julia/.test(po.bilan.lien), po);
check('portail : pratiques de la semaine (avec Marc hier, créneau libre jeudi)', po.pratiques.length === 2 && po.pratiques.some(x => x.avec === 'Marc') && po.pratiques.some(x => x.heure === '12:30'), po.pratiques);
check('promo sans visibles : tableau vide', po.promo.tableau.length === 0 && po.promo.eleves === 1);
J(run(`doPost({ postData: { contents: JSON.stringify({ key: KEY, what: 'public_set', t: '${jet}', public: true }) } })`));
const pm = J(run(`doGet({ parameter: { key: KEY, what: 'promo' } })`));
check('public_set -> Julia dans le tableau de la promo', pm.tableau.length === 1 && pm.tableau[0].prenom === 'Julia', pm);
check('portail refusé avec un faux jeton', !J(run(`doGet({ parameter: { key: KEY, what: 'portail', t: 'faux-jeton-123456789' } })`)).ok);

console.log('9. console');
const co = J(run(`doPost({ postData: { contents: JSON.stringify({ key: KEY, what: 'console', ckey: 'ck-test-0123456789abcdefghijkl' }) } })`));
const cj = co.eleves.find(e => e.email === 'julia@test.fr');
check('console : portail, vision, binôme, intake, semaineJours', co.ok && /portail/.test(cj.portail) && cj.binome === 'marc@test.fr' && cj.heures === '2 à 4 h' && cj.semaineJours, cj);
check('console : bilans de Marc', co.eleves.find(e => e.email === 'marc@test.fr').bilans.length === 1);
check('console : promo', co.promo && co.promo.eleves === 1);
const rel = co.rappels.find(r => r.type === 'relance');
check('rappel_traite refuse un id qui ne colle pas', !J(run(`doPost({ postData: { contents: JSON.stringify({ key: KEY, what: 'rappel_traite', ckey: 'ck-test-0123456789abcdefghijkl', row: ${rel.row}, id: 'autre' }) } })`)).ok);
check('rappel_traite ok', J(run(`doPost({ postData: { contents: JSON.stringify({ key: KEY, what: 'rappel_traite', ckey: 'ck-test-0123456789abcdefghijkl', row: ${rel.row}, id: '${rel.id}' }) } })`)).ok);

console.log('10. lien du mail « C\'est fait » -> page avec bouton portail');
const e0 = run(`findEng(loadAll(), '${dj.id}')`);
const page = run(`pageAction('done', { id: '${dj.id}', jeton: '${e0.jeton}', d: today() })`);
check('page Fait : série 1 + bouton vers le portail', /Fait\. 1 jour/.test(page.h) && /portail\/\?t=/.test(page.h), page.h.slice(0, 300));

console.log(`\n${ok} ok, ${ko} en échec`);
process.exit(ko ? 1 : 0);
