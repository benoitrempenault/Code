/* formation.js — onglet Formation & Documents (contenu Kadimmo + assistant documents) */
var curType=null,qLvl=null,qThm='all',qAns={},qActive=[];
function showFTab(tab,btn){
  document.querySelectorAll('.ftab').forEach(function(b){b.classList.remove('active')});btn.classList.add('active');
  document.getElementById('f-fiches').style.display=tab==='fiches'?'block':'none';
  document.getElementById('f-quiz').style.display=tab==='quiz'?'block':'none';
  document.getElementById('f-train').style.display=tab==='train'?'block':'none';
  if(tab==='train')trainWake();
}
function showMod(id,btn){
  document.querySelectorAll('.fiche').forEach(function(f){f.classList.remove('active')});
  document.querySelectorAll('.modbtn').forEach(function(b){b.classList.remove('active')});
  document.getElementById('mod-'+id).classList.add('active');btn.classList.add('active');
}
function setLvl(l,btn){qLvl=l;document.querySelectorAll('.lvbtn').forEach(function(b){b.className='lvbtn'});btn.className='lvbtn l'+l;}
function setThm(t,btn){qThm=t;document.querySelectorAll('.thbtn').forEach(function(b){b.classList.remove('active')});btn.classList.add('active');}

var allQ=[
  {q:"Que signifie CR\u00B2 ?",o:["Compte Rendu R\u00E9gulier","Connu et Reconnu / Connu et Recommand\u00E9","Chiffre de R\u00E9ussite au Carr\u00E9","Calendrier de Relance R\u00E9gulier"],a:1,e:"CR\u00B2 = Connu et Reconnu / Connu et Recommand\u00E9 sur son secteur.",l:'d',t:'prospection'},
  {q:"Combien de techniques de prospection sont list\u00E9es ?",o:["7","8","10","12"],a:2,e:"10 techniques : phoning, bo\u00EEtage, r\u00E9seaux, pige, emailing, 100 premiers, porte \u00E0 porte, SMS, farming, commer\u00E7ants.",l:'d',t:'prospection'},
  {q:"Que signifie START ?",o:["Sourire, Tenue, Attitude, Regard, Ton","Service, Travail, Argumentation, R\u00E9sultat, Temps","Strat\u00E9gie, Talent, Action, R\u00E9ussite, Terrain","Suivi, Terrain, Analyse, Relance, T\u00E9l\u00E9phone"],a:0,e:"START = Sourire, Tenue soign\u00E9e, Attitude positive, Regard non fuyant, Ton engag\u00E9.",l:'d',t:'prospection'},
  {q:"Que signifie ACM ?",o:["Accord Commercial Multipartite","Analyse Comparative de March\u00E9","Agent Commercial Mandat\u00E9","Acte de Commercialisation du Mandat"],a:1,e:"ACM = Analyse Comparative de March\u00E9 \u2014 la photo du march\u00E9 actuel.",l:'d',t:'r1'},
  {q:"Lors du R1, quelle est la r\u00E8gle de prise de parole ?",o:["50/50","70% conseiller / 30% client","20% conseiller / 80% client","100% conseiller"],a:2,e:"R1 = 20% le conseiller / 80% le client. Phase d'\u00E9coute avant tout.",l:'d',t:'r1'},
  {q:"Que signifie SONCAS ?",o:["S\u00E9rieux, Objectif, N\u00E9gociation, Compromis, Accord, Signature","S\u00E9curit\u00E9, Orgueil, Nouveaut\u00E9, Confort, Argent, Sympathie","Service, Offre, N\u00E9gociation, Contrat, Accord, Suivi","Strat\u00E9gie, Organisation, N\u00E9cessit\u00E9, Co\u00FBt, Avantage, Solution"],a:1,e:"SONCAS = S\u00E9curit\u00E9, Orgueil, Nouveaut\u00E9, Confort, Argent, Sympathie.",l:'d',t:'r1'},
  {q:"La particularit\u00E9 principale du Mandat Confiance ?",o:["Toujours moins cher","Exclusivit\u00E9 d'interlocuteur, pas d'agence","Interdit au vendeur de trouver un acheteur seul","Valable 6 mois minimum"],a:1,e:"Le Mandat Confiance est une exclusivit\u00E9 d'interlocuteur et non d'agence.",l:'d',t:'mandat'},
  {q:"Combien d'actions comprend la garantie d'action ?",o:["5","8","11","15"],a:2,e:"11 actions contractuelles. Si l'une manque, le vendeur peut se d\u00E9lier.",l:'d',t:'mandat'},
  {q:"Que pr\u00E9voit la clause 50/50 ?",o:["Partage des frais de notaire","Si le vendeur trouve un acheteur seul, l'agence g\u00E8re et reverse 50% de sa commission","Partage du prix de vente","Commission divis\u00E9e entre deux agences"],a:1,e:"Clause 50/50 : si le vendeur trouve seul un acheteur, l'agence g\u00E8re et reverse la moiti\u00E9 de sa commission.",l:'d',t:'mandat'},
  {q:"Un acqu\u00E9reur de type B, c'est :",o:["Pr\u00EAt \u00E0 acheter imm\u00E9diatement","Il manque un crit\u00E8re mineur pour acheter maintenant","Ne peut pas acheter de suite","Un investisseur"],a:1,e:"A = peut acheter maintenant / B = crit\u00E8re mineur manquant / C = ne peut pas acheter de suite.",l:'d',t:'acquereur'},
  {q:"La r\u00E8gle d'or du close ?",o:["Attendre que le client aborde le sujet","Toujours attendre le R3","Vaut mieux closer trop t\u00F4t que trop tard","Closer uniquement si tous les d\u00E9cisionnaires sont l\u00E0"],a:2,e:"Vaut mieux closer trop t\u00F4t que trop tard. Plus t\u00F4t = plus de confortage.",l:'d',t:'r2'},
  {q:"Lors du bilan de promotion, les 2 axes de conclusion sont :",o:["Relance ou bo\u00EEtage","Modifier les moyens de promotion ou modifier le prix","Baisser le prix ou r\u00E9silier le mandat","Changer les photos ou l'annonce"],a:1,e:"Bilan de promotion : modifier les moyens de promotion OU modifier le prix.",l:'d',t:'bilan'},
  {q:"Que faire si vous n'avez pas de r\u00E9ponse lors d'un porte \u00E0 porte ?",o:["Passer directement \u00E0 la suivante","Laisser un 'juste un mot' dans la bo\u00EEte aux lettres","Revenir 3 fois avant de passer","Appeler le propri\u00E9taire"],a:1,e:"Pr\u00E9parer des 'justes un mot' pour les maisons vides : je suis en recherche active dans le quartier, contactez-moi.",l:'i',t:'prospection'},
  {q:"Que signifie QIPM ?",o:["Qualifier, Informer, Prospecter, Mesurer","Quels Int\u00E9r\u00EAts Pour Moi","Questions, Informations, Prospects, M\u00E9thode","Qualifier, Identifier, Planifier, Mesurer"],a:1,e:"QIPM = Quels Int\u00E9r\u00EAts Pour Moi. Se poser cette question avant chaque action.",l:'i',t:'prospection'},
  {q:"Dans AIDA, le 'D' repr\u00E9sente :",o:["D\u00E9cision","Dur\u00E9e","D\u00E9sir","D\u00E9monstration"],a:2,e:"AIDA : Attention, Int\u00E9r\u00EAt, D\u00E9sir, Action. D = D\u00E9sir, mettre le prospect en situation de d\u00E9sir anticip\u00E9.",l:'i',t:'prospection'},
  {q:"Quelle est la structure temporelle du R1 ?",o:["Pr\u00E9sent \u2192 Futur \u2192 Pass\u00E9","Pass\u00E9 \u2192 Pr\u00E9sent \u2192 Futur","Futur \u2192 Pr\u00E9sent \u2192 Pass\u00E9","Pr\u00E9sent \u2192 Pass\u00E9 \u2192 Futur"],a:1,e:"Le squelette du R1 suit toujours : Pass\u00E9 \u2192 Pr\u00E9sent \u2192 Futur.",l:'i',t:'r1'},
  {q:"Que signifie CARE ?",o:["Comp\u00E9tent, Amical, R\u00E9actif, Efficace","Curieux, Attentif, Rigoureux, \u00C0 l'\u00E9coute","Confiant, Assertif, Rigoureux, Engag\u00E9","Commercial, Actif, R\u00E9fl\u00E9chi, Enthousiaste"],a:1,e:"CARE = Curieux, Attentif, Rigoureux, \u00C0 l'\u00E9coute.",l:'i',t:'r1'},
  {q:"Combien d'agences font partie du fichier AMEPI sur la CUB ?",o:["Environ 50","Environ 80","Environ 122","Environ 200"],a:2,e:"Environ 122 agences sur la CUB : Lafor\u00EAt, ERA, Guy Hoquet, Orpi, Square Habitat\u2026",l:'i',t:'mandat'},
  {q:"O\u00F9 doit imp\u00E9rativement d\u00E9buter le RDV de visite ?",o:["Devant le bien","\u00C0 l'agence, pour signer les bons de visite","Au domicile de l'acqu\u00E9reur","En visioconf\u00E9rence"],a:1,e:"\u00C0 l'agence : bons de visite + une seule voiture \u2192 retour agence forc\u00E9.",l:'i',t:'acquereur'},
  {q:"Un acqu\u00E9reur de type A r\u00E9unit combien de crit\u00E8res ?",o:["1 crit\u00E8re : la motivation","2 crit\u00E8res : motivation + financement","3 crit\u00E8res : s\u00E9rieux, motiv\u00E9, financ\u00E9","4 crit\u00E8res : s\u00E9rieux, motiv\u00E9, d\u00E9sireux ET capable d'acheter maintenant"],a:3,e:"A = s\u00E9rieux, motiv\u00E9, d\u00E9sireux ET capable d'acheter maintenant. Les 4 crit\u00E8res doivent \u00EAtre r\u00E9unis.",l:'i',t:'acquereur'},
  {q:"Dans la technique de l'entonnoir, apr\u00E8s avoir isol\u00E9 l'objection :",o:["Closer directement","Reformuler","Pr\u00E9-closer","Accepter"],a:2,e:"Entonnoir : Accepter \u2192 Reformuler \u2192 Isoler \u2192 Pr\u00E9-closer \u2192 R\u00E9pondre \u2192 Closer.",l:'i',t:'r2'},
  {q:"Pourquoi fixer les dates de bilan d\u00E8s la prise de mandat ?",o:["Pour respecter la loi Hoguet","Car c'est contractuel et cela maintient la confiance","Pour justifier les honoraires","Pour montrer son organisation"],a:1,e:"Les bilans sont contractuels. Planifier d\u00E8s la signature = garder la confiance et la r\u00E9activit\u00E9.",l:'i',t:'bilan'},
  {q:"Quel outil permet de relancer les agences de mobilit\u00E9 (Dassault, Airbus\u2026) ?",o:["L'ACM","La plaquette de pr\u00E9sentation en pr\u00E9-commercialisation","Le guide R1","La fiche SONCAS"],a:1,e:"En pr\u00E9-commercialisation, on relance les agences de mobilit\u00E9 avec une plaquette avant la mise sur le march\u00E9.",l:'i',t:'mandat'},
  {q:"Que pr\u00E9parer pour un bilan de promotion ?",o:["Uniquement l'ACM actualis\u00E9e","Bilan + chiffres sites + ancienne ACM + nouvelle ACM + fiche technique + estimation initiale","Uniquement les stats de clics","Le guide de commercialisation uniquement"],a:1,e:"Pr\u00E9parer : bilan, chiffres sites, ancienne + nouvelle ACM, fiche technique, estimation initiale.",l:'i',t:'bilan'},
  {q:"Un vendeur dit 'J'ai besoin de r\u00E9fl\u00E9chir'. Premi\u00E8re \u00E9tape de l'entonnoir ?",o:["Pr\u00E9-closer imm\u00E9diatement","Accepter : 'Je comprends votre point de vue'","Isoler : 'Est-ce la seule chose qui vous g\u00EAne ?'","R\u00E9pondre avec vos arguments"],a:1,e:"On commence toujours par Accepter pour d\u00E9samorcer la tension, avant de Reformuler, Isoler, Pr\u00E9-closer, R\u00E9pondre, Closer.",l:'a',t:'r2'},
  {q:"'Une autre agence m'a propos\u00E9 les m\u00EAmes services moins cher' \u2014 quelle famille d'objection ?",o:["Manque de confiance","Excuse","Comparaison avec","Co\u00FBt des frais"],a:2,e:"Objection de type 'comparaison avec'. R\u00E9ponse : qu'est-ce que vous voulez comparer exactement ?",l:'a',t:'r2'},
  {q:"Au R1, pourquoi demander le montant du cr\u00E9dit restant du vendeur ?",o:["Pour \u00E9valuer sa solvabilit\u00E9","Pour estimer le prix plancher r\u00E9el et anticiper les marges de n\u00E9gociation","C'est une obligation l\u00E9gale","Pour pr\u00E9parer le dossier notaire"],a:1,e:"Le cr\u00E9dit restant permet d'estimer le prix plancher r\u00E9el \u2014 cartouche pr\u00E9cieuse pour le R2.",l:'a',t:'r1'},
  {q:"Pourquoi ne pas attendre pour conseiller une baisse de prix au bilan ?",o:["C'est contre la loi","Les agences concurrentes en profiteront si on tarde","Le march\u00E9 peut se retourner","Le vendeur refusera syst\u00E9matiquement"],a:1,e:"Plus on tarde, plus les concurrents profitent du d\u00E9lai. Agir t\u00F4t = avantage concurrentiel.",l:'a',t:'bilan'},
  {q:"Apr\u00E8s visite, l'acqu\u00E9reur dit 'Je vais r\u00E9fl\u00E9chir'. Quelle question en priorit\u00E9 ?",o:["Quand me rappellerez-vous ?","Vous y voyez-vous ? Qu'est-ce qui vous emp\u00EAcherait de vous positionner ?","Avez-vous d'autres visites pr\u00E9vues ?","Quel est votre budget maximum ?"],a:1,e:"La balance post-visite : 'Vous y voyez-vous ? Qu'est-ce qui vous emp\u00EAcherait ?' puis close avec urgence.",l:'a',t:'acquereur'},
  {q:"Au R2, dans quel ordre pr\u00E9sente-t-on le plan de commercialisation ?",o:["Prix \u2192 promotion \u2192 mandat","Mandat \u2192 prix \u2192 promotion","Promotion \u2192 prix \u2192 pr\u00E9-close","Prix \u2192 mandat \u2192 promotion"],a:2,e:"On pr\u00E9sente d'abord les moyens de promotion, puis le prix, avant d'aller vers la pr\u00E9-close et le mandat.",l:'a',t:'r2'},
  {q:"Quelle est la diff\u00E9rence op\u00E9rationnelle Mandat Simple vs Mandat Confiance pour l'acheteur AMEPI ?",o:["Aucune diff\u00E9rence","Avec le MC, l'acheteur visite TOUJOURS avec le conseiller mandataire, m\u00EAme s'il vient d'une agence AMEPI","Avec le simple, l'acheteur a acc\u00E8s \u00E0 plus de biens","Avec le MC, l'acheteur paie moins"],a:1,e:"Avec le MC + AMEPI, les acqu\u00E9reurs des agences partenaires visitent TOUJOURS avec le conseiller mandataire.",l:'a',t:'mandat'},
  {q:"La d\u00E9couverte acqu\u00E9reur dure 20-40 min pour :",o:["Respecter un d\u00E9lai l\u00E9gal","Qualifier finement le projet, la motivation et le financement avant toute visite","Respecter le planning de l'agence","Faire signer le bon de visite"],a:1,e:"Une bonne d\u00E9couverte permet de qualifier A/B/C, identifier le SONCAS, valider le financement, envoyer des fiches pertinentes.",l:'a',t:'acquereur'},
  {q:"La logique de la pr\u00E9-commercialisation avant mise sur le march\u00E9 ?",o:["R\u00E9duire les frais de pub","Cr\u00E9er de la raret\u00E9 et favoriser une vente rapide au meilleur prix","Tester le prix sans engagement","Respecter un d\u00E9lai l\u00E9gal de 30 jours"],a:1,e:"La pr\u00E9-commercialisation cr\u00E9e de la raret\u00E9 et de l'urgence \u2014 les acqu\u00E9reurs sont en concurrence avant la mise publique.",l:'a',t:'mandat'},
  {q:"Un vendeur a eu un mauvais v\u00E9cu avec un mandat simple. Quelle cartouche cela donne-t-il au R2 ?",o:["Aucune, c'est neutre","Souligner les limites du simple v\u00E9cu et valoriser l'exclusivit\u00E9 d'interlocuteur du Mandat Confiance","\u00C9viter le sujet","Proposer imm\u00E9diatement de signer"],a:1,e:"L'exp\u00E9rience pass\u00E9e avec un mandat simple est une cartouche majeure pour valoriser le Mandat Confiance au R2.",l:'a',t:'r1'},
  {q:"Quel accord Tolt\u00E8que s'applique quand un vendeur devient agressif au bilan ?",o:["Que votre parole soit impeccable","Ne pas en faire une affaire personnelle","Ne pas faire de suppositions","Faire toujours de son mieux"],a:1,e:"'Ne pas en faire une affaire personnelle' \u2014 les r\u00E9actions du vendeur viennent de sa situation, pas d'un jugement sur vous.",l:'a',t:'r2'},
  {q:"En porte \u00E0 porte, que faire devant une maison sans sonnette ?",o:["Passer \u00E0 la maison suivante","Entrer : pas de sonnette signifie que les occupants acceptent qu'on entre sur la propri\u00E9t\u00E9","Laisser un mailing et partir","Revenir un autre jour"],a:1,e:"Ne sauter aucune maison : si pas de sonnette, c'est que les occupants acceptent qu'on rentre sur leur propri\u00E9t\u00E9.",l:'d',t:'prospection'},
  {q:"Dans les sc\u00E9narios de prospection, comment doit-on parler ?",o:["Au conditionnel, pour rester prudent","Au futur, pour projeter le client","Au pr\u00E9sent, avec des mots forts et positifs","Au pass\u00E9, pour rassurer"],a:2,e:"Utiliser des mots forts, positifs, et toujours parler au pr\u00E9sent.",l:'d',t:'prospection'},
  {q:"Sur l'application du conseiller, que signifie le point jaune ?",o:["Mandat rentr\u00E9 par l'agence","Contact renseign\u00E9 dans CenturyNet","Estimation r\u00E9alis\u00E9e","Maison \u00E0 vendre"],a:1,e:"Point blanc = contact non renseign\u00E9, point jaune = contact renseign\u00E9. M = mandat, V = vente, E = estimation par l'agence.",l:'i',t:'prospection'},
  {q:"Avant chaque action de prospection, que faut-il imp\u00E9rativement lire ?",o:["Le cadastre","L'historique des actions men\u00E9es sur le prospect","Les annonces concurrentes","La fiche bien"],a:1,e:"L'historique rappelle la derni\u00E8re conversation et permet un discours personnalis\u00E9.",l:'i',t:'prospection'},
  {q:"Cr\u00E9maill\u00E8re : que fait-on \u00E0 J+1 ?",o:["Le second porte \u00E0 porte de confirmation","La commande chez le fromager et le boucher","SMS de remerciements + photos, publication r\u00E9seaux en mentionnant les commer\u00E7ants","La liste des boissons"],a:2,e:"J+1 : SMS de remerciements \u00E0 tous les participants avec photos, et publication Facebook/Instagram en notant les commer\u00E7ants.",l:'a',t:'prospection'},
  {q:"Une estimation se d\u00E9roule en combien de rendez-vous ?",o:["Un seul, tout se fait sur place","Deux : le R1 chez le client, le R2 \u00E0 l'agence","Trois : R1, R2, R3","Cela d\u00E9pend du bien"],a:1,e:"R1 = d\u00E9couverte du projet et du bien chez le client ; R2 = \u00E0 l'agence : march\u00E9, m\u00E9thode de commercialisation et montant de l'estimation.",l:'d',t:'r1'},
  {q:"\u00AB Le premier qui dit le prix\u2026 \u00BB",o:["\u2026a gagn\u00E9","\u2026a perdu","\u2026doit se justifier","\u2026prend la main"],a:1,e:"Le premier qui dit le prix a perdu. Faire dire le prix au vendeur d\u00E8s le R1 est tr\u00E8s important.",l:'d',t:'r1'},
  {q:"Que faire avec l'appareil photo avant de partir au R1 ?",o:["Le charger dans la voiture","Prendre une photo \u00E0 l'agence pour v\u00E9rifier piles, carte m\u00E9moire et batterie","V\u00E9rifier seulement l'objectif","Rien, le t\u00E9l\u00E9phone suffit"],a:1,e:"Toujours v\u00E9rifier piles, carte m\u00E9moire et batterie : prendre une photo \u00E0 l'agence avant de partir.",l:'i',t:'r1'},
  {q:"En quoi l'ACM doit-elle \u00EAtre pr\u00E9sent\u00E9e ?",o:["En prix FAI (frais d'agence inclus)","En net vendeur","En prix au m\u00B2","En valeur locative"],a:1,e:"L'ACM doit \u00EAtre pr\u00E9sent\u00E9e en NET VENDEUR.",l:'i',t:'r1'},
  {q:"Quelles sources permettent de constituer une ACM ?",o:["Uniquement la base CenturyNet","CenturyNet, ETALAB/DVF, AMEPI, connaissance du secteur, sites immobiliers, espace imp\u00F4ts","Uniquement les sites d'annonces","Les notaires exclusivement"],a:1,e:"Plusieurs sources : base CenturyNet, ETALAB/DVF (ventes publi\u00E9es 6 \u00E0 12 mois apr\u00E8s l'acte), AMEPI, connaissance du march\u00E9, sites immo, espace personnel imp\u00F4ts.",l:'a',t:'r1'},
  {q:"Un vendeur au profil SONCAS \u00AB S\u00E9curit\u00E9 \u00BB, on le convainc avec :",o:["Les nouveaux outils digitaux","Un service sur-mesure valorisant","L'agence, la garantie d'action, les diagnostics et des comptes rendus r\u00E9guliers","Le rapport qualit\u00E9/prix"],a:2,e:"Le client S\u00E9curit\u00E9 est prudent et a besoin d'\u00EAtre rassur\u00E9 : \u00E9quipe et formation de l'agence, garantie d'action, diagnostics, suivi et comptes rendus r\u00E9guliers.",l:'a',t:'r1'},
  {q:"Combien d'agences compte le r\u00E9seau Century 21 en France ?",o:["Environ 500","Environ 700","Environ 902","Environ 1200"],a:2,e:"Le r\u00E9seau compte 902 agences en France : client\u00E8le nationale et locale.",l:'d',t:'mandat'},
  {q:"Sur quels 3 sites internet le bien est-il commercialis\u00E9 ?",o:["Century21, SeLoger, PAP","Century21, A Vendre \u00C0 Louer, leboncoin","Leboncoin, Bien'ici, Logic-Immo","Century21, Facebook, Instagram"],a:1,e:"Les 3 sites les plus consult\u00E9s par les acqu\u00E9reurs : Century21, A Vendre \u00C0 Louer et leboncoin.",l:'i',t:'mandat'},
  {q:"Au prix du march\u00E9, quel d\u00E9lai de vente annonce la lettre d'estimation ?",o:["1 mois","3 mois","6 mois","1 an"],a:1,e:"\u00C0 ce prix, vente esp\u00E9r\u00E9e sous 3 mois. \u00C0 un prix sup\u00E9rieur, le d\u00E9lai s'allonge selon l'\u00E9cart avec le march\u00E9.",l:'i',t:'mandat'},
  {q:"Concr\u00E8tement, que permet l'appartenance \u00E0 l'AMEPI pour le vendeur ?",o:["Une baisse des honoraires","Les acqu\u00E9reurs des autres agences visitent son bien, toujours accompagn\u00E9s de son conseiller","Une publicit\u00E9 dans la presse nationale","Une estimation gratuite par plusieurs agences"],a:1,e:"Les acqu\u00E9reurs des agences du fichier AMEPI, apr\u00E8s s'\u00EAtre pr\u00E9sent\u00E9s, visitent le bien toujours en compagnie du conseiller : un seul interlocuteur, tous les acqu\u00E9reurs du secteur.",l:'a',t:'mandat'},
  {q:"Combien de temps doit durer une d\u00E9couverte acqu\u00E9reur ?",o:["5 \u00E0 10 minutes","20 \u00E0 40 minutes","1 heure minimum","Le temps d'une visite"],a:1,e:"Prendre le temps : une d\u00E9couverte doit prendre entre 20 et 40 minutes. Il n'y a pas de question interdite !",l:'d',t:'acquereur'},
  {q:"Combien de fiches biens envoyer id\u00E9alement apr\u00E8s la d\u00E9couverte ?",o:["Une seule pour cibler","3 fiches, avec rappel imp\u00E9ratif pour d\u00E9briefer","10 fiches pour maximiser","Toutes les fiches du stock"],a:1,e:"3 fiches est le top \u2014 puis rappel imp\u00E9ratif derri\u00E8re pour d\u00E9briefer chaque bien et prendre les rendez-vous de visite.",l:'d',t:'acquereur'},
  {q:"\u00AB Les acheteurs d'aujourd'hui sont\u2026 \u00BB",o:["\u2026les curieux de demain","\u2026les vendeurs de demain","\u2026les locataires d'hier","\u2026les investisseurs de demain"],a:1,e:"Les acheteurs d'aujourd'hui sont les vendeurs de demain ! Soigner chaque acqu\u00E9reur, c'est pr\u00E9parer de futurs mandats.",l:'d',t:'acquereur'},
  {q:"Quels sont les 4 constats \u00E0 faire en fin de d\u00E9couverte acqu\u00E9reur ?",o:["Budget, secteur, surface, d\u00E9lai","A-t-il les moyens ? Est-il pr\u00EAt ? Le veut-il vraiment ? Est-il seul d\u00E9cisionnaire ?","Apport, cr\u00E9dit, vente en cours, urgence","Pass\u00E9, pr\u00E9sent, futur, motivation"],a:1,e:"Fin de d\u00E9couverte : a-t-il les moyens d'acheter maintenant, est-il pr\u00EAt, le veut-il vraiment, est-il le seul d\u00E9cisionnaire ?",l:'i',t:'acquereur'},
  {q:"Au retour de visite, pourquoi s'absenter \u00AB chercher les dossiers \u00BB ?",o:["Pour pr\u00E9parer le compromis","Pour laisser les clients \u00E9changer seuls sur leur d\u00E9cision","Pour appeler le vendeur","Pour imprimer les diagnostics"],a:1,e:"Profiter du pr\u00E9texte d'aller chercher les dossiers pour les laisser seuls \u00E9changer sur leur d\u00E9cision possible.",l:'i',t:'acquereur'},
  {q:"Que montrer imp\u00E9rativement avant d'aller chercher l'offre ?",o:["Le mandat","Les diagnostics","La taxe fonci\u00E8re","L'ACM"],a:1,e:"Ne pas oublier de montrer les diagnostics avant d'aller chercher l'offre.",l:'a',t:'acquereur'},
  {q:"Que pr\u00E9parer sur le bureau avant un R2 ?",o:["Seulement le mandat et un stylo","Bouteille d'eau, caf\u00E9, clim/chauffage r\u00E9gl\u00E9e, stylo, dossier sous pochette face \u00E0 la vitrine","L'ordinateur et un diaporama","Rien, l'improvisation cr\u00E9e le naturel"],a:1,e:"Pr\u00E9paration du bureau : eau, caf\u00E9, temp\u00E9rature, propret\u00E9, stylo, dossier sous pochette plac\u00E9 face \u00E0 la vitrine.",l:'d',t:'r2'},
  {q:"Selon le plan de com, quels sont les 2 moyens d\u00E9terminants pour la vente ?",o:["Les photos et l'annonce","Le prix et les moyens de promotion","Le panneau et la vitrine","Le r\u00E9seau et l'AMEPI"],a:1,e:"2 moyens d\u00E9terminants pour la vente : le prix et les moyens de promotion.",l:'d',t:'r2'},
  {q:"Apr\u00E8s un pr\u00E9-close r\u00E9ussi au R2, que planifie-t-on imm\u00E9diatement ?",o:["La signature du compromis","La date et l'heure de la visite marketing","Le premier bilan de promotion","La parution presse"],a:1,e:"Pr\u00E9-close : si on est OK sur le prix, on signe le mandat confiance, et on planifie la date et l'heure de la visite marketing.",l:'i',t:'r2'},
  {q:"R\u00E8gle de la pige : quel canal ne jamais utiliser ?",o:["Le t\u00E9l\u00E9phone","Le mail ou le SMS","La visite directe","Le courrier"],a:1,e:"La pige, jamais par mail ou SMS. Bien se pr\u00E9senter, ne jamais s'excuser, phrases courtes, savoir couper court.",l:'i',t:'r2'},
  {q:"Vous venez de pr\u00E9senter une offre sur papier libre en net vendeur. Que faire ?",o:["Argumenter imm\u00E9diatement","Silence !","Proposer une contre-offre","Rappeler le co\u00FBt de la non-vente"],a:1,e:"Pr\u00E9senter l'offre en net vendeur sur papier libre, puis silence ! Laisser le vendeur r\u00E9agir en premier.",l:'a',t:'r2'},
  {q:"Quels sont les 5 facteurs \u00E0 prendre en compte dans la vente d'un bien ?",o:["Prix, surface, \u00E9tat, quartier, \u00E9tage","Conjoncture, concurrence, moyens de promotion, conditions de pr\u00E9sentation, prix","Photos, annonce, panneau, vitrine, site","Mandat, prix, d\u00E9lai, diagnostics, notaire"],a:1,e:"5 facteurs : la conjoncture, la concurrence, les moyens de promotion, les conditions de pr\u00E9sentation, le prix.",l:'a',t:'r2'},
  {q:"Qu'est-ce qu'un \u00AB mandat en stock \u00BB ?",o:["Un mandat en attente de signature","Un mandat non vendu, par manque de communication ou prix inadapt\u00E9","Un mandat expir\u00E9","Un mandat simple"],a:1,e:"Un mandat en stock est un mandat non vendu soit par manque de communication, soit du fait d'un prix inadapt\u00E9.",l:'d',t:'bilan'},
  {q:"En d\u00E9but de bilan, pourquoi rappeler le projet du vendeur ?",o:["Pour remplir le compte rendu","En cas de modification, ou pour prise de conscience","Pour justifier les honoraires","C'est une obligation contractuelle"],a:1,e:"Rappel du projet si modification ou pour prise de conscience, apr\u00E8s avoir pos\u00E9 le cadre.",l:'d',t:'bilan'},
  {q:"Quelle question poser au vendeur pendant le bilan ?",o:["\u00AB Voulez-vous baisser le prix ? \u00BB","\u00AB Qu'en pensez-vous ? Souhaitez-vous qu'on modifie des choses ? \u00BB","\u00AB \u00CAtes-vous toujours vendeur ? \u00BB","\u00AB Avez-vous vu nos annonces ? \u00BB"],a:1,e:"Prendre le ressenti sur la commercialisation par le questionnement : qu'en pensez-vous ? souhaitez-vous qu'on modifie des choses ?",l:'i',t:'bilan'},
  {q:"Qu'est-ce qui rend les bilans de promotion faciles et agr\u00E9ables ?",o:["Un bon caf\u00E9","Un suivi rigoureux et un accompagnement r\u00E9gulier toutes les semaines","Une baisse de prix anticip\u00E9e","Des chiffres flatteurs"],a:1,e:"Si les actions ont \u00E9t\u00E9 r\u00E9alis\u00E9es en amont et le suivi fait toutes les semaines, le rendez-vous sera un bon moment pour tout le monde.",l:'i',t:'bilan'},
  {q:"Pour concr\u00E9tiser une baisse de prix, que fait-on signer ?",o:["Un nouveau mandat","Un avenant au prix march\u00E9","Une lettre d'intention","Un compromis"],a:1,e:"Vendre la baisse de prix : revenir sur l'estimation, le projet, l'urgence, la liste d'acqu\u00E9reurs potentiels, et faire signer un AVENANT au PRIX MARCH\u00C9.",l:'a',t:'bilan'},
];

function startQ(){
  if(!qLvl){alert('Veuillez choisir un niveau.');return;}
  qAns={};
  qActive=allQ.filter(function(q){return q.l===qLvl&&(qThm==='all'||q.t===qThm);});
  if(!qActive.length){alert('Aucune question pour cette combinaison. Essayez un autre th\u00E8me ou niveau.');return;}
  qActive.sort(function(){return Math.random()-.5});
  document.getElementById('qsetup').style.display='none';
  document.getElementById('qplay').style.display='block';
  var ln={d:'\uD83D\uDFE2 D\u00E9butant',i:'\uD83D\uDD35 Interm\u00E9diaire',a:'\uD83D\uDD34 Avanc\u00E9'};
  var lc={d:'lbd',i:'lbi',a:'lba'};
  document.getElementById('qbadge').innerHTML='<span class="lbadge '+lc[qLvl]+'">'+ln[qLvl]+(qThm!=='all'?' \u2014 '+qThm.charAt(0).toUpperCase()+qThm.slice(1):'')+'</span><p style="font-size:13px;color:#777;margin-bottom:1rem">'+qActive.length+' questions</p>';
  var html='';
  qActive.forEach(function(q,i){
    html+='<div class="qq" id="qq'+i+'"><div class="qn">Question '+(i+1)+' / '+qActive.length+'</div><div class="qt">'+q.q+'</div><div class="qopts">';
    q.o.forEach(function(opt,j){html+='<div class="qopt" id="op'+i+'_'+j+'" onclick="selOpt('+i+','+j+')"><input type="radio" name="q'+i+'" value="'+j+'"> '+opt+'</div>';});
    html+='</div><div id="fb'+i+'" class="qfb"></div></div>';
  });
  document.getElementById('qquestions').innerHTML=html;
  document.getElementById('qsubmit').style.display='block';
  var sc=document.querySelector('.score');if(sc)sc.remove();
}
function selOpt(qi,oi){
  if(qAns[qi]!==undefined)return;
  document.querySelectorAll('#qq'+qi+' .qopt').forEach(function(el){el.classList.remove('sel')});
  document.getElementById('op'+qi+'_'+oi).classList.add('sel');
  qAns[qi]=oi;
}
function submitQ(){
  var ans=Object.keys(qAns).length;
  if(ans<qActive.length){alert('R\u00E9pondez \u00E0 toutes les questions ('+ans+' / '+qActive.length+' r\u00E9pondues).');return;}
  var score=0;
  qActive.forEach(function(q,i){
    var u=qAns[i],ok=(u===q.a);if(ok)score++;
    document.querySelectorAll('#qq'+i+' .qopt').forEach(function(el,j){if(j===q.a)el.classList.add('ok');else if(j===u&&!ok)el.classList.add('ko');});
    var fb=document.getElementById('fb'+i);fb.className='qfb '+(ok?'ok':'ko');fb.textContent=(ok?'\u2713 Correct \u2014 ':'\u2717 Incorrect \u2014 ')+q.e;
  });
  document.getElementById('qsubmit').style.display='none';
  var pct=Math.round(score/qActive.length*100);
  var msg=pct>=80?'Excellent ! Tr\u00E8s bonne ma\u00EEtrise.':pct>=60?'Bon r\u00E9sultat, quelques points \u00E0 retravailler.':'\u00C0 revoir \u2014 relisez les fiches correspondantes.';
  var sc='<div class="score"><div class="snum">'+score+'/'+qActive.length+'</div><div class="slbl">Score : '+pct+'%<br>'+msg+'</div><div style="display:flex;gap:8px;justify-content:center;margin-top:1rem"><button class="btn-s" onclick="restartQ()">Recommencer</button><button class="btn-p" onclick="backSetup()">Autre quiz</button></div></div>';
  document.getElementById('qquestions').insertAdjacentHTML('beforebegin',sc);
}
function restartQ(){qAns={};var sc=document.querySelector('.score');if(sc)sc.remove();document.getElementById('qquestions').innerHTML='';document.getElementById('qsubmit').style.display='block';startQ();}
function backSetup(){qAns={};var sc=document.querySelector('.score');if(sc)sc.remove();document.getElementById('qquestions').innerHTML='';document.getElementById('qplay').style.display='none';document.getElementById('qsetup').style.display='block';}

// ----- Etat de l'entrainement -----
var TRAIN_API=(location.hostname==='localhost'||location.hostname==='127.0.0.1')?'http://localhost:3999':'https://kadimmo-ia.onrender.com';
var tMsgs=[],tBusy=false,tEnded=false,tRec=null,tRecOn=false,tProfil={},tMystere=false,tGuess=null,tGuessLabel='',tRevealS='',tRevealC='';
var tHints=0,tArchive=[],tDrill=false,tDrillList=[],tDrillIdx=0,tDrillScore=0;
var tPremium=false,tAudio=null,tVoice=null,tAudioUnlocked=false;
var HIST_KEY='kadimmo_train_hist_v1';
var SILENT_WAV='data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

function tEl(id){return document.getElementById(id);}
function setTStatus(t){tEl('tstatus').textContent=t;}

function trainWake(){
  fetch(TRAIN_API+'/healthz').then(function(r){return r.json();}).then(function(d){tPremium=!!(d&&d.tts);}).catch(function(){});
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){tEl('tmic').style.display='none';tEl('tsetupnote').textContent='Micro non disponible sur ce navigateur : vous pourrez \u00E9crire vos r\u00E9pliques.';}
  renderBadges();
}

// ----- Audio : deverrouillage iOS + choix de voix -----
function unlockAudio(){
  if(tAudioUnlocked)return;
  tAudioUnlocked=true;
  try{
    if(window.speechSynthesis){var u=new SpeechSynthesisUtterance(' ');u.volume=0;speechSynthesis.speak(u);}
  }catch(e){}
  try{
    if(!tAudio)tAudio=new Audio();
    tAudio.src=SILENT_WAV;
    var p=tAudio.play();if(p&&p.catch)p.catch(function(){});
  }catch(e){}
}
function pickVoice(){
  if(!window.speechSynthesis)return;
  var vs=speechSynthesis.getVoices().filter(function(x){return x.lang&&x.lang.indexOf('fr')===0;});
  if(!vs.length)return;
  var pref=['Google fran','Am\u00E9lie','Amelie','Audrey','Aur\u00E9lie','Thomas','Daniel','Enhanced','Premium','Siri'];
  for(var i=0;i<pref.length;i++){
    for(var j=0;j<vs.length;j++){
      if(vs[j].name.indexOf(pref[i])>-1){tVoice=vs[j];return;}
    }
  }
  tVoice=vs[0];
}
if(window.speechSynthesis){pickVoice();speechSynthesis.onvoiceschanged=pickVoice;}

function speak(text){
  if(tPremium){speakPremium(text);return;}
  speakLocal(text);
}
function speakLocal(text){
  if(!window.speechSynthesis)return;
  try{
    speechSynthesis.cancel();
    var u=new SpeechSynthesisUtterance(text);
    u.lang='fr-FR';
    if(tVoice)u.voice=tVoice;
    speechSynthesis.speak(u);
  }catch(e){}
}
function speakPremium(text){
  fetch(TRAIN_API+'/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:text})})
    .then(function(r){if(!r.ok)throw 0;return r.blob();})
    .then(function(b){
      if(!tAudio)tAudio=new Audio();
      tAudio.src=URL.createObjectURL(b);
      var p=tAudio.play();
      if(p&&p.catch)p.catch(function(){speakLocal(text);});
    })
    .catch(function(){tPremium=false;speakLocal(text);});
}

// ----- Configuration de session -----
function tPick(btn){
  btn.parentNode.querySelectorAll('.thbtn').forEach(function(b){b.classList.remove('active')});
  btn.classList.add('active');
}
function tVal(id){return tEl(id).querySelector('.thbtn.active').getAttribute('data-v');}
function tLabel(id){return tEl(id).querySelector('.thbtn.active').textContent;}
function tRandomSel(sel){return sel.options[1+Math.floor(Math.random()*(sel.options.length-1))];}

function startTrain(){
  unlockAudio();
  tMsgs=[];tBusy=false;tEnded=false;tGuess=null;tGuessLabel='';tHints=0;tDrill=false;tArchive=[];
  tMystere=tEl('tmystere').checked;
  var sSel=tEl('tsoncas'),cSel=tEl('tctx');
  var sOpt=(!tMystere&&sSel.value)?sSel.options[sSel.selectedIndex]:tRandomSel(sSel);
  var cOpt=(!tMystere&&cSel.value)?cSel.options[cSel.selectedIndex]:tRandomSel(cSel);
  tProfil={soncas:sOpt.value,contexte:cOpt.value};
  tRevealS=sOpt.text;tRevealC=cOpt.text;
  tEl('tsetup').style.display='none';
  tEl('tdebrief').style.display='none';
  tEl('tplay').style.display='block';
  tEl('tguess').style.display='none';
  tEl('tactions').style.display='flex';
  tEl('tendbtn').style.display='';
  tEl('thintbtn').style.display='';
  tEl('tchat').innerHTML='';
  var prof=tMystere?'\uD83C\uDFAD Profil myst\u00E8re':(sOpt.text+' / '+cOpt.text);
  tEl('tbadge').innerHTML='<span class="lbadge lbi">'+tLabel('tscen')+' \u2014 '+tLabel('tdiff')+' \u2014 '+prof+'</span>';
  setTStatus('\u00C0 vous : saluez votre client et lancez le rendez-vous.');
  tEl('tinput').focus();
}

// ----- Fil de conversation -----
function addBubble(cls,text){
  var d=document.createElement('div');
  d.className='tmsg '+cls;
  d.textContent=text;
  var c=tEl('tchat');c.appendChild(d);c.scrollTop=c.scrollHeight;
}
function addTMsg(role,text){addBubble(role==='user'?'tme':'tclient',text);}

function sendTrainInput(){
  if(tBusy||tEnded)return;
  var inp=tEl('tinput');var t=inp.value.trim();
  if(!t)return;
  unlockAudio();
  inp.value='';
  sendTrain(t);
}

function sendTrain(text){
  if(tBusy||tEnded)return;
  if(tDrill){drillAnswer(text);return;}
  tBusy=true;
  tMsgs.push({role:'user',content:text});
  addTMsg('user',text);
  setTStatus(tMsgs.length<=1?'Le client arrive\u2026 (jusqu\u2019\u00E0 50 s si le serveur \u00E9tait endormi)':'Le client r\u00E9fl\u00E9chit\u2026');
  trainFetch('/api/roleplay').then(function(data){
    tBusy=false;
    if(data.error){setTStatus(data.error);tMsgs.pop();tEl('tchat').lastChild.remove();tEl('tinput').value=text;return;}
    tMsgs.push({role:'assistant',content:data.reply});
    addTMsg('assistant',data.reply);
    setTStatus('');
    speak(data.reply);
  }).catch(function(){
    tBusy=false;
    setTStatus('Serveur injoignable. V\u00E9rifiez la connexion et r\u00E9essayez.');
    tMsgs.pop();tEl('tchat').lastChild.remove();tEl('tinput').value=text;
  });
}

function trainFetch(path){
  return fetch(TRAIN_API+path,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({scenario:tVal('tscen'),difficulte:tVal('tdiff'),profil:tProfil,messages:tMsgs,hints:tHints})
  }).then(function(r){return r.json();});
}

// ----- Micro -----
function toggleMic(){
  var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR)return;
  unlockAudio();
  if(tRecOn){try{tRec.stop();}catch(e){}return;}
  try{speechSynthesis.cancel();}catch(e){}
  tRec=new SR();
  tRec.lang='fr-FR';tRec.interimResults=true;tRec.continuous=false;
  var finalT='';
  tRec.onresult=function(ev){
    var interim='';
    for(var i=ev.resultIndex;i<ev.results.length;i++){
      if(ev.results[i].isFinal)finalT+=ev.results[i][0].transcript;
      else interim+=ev.results[i][0].transcript;
    }
    setTStatus((finalT||interim)?('\u00AB '+(finalT||interim)+' \u00BB'):'Je vous \u00E9coute\u2026');
  };
  tRec.onend=function(){
    tRecOn=false;tEl('tmic').classList.remove('rec');
    var t=finalT.trim();
    if(t){setTStatus('');sendTrain(t);}
    else setTStatus('');
  };
  tRec.onerror=function(ev){
    tRecOn=false;tEl('tmic').classList.remove('rec');
    setTStatus(ev.error==='not-allowed'?'Micro refus\u00E9 : autorisez-le dans les r\u00E9glages du navigateur, ou \u00E9crivez.':'Micro indisponible : \u00E9crivez votre r\u00E9plique.');
  };
  tRecOn=true;tEl('tmic').classList.add('rec');
  setTStatus('Je vous \u00E9coute\u2026');
  try{tRec.start();}catch(e){tRecOn=false;tEl('tmic').classList.remove('rec');}
}

// ----- Indice du formateur -----
function askHint(){
  if(tBusy||tEnded||tDrill)return;
  if(tMsgs.length<1){setTStatus('Commencez la conversation avant de demander un indice.');return;}
  tBusy=true;
  setTStatus('Le formateur r\u00E9fl\u00E9chit\u2026');
  trainFetch('/api/hint').then(function(data){
    tBusy=false;
    if(data.error){setTStatus(data.error);return;}
    tHints++;
    addBubble('thint','\uD83D\uDCA1 '+data.hint);
    setTStatus('');
  }).catch(function(){tBusy=false;setTStatus('Serveur injoignable. R\u00E9essayez.');});
}

// ----- Fin de session et debriefing -----
function endTrain(){
  if(tBusy||tDrill)return;
  var userTurns=tMsgs.filter(function(m){return m.role==='user';}).length;
  if(userTurns<1){setTStatus('Parlez au moins une fois avant le d\u00E9briefing !');return;}
  if(tMystere&&tGuess===null){
    tEl('tactions').style.display='none';
    tEl('tguess').style.display='block';
    setTStatus('Posez votre diagnostic : quel profil SONCAS avez-vous d\u00E9tect\u00E9 ?');
    return;
  }
  runDebrief();
}

function guessSoncas(btn){
  unlockAudio();
  tGuess=btn.getAttribute('data-v');
  tGuessLabel=btn.textContent;
  tEl('tguess').style.display='none';
  runDebrief();
}

function runDebrief(){
  tBusy=true;tEnded=true;
  tArchive=tMsgs.slice();
  try{speechSynthesis.cancel();}catch(e){}
  setTStatus('Le formateur pr\u00E9pare votre d\u00E9briefing\u2026 (environ 30 s)');
  trainFetch('/api/debrief').then(function(data){
    tBusy=false;
    if(data.error){tEnded=false;tEl('tactions').style.display='flex';setTStatus(data.error);return;}
    showDebrief(data.debrief);
  }).catch(function(){
    tBusy=false;tEnded=false;tEl('tactions').style.display='flex';
    setTStatus('Serveur injoignable. R\u00E9essayez.');
  });
}

function tEsc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML;}

function tNorm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9\u00E0\u00E2\u00E4\u00E9\u00E8\u00EA\u00EB\u00EE\u00EF\u00F4\u00F6\u00F9\u00FB\u00FC\u00E7]+/g,' ').trim();}
function findMomentKeep(cit){
  var c=tNorm(cit).slice(0,30);
  if(!c)return -1;
  for(var i=0;i<tArchive.length;i++){
    if(tNorm(tArchive[i].content).indexOf(c)>-1){
      return tArchive[i].role==='user'?i:i+1;
    }
  }
  return -1;
}

function showDebrief(d){
  tEl('tplay').style.display='none';
  recordSession({sc:tVal('tscen'),di:tVal('tdiff'),note:d.note|0});
  var h='';
  if(tMystere){
    var ok=tGuess===tProfil.soncas;
    h+='<div class="kp '+(ok?'kps':'kpw')+'" style="margin-bottom:12px">\uD83C\uDFAD Profil r\u00E9el : <strong>'+tEsc(tRevealS)+'</strong> ('+tEsc(tRevealC)+') \u2014 votre diagnostic : <strong>'+tEsc(tGuessLabel)+'</strong>. '+(ok?'Bien vu, profil d\u00E9tect\u00E9 !':'Rat\u00E9 \u2014 relisez la fiche SONCAS et guettez les indices dans les mots du client.')+'</div>';
  }
  h+='<div class="score"><div class="snum">'+tEsc(d.note)+'/20</div><div class="slbl">'+tEsc(d.resume)+'</div></div>';
  h+='<div class="cc"><h3>Points forts</h3><ul class="blist">'+d.points_forts.map(function(x){return '<li>'+tEsc(x)+'</li>';}).join('')+'</ul></div>';
  h+='<div class="cc"><h3>\u00C0 travailler</h3><ul class="blist">'+d.axes_travail.map(function(x){return '<li>'+tEsc(x)+'</li>';}).join('')+'</ul></div>';
  h+='<div class="cc"><h3>Moments cl\u00E9s</h3>'+d.moments_cles.map(function(m){
    var keep=findMomentKeep(m.citation);
    var replay=keep>0?'<button class="btn-s" style="margin-bottom:12px" onclick="replayMoment('+keep+')">\u21A9 Rejouer ce moment</button>':'';
    return '<div class="qb" style="margin-bottom:8px">\u00AB '+tEsc(m.citation)+' \u00BB</div><div class="kp" style="margin-bottom:'+(replay?'8px':'12px')+'">'+tEsc(m.commentaire)+'</div>'+replay;
  }).join('')+'</div>';
  h+='<div style="display:flex;gap:8px;margin-top:1rem"><button class="btn-p" onclick="restartTrain()">Nouvelle session</button></div>';
  tEl('tdebrief').innerHTML=h;
  tEl('tdebrief').style.display='block';
}

function replayMoment(keep){
  unlockAudio();
  tMsgs=tArchive.slice(0,keep);
  tEnded=false;tBusy=false;tGuess=null;tGuessLabel='';
  tEl('tdebrief').style.display='none';
  tEl('tplay').style.display='block';
  tEl('tguess').style.display='none';
  tEl('tactions').style.display='flex';
  tEl('tchat').innerHTML='';
  tMsgs.forEach(function(m){addTMsg(m.role,m.content);});
  var c=tEl('tchat');c.scrollTop=c.scrollHeight;
  setTStatus('On rejoue \u00E0 partir d\u2019ici \u2014 \u00E0 vous !');
  tEl('tinput').focus();
}

function restartTrain(){
  tEl('tdebrief').style.display='none';
  tEl('tsetup').style.display='block';
  renderBadges();
}
function quitTrain(){
  try{speechSynthesis.cancel();}catch(e){}
  tDrill=false;tBusy=false;tEnded=false;
  tEl('tendbtn').style.display='';
  tEl('thintbtn').style.display='';
  tEl('tplay').style.display='none';
  tEl('tsetup').style.display='block';
  renderBadges();
}

// ----- Drill objections eclair -----
function startDrill(){
  unlockAudio();
  tDrill=true;tMsgs=[];tBusy=true;tEnded=false;tDrillIdx=0;tDrillScore=0;tDrillList=[];
  tEl('tsetup').style.display='none';
  tEl('tdebrief').style.display='none';
  tEl('tplay').style.display='block';
  tEl('tguess').style.display='none';
  tEl('tactions').style.display='flex';
  tEl('tendbtn').style.display='none';
  tEl('thintbtn').style.display='none';
  tEl('tchat').innerHTML='';
  tEl('tbadge').innerHTML='<span class="lbadge lba">\u26A1 Drill objections \u2014 5 objections, 1 r\u00E9plique chacune</span>';
  setTStatus('Chargement des objections\u2026 (jusqu\u2019\u00E0 50 s si le serveur \u00E9tait endormi)');
  fetch(TRAIN_API+'/api/objections').then(function(r){return r.json();}).then(function(d){
    tDrillList=(d&&d.objections)||[];
    if(!tDrillList.length){setTStatus('Serveur injoignable. R\u00E9essayez.');return;}
    tBusy=false;
    setTStatus('');
    drillNext();
  }).catch(function(){setTStatus('Serveur injoignable. R\u00E9essayez.');});
}
function drillNext(){
  var o=tDrillList[tDrillIdx];
  addBubble('tclient','('+(tDrillIdx+1)+'/'+tDrillList.length+') '+o.text);
  speak(o.text);
  setTStatus('Votre r\u00E9ponse, en une seule r\u00E9plique !');
}
function drillAnswer(text){
  var o=tDrillList[tDrillIdx];
  if(!o)return;
  tBusy=true;
  addBubble('tme',text);
  setTStatus('Le formateur \u00E9value\u2026');
  fetch(TRAIN_API+'/api/drill',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({objection:o.text,reponse:text})
  }).then(function(r){return r.json();}).then(function(d){
    tBusy=false;
    if(d.error){setTStatus(d.error);tEl('tchat').lastChild.remove();tEl('tinput').value=text;return;}
    tDrillScore+=d.eval.score;
    addBubble('tcoach','\uD83D\uDCCB '+d.eval.score+'/4 \u2014 '+d.eval.commentaire);
    tDrillIdx++;
    if(tDrillIdx<tDrillList.length){setTimeout(drillNext,900);}
    else{drillEnd();}
  }).catch(function(){
    tBusy=false;setTStatus('Serveur injoignable. R\u00E9essayez.');
    tEl('tchat').lastChild.remove();tEl('tinput').value=text;
  });
}
function drillEnd(){
  tEnded=true;
  var max=tDrillList.length*4;
  var note20=Math.round(tDrillScore/max*20);
  recordSession({drill:1,note:note20});
  var msg=note20>=16?'R\u00E9flexes aff\u00FBt\u00E9s, beau travail !':(note20>=10?'De bons r\u00E9flexes \u2014 continuez \u00E0 driller pour automatiser l\u2019entonnoir.':'L\u2019entonnoir n\u2019est pas encore un r\u00E9flexe : accepter, isoler, pr\u00E9-closer. On refait un tour ?');
  addBubble('tcoach','\uD83C\uDFC1 Score final : '+tDrillScore+'/'+max+' (soit '+note20+'/20). '+msg);
  setTStatus('Drill termin\u00E9 \u2014 \u00AB Abandonner \u00BB pour revenir au menu.');
}

// ----- Badges de certification -----
function histLoad(){
  try{return JSON.parse(localStorage.getItem(HIST_KEY)||'[]');}catch(e){return [];}
}
function recordSession(rec){
  try{
    var h=histLoad();rec.t=Date.now();h.push(rec);
    localStorage.setItem(HIST_KEY,JSON.stringify(h.slice(-200)));
  }catch(e){}
  renderBadges();
}
function renderBadges(){
  var box=tEl('tbadges');if(!box)return;
  var h=histLoad();
  var html='';var allWon=true;
  document.querySelectorAll('#tscen .thbtn').forEach(function(b){
    var sc=b.getAttribute('data-v');
    var won=h.some(function(x){return x.sc===sc&&x.di==='difficile'&&x.note>=14;});
    var best=h.filter(function(x){return x.sc===sc;}).reduce(function(m,x){return Math.max(m,x.note||0);},-1);
    if(!won)allWon=false;
    var tip=won?'Valid\u00E9 : 14/20 ou plus face au client difficile':('\u00C0 valider : 14/20 face au client difficile'+(best>-1?' \u2014 votre record : '+best+'/20':''));
    html+='<span class="tbadge '+(won?'won':'locked')+'" title="'+tip+'">'+(won?'\uD83C\uDFC5':'\uD83D\uDD12')+' '+b.textContent+'</span>';
  });
  html+='<span class="tbadge '+(allWon?'won':'locked')+'" title="Les 4 sc\u00E9narios valid\u00E9s face au client difficile">'+(allWon?'\uD83C\uDFC6':'\uD83D\uDD12')+' Tolt\u00E8que</span>';
  box.innerHTML=html;
}


/* ================= DOCUMENTS : assistant dossier de vente (version C21) ================= */
var c21store = {
  get:function(k,d){ try{ var v=localStorage.getItem("c21fd:"+k); return v===null?d:JSON.parse(v);}catch(e){return d;} },
  set:function(k,v){ try{ localStorage.setItem("c21fd:"+k,JSON.stringify(v)); }catch(e){} }
};
function dEsc(s){ return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); }

var SOURCES = {
  vendeur:       { label:"Le vendeur",              ico:"🗝️", conseil:"À demander dès le R1. Donnez la liste par écrit : un vendeur retrouve rarement tout du premier coup. Proposez de l'aider à chercher — c'est aussi un excellent prétexte de re-contact." },
  notaire:       { label:"Le notaire",              ico:"⚖️", conseil:"Le notaire du vendeur détient la copie du titre de propriété et les actes. Écrivez-lui avec l'accord du vendeur ; comptez de quelques jours à deux semaines." },
  syndic:        { label:"Le syndic",               ico:"🏢", conseil:"Certains documents sont payants (pré-état daté notamment). Anticipez : les syndics répondent parfois en plusieurs semaines. Le vendeur peut souvent les télécharger gratuitement depuis son extranet copropriétaire." },
  diagnostiqueur:{ label:"Le diagnostiqueur",       ico:"📐", conseil:"Groupez tous les diagnostics en une seule visite : c'est moins cher et plus rapide. Vérifiez les dates de validité des diagnostics déjà réalisés avant d'en commander de nouveaux." },
  mairie:        { label:"La mairie / l'urbanisme", ico:"🏛️", conseil:"Urbanisme, autorisations de travaux, alignement, assainissement collectif : passez par le service urbanisme de la commune. Beaucoup de communes répondent par mail." },
  enligne:       { label:"Les services en ligne",   ico:"🌐", conseil:"Impots.gouv (taxe foncière), cadastre.gouv (plan cadastral) : le vendeur — ou vous — pouvez les obtenir immédiatement, gratuitement." }
};

var QUESTIONS = [
  { id:"type", titre:"Quel type de bien vendez-vous ?", sub:"C'est la première question à poser : elle détermine toute la suite du dossier.",
    opts:[
      {v:"maison",      ico:"🏠", t:"Une maison",      d:"Individuelle ou en lotissement"},
      {v:"appartement", ico:"🏬", t:"Un appartement",  d:"En copropriété dans la quasi-totalité des cas"},
      {v:"terrain",     ico:"🌳", t:"Un terrain",      d:"À bâtir ou non constructible"}
    ]},
  { id:"copro", titre:"Le bien est-il en copropriété ?", sub:"Une maison peut aussi être en copropriété (lotissement avec parties communes, copropriété horizontale).",
    when:function(a){return a.type!=="terrain";},
    opts:[
      {v:"oui", ico:"🏢", t:"Oui", d:"Il y a un syndic, des charges, des AG"},
      {v:"non", ico:"🚪", t:"Non", d:"Propriété individuelle, aucune partie commune"}
    ]},
  { id:"construction", titre:"Quand le bien a-t-il été construit ?", sub:"L'âge du bâti déclenche (ou non) les diagnostics plomb, amiante, gaz et électricité.",
    when:function(a){return a.type!=="terrain";},
    opts:[
      {v:"avant1949", ico:"🏚️", t:"Avant 1949",            d:"Diagnostic plomb obligatoire"},
      {v:"avant1997", ico:"🧱", t:"Entre 1949 et juil. 1997", d:"Diagnostic amiante obligatoire"},
      {v:"apres1997", ico:"🏗️", t:"Après juillet 1997",     d:"Ni plomb, ni amiante"},
      {v:"moins10",   ico:"✨", t:"Il y a moins de 10 ans",  d:"Garanties constructeur encore actives"}
    ]},
  { id:"vendeur", titre:"Quelle est la situation du vendeur ?", sub:"Le contexte juridique du vendeur change les pièces à réunir — et les signatures nécessaires sur votre mandat.",
    opts:[
      {v:"seul",       ico:"🧍", t:"Un propriétaire unique",   d:"Cas le plus simple"},
      {v:"couple",     ico:"💍", t:"Un couple marié ou pacsé", d:"Les deux signatures peuvent être requises"},
      {v:"succession", ico:"🕊️", t:"Succession / indivision",  d:"Plusieurs héritiers ou indivisaires"},
      {v:"divorce",    ico:"⚡", t:"Divorce en cours",          d:"Accord des deux époux indispensable"},
      {v:"sci",        ico:"📜", t:"Une SCI",                   d:"Vérifier les pouvoirs du gérant"},
      {v:"protege",    ico:"🛡️", t:"Majeur protégé",           d:"Tutelle ou curatelle : autorisation du juge"}
    ]},
  { id:"occupation", titre:"Le bien est-il occupé par un locataire ?", sub:"Un bien loué se vend, mais le dossier — et parfois la procédure de congé — change.",
    when:function(a){return a.type!=="terrain";},
    opts:[
      {v:"libre", ico:"🔓", t:"Non, il est libre",  d:"Occupé par le vendeur ou vide"},
      {v:"loue",  ico:"🔑", t:"Oui, il est loué",   d:"Bail en cours"},
      {v:"parti", ico:"🚚", t:"Le locataire vient de partir", d:"Congé délivré, état des lieux de sortie fait ou à faire"}
    ]},
  { id:"equip", titre:"Cochez ce qui concerne le bien", sub:"Chaque équipement a ses justificatifs. Vous pourrez repasser ici si vous découvrez quelque chose en visite.",
    when:function(a){return a.type!=="terrain";}, multi:true,
    opts:[
      {v:"piscine",  ico:"🏊", t:"Piscine",                    d:"Sécurité et déclaration de travaux"},
      {v:"cheminee", ico:"🔥", t:"Cheminée / poêle / insert",  d:"Justificatif de ramonage"},
      {v:"anc",      ico:"💧", t:"Assainissement individuel",  d:"Fosse septique, micro-station"},
      {v:"gaz15",    ico:"♨️", t:"Installation gaz de +15 ans", d:"Diagnostic gaz obligatoire"},
      {v:"elec15",   ico:"⚡", t:"Installation élec. de +15 ans", d:"Diagnostic électricité obligatoire"},
      {v:"solaire",  ico:"☀️", t:"Panneaux solaires",           d:"Contrats et factures"},
      {v:"dpeFG",    ico:"🌡️", t:"DPE F ou G (ou supposé)",    d:"Audit énergétique à prévoir"}
    ]},
  { id:"travaux", titre:"Des travaux importants ont-ils été réalisés depuis moins de 10 ans ?", sub:"Extension, toiture, gros œuvre… Les garanties décennales protègent l'acquéreur : c'est un argument de vente.",
    when:function(a){return a.type!=="terrain";},
    opts:[
      {v:"oui", ico:"🔨", t:"Oui", d:"Extension, rénovation lourde, toiture…"},
      {v:"non", ico:"➖", t:"Non", d:"Rien de significatif"}
    ]}
];

var DOCS = [
  /* --- fondamentaux --- */
  { id:"titre", nom:"Titre de propriété", src:"notaire", delai:"1 à 2 semaines", niv:"oblig",
    d:"L'acte authentique qui prouve que le vendeur est bien propriétaire.",
    astuce:"Demandez-le dès la prise de mandat : il révèle servitudes, indivision ou hypothèques qui peuvent freiner la vente.", when:function(a){return true;} },
  { id:"identite", nom:"Pièces d'identité et livret de famille", src:"vendeur", delai:"Immédiat", niv:"oblig",
    d:"CNI ou passeport de chaque vendeur, livret de famille si couple.",
    astuce:"Photographiez-les au premier rendez-vous, avec l'accord du vendeur : c'est fait, et votre mandat sera juste du premier coup.", when:function(a){return true;} },
  { id:"taxefonciere", nom:"Dernier avis de taxe foncière", src:"enligne", delai:"Immédiat", niv:"oblig",
    d:"Les acquéreurs le demandent systématiquement ; il sert aussi au prorata chez le notaire.",
    astuce:"Téléchargeable en 2 minutes sur impots.gouv.fr, espace particulier du vendeur.", when:function(a){return true;} },
  { id:"erp", nom:"État des risques et pollutions (ERP)", src:"diagnostiqueur", delai:"Moins d'1 semaine", niv:"oblig",
    d:"Risques naturels, miniers, technologiques, sismicité, radon. Obligatoire dès l'annonce.",
    astuce:"Le diagnostiqueur l'établit avec les autres diagnostics — à refaire s'il a plus de 6 mois au compromis (vérifiable sur errial.georisques.gouv.fr).", when:function(a){return a.type!=="terrain";} },
  { id:"dpe", nom:"DPE — diagnostic de performance énergétique", src:"diagnostiqueur", delai:"Moins d'1 semaine", niv:"oblig",
    d:"Obligatoire avant toute annonce : l'étiquette doit figurer dans la publicité.",
    astuce:"Commandez-le en premier — sans DPE, pas de mise en vente. Validité 10 ans (sauf DPE réalisés avant juillet 2021, désormais expirés).", when:function(a){return a.type!=="terrain";} },
  { id:"termites", nom:"État relatif à la présence de termites", src:"diagnostiqueur", delai:"Moins d'1 semaine", niv:"zone",
    d:"Obligatoire uniquement dans les zones délimitées par arrêté préfectoral.",
    astuce:"Vérifiez en mairie ou sur le site de la préfecture si la commune est en zone termites. Validité : 6 mois seulement.", when:function(a){return true;} },
  { id:"plans", nom:"Plans du bien", src:"vendeur", delai:"Variable", niv:"reco",
    d:"Plans d'origine, plans de permis ou croquis coté.",
    astuce:"Pas de plans ? Faites un relevé simple en visite : un plan, même sommaire, augmente le taux de contact sur l'annonce.", when:function(a){return a.type!=="terrain";} },
  { id:"energie", nom:"Factures d'énergie récentes", src:"vendeur", delai:"Immédiat", niv:"reco",
    d:"12 derniers mois d'électricité, gaz, fioul… Les acquéreurs veulent le coût réel.",
    astuce:"Transformez-les en argument : « chauffage : X €/mois » parle plus qu'une étiquette DPE.", when:function(a){return a.type!=="terrain";} },

  /* --- selon l'âge du bâti --- */
  { id:"plomb", nom:"Diagnostic plomb (CREP)", src:"diagnostiqueur", delai:"Moins d'1 semaine", niv:"oblig",
    d:"Constat de risque d'exposition au plomb, pour tout logement construit avant 1949.",
    astuce:"Validité illimitée si aucun plomb détecté ; 1 an seulement en cas de présence.", when:function(a){return a.construction==="avant1949";} },
  { id:"amiante", nom:"Diagnostic amiante", src:"diagnostiqueur", delai:"Moins d'1 semaine", niv:"oblig",
    d:"Pour tout permis de construire antérieur à juillet 1997.",
    astuce:"Validité illimitée si négatif et réalisé après 2013 ; sinon, à refaire.", when:function(a){return a.construction==="avant1949"||a.construction==="avant1997";} },
  { id:"do", nom:"Dommages-ouvrage : attestation + quittances de primes + décennales", src:"vendeur", delai:"Quelques jours", niv:"oblig",
    d:"Pour un bien de moins de 10 ans : attestation d'assurance dommages-ouvrage du maître d'ouvrage, quittances de primes (preuve que l'assurance a bien été réglée) et attestations décennales des entreprises.",
    astuce:"C'est un argument de vente fort : l'acquéreur reste couvert jusqu'aux 10 ans du bâtiment. Sans quittance de prime, l'assurance peut être inopérante : réclamez-la systématiquement.", when:function(a){return a.construction==="moins10";} },
  { id:"pcdaact", nom:"Permis de construire : dossier de dépôt + arrêté + DAACT + attestation de conformité", src:"mairie", delai:"1 à 3 semaines", niv:"oblig",
    d:"Le dossier complet : dossier de dépôt du permis, arrêté accordant le permis, déclaration d'achèvement (DAACT) et attestation de non-contestation de la conformité.",
    astuce:"Le vendeur les a normalement conservés ; sinon, le service urbanisme en garde copie. Sans DAACT, la conformité n'est pas acquise : vérifiez avant de promettre un délai.", when:function(a){return a.construction==="moins10";} },
  { id:"gaz", nom:"Diagnostic gaz", src:"diagnostiqueur", delai:"Moins d'1 semaine", niv:"oblig",
    d:"Installation intérieure de gaz de plus de 15 ans.",
    astuce:"Validité 3 ans pour une vente. Une anomalie n'empêche pas de vendre : elle informe l'acquéreur.", when:function(a){return (a.equip||[]).indexOf("gaz15")>=0;} },
  { id:"elec", nom:"Diagnostic électricité", src:"diagnostiqueur", delai:"Moins d'1 semaine", niv:"oblig",
    d:"Installation électrique de plus de 15 ans.",
    astuce:"Validité 3 ans. Anticipez les questions : chiffrez avec un artisan le coût de mise en sécurité des anomalies relevées.", when:function(a){return (a.equip||[]).indexOf("elec15")>=0;} },
  { id:"audit", nom:"Audit énergétique réglementaire", src:"diagnostiqueur", delai:"1 à 2 semaines", niv:"oblig",
    d:"Obligatoire pour la vente d'une maison (mono-propriété) classée F ou G : scénarios de travaux chiffrés.",
    astuce:"Plus complet (et plus cher) que le DPE. Commandez-le en même temps que les autres diagnostics pour gagner du temps.",
    when:function(a){return (a.equip||[]).indexOf("dpeFG")>=0 && a.type==="maison" && a.copro!=="oui";} },

  /* --- copropriété --- */
  { id:"reglement", nom:"Règlement de copropriété + état descriptif de division", src:"syndic", delai:"1 à 2 semaines", niv:"oblig",
    d:"Avec tous ses modificatifs. Annexé au compromis (loi ALUR).",
    astuce:"Le vendeur l'a reçu à son achat — souvent plus vite retrouvé chez son notaire que via le syndic.", when:function(a){return a.copro==="oui";} },
  { id:"pvag", nom:"Procès-verbaux des 3 dernières AG", src:"syndic", delai:"Quelques jours", niv:"oblig",
    d:"Ils révèlent travaux votés, litiges et ambiance de la copropriété.",
    astuce:"Lisez-les avant l'acquéreur : un ravalement voté non payé, ça se découvre au mandat, pas au compromis.", when:function(a){return a.copro==="oui";} },
  { id:"fiche", nom:"Fiche synthétique de la copropriété", src:"syndic", delai:"Quelques jours", niv:"oblig",
    d:"Carte d'identité de la copro : nombre de lots, budget, impayés.",
    astuce:"Le syndic doit la fournir sous 15 jours — souvent disponible sur l'extranet copropriétaire.", when:function(a){return a.copro==="oui";} },
  { id:"carnet", nom:"Carnet d'entretien de l'immeuble", src:"syndic", delai:"Quelques jours", niv:"oblig",
    d:"Historique des travaux et contrats d'entretien de l'immeuble.",
    astuce:"Utile pour répondre à LA question des acquéreurs : « la toiture / la chaudière collective a quel âge ? »", when:function(a){return a.copro==="oui";} },
  { id:"charges", nom:"Appels de charges des 2 derniers exercices", src:"vendeur", delai:"Immédiat", niv:"oblig",
    d:"Charges courantes et travaux, pour chiffrer le budget réel de l'acquéreur.",
    astuce:"Annoncez des charges exactes dès l'annonce : une mauvaise surprise à ce stade fait fuir.", when:function(a){return a.copro==="oui";} },
  { id:"preetat", nom:"Pré-état daté", src:"syndic", delai:"2 à 4 semaines", niv:"oblig",
    d:"Situation financière du lot (impayés, procédures, fonds travaux). Nécessaire pour le compromis.",
    astuce:"Payant (souvent 150 à 400 €). Commandez-le dès l'offre acceptée pour ne pas retarder la signature.", when:function(a){return a.copro==="oui";} },
  { id:"carrez", nom:"Mesurage loi Carrez", src:"diagnostiqueur", delai:"Moins d'1 semaine", niv:"oblig",
    d:"Surface privative certifiée, obligatoire pour tout lot de copropriété.",
    astuce:"Si la surface réelle est inférieure de plus de 5 % à celle de l'acte, l'acquéreur peut exiger une baisse de prix : ne le bâclez jamais.", when:function(a){return a.copro==="oui";} },

  /* --- maison hors copro --- */
  { id:"anc", nom:"Diagnostic assainissement non collectif (SPANC)", src:"mairie", delai:"2 à 6 semaines", niv:"oblig",
    d:"Contrôle de la fosse septique / micro-station par le SPANC. Validité 3 ans.",
    astuce:"Le plus long à obtenir dans certaines communes : lancez la demande dès le mandat. En cas de non-conformité, l'acquéreur a 1 an après l'acte pour mettre aux normes.", when:function(a){return (a.equip||[]).indexOf("anc")>=0;} },
  { id:"egout", nom:"Attestation de raccordement au tout-à-l'égout", src:"mairie", delai:"1 à 4 semaines", niv:"zone",
    d:"Certaines communes exigent un contrôle de conformité du raccordement lors de la vente.",
    astuce:"Appelez le service assainissement de la commune : la règle varie d'une ville à l'autre.", when:function(a){return a.type==="maison" && (a.equip||[]).indexOf("anc")<0;} },
  { id:"cadastre", nom:"Plan cadastral et bornage", src:"enligne", delai:"Immédiat", niv:"reco",
    d:"Références cadastrales et limites de la parcelle.",
    astuce:"Plan gratuit sur cadastre.gouv.fr. En cas de doute sur les limites (clôture, haie), signalez-le tôt : un bornage se négocie avant le compromis.", when:function(a){return a.type==="maison";} },
  { id:"piscine", nom:"Piscine : déclaration de travaux + attestation de sécurité", src:"vendeur", delai:"Variable", niv:"oblig",
    d:"Autorisation d'urbanisme de la piscine et conformité du dispositif de sécurité (alarme, barrière, abri, couverture).",
    astuce:"Une piscine non déclarée se régularise auprès de l'urbanisme et des impôts — mieux vaut le faire avant la vente qu'au moment du compromis.", when:function(a){return (a.equip||[]).indexOf("piscine")>=0;} },
  { id:"ramonage", nom:"Certificat de ramonage", src:"vendeur", delai:"Immédiat", niv:"reco",
    d:"Justificatif d'entretien de la cheminée, du poêle ou de l'insert.",
    astuce:"Un ramonage récent rassure ; l'assurance de l'acquéreur l'exigera de toute façon.", when:function(a){return (a.equip||[]).indexOf("cheminee")>=0;} },
  { id:"solaire", nom:"Panneaux solaires : contrats et factures", src:"vendeur", delai:"Quelques jours", niv:"oblig",
    d:"Facture d'installation, contrat de revente (EDF OA…) ou de location/leasing.",
    astuce:"Vérifiez si les panneaux sont en location : un contrat de leasing se transfère à l'acquéreur et doit être annoncé.", when:function(a){return (a.equip||[]).indexOf("solaire")>=0;} },

  /* --- terrain --- */
  { id:"cu", nom:"Certificat d'urbanisme", src:"mairie", delai:"1 à 2 mois", niv:"oblig",
    d:"CU d'information ou opérationnel : constructibilité, règles applicables, taxes.",
    astuce:"Demandez un CU opérationnel si l'acquéreur a un projet précis : il « gèle » les règles d'urbanisme 18 mois.", when:function(a){return a.type==="terrain";} },
  { id:"bornage", nom:"Bornage par géomètre-expert", src:"vendeur", delai:"3 à 6 semaines", niv:"oblig",
    d:"Obligatoire pour un terrain à bâtir issu d'un lotissement ; fortement conseillé partout ailleurs.",
    astuce:"Le descriptif de bornage doit être mentionné dans le compromis, sous peine de nullité pour un terrain en lotissement.", when:function(a){return a.type==="terrain";} },
  { id:"g1", nom:"Étude de sol G1 (loi ELAN)", src:"diagnostiqueur", delai:"2 à 4 semaines", niv:"zone",
    d:"Obligatoire pour la vente d'un terrain constructible en zone d'argiles gonflantes moyenne ou forte.",
    astuce:"Vérifiez la zone sur georisques.gouv.fr (retrait-gonflement des argiles). Comptez 800 à 1 500 €.", when:function(a){return a.type==="terrain";} },
  { id:"hydro", nom:"Étude hydrogéologique", src:"diagnostiqueur", delai:"2 à 4 semaines", niv:"reco",
    d:"Comportement des eaux souterraines : nappe, ruissellement, faisabilité de l'assainissement individuel, risque d'humidité pour la future construction.",
    astuce:"Très vendeuse pour un terrain à bâtir : elle rassure l'acquéreur (et son constructeur) sur la faisabilité du projet. À coupler avec l'étude de sol G1.", when:function(a){return a.type==="terrain";} },
  { id:"erpterrain", nom:"État des risques et pollutions (ERP) du terrain", src:"diagnostiqueur", delai:"Moins d'1 semaine", niv:"oblig",
    d:"Risques naturels, miniers et technologiques applicables à la parcelle. Obligatoire dès l'annonce.",
    astuce:"Le diagnostiqueur peut l'établir sans visite ; pensez aussi au zonage assainissement et aux réseaux en limite de parcelle (mairie et concessionnaires).", when:function(a){return a.type==="terrain";} },
  { id:"reglot", nom:"Règlement et cahier des charges du lotissement", src:"vendeur", delai:"Quelques jours", niv:"zone",
    d:"S'il s'agit d'un lot de lotissement : règles privées de construction et d'usage.",
    astuce:"L'association syndicale du lotissement ou le notaire d'origine en détiennent copie.", when:function(a){return a.type==="terrain";} },

  /* --- situation du vendeur --- */
  { id:"conjoint", nom:"Accord du conjoint", src:"vendeur", delai:"Immédiat", niv:"oblig",
    d:"Si le bien est la résidence de la famille, les DEUX époux doivent consentir à la vente (art. 215 du Code civil), même si un seul est propriétaire.",
    astuce:"Faites signer le mandat par les deux dès le départ : un mandat signé d'un seul époux sur la maison familiale est fragile.", when:function(a){return a.vendeur==="couple";} },
  { id:"notoriete", nom:"Acte de notoriété + attestation immobilière", src:"notaire", delai:"2 semaines à plusieurs mois", niv:"oblig",
    d:"Établit qui sont les héritiers et leur transfère officiellement la propriété.",
    astuce:"Sans attestation immobilière publiée, impossible de signer l'acte de vente. Vérifiez où en est la succession AVANT de promettre un délai à un acquéreur.", when:function(a){return a.vendeur==="succession";} },
  { id:"indivisaires", nom:"Accord écrit de tous les indivisaires", src:"vendeur", delai:"Variable", niv:"oblig",
    d:"La vente exige en principe l'unanimité des indivisaires ; le mandat aussi.",
    astuce:"Collectez les coordonnées de TOUS les indivisaires au premier rendez-vous et faites signer le mandat par chacun (ou avec procurations).", when:function(a){return a.vendeur==="succession";} },
  { id:"divorce", nom:"Situation du divorce : jugement ou accord des deux époux", src:"vendeur", delai:"Variable", niv:"oblig",
    d:"Tant que la communauté n'est pas liquidée, les deux époux signent — même séparés.",
    astuce:"Restez neutre entre les deux époux et informez-les symétriquement : c'est votre meilleure protection en cas de conflit.", when:function(a){return a.vendeur==="divorce";} },
  { id:"sci", nom:"SCI : statuts, Kbis de moins de 3 mois, décision autorisant la vente", src:"vendeur", delai:"Quelques jours", niv:"oblig",
    d:"Vérifier que le gérant a le pouvoir de vendre ; sinon, PV d'assemblée des associés.",
    astuce:"Lisez la clause « pouvoirs du gérant » des statuts : si la vente n'y figure pas, exigez le PV d'AG avant de commercialiser.", when:function(a){return a.vendeur==="sci";} },
  { id:"tutelle", nom:"Jugement de protection + autorisation du juge", src:"vendeur", delai:"1 à 3 mois", niv:"oblig",
    d:"La vente du logement d'un majeur sous tutelle exige l'autorisation du juge des contentieux de la protection.",
    astuce:"Le juge exige souvent deux avis de valeur : proposez le vôtre, c'est aussi l'occasion de sécuriser le mandat.", when:function(a){return a.vendeur==="protege";} },

  /* --- bien loué ou récemment libéré --- */
  { id:"bail", nom:"Bail en cours + avenants", src:"vendeur", delai:"Immédiat", niv:"oblig",
    d:"Le bail se transmet à l'acquéreur avec le bien.",
    astuce:"Vérifiez la date d'échéance du bail : elle commande la stratégie (vente occupée ou congé pour vendre libre).", when:function(a){return a.occupation==="loue";} },
  { id:"edle", nom:"État des lieux d'entrée", src:"vendeur", delai:"Immédiat", niv:"oblig",
    d:"Il fait partie du dossier locatif transmis à l'acquéreur et servira de référence à la sortie du locataire.",
    astuce:"S'il est introuvable, notez-le : sans état des lieux d'entrée, le locataire est présumé avoir reçu le logement en bon état — cela pèse sur la restitution du dépôt de garantie.", when:function(a){return a.occupation==="loue"||a.occupation==="parti";} },
  { id:"quittances", nom:"3 dernières quittances + dépôt de garantie", src:"vendeur", delai:"Immédiat", niv:"oblig",
    d:"Loyer réellement payé et montant du dépôt à transférer à l'acquéreur.",
    astuce:"Un locataire à jour de ses loyers est un argument pour les investisseurs : mettez la rentabilité en avant dans l'annonce.", when:function(a){return a.occupation==="loue";} },
  { id:"conge", nom:"Congé (délivré ou reçu)", src:"vendeur", delai:"6 mois avant l'échéance du bail", niv:"oblig",
    d:"Congé pour vente délivré par le bailleur (le locataire est alors prioritaire pour acheter) ou congé donné par le locataire.",
    astuce:"Le congé pour vente vaut offre de vente au locataire : prix ferme et sérieux, notification par huissier ou LRAR. Conservez l'accusé de réception au dossier.", when:function(a){return a.occupation==="loue"||a.occupation==="parti";} },
  { id:"edls", nom:"État des lieux de sortie", src:"vendeur", delai:"Au départ du locataire", niv:"oblig",
    d:"Constate l'état du logement à la restitution des clés et solde la relation locative (dépôt de garantie).",
    astuce:"Pour vendre libre après un congé : état des lieux de sortie + remise des clés = le bien est juridiquement libre. Ajoutez les photos du logement vide au dossier.", when:function(a){return a.occupation==="parti";} },

  /* --- travaux --- */
  { id:"factures", nom:"Factures des travaux + garanties", src:"vendeur", delai:"Quelques jours", niv:"oblig",
    d:"Factures des entreprises et attestations décennales pour les travaux de moins de 10 ans.",
    astuce:"Des travaux facturés par des pros = garanties transmissibles = argument prix. Des travaux « au noir » = aucune garantie : ajustez l'estimation.", when:function(a){return a.travaux==="oui";} },
  { id:"autorisations", nom:"Travaux soumis à DP / PC : dossier de dépôt + arrêté + DAACT + attestation de conformité", src:"mairie", delai:"1 à 3 semaines", niv:"oblig",
    d:"Pour chaque extension, véranda, garage, fenêtre de toit… : le dossier de dépôt, l'arrêté accordant l'autorisation, la déclaration d'achèvement (DAACT) et l'attestation de non-contestation de la conformité.",
    astuce:"Une extension non déclarée bloque souvent la vente au moment du notaire. Détectez-la au mandat (comparez avec le plan cadastral) et régularisez tôt.", when:function(a){return a.travaux==="oui";} }
];

var NIV_LABEL = { oblig:{c:"oblig", t:"Obligatoire"}, reco:{c:"reco", t:"Recommandé"}, zone:{c:"zone", t:"Selon zone / cas"} };

var docsDossier = c21store.get("dossier", null);
var docsApp = null;
var wizAnswers = null, wizIdx = 0;

function visibleQuestions(a){ return QUESTIONS.filter(function(q){return !q.when || q.when(a);}); }
function docsFor(a){ return DOCS.filter(function(d){return d.when(a);}); }

function renderDocsModule(){
  docsApp = document.getElementById("docsApp");
  if(docsDossier && docsDossier.done){ renderDocResults(); } else { renderWizard(); }
}

function renderWizard(){
  if(!wizAnswers){ wizAnswers = (docsDossier && !docsDossier.done) ? docsDossier.answers : {}; wizIdx = 0; }
  var qs = visibleQuestions(wizAnswers);
  if(wizIdx >= qs.length){ finishWizard(); return; }
  var q = qs[wizIdx];
  var multi = !!q.multi;
  var cur = wizAnswers[q.id];
  docsApp.innerHTML =
    '<div class="deyebrow">Assistant dossier de vente · question '+(wizIdx+1)+' sur '+qs.length+'</div>'+
    '<div class="wizard-progress"><i style="width:'+Math.round(wizIdx/qs.length*100)+'%"></i></div>'+
    '<h2 class="dh1">'+q.titre+'</h2>'+
    '<p class="dmuted">'+q.sub+'</p>'+
    '<div class="opt-grid">'+q.opts.map(function(o){
      var sel = multi ? (cur||[]).indexOf(o.v)>=0 : cur===o.v;
      return '<button class="opt '+(sel?"selected":"")+'" data-v="'+o.v+'"><span class="opt-ico">'+o.ico+'</span><span class="opt-t">'+o.t+'</span><span class="opt-d">'+o.d+'</span></button>';
    }).join("")+'</div>'+
    '<div class="wizard-nav"><button class="dbtn ghost" id="wizBack" '+(wizIdx===0?"disabled":"")+'>← Retour</button>'+
    (multi ? '<button class="dbtn" id="wizNext">Continuer →</button>' : '<span class="dmuted dsmall" style="align-self:center">Choisissez une réponse pour continuer</span>')+'</div>';
  docsApp.querySelectorAll(".opt").forEach(function(b){ b.addEventListener("click", function(){
    if(multi){
      var arr = (wizAnswers[q.id]||[]).slice();
      var ix = arr.indexOf(b.dataset.v);
      if(ix>=0) arr.splice(ix,1); else arr.push(b.dataset.v);
      wizAnswers[q.id] = arr;
      b.classList.toggle("selected");
    } else {
      wizAnswers[q.id] = b.dataset.v;
      if(q.id==="type" && b.dataset.v==="terrain"){ delete wizAnswers.copro; delete wizAnswers.construction; delete wizAnswers.occupation; delete wizAnswers.equip; delete wizAnswers.travaux; }
      wizIdx++;
      renderWizard();
    }
  });});
  var back = document.getElementById("wizBack");
  if(back) back.addEventListener("click", function(){ if(wizIdx>0){ wizIdx--; renderWizard(); } });
  var next = document.getElementById("wizNext");
  if(next) next.addEventListener("click", function(){ if(!wizAnswers[q.id]) wizAnswers[q.id]=[]; wizIdx++; renderWizard(); });
}

function finishWizard(){
  docsDossier = { answers: wizAnswers, checked: (docsDossier && docsDossier.checked) || {}, done: true };
  c21store.set("dossier", docsDossier);
  wizAnswers = null; wizIdx = 0;
  renderDocResults();
}

function resumeLabel(a){
  var t = {maison:"Maison", appartement:"Appartement", terrain:"Terrain"}[a.type]||"";
  var bits = [t];
  if(a.copro==="oui") bits.push("copropriété");
  if(a.occupation==="loue") bits.push("loué");
  if(a.occupation==="parti") bits.push("locataire sortant");
  var v = {seul:"", couple:"couple", succession:"succession", divorce:"divorce", sci:"SCI", protege:"majeur protégé"}[a.vendeur];
  if(v) bits.push(v);
  return bits.join(" · ");
}

function checkedDocs(){
  return docsFor(docsDossier.answers).filter(function(d){return docsDossier.checked[d.id];});
}

// Liste envoyée / copiée / imprimée : UNIQUEMENT les documents cochés
// (« à demander »), sans niveau ni délai — juste les noms, groupés par source.
function docsListText(){
  var docs = checkedDocs();
  var bySrc = {};
  docs.forEach(function(d){ (bySrc[d.src] = bySrc[d.src]||[]).push(d); });
  var lines = ["Documents à réunir — " + resumeLabel(docsDossier.answers), ""];
  Object.keys(bySrc).forEach(function(src){
    lines.push("■ " + SOURCES[src].label.toUpperCase());
    bySrc[src].forEach(function(d){ lines.push("- " + d.nom); });
    lines.push("");
  });
  return lines.join("\n");
}

// Vue d'impression : seuls les documents cochés, une case à cocher devant
// chaque nom (le vendeur coche au fur et à mesure qu'il les réunit).
function docsPrintHtml(){
  var docs = checkedDocs();
  var bySrc = {};
  docs.forEach(function(d){ (bySrc[d.src] = bySrc[d.src]||[]).push(d); });
  return '<div id="docsPrint">'+
    '<div class="ph-eyebrow">Dossier de vente</div>'+
    '<h1>Documents à réunir</h1>'+
    '<p class="ph-sub">'+dEsc(resumeLabel(docsDossier.answers))+'</p>'+
    Object.keys(bySrc).map(function(src){
      return '<h2>'+dEsc(SOURCES[src].label)+'</h2>'+
        bySrc[src].map(function(d){ return '<div class="pline"><span class="pbox"></span>'+dEsc(d.nom)+'</div>'; }).join("");
    }).join("")+
    '</div>';
}

function renderDocResults(){
  var a = docsDossier.answers;
  var docs = docsFor(a);
  var byNiv = {oblig:[],reco:[],zone:[]};
  docs.forEach(function(d){byNiv[d.niv].push(d);});
  var total = docs.length;
  var done = docs.filter(function(d){return docsDossier.checked[d.id];}).length;
  var pct = total ? Math.round(done/total*100) : 0;
  var bySrc = {};
  docs.forEach(function(d){ (bySrc[d.src] = bySrc[d.src]||[]).push(d); });
  var circ = 2*Math.PI*40;

  docsApp.innerHTML =
    '<div class="dcard no-print" style="margin-bottom:20px"><div class="gauge-wrap">'+
      '<svg class="gauge" viewBox="0 0 100 100" role="img" aria-label="'+done+' document(s) à demander sur '+total+'">'+
        '<circle cx="50" cy="50" r="40" fill="none" stroke="var(--ui-line)" stroke-width="10"/>'+
        '<circle cx="50" cy="50" r="40" fill="none" stroke="var(--ui-accent)" stroke-width="10" stroke-linecap="round" stroke-dasharray="'+circ+'" stroke-dashoffset="'+(circ*(1-pct/100))+'" transform="rotate(-90 50 50)"/>'+
        '<text x="50" y="55" text-anchor="middle">'+pct+'%</text></svg>'+
      '<div style="flex:1;min-width:220px">'+
        '<div class="deyebrow">Votre dossier de vente</div>'+
        '<h2 class="dh1" style="margin:.15em 0 .2em">'+resumeLabel(a)+'</h2>'+
        '<p class="dmuted dsmall" style="margin:0">'+total+' documents proposés — '+byNiv.oblig.length+' obligatoires, '+byNiv.reco.length+' recommandés, '+byNiv.zone.length+' selon zone ou cas particulier.</p>'+
        '<p class="dsmall" style="margin:8px 0 0;color:var(--ui-accent);font-weight:600">Cochez les documents à demander au vendeur ('+done+' coché'+(done>1?"s":"")+') — seuls les documents cochés partent dans « Copier », « E-mail » et « Imprimer ».</p>'+
        '<div class="pill-row" style="margin-top:12px">'+
          '<button class="dbtn sm secondary" id="docEdit">✎ Modifier les réponses</button>'+
          '<button class="dbtn sm secondary" id="docRestart">↺ Nouveau dossier</button>'+
          '<button class="dbtn sm secondary" id="docCopy">⧉ Copier la liste</button>'+
          '<button class="dbtn sm secondary" id="docMail">✉️ Envoyer par e-mail</button>'+
          '<button class="dbtn sm secondary" id="docPrint">🖨 Imprimer</button>'+
        '</div></div></div></div>'+
    Object.keys(bySrc).map(function(src){
      var s = SOURCES[src];
      var items = bySrc[src];
      var sdone = items.filter(function(d){return docsDossier.checked[d.id];}).length;
      return '<section class="src-group">'+
        '<div class="src-head"><div class="src-ico">'+s.ico+'</div><div style="flex:1"><h3 class="dh2" style="margin:0">'+s.label+'</h3></div><span class="dchip">'+sdone+'/'+items.length+'</span></div>'+
        '<p class="src-conseil">'+s.conseil+'</p>'+
        items.map(function(d){
          return '<div class="ddoc '+(docsDossier.checked[d.id]?"done":"")+'">'+
            '<input type="checkbox" id="ck-'+d.id+'" data-doc="'+d.id+'" '+(docsDossier.checked[d.id]?"checked":"")+' aria-label="À demander : '+dEsc(d.nom)+'">'+
            '<div style="flex:1"><label class="ddoc-t" for="ck-'+d.id+'">'+d.nom+'</label>'+
            '<div class="ddoc-d">'+d.d+'</div>'+
            '<div class="ddoc-meta"><span class="dbadge '+NIV_LABEL[d.niv].c+'">'+NIV_LABEL[d.niv].t+'</span><span class="dchip">⏱ '+d.delai+'</span></div>'+
            '<div class="ddoc-astuce"><b>Astuce conseiller :</b> '+d.astuce+'</div></div></div>';
        }).join("")+'</section>';
    }).join("")+
    '<p class="dmuted dsmall" style="margin-top:26px">Liste indicative à visée pédagogique : les obligations exactes dépendent de la commune et de la situation. En cas de doute, validez avec le notaire.</p>'+
    docsPrintHtml();

  docsApp.querySelectorAll("input[data-doc]").forEach(function(c){ c.addEventListener("change", function(){
    docsDossier.checked[c.dataset.doc] = c.checked;
    c21store.set("dossier", docsDossier);
    renderDocResults();
  });});
  document.getElementById("docEdit").addEventListener("click", function(){ wizAnswers = JSON.parse(JSON.stringify(docsDossier.answers)); wizIdx = 0; docsDossier.done = false; renderWizard(); });
  document.getElementById("docRestart").addEventListener("click", function(){
    if(confirm("Repartir de zéro ? Les cases cochées seront effacées.")){ docsDossier = null; wizAnswers = null; wizIdx = 0; c21store.set("dossier", null); renderWizard(); }
  });
  function requireChecked(){
    if(checkedDocs().length) return true;
    alert("Cochez d'abord les documents à demander au vendeur : seuls les documents cochés partent dans la liste.");
    return false;
  }
  document.getElementById("docCopy").addEventListener("click", function(e){
    if(!requireChecked()) return;
    if(navigator.clipboard) navigator.clipboard.writeText(docsListText()).then(function(){ e.target.textContent = "✓ Copié !"; setTimeout(function(){e.target.textContent="⧉ Copier la liste";}, 1600); });
  });
  document.getElementById("docMail").addEventListener("click", function(){
    if(!requireChecked()) return;
    var subject = "Dossier de vente — documents à réunir (" + resumeLabel(docsDossier.answers) + ")";
    var body = "Bonjour,\n\nVoici la liste des documents à réunir pour la vente de votre bien. Je reste à votre disposition pour vous aider à les obtenir.\n\n" + docsListText() + "\nBien cordialement";
    location.href = "mailto:?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
  });
  document.getElementById("docPrint").addEventListener("click", function(){
    if(!requireChecked()) return;
    window.print();
  });
}


/* ----- Navigation de l'onglet + identite agence ----- */
function showFD(id, btn){
  document.querySelectorAll('.fd-nav button').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  document.getElementById('section-fd-docs').classList.toggle('active', id === 'docs');
  document.getElementById('section-formation').classList.toggle('active', id === 'formation');
  var tools = document.getElementById('section-fd-tools');
  if (tools) tools.classList.toggle('active', id === 'tools');
}
document.addEventListener('DOMContentLoaded', function(){
  /* Copie dediee Century 21 Kadima : logo embarque, pas de verrou. */
  try {
    var tl = document.getElementById('topbarLogo');
    if (tl && window.KADIMA && window.KADIMA.emblem) tl.src = window.KADIMA.emblem;
    else if (tl) tl.parentNode.style.display = 'none';
  } catch (e) {}
  document.querySelectorAll('.fd-nav button').forEach(function(b){
    b.addEventListener('click', function(){ showFD(b.dataset.sec, b); });
  });
  renderDocsModule();
});

/* ================= OUTILS DE CALCUL ================= */
function eur(n){ return new Intl.NumberFormat('fr-FR', {style:'currency', currency:'EUR', maximumFractionDigits:0}).format(Math.round(n)); }
function pct1(n){ return (Math.round(n*10)/10).toLocaleString('fr-FR') + ' %'; }
function num(id){ var v = parseFloat(document.getElementById(id).value); return isFinite(v) && v >= 0 ? v : 0; }
function resRow(label, val, cls){ return '<div class="crow '+(cls||'')+'"><span>'+label+'</span><b>'+val+'</b></div>'; }

/* ----- Frais de notaire ----- */
var fnType = 'ancien';

/* Émoluments proportionnels du notaire (barème en vigueur depuis 2021), hors TVA */
function emoluments(base){
  var t = 0;
  t += Math.min(base, 6500) * 0.03870;
  if (base > 6500)  t += (Math.min(base, 17000) - 6500)  * 0.01596;
  if (base > 17000) t += (Math.min(base, 60000) - 17000) * 0.01064;
  if (base > 60000) t += (base - 60000) * 0.00799;
  return t;
}

function calcNotaire(){
  var prix = num('fnPrix'), mobilier = Math.min(num('fnMobilier'), prix);
  var base = prix - mobilier;
  var hausse = document.getElementById('fnHausse').checked;
  var emol = emoluments(base);
  var emolTTC = emol * 1.20;
  var dmtoTaux = fnType === 'neuf' ? 0.00715 : (hausse ? 0.063185 : 0.0580665);
  var dmto = base * dmtoTaux;
  var csi = Math.max(base * 0.001, 15);
  var debours = fnType === 'neuf' ? 1000 : 1200;
  var total = emolTTC + dmto + csi + debours;
  var el = document.getElementById('fnRes');
  el.innerHTML =
    (mobilier > 0 ? resRow('Base taxable (mobilier déduit)', eur(base)) : '') +
    resRow(fnType === 'neuf' ? 'Taxe de publicité foncière (0,715 %)' : 'Droits de mutation (' + pct1(dmtoTaux * 100) + ')', eur(dmto)) +
    resRow('Émoluments du notaire (TTC)', eur(emolTTC)) +
    resRow('Contribution de sécurité immobilière (0,10 %)', eur(csi)) +
    resRow('Formalités et débours (forfait)', eur(debours)) +
    resRow('Total estimé', eur(total), 'ctotal') +
    resRow('Soit ' + pct1(base > 0 ? total / base * 100 : 0) + ' du prix — provision conseillée', eur(Math.ceil(total / 500) * 500), 'csub') +
    (fnType === 'neuf' ? '<p class="cnote">Dans le neuf, la TVA (20 %) est déjà comprise dans le prix de vente affiché par le promoteur.</p>' : '') +
    (mobilier > 0 ? '<p class="cnote">Le mobilier déduit doit être listé et valorisé de façon réaliste dans le compromis (factures à l\'appui).</p>' : '');
}

/* ----- Plus-value ----- */
var pvFaMode = 'forfait', pvTxMode = 'aucun';

function surtaxePV(pv){
  if (pv <= 50000) return 0;
  if (pv <= 60000)  return 0.02 * pv - (60000 - pv) * 1 / 20;
  if (pv <= 100000) return 0.02 * pv;
  if (pv <= 110000) return 0.03 * pv - (110000 - pv) * 1 / 10;
  if (pv <= 150000) return 0.03 * pv;
  if (pv <= 160000) return 0.04 * pv - (160000 - pv) * 15 / 100;
  if (pv <= 200000) return 0.04 * pv;
  if (pv <= 210000) return 0.05 * pv - (210000 - pv) * 20 / 100;
  if (pv <= 250000) return 0.05 * pv;
  if (pv <= 260000) return 0.06 * pv - (260000 - pv) * 25 / 100;
  return 0.06 * pv;
}

function calcPV(){
  var el = document.getElementById('pvRes');
  if (document.getElementById('pvRP').checked){
    el.innerHTML = resRow('Résidence principale', 'Exonération totale', 'ctotal') +
      '<p class="cnote">La cession de la résidence principale (et de ses dépendances vendues simultanément) est exonérée d\'impôt sur la plus-value, sans condition de durée.</p>';
    return;
  }
  var vente = num('pvVente'), fCession = num('pvFraisCession');
  var achat = num('pvAchat'), annees = Math.floor(num('pvAnnees'));
  var fa = pvFaMode === 'reel' ? num('pvFaReel') : achat * 0.075;
  var tx = 0;
  if (pvTxMode === 'forfait' && annees >= 5) tx = achat * 0.15;
  if (pvTxMode === 'reel') tx = num('pvTxReel');
  var prixCorrige = achat + fa + tx;
  var pvBrute = (vente - fCession) - prixCorrige;
  if (pvBrute <= 0){
    el.innerHTML = resRow('Plus-value brute', eur(Math.max(pvBrute, -pvBrute) * (pvBrute < 0 ? -1 : 1))) +
      resRow('Aucune imposition', 'Moins-value ou plus-value nulle', 'ctotal') +
      '<p class="cnote">Prix d\'acquisition corrigé retenu : ' + eur(prixCorrige) + ' (achat + frais + travaux). Une moins-value n\'est ni imposée, ni imputable sur une autre vente (sauf cas particuliers).</p>';
    return;
  }
  /* abattements pour durée de détention */
  var abIR = 0, abPS = 0;
  if (annees >= 6){
    abIR = 6 * (Math.min(annees, 21) - 5) + (annees >= 22 ? 4 : 0);
    abPS = 1.65 * (Math.min(annees, 21) - 5) + (annees >= 22 ? 1.6 : 0) + (annees > 22 ? 9 * (Math.min(annees, 30) - 22) : 0);
  }
  abIR = Math.min(abIR, 100); abPS = Math.min(abPS, 100);
  var baseIR = pvBrute * (1 - abIR / 100);
  var basePS = pvBrute * (1 - abPS / 100);
  var ir = baseIR * 0.19;
  var ps = basePS * 0.172;
  var surtaxe = surtaxePV(baseIR);
  var total = ir + ps + surtaxe;
  var net = vente - fCession - total;
  el.innerHTML =
    resRow('Plus-value brute', eur(pvBrute)) +
    resRow('Abattement durée — impôt (' + annees + ' an' + (annees > 1 ? 's' : '') + ')', pct1(abIR)) +
    resRow('Abattement durée — prélèv. sociaux', pct1(abPS)) +
    resRow('Impôt sur la plus-value (19 %)', eur(ir)) +
    resRow('Prélèvements sociaux (17,2 %)', eur(ps)) +
    (surtaxe > 0 ? resRow('Surtaxe (plus-value > 50 000 €)', eur(surtaxe)) : '') +
    resRow('Imposition totale estimée', eur(total), 'ctotal') +
    resRow('Net vendeur après impôt', eur(net), 'csub') +
    (annees >= 22 && annees < 30 ? '<p class="cnote">Détention ≥ 22 ans : plus d\'impôt sur le revenu — il ne reste que les prélèvements sociaux (exonérés à 30 ans).</p>' : '');
}

/* ----- Financement ----- */
function calcFin(){
  var prix = num('fiPrix'), frais = num('fiFrais'), apport = num('fiApport');
  var taux = num('fiTaux') / 100, annees = Math.max(1, Math.floor(num('fiDuree')));
  var tassu = num('fiAssu') / 100;
  var revenus = num('fiRevenus'), charges = num('fiCharges');
  var capital = Math.max(0, prix + frais - apport);
  var n = annees * 12, tm = taux / 12;
  var mens = tm > 0 ? capital * tm / (1 - Math.pow(1 + tm, -n)) : capital / n;
  var assu = capital * tassu / 12;
  var mensTot = mens + assu;
  var coutInterets = mens * n - capital;
  var coutAssu = assu * n;
  var effort = revenus > 0 ? (mensTot + charges) / revenus * 100 : 0;
  /* capacité maximale à 35 % d'effort, assurance comprise */
  var mensMax = Math.max(0, revenus * 0.35 - charges);
  var facteur = (tm > 0 ? tm / (1 - Math.pow(1 + tm, -n)) : 1 / n) + tassu / 12;
  var capMax = facteur > 0 ? mensMax / facteur : 0;
  var ok = effort <= 35;
  var el = document.getElementById('fiRes');
  el.innerHTML =
    resRow('Capital à emprunter', eur(capital), 'ctotal') +
    resRow('Mensualité hors assurance', eur(mens)) +
    resRow('Assurance emprunteur / mois', eur(assu)) +
    resRow('Mensualité totale', eur(mensTot), 'csub') +
    resRow('Coût total des intérêts', eur(coutInterets)) +
    resRow('Coût total de l\'assurance', eur(coutAssu)) +
    resRow('Coût total du crédit', eur(coutInterets + coutAssu)) +
    '<div class="crow"><span>Taux d\'effort (endettement)</span><b class="' + (ok ? 'cok' : 'cko') + '">' + pct1(effort) + (ok ? ' ✓' : ' ✗ > 35 %') + '</b></div>' +
    resRow('Capacité d\'emprunt max. du foyer (35 %, ' + annees + ' ans)', eur(capMax)) +
    (!ok ? '<p class="cnote">Au-dessus de 35 % : allongez la durée, augmentez l\'apport ou visez un prix inférieur — capacité d\'emprunt indicative ci-dessus, à laquelle s\'ajoute l\'apport.</p>'
         : '<p class="cnote">Dossier dans les clous du HCSF. Pensez à faire valider une attestation de faisabilité par la banque ou un courtier avant les visites : c\'est un argument fort au passage d\'offre.</p>');
}

/* ----- Navigation et écouteurs des outils ----- */
document.addEventListener('DOMContentLoaded', function(){
  if (!document.getElementById('section-fd-tools')) return;
  document.querySelectorAll('.ctab').forEach(function(b){
    b.addEventListener('click', function(){
      document.querySelectorAll('.ctab').forEach(function(x){ x.classList.remove('active'); });
      document.querySelectorAll('.ctool').forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      document.getElementById('tool-' + (b.dataset.tool === 'fin' ? 'fin' : b.dataset.tool)).classList.add('active');
    });
  });
  document.querySelectorAll('[data-fn-type]').forEach(function(b){
    b.addEventListener('click', function(){
      fnType = b.dataset.fnType;
      document.querySelectorAll('[data-fn-type]').forEach(function(x){ x.classList.toggle('active', x === b); });
      calcNotaire();
    });
  });
  document.querySelectorAll('[data-pv-fa]').forEach(function(b){
    b.addEventListener('click', function(){
      pvFaMode = b.dataset.pvFa;
      document.querySelectorAll('[data-pv-fa]').forEach(function(x){ x.classList.toggle('active', x === b); });
      document.getElementById('pvFaReelWrap').hidden = pvFaMode !== 'reel';
      calcPV();
    });
  });
  document.querySelectorAll('[data-pv-tx]').forEach(function(b){
    b.addEventListener('click', function(){
      pvTxMode = b.dataset.pvTx;
      document.querySelectorAll('[data-pv-tx]').forEach(function(x){ x.classList.toggle('active', x === b); });
      document.getElementById('pvTxReelWrap').hidden = pvTxMode !== 'reel';
      calcPV();
    });
  });
  ['fnPrix','fnMobilier'].forEach(function(id){ document.getElementById(id).addEventListener('input', calcNotaire); });
  document.getElementById('fnHausse').addEventListener('change', calcNotaire);
  ['pvVente','pvFraisCession','pvAchat','pvAnnees','pvFaReel','pvTxReel'].forEach(function(id){ document.getElementById(id).addEventListener('input', calcPV); });
  document.getElementById('pvRP').addEventListener('change', calcPV);
  ['fiPrix','fiFrais','fiApport','fiTaux','fiDuree','fiAssu','fiRevenus','fiCharges'].forEach(function(id){ document.getElementById(id).addEventListener('input', calcFin); });
  calcNotaire(); calcPV(); calcFin();
});

/* ----- Profil acquéreur ----- */
var PA_RATES = [
  { label: "Aujourd'hui", taux: 3.20 },
  { label: "2024", taux: 3.65 },
  { label: "2023", taux: 3.69 },
  { label: "2022", taux: 1.59 }
];
var paLast = null;

function pct2(n){ return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %'; }
function paMensualite(capital, tauxPct, mois){
  var t = tauxPct / 100 / 12;
  return t > 0 ? capital * t / (1 - Math.pow(1 + t, -mois)) : capital / mois;
}
function paCapacite(mensualite, tauxPct, mois){
  var t = tauxPct / 100 / 12;
  return t > 0 ? mensualite * (1 - Math.pow(1 + t, -mois)) / t : mensualite * mois;
}

function buildProfilRows(){
  var t1 = document.getElementById('paT1'), t2 = document.getElementById('paT2');
  t1.innerHTML = PA_RATES.map(function(r, i){
    return '<div class="parow' + (i === 0 ? ' pa-now' : '') + '">' +
      '<span class="pa-year">' + r.label + (i === 0 ? ' •' : '') + '</span>' +
      '<span class="pa-taux-cell"><input class="cin pa-taux-in" type="number" step="0.05" min="0" max="15" data-pa="' + i + '" value="' + r.taux.toFixed(2) + '" aria-label="Taux ' + r.label + '"></span>' +
      '<span class="pa-bar-zone"><i class="pa-taux-bar" id="paT1t' + i + '"></i><i class="pa-prix-bar" id="paT1p' + i + '"></i></span>' +
      '</div>';
  }).join('');
  t2.innerHTML = PA_RATES.map(function(r, i){
    return '<div class="parow' + (i === 0 ? ' pa-now' : '') + '">' +
      '<span class="pa-year">' + r.label + (i === 0 ? ' •' : '') + '</span>' +
      '<span class="pa-taux-cell pa-taux-txt" id="paT2x' + i + '"></span>' +
      '<span class="pa-bar-zone"><i class="pa-rev-box" id="paT2r' + i + '"></i><i class="pa-prix-bar pa-fixed" id="paT2p' + i + '"></i></span>' +
      '</div>';
  }).join('');
  t1.querySelectorAll('.pa-taux-in').forEach(function(inp){
    inp.addEventListener('input', function(){
      var v = parseFloat(inp.value);
      if (isFinite(v) && v >= 0) PA_RATES[+inp.dataset.pa].taux = v;
      if (+inp.dataset.pa === 0) syncRevenuFromPrix();
      calcProfil();
    });
  });
}

/* Prix et revenu du foyer sont liés : l'un se déduit de l'autre au taux
   « Aujourd'hui » et à la durée choisie (effort de 35 %). */
function syncRevenuFromPrix(){
  var mois = Math.max(1, Math.floor(num('paDuree'))) * 12;
  var rev = paMensualite(num('paPrix'), PA_RATES[0].taux, mois) / 0.35;
  document.getElementById('paRevenu').value = Math.round(rev);
}
function syncPrixFromRevenu(){
  var mois = Math.max(1, Math.floor(num('paDuree'))) * 12;
  var cap = paCapacite(num('paRevenu') * 0.35, PA_RATES[0].taux, mois);
  document.getElementById('paPrix').value = Math.round(cap);
}

function calcProfil(){
  var prix = num('paPrix'), revenu = num('paRevenu');
  var annees = Math.max(1, Math.floor(num('paDuree'))), mois = annees * 12;
  var mensMax = revenu * 0.35;
  document.getElementById('paMens').textContent = eur(mensMax);
  document.getElementById('paT1Titre').textContent = eur(revenu) + ' / mois — impact des taux sur le prix d’achat';
  document.getElementById('paT2Titre').textContent = eur(prix) + ' — impact des taux sur le revenu requis';
  var maxTaux = Math.max.apply(null, PA_RATES.map(function(r){ return r.taux; })) || 1;
  var caps = PA_RATES.map(function(r){ return paCapacite(mensMax, r.taux, mois); });
  var maxCap = Math.max.apply(null, caps) || 1;
  var revs = PA_RATES.map(function(r){ return paMensualite(prix, r.taux, mois) / 0.35; });
  PA_RATES.forEach(function(r, i){
    var tb = document.getElementById('paT1t' + i), pb = document.getElementById('paT1p' + i);
    tb.style.width = Math.max(10, r.taux / maxTaux * 26) + '%';
    tb.textContent = pct2(r.taux);
    pb.style.width = Math.max(18, caps[i] / maxCap * 72) + '%';
    pb.textContent = eur(caps[i]);
    var xb = document.getElementById('paT2x' + i), rb = document.getElementById('paT2r' + i), fb = document.getElementById('paT2p' + i);
    xb.textContent = pct2(r.taux);
    rb.textContent = eur(revs[i]);
    fb.textContent = eur(prix);
  });
  document.getElementById('paCout').textContent = eur(mensMax * mois);
  paLast = { prix: prix, revenu: revenu, annees: annees, mensMax: mensMax, caps: caps, revs: revs, cout: mensMax * mois };
}

/* ----- Impression et e-mail des calculettes ----- */
var DISCLAIMER = "Estimation indicative, communiquée à titre pédagogique : elle n'engage pas l'agence Century 21 Kadima.";

function toolRowsText(sel){
  return Array.prototype.map.call(document.querySelectorAll(sel + ' .crow'), function(r){
    var s = r.querySelector('span'), b = r.querySelector('b');
    return (s ? s.textContent : '') + ' : ' + (b ? b.textContent : '');
  }).join('\n');
}

function toolMailText(tool){
  var lines = [];
  if (tool === 'notaire'){
    lines.push('ESTIMATION DES FRAIS DE NOTAIRE');
    lines.push('Prix : ' + eur(num('fnPrix')) + (num('fnMobilier') > 0 ? ' (dont mobilier déduit : ' + eur(num('fnMobilier')) + ')' : '') + ' — bien ' + (fnType === 'neuf' ? 'neuf' : 'ancien'));
    lines.push('');
    lines.push(toolRowsText('#fnRes'));
  } else if (tool === 'pv'){
    lines.push('ESTIMATION DE LA PLUS-VALUE IMMOBILIÈRE');
    lines.push('Prix de vente : ' + eur(num('pvVente')) + ' — prix d’achat : ' + eur(num('pvAchat')) + ' — détention : ' + Math.floor(num('pvAnnees')) + ' ans');
    lines.push('');
    lines.push(toolRowsText('#pvRes'));
  } else if (tool === 'fin'){
    lines.push('SIMULATION DE FINANCEMENT');
    lines.push('Prix : ' + eur(num('fiPrix')) + ' + frais ' + eur(num('fiFrais')) + ' — apport : ' + eur(num('fiApport')) + ' — ' + Math.floor(num('fiDuree')) + ' ans à ' + num('fiTaux').toLocaleString('fr-FR') + ' %');
    lines.push('');
    lines.push(toolRowsText('#fiRes'));
  } else if (tool === 'profil' && paLast){
    lines.push('PROFIL ACQUÉREUR — ' + eur(paLast.prix));
    lines.push('Revenu net mensuel : ' + eur(paLast.revenu) + ' — mensualité max (35 %) : ' + eur(paLast.mensMax) + ' — durée : ' + paLast.annees + ' ans');
    lines.push('');
    lines.push('Impact des taux sur le prix d’achat (à ' + eur(paLast.revenu) + ' / mois) :');
    PA_RATES.forEach(function(r, i){ lines.push('  ' + r.label + ' — ' + pct2(r.taux) + ' : ' + eur(paLast.caps[i])); });
    lines.push('Coût total d’acquisition (aujourd’hui) : ' + eur(paLast.cout));
    lines.push('');
    lines.push('Revenu requis pour ' + eur(paLast.prix) + ' :');
    PA_RATES.forEach(function(r, i){ lines.push('  ' + r.label + ' — ' + pct2(r.taux) + ' : ' + eur(paLast.revs[i]) + ' / mois'); });
  }
  lines.push('');
  lines.push(DISCLAIMER);
  lines.push('Century 21 Kadima');
  return lines.join('\n');
}

var TOOL_TITLES = { notaire: 'Frais de notaire', pv: 'Plus-value immobilière', fin: 'Simulation de financement', profil: 'Profil acquéreur' };

document.addEventListener('DOMContentLoaded', function(){
  if (!document.getElementById('tool-profil')) return;
  buildProfilRows();
  document.getElementById('paPrix').addEventListener('input', function(){ syncRevenuFromPrix(); calcProfil(); });
  document.getElementById('paRevenu').addEventListener('input', function(){ syncPrixFromRevenu(); calcProfil(); });
  document.getElementById('paDuree').addEventListener('input', function(){ syncRevenuFromPrix(); calcProfil(); });
  calcProfil();
  document.querySelectorAll('[data-print-tool]').forEach(function(b){
    b.addEventListener('click', function(){
      document.body.setAttribute('data-print', 'tools');
      window.print();
    });
  });
  window.addEventListener('afterprint', function(){ document.body.removeAttribute('data-print'); });
  document.querySelectorAll('[data-mail-tool]').forEach(function(b){
    b.addEventListener('click', function(){
      var tool = b.dataset.mailTool;
      var subject = TOOL_TITLES[tool] + ' — estimation Century 21 Kadima';
      location.href = 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(toolMailText(tool));
    });
  });
});
