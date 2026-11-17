@echo off
rem Note dans agent-portails.log la duree de vie des cookies des portails (jamais leur valeur).
rem A lancer juste apres CONNECTER.cmd, puis le lendemain matin : on voit ce qui a expire.
cd /d "%~dp0"
set NODE=node
if exist "%~dp0node-chemin.txt" set /p NODE=<"%~dp0node-chemin.txt"
"%NODE%" "%~dp0agent-portails.mjs" diagnostic
pause
