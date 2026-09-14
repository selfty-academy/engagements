#!/usr/bin/env python3
"""Questionnaire d'entrée des élèves Selfty Academy (« intake », 20 questions) via l'API Tally.

Texte : selfty-plateforme/mail-bienvenue-v2.md, section 3. Même DA et mêmes pièges que le bilan hebdo
(selfty-console/eow/build_form.py) : créer directement en PUBLISHED, renvoyer styles-selfty.json à chaque update.
Hidden fields `email` et `prenom` portés par le lien perso (portail, console, mail de bienvenue).
Les réponses arrivent au pont Engagements par webhook Tally (onglet « Élèves » du Sheet Engagements Selfty).

Usage :
  python3 build_form.py create              -> nouveau form
  python3 build_form.py update FORM_ID      -> remplace les blocs (les réponses restent)
  python3 build_form.py webhook FORM_ID URL -> branche le webhook FORM_RESPONSE vers le pont
  python3 build_form.py webhooks            -> liste les webhooks du compte
"""
import json, sys, urllib.request, uuid

HERE = __file__.rsplit('/', 1)[0]
KEY = open(HERE + '/../../selfty-console/tally-key.txt').read().strip()
API = 'https://api.tally.so'
WORKSPACE = 'wAvg5N'
LOGO_URL = 'https://storage.tally.so/83e59b8d-1cb9-42fe-931e-d6062a8cbfc1/logo-selfty-encre.png'

blocks = []
_page = [0]
u = lambda: str(uuid.uuid4())


def add(type_, group_uuid, group_type, payload, block_uuid=None):
    b = {'uuid': block_uuid or u(), 'type': type_, 'groupUuid': group_uuid, 'groupType': group_type, 'payload': payload}
    blocks.append(b)
    return b


def text(t):
    return add('TEXT', u(), 'TEXT', {'safeHTMLSchema': [[t]]})


def heading(level, t):
    ht = 'HEADING_%d' % level
    return add(ht, u(), ht, {'safeHTMLSchema': [[t]]})


def q(t):
    return add('TITLE', u(), 'QUESTION', {'safeHTMLSchema': [[t]]})


def choix(options, required=True, autre=False):
    g = u()
    for i, opt in enumerate(options):
        add('MULTIPLE_CHOICE_OPTION', g, 'MULTIPLE_CHOICE', {
            'index': i, 'isRequired': required, 'isFirst': i == 0, 'isLast': i == len(options) - 1 and not autre, 'text': opt})
    return g


def cases(options, required=True):
    g = u()
    for i, opt in enumerate(options):
        add('CHECKBOX', g, 'CHECKBOXES', {
            'index': i, 'isRequired': required, 'isFirst': i == 0, 'isLast': i == len(options) - 1, 'text': opt})
    return g


def champ(type_, required, placeholder=''):
    return add(type_, u(), type_, {'isRequired': required, 'placeholder': placeholder})


def page(button=None, name=None, first=False, last=False, ty=False):
    p = {'index': _page[0], 'isFirst': first, 'isLast': last, 'isThankYouPage': ty, 'isQualifiedForThankYouPage': ty}
    _page[0] += 1
    if button:
        p['button'] = {'label': button}
    if name:
        p['name'] = name
    return add('PAGE_BREAK', u(), 'PAGE_BREAK', p)


# ---------------------------------------------------------------- accueil
add('FORM_TITLE', u(), 'TEXT', {
    'title': 'Ton point de départ',
    'safeHTMLSchema': [['Ton point de départ']],
    'button': {'label': 'Je commence'},
    'logo': LOGO_URL,
})
add('HIDDEN_FIELDS', u(), 'HIDDEN_FIELDS', {'hiddenFields': [{'uuid': u(), 'name': 'email'}, {'uuid': u(), 'name': 'prenom'}]})
text('Quinze minutes pour dire d’où tu pars, ce que tu veux et ce qui risque de te ralentir. Anaïs lit chaque réponse avant ta première semaine : c’est avec ça qu’elle prépare ton accompagnement.')
text('Réponds avec tes mots, sans chercher la bonne réponse. Personne d’autre qu’Anaïs et Ambre ne lit ce questionnaire.')

# ---------------------------------------------------------------- toi (si le lien n'est pas perso)
page(button='Suivant', name='Toi', first=True)
text('Si tu as ouvert ce questionnaire depuis ton lien personnel, tu peux passer. Sinon, dis-nous qui tu es :')
q('Prénom')
champ('INPUT_TEXT', False, 'Ton prénom')
q('E-mail')
champ('INPUT_EMAIL', False, 'L’adresse avec laquelle tu t’es inscrite')

# ---------------------------------------------------------------- A
page(button='Suivant', name='D’où tu pars')
heading(2, 'D’où tu pars')
q('1. Aujourd’hui, ton activité, c’est quoi exactement ?')
choix(['Je ne coache pas encore', 'Je coache gratuitement ou pour me former', 'Je coache et je facture, à côté d’un emploi', 'Je vis de mon activité', 'Autre'])
q('Si « autre », précise')
champ('INPUT_TEXT', False)
q('2. Quelles formations ou pratiques tu as déjà suivies (coaching, thérapie, somatique, autre), et ce que tu en gardes ?')
champ('TEXTAREA', True)
q('3. Combien de personnes tu as accompagnées jusqu’ici, gratuitement ou non ?')
choix(['0', '1 à 5', '6 à 20', 'Plus de 20'])
q('4. Tes revenus du coaching sur les 3 derniers mois, en tout ?')
choix(['0 €', 'Moins de 1 000 €', '1 000 à 5 000 €', 'Plus de 5 000 €'])
q('Et ton revenu principal vient d’où aujourd’hui ?')
champ('INPUT_TEXT', True, 'Ex. : mon emploi salarié, mon activité, mon conjoint')

# ---------------------------------------------------------------- B
page(button='Suivant', name='Ton offre')
heading(2, 'Ton offre et tes clientes')
q('5. Si tu as une offre, décris-la en 3 lignes : pour qui, quoi, combien.')
champ('TEXTAREA', True, '« Pas encore » est une réponse acceptée')
q('6. La dernière fois que tu as annoncé un prix, ça s’est passé comment ?')
champ('TEXTAREA', True)
q('7. Ta cliente idéale : qui, quel problème, qu’est-ce qu’elle veut à la fin ?')
champ('TEXTAREA', True)

# ---------------------------------------------------------------- C
page(button='Suivant', name='Ce que tu veux')
heading(2, 'Ce que tu veux, en 27 semaines')
q('8. Le 17 avril 2027, qu’est-ce qui doit être vrai pour que tu dises « ça valait le coup » ?')
champ('TEXTAREA', True)
q('9. Un chiffre pour la fin du programme : nombre de clientes, revenu mensuel ou séances par semaine. Choisis-en un.')
champ('INPUT_TEXT', True, 'Ex. : 5 clientes régulières')
q('10. Ta vision, telle que tu l’as dite pendant ton appel avec Anaïs : écris-la, et complète-la si elle a bougé.')
champ('TEXTAREA', True, 'Elle s’affichera en haut de ta page personnelle')

# ---------------------------------------------------------------- D
page(button='Suivant', name='Ce qui peut te ralentir')
heading(2, 'Ce qui peut te ralentir')
q('11. Ta peur numéro 1 en entrant dans ce programme ?')
champ('TEXTAREA', True)
q('12. Ce qui t’a fait abandonner ou ralentir la dernière fois que tu t’es engagée dans quelque chose ?')
champ('TEXTAREA', True, 'On s’en servira pour te rattraper au bon moment')
q('13. Tes contraintes réelles sur les 6 mois : enfants, emploi, santé, déménagement, autre ?')
champ('TEXTAREA', True)
q('14. Combien d’heures par semaine tu peux vraiment consacrer à l’école, hors calls ?')
choix(['Moins de 2 h', '2 à 4 h', '4 à 8 h', 'Plus de 8 h'])

# ---------------------------------------------------------------- E
page(button='Suivant', name='Comment tu fonctionnes')
heading(2, 'Comment tu fonctionnes')
q('15. Tu apprends mieux comment ?')
cases(['En regardant', 'En écrivant', 'En pratiquant tout de suite', 'En discutant', 'Seule', 'En groupe'])
q('16. Quand ça coince, tu as tendance à :')
choix(['Te taire', 'Demander de l’aide', 'Disparaître quelques jours', 'Foncer sans réfléchir'])
q('Tu veux préciser ?')
champ('INPUT_TEXT', False)
q('17. À quel moment de la journée tu es la plus disponible pour toi ?')
choix(['Matin tôt', 'Matinée', 'Midi', 'Après-midi', 'Soirée'])
q('Quel jour de la semaine est le plus calme pour toi ?')
choix(['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'])

# ---------------------------------------------------------------- F
page(button='Envoyer', name='Ton engagement')
heading(2, 'Ce que tu attends, et ton engagement')
q('18. Ce que tu attends précisément d’Anaïs et d’Ambre pendant ces 6 mois, et ce que tu ne veux surtout pas ?')
champ('TEXTAREA', True)
q('19. Ce que tu t’engages à faire, toi, chaque semaine, quoi qu’il arrive : une action quotidienne et une action hebdo.')
champ('TEXTAREA', True, 'Ex. : 20 min de prospection chaque jour ; une séance d’entraînement par semaine')
q('20. Ton engagement')
text('Je m’engage à être présente aux calls (2 absences maximum sur le programme), à remplir mon bilan chaque vendredi, à pratiquer chaque semaine, et à prévenir avant de disparaître.')
cases(['Je m’engage'])
q('Ton prénom pour signer')
champ('INPUT_TEXT', True)

# ---------------------------------------------------------------- merci
page(name='Merci', ty=True, last=True)
heading(1, 'Merci, c’est reçu.')
text('Anaïs lit ton questionnaire avant ta première semaine. Ta vision s’affiche maintenant en haut de ta page personnelle.')
text('Prochaine étape : déclare ton action quotidienne et ton action hebdo sur ta page. On se retrouve au premier call.')

payload = {
    'workspaceId': WORKSPACE,
    'status': 'PUBLISHED',
    'name': 'Selfty Academy · Ton point de départ (intake)',
    'blocks': blocks,
    'settings': {'language': 'fr', 'hasProgressBar': True, 'hasPartialSubmissions': False, 'pageAutoJump': False},
}
payload['settings']['styles'] = json.load(open(HERE + '/../../selfty-console/eow/styles-selfty.json'))


def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method)
    req.add_header('Authorization', 'Bearer ' + KEY)
    req.add_header('User-Agent', 'curl/8.4.0')
    data = None
    if body is not None:
        req.add_header('Content-Type', 'application/json')
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
    try:
        with urllib.request.urlopen(req, data) as r:
            return r.status, json.loads(r.read().decode('utf-8') or 'null')
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'create':
        status, resp = call('POST', '/forms', payload)
        print('HTTP', status)
        if status == 201:
            json.dump({'id': resp['id']}, open(HERE + '/form-id.json', 'w'))
            print('Form ID :', resp['id'], '· public https://tally.so/r/%s' % resp['id'])
        else:
            print(resp)
    elif cmd == 'update':
        status, resp = call('PATCH', '/forms/' + sys.argv[2], {'blocks': blocks, 'settings': payload['settings'], 'name': payload['name']})
        print('HTTP', status, '' if status in (200, 204) else resp)
    elif cmd == 'webhook':
        status, resp = call('POST', '/webhooks', {'formId': sys.argv[2], 'url': sys.argv[3], 'eventTypes': ['FORM_RESPONSE']})
        print('HTTP', status, resp if isinstance(resp, str) else json.dumps(resp, ensure_ascii=False)[:600])
    elif cmd == 'webhooks':
        print(json.dumps(call('GET', '/webhooks')[1], ensure_ascii=False, indent=1)[:4000])
    else:
        print(__doc__)
