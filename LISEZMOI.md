# MATRIX // CHAT — messagerie privée

Un site avec connexion obligatoire, où **seul l'hôte (toi) crée les identifiants**,
et une messagerie partagée en thème Matrix.

## Lancer le site sur ton ordinateur

1. Installe **Node.js** (version 18 ou plus) : https://nodejs.org
2. Ouvre un terminal dans ce dossier et tape :

   ```
   node server.js
   ```

3. Au **premier lancement**, le terminal affiche ton compte administrateur
   (identifiant `admin` + un mot de passe généré). **Note-le.**
4. Ouvre http://localhost:3000 et connecte-toi.

Aucune installation de paquets n'est nécessaire (`npm install` inutile).

Pour choisir toi-même le mot de passe admin au premier lancement :

```
ADMIN_USER=sacha ADMIN_PASSWORD=MonMotDePasse node server.js
```
(sous Windows PowerShell : `$env:ADMIN_PASSWORD="MonMotDePasse"; node server.js`)

## Créer des accès pour les autres

Connecté en admin, clique sur **ADMIN** en haut à droite :

- **Créer un accès** : identifiant + mot de passe (le bouton 🎲 en génère un). Le site te
  propose de copier les deux pour les envoyer à la personne.
- **MOT DE PASSE** : change le mot de passe d'un compte (la personne est déconnectée).
- **SUPPRIMER** : retire l'accès d'une personne (elle est déconnectée aussitôt).

Personne ne peut se créer de compte seul. Sans identifiants, on ne voit que l'écran de connexion.

## La messagerie

- Un seul fil de discussion, **visible par tous les comptes connectés**.
- Pas de messages privés entre membres.
- **↩ répondre** cite un message (cliquer sur la citation y ramène).
- **☺ réagir** ajoute / retire une réaction ; on voit qui a réagi en survolant.
- **📎** joint jusqu'à 5 fichiers de 10 Mo (les images s'affichent dans le message).
- Les nouveaux messages apparaissent en direct, sans recharger la page.
- Chacun peut supprimer ses messages ; l'admin peut supprimer n'importe lequel.

## Mot de passe admin oublié

Arrête le serveur puis :

```
node reset-admin.js NouveauMotDePasse
```

## Partager le site avec tes amis (le plus simple)

Pas besoin d'hébergeur : ton ordinateur sert de serveur et un lien public temporaire est créé.

1. Installe **Node.js** (https://nodejs.org, version LTS).
2. Lance le script :
   - **Mac** : double-clique sur `DEMARRER-MAC.command`
     (si macOS refuse : clic droit > Ouvrir, puis confirme).
   - **Windows** : double-clique sur `DEMARRER-WINDOWS.bat`.
   Le script installe `cloudflared` s'il manque (Homebrew sur Mac, winget sur Windows).
3. Au premier lancement, note l'identifiant et le mot de passe **admin** affichés.
4. Un lien `https://xxxx.trycloudflare.com` s'affiche : c'est l'adresse à envoyer à tes amis.
5. Ouvre ce lien, connecte-toi en admin, clique sur **ADMIN** > **Créer un accès**,
   puis envoie à chaque ami **le lien + son identifiant + son mot de passe**.

À savoir :
- Le lien **change à chaque démarrage** : renvoie le nouveau à tes amis.
- Ton ordinateur doit rester **allumé et connecté** (et la fenêtre ouverte) pour que le site soit joignable.
- Pour tout arrêter, ferme la fenêtre : le site n'est plus accessible.
- Les comptes et messages sont conservés dans `data/` entre deux démarrages.

Pour un lien **fixe** qui marche 24 h/24, passe plutôt par un hébergeur (section suivante).

## Mettre le site en ligne 24 h/24 avec Railway

Railway héberge le site en permanence (abonnement Hobby, environ 5 $/mois, carte bancaire demandée).

1. Crée un compte sur https://github.com puis un dépôt **privé** (New repository > Private).
2. Envoie-y le contenu de ce dossier. Le fichier `.gitignore` empêche d'envoyer `data/`
   (comptes et messages) : ne l'ajoute jamais à la main.
   Sans ligne de commande : sur la page du dépôt, « Add file > Upload files » et glisse les fichiers
   (le dossier `public/` compris), **sans** le dossier `data/`.
3. Sur https://railway.com : **New Project > Deploy from GitHub repo** et choisis ton dépôt.
4. Dans le service, onglet **Variables**, ajoute :
   - `TRUST_PROXY` = `1`
   - `DATA_DIR` = `/data`
   - `ADMIN_USER` = l'identifiant admin voulu
   - `ADMIN_PASSWORD` = le mot de passe admin voulu
5. Ajoute un **Volume** (bouton « New » ou clic droit sur le canvas > Volume), attache-le au service
   et mets le **Mount path** à `/data`. Sans ça, tout est effacé à chaque redémarrage.
6. **Settings > Networking > Generate Domain** : tu obtiens ton lien fixe `https://….up.railway.app`.
7. Ouvre le lien, connecte-toi en admin, crée les accès de tes amis.
8. Une fois connecté, tu peux supprimer la variable `ADMIN_PASSWORD` de Railway : le mot de passe
   est déjà enregistré (haché) dans le site.

Pour modifier le site ensuite : change les fichiers dans GitHub, Railway redéploie tout seul.
Les données sur le volume ne sont pas touchées.

Autres hébergeurs : il faut un serveur Node.js avec **disque persistant**, du HTTPS,
`TRUST_PROXY=1`, et `DATA_DIR` pointant vers ce disque. Sauvegarde `data/` régulièrement.

## Sécurité en bref

Mots de passe hachés (scrypt), sessions par cookie `HttpOnly`/`SameSite=Strict`, blocage
après 8 mauvaises tentatives en 10 min, fichiers téléchargeables uniquement par les
membres connectés, protection CSRF, en-têtes de sécurité (CSP).

## Fichiers

| Fichier | Rôle |
|---|---|
| `server.js` | le serveur (comptes, messages, fichiers, temps réel) |
| `lib.js` | hachage des mots de passe |
| `reset-admin.js` | réinitialiser le mot de passe admin |
| `DEMARRER-MAC.command` / `DEMARRER-WINDOWS.bat` | lancent le site + créent le lien à partager |
| `public/` | l'interface (page, style, script) |
| `data/` | créé automatiquement : base de données et fichiers envoyés |
