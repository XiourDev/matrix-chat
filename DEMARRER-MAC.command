#!/bin/bash
# Double-clique sur ce fichier : le site démarre et un lien public est créé pour tes amis.
cd "$(dirname "$0")"
export TRUST_PROXY=1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo " Node.js n'est pas installe. Telecharge-le ici : https://nodejs.org (version LTS), puis relance ce fichier."
  read -n 1 -s -r -p " Appuie sur une touche pour fermer..."; exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  echo
  echo " 'cloudflared' (l'outil qui cree le lien public) n'est pas installe."
  if command -v brew >/dev/null 2>&1; then
    echo " Installation automatique avec Homebrew..."
    brew install cloudflared || { echo " Echec. Voir le LISEZMOI.md"; read -n 1 -s -r -p " Touche pour fermer..."; exit 1; }
  else
    echo " Ouvre le Terminal et tape :  brew install cloudflared"
    echo " (Homebrew : https://brew.sh si la commande 'brew' n'existe pas)"
    read -n 1 -s -r -p " Puis relance ce fichier. Appuie sur une touche pour fermer..."; exit 1
  fi
fi

echo
echo " Demarrage du site..."
echo " Pour tout arreter, ferme cette fenetre."
echo

node server.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT
sleep 3

# Lance le tunnel et affiche le lien de facon bien visible des qu'il apparait
cloudflared tunnel --url http://localhost:3000 2>&1 | while IFS= read -r line; do
  url=$(printf '%s' "$line" | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1)
  if [ -n "$url" ]; then
    echo
    echo " ============================================================"
    echo "  LIEN A ENVOYER A TES AMIS :"
    echo "  $url"
    echo " ============================================================"
    echo "  (ce lien change a chaque demarrage ; ton Mac doit rester allume)"
    echo
    printf '%s' "$url" | pbcopy 2>/dev/null && echo "  -> Lien copie dans ton presse-papiers."
  fi
done
