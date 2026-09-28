@echo off
rem Ouvre Edge : allez jusqu'aux statistiques de vos annonces sur chaque portail, puis fermez Edge.
cd /d "%~dp0"
set NODE=node
if exist "%~dp0node-chemin.txt" set /p NODE=<"%~dp0node-chemin.txt"
"%NODE%" "%~dp0agent-portails.mjs" apprendre
pause
