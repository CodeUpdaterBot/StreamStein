YouTube Downloader Bridge (Local)

What this is
- A small Node server that resolves a YouTube URL and streams the best combined (video+audio) format back to the browser.
- The Chrome extension calls this at http://127.0.0.1:8789/api/download to start a real .mp4 download via the Downloads API.

Requirements
- Node.js 20+ recommended.

Setup
1) Open a terminal in this folder:
   cd yt-saver-bridge

2) Install deps:
   npm install

3) Start the server:
   npm start

4) Optional health check:
   curl http://127.0.0.1:8789/api/ping

Download test (from a terminal)
curl -X POST http://127.0.0.1:8789/api/download ^
  -H "Content-Type: application/json" ^
  -d "{\"url\":\"https://www.youtube.com/watch?v=dQw4w9WgXcQ\"}" ^
  --output test.mp4

Notes
- This bridge uses youtubei.js to handle YouTube’s InnerTube API and deciphering. Some videos may require additional SABR handling. If you run into cases that fail, keep the library up to date, or extend the server to use @luanrt/googlevideo’s SABR flow as a fallback.
- Keep usage within YouTube’s TOS and your local laws.


