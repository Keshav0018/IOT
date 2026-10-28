import uvicorn

from .config import settings

if __name__ == "__main__":
    print(f"PostureGuard → http://localhost:{settings.port}  (source={settings.source}, mode={settings.mode})")
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, log_level="info")
