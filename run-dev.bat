@echo off
REM Lanza el servidor de Faster-Whisper y la API Node en dos ventanas

REM === Ventana 1: FW microservice ===
start "FW" cmd /k "cd /d %~dp0fw-server && (if exist venv\Scripts\activate (call venv\Scripts\activate) else (py -m venv venv && call venv\Scripts\activate && pip install --upgrade pip && pip install faster-whisper fastapi uvicorn python-multipart)) && set FW_MODEL=small && set FW_DEVICE=auto && set FW_COMPUTE=auto && python fw_server.py"

REM === Ventana 2: API ===
start "API" cmd /k "cd /d %~dp0 && (if exist node_modules (echo node_modules presente) else (npm install)) && npm run dev"
