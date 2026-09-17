# backend/main.py
import os
import time
import asyncio
from pathlib import Path
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from typing import List

app = FastAPI(title="ChildVideoFilter Backend")

# 上傳目錄（使用絕對路徑避免工作目錄問題）
UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# 靜態檔案服務：http://localhost:8000/uploads/...
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# CORS 允許 Chrome Extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["chrome-extension://*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/api/upload-frames")
async def upload_frames(
    video_id: str = Form(...),
    frames: List[UploadFile] = File(...),
    sample_indices: str = Form(default="[]"),
):
    """
    接收前端傳來的 blob 圖片並儲存
    - video_id: 影片 ID
    - frames: 圖片檔案列表 (multipart/form-data)
    - sample_indices: 採樣索引 JSON 字串
    
    回傳:
    - frame_urls: 可直接存取的公開 URL 陣列
    """
    timestamp = int(time.time())
    video_dir = UPLOAD_DIR / video_id
    video_dir.mkdir(exist_ok=True)
    
    frame_urls = []
    results = []
    
    for i, frame in enumerate(frames):
        content = await frame.read()
        
        # 儲存檔案
        filename = f"{timestamp}_{i}.jpg"
        filepath = video_dir / filename
        filepath.write_bytes(content)
        
        # 公開 URL
        url = f"/uploads/{video_id}/{filename}"
        frame_urls.append(url)
        
        print(f"Saved frame {i}: {filepath}, size: {len(content)} bytes")
        
        results.append({
            "index": i,
            "filename": filename,
            "size": len(content),
            "content_type": frame.content_type,
            "url": url,
        })
    
    return {
        "success": True,
        "video_id": video_id,
        "received_count": len(frames),
        "frame_urls": frame_urls,
        "frames": results,
    }

@app.get("/health")
async def health():
    return {"status": "ok"}

# ===== 背景清理任務：1小時前的檔案 =====
async def cleanup_old_uploads():
    """每小時清理超過 1 小時的上傳目錄"""
    while True:
        await asyncio.sleep(3600)  # 1小時
        now = time.time()
        try:
            for video_dir in UPLOAD_DIR.iterdir():
                if not video_dir.is_dir():
                    continue
                # 檢查目錄最新檔案時間
                latest_mtime = 0
                for f in video_dir.iterdir():
                    if f.is_file():
                        latest_mtime = max(latest_mtime, f.stat().st_mtime)
                # 超過 1小時且無新檔案
                if now - latest_mtime > 3600:
                    for f in video_dir.iterdir():
                        f.unlink(missing_ok=True)
                    video_dir.rmdir()
                    print(f"Cleaned up old upload dir: {video_dir}")
        except Exception as e:
            print(f"Cleanup error: {e}")

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cleanup_old_uploads())
    print("Backend started, cleanup task running")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)