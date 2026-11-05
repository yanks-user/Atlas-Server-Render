@echo off
rem Serveur TACNET sous Windows, sans Docker : double-clic pour demarrer, fermez la fenetre pour arreter.
rem (Fichier volontairement sans accents : l'affichage de cmd depend de la page de codes de Windows.)
rem Pour les essais automatiques : TACNET_SANS_PAUSE=1 supprime les pauses et l'ouverture du Bloc-notes.
setlocal
cd /d "%~dp0"
title Serveur TACNET
rem Le journal du serveur est en UTF-8 : sans cela, la fenetre affiche mal les accents.
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js n'est pas installe sur ce PC.
  echo Installez la version LTS depuis https://nodejs.org puis relancez ce fichier.
  call :attendre
  exit /b 1
)

if not exist "node_modules" (
  echo Premier lancement : installation des composants du serveur ^(une minute, internet necessaire^)...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo L'installation a echoue. Verifiez la connexion internet puis relancez ce fichier.
    call :attendre
    exit /b 1
  )
)

if not exist "config.env" (
  copy /y "config.env.example" "config.env" >nul
  echo.
  echo Le fichier config.env vient d'etre cree.
  echo Remplissez la ligne SERVER_PASSWORD ^(8 caracteres minimum^), enregistrez, fermez le Bloc-notes, puis relancez ce fichier.
  if not defined TACNET_SANS_PAUSE start "" notepad "config.env"
  call :attendre
  exit /b 0
)

echo Serveur TACNET : laissez cette fenetre ouverte pendant les parties, fermez-la pour arreter le serveur.
echo.
node src\index.js
set "code=%errorlevel%"
echo.
echo Le serveur s'est arrete ^(voir le message ci-dessus^).
call :attendre
exit /b %code%

:attendre
if not defined TACNET_SANS_PAUSE pause
exit /b 0
