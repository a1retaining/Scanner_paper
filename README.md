# TradeBot Backend v23

Render:
- Build Command: npm install
- Start Command: npm start
- Root Directory: the folder containing package.json

Routes:
- /api/health
- /api/scan?mode=swing&symbols=SPY,QQQ,NVDA,TSLA,AAPL,COST&risk=100
- /api/discover?risk=100&limit=10
- /api/bars?symbol=NVDA&range=1y&interval=1d
- /api/keepalive

Keeping awake:
The HTML pings /api/keepalive every 4 minutes while the scanner page is open.
If nobody has the scanner page open, free Render can still sleep. To stop that, use Render paid or a free uptime monitor like UptimeRobot, Better Stack, or cron-job.org to ping /api/keepalive every 5 minutes.
