@echo off
rem Ouvre Edge (profil de l'agent) : connectez-vous aux 3 portails puis fermez Edge.
cd /d "%~dp0"
set NODE=node
if exist "%~dp0node-chemin.txt" set /p NODE=<"%~dp0node-chemin.txt"
"%NODE%" "%~dp0agent-portails.mjs" connecter
pause
