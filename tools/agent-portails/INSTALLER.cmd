@echo off
rem Double-cliquez ce fichier : installation dans une fenetre qui reste ouverte.
cd /d "%~dp0"
powershell.exe -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0installer.ps1"
