@chcp 65001>nul
@echo off
rem UTF-8 console first: task prompts and produced file names are Chinese, and the OEM code page
rem turns them into mojibake in this process's own log.
node "%~dp0dist\main.js" %*
