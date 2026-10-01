@echo off
chcp 65001 >nul
rem 在 Windows 上把程序打包成单个 exe，结果在 dist 文件夹
cd /d "%~dp0"
python -m pip install --upgrade pyinstaller || goto :error
python -m unittest discover -s tests || goto :error
python -m PyInstaller --noconfirm --onefile --windowed --name CaseTracker run.pyw || goto :error
echo.
echo 打包完成：dist\CaseTracker.exe
pause
exit /b 0
:error
echo 打包失败，请查看上面的错误信息。
pause
exit /b 1
