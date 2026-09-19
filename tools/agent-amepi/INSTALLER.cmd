@echo off
rem Double-cliquez ce fichier : il lance l'installation dans une fenetre qui reste ouverte.
cd /d "%~dp0"
powershell.exe -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0installer.ps1"
