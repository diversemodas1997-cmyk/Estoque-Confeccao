@echo off
REM ============================================================
REM  Controle de Estoque - Confeccao
REM  Abre o programa no navegador padrao do Windows
REM ============================================================
title Controle de Estoque - Confeccao

if not exist "%~dp0index.html" (
    echo.
    echo ERRO: arquivo index.html nao encontrado.
    echo.
    echo Verifique se voce extraiu o ZIP corretamente e se o
    echo arquivo "index.html" esta na mesma pasta deste script.
    echo.
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo    Controle de Estoque - Confeccao
echo  ============================================================
echo.
echo  Abrindo o programa no seu navegador...
echo.

start "" "%~dp0index.html"

REM A janela fecha automaticamente apos 2 segundos
timeout /t 2 /nobreak >nul
exit
