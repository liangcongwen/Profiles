@echo off
chcp 65001 >nul
rem 用本机 Python 直接运行（需要已安装 Python 3.8 以上版本）
cd /d "%~dp0"
start "" pythonw run.pyw
