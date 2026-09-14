# Engagements Selfty

Système d'accountability des élèves de la Selfty Academy, étape 1 « le rappel qui marche » : une élève déclare une action à répéter (tous les jours, certains jours, ou une fois par semaine), reçoit un mail de rappel à l'heure qu'elle a choisie avec un seul bouton « C'est fait », voit sa série grandir, et Anaïs sait qui décroche avec le message WhatsApp déjà prêt.

- **Page en ligne** : https://selfty-academy.github.io/engagements/ (code de l'école `Selfty2026`, demandé une fois par téléphone).
- **Un seul fichier** : `index.html` (mobile d'abord, DA Selfty, logo encre hébergé sur `selfty-academy.github.io/console/contrat/logo.png`).
- **Pont Apps Script** : dossier `pont/` (clasp, **compte selfty.academy, profil `--user selfty`**). Données dans le Google Sheet « Engagements Selfty » (onglets `Engagements`, `Faits`, `Rappels`) créé par le pont dans le Drive de selfty.academy. Aucune donnée personnelle dans ce repo.
- **Mode test local** : `index.html?local=1` (tout reste dans le navigateur, aucun mail), `?local=1&demo=1` ajoute deux engagements fictifs avec 12 jours d'historique.

## Mise en route (une fois, à faire dans un navigateur connecté à selfty.academy@gmail.com)

Ouvrir cette URL, accepter l'autorisation (Sheets, Drive, mail, déclencheurs), puis la rouvrir si la première ouverture n'affiche que l'écran d'autorisation :

```
https://script.google.com/macros/s/AKfycbwROj9t1ce54CnwjVJ7piRzVhqug2eKzyjy8y3BhvpJcKDrXHEIF_YmZQ169cgw1zc/exec?key=<KEY>&what=setup
```

`<KEY>` = contenu de `pont/pont-key.txt` (local, jamais commité ; la même clé est dans `index.html`, elle évite seulement les appels accidentels).

Réponse attendue : `{"ok":true,"sheet_url":"…","triggers":["chaqueHeure"],…}`. Le Sheet est créé avec ses 3 onglets, le déclencheur horaire est installé.

Si l'URL n'affiche pas l'écran d'autorisation : `cd pont && clasp open-script --user selfty`, exécuter la fonction `autoriser()` dans l'éditeur, accepter, puis rouvrir l'URL de setup.

## Ce que fait la page

- **Aujourd'hui** : une carte par engagement actif (action, pourquoi, preuve, série en cours, record, taux sur 4 semaines, 14 dernières pastilles) avec le gros bouton **« Fait aujourd'hui ✓ »** (ou « Fait cette semaine » pour un hebdo), « Fait hier (avant minuit) » si la veille a été manquée, « Pas aujourd'hui », et « Détails » (pause de 1 à 7 jours, reprendre, arrêter). Après un « Fait », un mot de preuve facultatif.
- **Historique** : grille des 4 dernières semaines (lundi à dimanche) par engagement : vert fait, rose manqué, beige « pas ce jour-là », bleu pause, pointillé pas prévu. Une case touchée montre la note du jour.
- **Bilan** : jours faits / prévus cette semaine et la semaine dernière, série, un mot sur la semaine, le taux global, et les 8 règles du jeu.
- **Déclarer** : fréquence (tous les jours / certains jours / chaque semaine), jours, action, pourquoi, preuve, heure du rappel (6h à 22h). Un seul engagement quotidien et un seul hebdo par élève : l'ancien passe en « terminé » et reste dans l'historique.
- Identité légère : prénom + e-mail (+ WhatsApp facultatif, pour les relances d'Anaïs) mémorisés dans le téléphone (localStorage), pas de mot de passe.

## Règles de calcul (identiques dans la page et le pont)

- Un jour non prévu ne compte ni pour ni contre. Une pause déclarée est neutre. Un « Pas aujourd'hui » dit à temps ne casse pas la série mais compte dans le taux. Le silence (jour prévu sans rien) casse la série.
- Le « Fait » du jour J est accepté jusqu'au lendemain minuit (lien du mail ou bouton « Fait hier »). Pour un hebdo, n'importe quel jour de la semaine en cours.
- Série = jours prévus faits d'affilée en remontant depuis hier (aujourd'hui compte s'il est fait). Record = plus longue série depuis le début. Taux = faits / (faits + manqués + pas aujourd'hui) sur 28 jours.
- Pause : 7 jours max, 2 fois par engagement, à partir du jour même. Reprise automatique le lendemain de la fin, ou à la main.

## Mails (MailApp, depuis selfty.academy, nom « Anaïs, Selfty Academy », cadre rose)

Textes du document de conception (`selfty-plateforme/systeme-accountability.md`, section 4).

- **À la déclaration** : « {Prénom}, ton engagement est posé » (récap + heure du premier rappel).
- **Rappel quotidien** (déclencheur horaire, à l'heure choisie, seulement les jours prévus, jamais deux fois le même jour, pas envoyé si déjà fait) : objet « {Prénom}, ton action du jour · série {n} 🔥 », phrase de série selon le cas (jour 0, 1 à 6, multiples de 7, record, ≥ 30), boutons « C'est fait ✓ » / « Pas aujourd'hui » / « Mettre en pause » (liens `?what=done|skip|pause&id=…&jeton=…&d=…`, page de confirmation HTML avec la grille des 4 semaines et un champ pour noter la preuve).
- **Série cassée** (9h, le lendemain d'un jour prévu manqué, seulement si la série était ≥ 3) : objet « {Prénom}, ta série de {n} jours s'est arrêtée hier », bouton « Je reprends aujourd'hui ✓ ». La question sur la réponse 12 de l'intake arrive à l'étape 2 (le mail demande pour l'instant « qu'est-ce qui s'est passé, hier ? »).
- **Mail du lundi** (7h) : « Ta semaine {k} sur 27, {Prénom} », jours faits sur prévus la semaine dernière, action hebdo faite ou pas, question « qu'est-ce qui rendrait cette semaine réussie ? ». Les lignes bilan du vendredi, engagement de la semaine et « 3 choses de la semaine » arrivent à l'étape 2.
- **Relance humaine** (9h, à 2 jours de silence, une fois par épisode ; à 5 jours, ligne « appel ») : **pas de mail**. Une ligne dans l'onglet `Rappels` (type `relance` ou `appel`) avec le lien `wa.me` prérempli du message d'Anaïs (numéro WhatsApp de l'élève si elle l'a donné, sinon WhatsApp ouvre le choix du contact). Anaïs envoie ou pas, et note la date dans « Traité le ». Le Telegram à Anaïs et la carte dans la console arrivent avec l'onglet console (étape 1, jour 4).

Quota : 100 mails / 24 h sur le compte gratuit. Avec 15 élèves : 1 rappel par jour + casses + lundi, ça passe. Au-delà de 25 élèves, Google Workspace.

## Onglets du Sheet

- `Engagements` : ID, Créé le, Prénom, E-mail, WhatsApp, Action, Fréquence (quotidien / jours / hebdo), Jours (1 = lundi … 7 = dimanche), Heure du rappel, Pourquoi, Preuve, Statut (actif / pause / terminé), Pause du, Pause jusqu'au, Pauses, Jeton, Début, Fin, Dernier rappel, MAJ.
- `Faits` : Date, E-mail, ID engagement, Fait (oui / non / pause), Heure du clic, Source (mail / page), Note.
- `Rappels` : Date, Type (rappel / casse / relance / appel / lundi), ID engagement, Prénom, E-mail, Action, Série, Jours manqués, Message / lien, Traité le.

## Endpoints du pont

`doGet ?key=…&what=setup|list&email=…|tick&h=…` ; sans clé, par jeton : `?what=done|skip|pause|note&id=…&jeton=…&d=…` (pages HTML des liens du mail).
`doPost {key, what, …}` : `list {email}`, `declare {prenom,email,whatsapp,action,frequence,jours,heure,pourquoi,preuve}`, `done {id,email,d?,note?}`, `skip {id,email,d?}`, `pause {id,email,jours}`, `resume {id,email}`, `stop {id,email}`, `tick {h?}` (simule le déclencheur à l'heure h : rappels, et à 9h casses + relances, lundi 7h mail de la semaine), `mail_test {to}`.

Test en ligne de commande (jamais `-X POST` : la redirection 302 casse) :
```
curl -s -L -d '{"key":"<KEY>","what":"mail_test","to":"toi@exemple.fr"}' "https://script.google.com/macros/s/AKfycbwROj9t1ce54CnwjVJ7piRzVhqug2eKzyjy8y3BhvpJcKDrXHEIF_YmZQ169cgw1zc/exec"
curl -s -L "https://script.google.com/macros/s/AKfycbwROj9t1ce54CnwjVJ7piRzVhqug2eKzyjy8y3BhvpJcKDrXHEIF_YmZQ169cgw1zc/exec?key=<KEY>&what=tick&h=7"
```

## Modifier le pont

```
cd pont
clasp push -f --user selfty
clasp redeploy AKfycbwROj9t1ce54CnwjVJ7piRzVhqug2eKzyjy8y3BhvpJcKDrXHEIF_YmZQ169cgw1zc --user selfty -d "desc"
```
Jamais `clasp deploy` (nouvelle URL). Si les scopes changent : rouvrir l'URL de setup (ou `autoriser()` dans l'éditeur). Piège : `clasp create-script` écrase `appsscript.json` (le bloc `webapp` saute), le réécrire avant de pousser.

## Modifier la page

Éditer `index.html`, `git push` sur `main` : GitHub Pages se met à jour en 1 à 2 minutes.

## Étapes 2 et 3 (15/09/2026)

Tout passe par le même pont (déploiement @6, même URL), même DA, testé en local (`node pont/test-local.js`, 31 vérifications, Apps Script simulé, aucun réseau) puis en réel (intake Tally -> webhook -> Sheet -> portail, nettoyé).

- **Portail perso** : https://selfty-academy.github.io/engagements/portail/?t=JETON (dossier `portail/`, test `?local=1`). Vision en tête, semaine k/27 (J-… avant le lundi 12/10), « Fait » / « Pas aujourd'hui » / pause, série + grille des 27 semaines, ma semaine (module de l'onglet Programme, Selfty Call, pratique de l'agenda des pratiques), binôme (série + coup de pouce WhatsApp), bilan du vendredi (rendu ou lien perso avec série / jours / hebdo), promo (score, séries ≥ 7, objectif 85 %, case « visible »), règles. Pas de code d'école : le jeton suffit. Le jeton vit dans l'onglet **Élèves** (créé à la déclaration, à l'intake, ou par la console) ; tous les mails du pont pointent vers le portail (« Voir ma page », pied de mail, pages « Fait »).
- **Intake** « Ton point de départ » : Tally https://tally.so/r/81X5kk (20 questions de `selfty-plateforme/mail-bienvenue-v2.md`, « quand tu bloques » reformulé), script `intake/build_form.py` (create / update / webhook / webhooks, clé Tally locale). Webhook Tally -> pont `?wh=<secret>` (secret posé par `wh_init`, jamais dans le code) -> onglet Élèves : vision (Q10), peur (Q11), abandon (Q12, cité dans le mail de série cassée), heures (Q14), moment + jour calme (Q17), engagement (Q19), chiffre de fin (Q9), toutes les réponses en JSON. Lien ajouté au mail de bienvenue (script Contrats) + bouton sur le portail + copie dans la console.
- **Bilan du vendredi croisé** : Tally 1AekPO mis à jour (`selfty-console/eow/build_form.py`) : champs cachés `serie`, `jours`, `hebdo` + « qu'est-ce qui explique les jours manqués », « ton action hebdo : faite ? », « ce que ça a donné » ; « blocage » retiré. Webhook -> onglet **Bilans** (idempotent par ID Tally). Le pont recalcule chaque heure l'onglet **Résumé semaine** (x/y jours, série, hebdo) que le script Contrats lit pour le mail du vendredi 16h (ligne « Cette semaine : x/y jours, série n » + champs cachés). Console : bilan à côté des « Fait », écart signalé (hebdo cochée mais « non » au bilan, ou l'inverse, ou ≥ 80 % de Fait avec une semaine notée ≤ 3/10).
- **Mail du lundi complet** : semaine k/27, x/y jours + hebdo, bilan du vendredi fait / pas fait, « ton engagement pour cette semaine » (écrit vendredi), les 3 choses de la semaine (module de l'onglet **Programme** à remplir par Anaïs, 27 lignes préremplies, Selfty Call « samedi 10h » provisoire, pratique de la semaine ou « à poser, avec {binôme} »).
- **Binômes** : choisis dans la console (onglet Ambre, carte Engagements, `binome_set`, les deux fiches liées). À 2 jours de silence, mail court à la binôme avec le WhatsApp prérempli (une fois par épisode, ligne `binome` dans Rappels) avant la relance d'Anaïs. Une pratique d'hier (agenda des pratiques, créneau pris) = « Fait » automatique sur l'action hebdo qui contient « pratiq » (9h).
- **Score de promo opt-in** : case sur le portail (`public_set`), écran de projection https://selfty-academy.github.io/engagements/promo/ (`?local=1` pour la démo) : score de la semaine (lundi : semaine passée), séries ≥ 7, objectif 85 %, tableau des seules élèves visibles.
- **Pointage Zoom** : prêt dans `selfty-console/build.py`, inactif tant que les secrets `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_MEETING_ID` n'existent pas (app Server-to-Server OAuth sur le compte d'Anaïs). N'écrit que les calls sans aucun pointage (source zoom).
- Endpoints ajoutés : `portail`, `public_set`, `promo`, `wh_init`, `binome_set`, `vision_set`, `console` (enrichi : jeton, vision, binôme, intake, bilans, semaine en cours), `dev_clear {ckey, email}` (tests). `.claspignore` exclut `test-local.js` (sinon Apps Script le charge et le pont plante : arrivé le 15/09, corrigé en 3 min).
- Reste (étape 3) : bilan de mi-parcours (semaine 13), Telegram à Anaïs, remplir l'onglet Programme, confirmer jour / heure du Selfty Call.

## Étapes suivantes (document de conception, section 10)

- **Reste de l'étape 1** : Telegram à Anaïs (déclaration + « à relancer » à 9h), carte Engagements dans l'onglet Ambre de la console (série, pastilles, bouton WhatsApp lu dans `Rappels`), tests 3 jours réels avec Anaïs, Ambre et Alex, réglage des textes.
- **Étape 2** : page portail perso par lien (vision, grille des 27 semaines), bilan du vendredi croisé (hidden fields série / jours), mail de bienvenue v2 et intake (question 12 dans le mail de casse), mail du lundi complet.
- **Étape 3** : binômes (mail binôme à 2 jours, coup de pouce WhatsApp), score de promo opt-in, pointage Zoom, bilan de mi-parcours.
