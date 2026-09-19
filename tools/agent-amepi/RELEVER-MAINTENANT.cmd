@echo off
rem Double-cliquez ce fichier pour faire un releve AMEPI tout de suite (fenetre qui reste ouverte).
cd /d "%~dp0"
powershell.exe -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0agent-amepi.ps1"
