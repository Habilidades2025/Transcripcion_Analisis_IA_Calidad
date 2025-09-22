from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from faster_whisper import WhisperModel
import uvicorn, os, tempfile, shutil, time

MODEL_NAME = (os.getenv("FW_MODEL", "small") or "small").strip()
DEVICE     = (os.getenv("FW_DEVICE", "auto") or "auto").strip()
COMPUTE    = (os.getenv("FW_COMPUTE", "auto") or "auto").strip()

# ... (auto-detección de DEVICE/COMPUTE si la tienes)

app = FastAPI(title="faster-whisper server")
model = None

def get_model():
  global model
  if model is None:
    print(f"[FW] Cargando modelo: {MODEL_NAME} ({DEVICE}/{COMPUTE})")
    model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE)
    print("[FW] Modelo cargado")
  return model

# PRELOAD opcional
PRELOAD = (os.getenv("FW_PRELOAD", "1") == "1")
if PRELOAD:
  _ = get_model()  # fuerza la carga al iniciar el server

@app.get("/health")
async def health():
  return {"ok": True, "model": MODEL_NAME, "device": DEVICE, "compute": COMPUTE}

@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: str = Form(default="es")):
  tmpdir = tempfile.mkdtemp(prefix="fw_")
  t0 = time.time()
  try:
    audio_path = os.path.join(tmpdir, file.filename)
    with open(audio_path, "wb") as f:
      f.write(await file.read())
    m = get_model()
    segments, info = m.transcribe(audio_path, language=language or None)
    text = "".join(s.text for s in segments).strip()
    elapsed = round(time.time() - t0, 2)
    return JSONResponse({"ok": True, "language": info.language, "duration": info.duration, "text": text, "elapsed": elapsed})
  except Exception as e:
    return JSONResponse({"ok": False, "error": str(e)}, status_code=500)
  finally:
    shutil.rmtree(tmpdir, ignore_errors=True)
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("fw_server:app", host="0.0.0.0", port=8000)
