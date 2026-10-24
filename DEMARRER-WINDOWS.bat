@echo off
cd /d "%~dp0"
title PROJET ZER0
set TRUST_PROXY=1

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js n'est pas installe. Telecharge-le ici : https://nodejs.org ^(version LTS^)
  echo  puis relance ce fichier.
  pause
  exit /b 1
)

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo  'cloudflared' ^(l'outil qui cree le lien public^) n'est pas installe. Installation...
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements
  echo.
  echo  Si l'installation a reussi, FERME cette fenetre et relance DEMARRER-WINDOWS.bat.
  pause
  exit /b 1
)

echo.
echo  Demarrage du site... Deux fenetres vont s'ouvrir.
echo  - La fenetre "Site" : NE LA FERME PAS ^(elle affiche aussi ton mot de passe admin au premier lancement^).
echo  - La fenetre "Lien" : cherche l'adresse en https://....trycloudflare.com, c'est le lien pour tes amis.
echo  - Ce lien change a chaque demarrage, et ton PC doit rester allume.
echo.
start "Site" cmd /k node server.js
timeout /t 3 /nobreak >nul
start "Lien" cmd /k cloudflared tunnel --url http://localhost:3000
