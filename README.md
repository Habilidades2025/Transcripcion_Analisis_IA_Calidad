# IA Analista de Calidad (Faster-Whisper + OpenAI)

Flujo: subes **matriz.xlsx** + **audio** → **transcribe** con Faster-Whisper (local) → **analiza** con OpenAI usando la matriz → devuelve **informe** + **nota** → guarda histórico y consolidado → UI web para ver todo.

## Requisitos
- **Node.js 20+** (o 22)
- **Python 3.9+** y **ffmpeg** para Faster-Whisper
- Conexión a OpenAI para el análisis

## 1) Microservicio Faster-Whisper (Python)
```bat
cd fw-server
py -m venv venv
.env\Scriptsctivate
pip install --upgrade pip
pip install faster-whisper fastapi uvicorn python-multipart

set FW_MODEL=small
set FW_DEVICE=auto
set FW_COMPUTE=auto
python fw_server.py
```
Verás `Uvicorn running on http://0.0.0.0:8000`.

Smoke test:
```bat
curl http://127.0.0.1:8000/transcribe -X POST ^
  -F "file=@C:\ruta\llamada.mp3" ^
  -F "language=es"
```

## 2) Backend Node
```bat
copy .env.example .env
npm install
npm run dev
```
Abre `http://127.0.0.1:3000/`

### Endpoints
- `GET /` — UI simple
- `GET /health`
- `POST /transcribe` — prueba SOLO transcripción (multipart: `audio`, `language` opcional)
- `POST /analyze` — **matriz + audio** → transcribe (FW) + analiza (OpenAI)
- `GET /audits` — auditorías guardadas
- `GET /audits/summary` — consolidado global
- `GET /audits/export.json` — export completo
- `GET /diagnostics/openai` — lista modelos (prueba API)
- `GET /diagnostics/chat` — mini-chat (prueba análisis)

## 3) Variables (.env)
Por defecto ya usa Faster-Whisper:
```
TRANSCRIBE_PROVIDER=faster
FW_SERVER_URL=http://127.0.0.1:8000/transcribe
OPENAI_API_KEY=sk-...
OPENAI_CHAT_MODEL=gpt-4o-mini
```
> Usa **127.0.0.1**, no `localhost`, para evitar IPv6 en Windows.

## 4) Tips
- Si tu red corporativa bloquea OpenAI: usa `NODE_EXTRA_CA_CERTS` o configura proxy.
- Para pruebas sin audio, `SKIP_TRANSCRIPTION=1` y usa `/analyze` con campo `transcript`.
- CPU: prueba `FW_MODEL=base` o `small` + `FW_COMPUTE=int8`; GPU: `FW_DEVICE=cuda` + `FW_COMPUTE=float16`.
