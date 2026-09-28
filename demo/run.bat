@echo off
:: Run SSD Tick against socialmedia-mock on the Nightly tablets and Windows Firefox.
:: Extra arguments pass through, e.g.  run.bat --only android   run.bat --serial SERIAL-1
cd /d "%~dp0.."
if exist .venv\Scripts\activate.bat call .venv\Scripts\activate.bat
python demo\tick_run.py %*
