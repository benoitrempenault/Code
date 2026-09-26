@echo off
rem Fait un releve des portails tout de suite.
cd /d "%~dp0"
set NODE=node
if exist "%~dp0node-chemin.txt" set /p NODE=<"%~dp0node-chemin.txt"
"%NODE%" "%~dp0agent-portails.mjs" --forcer
pause
