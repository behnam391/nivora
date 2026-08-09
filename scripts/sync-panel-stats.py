#!/usr/bin/env python3
import json, os, sqlite3, tempfile, time
source=os.environ.get("XUI_DB_PATH","/etc/x-ui/x-ui.db")
target=os.environ.get("PANEL_STATS_PATH","/opt/nivora/data/panel-stats.json")
db=sqlite3.connect(f"file:{source}?mode=ro",uri=True); db.row_factory=sqlite3.Row
rows=db.execute("SELECT email,up,down,total,expiry_time,last_online,enable FROM client_traffics WHERE email IS NOT NULL").fetchall()
now=int(time.time()*1000)
result={r["email"]:{"upBytes":r["up"] or 0,"downBytes":r["down"] or 0,"totalBytes":r["total"] or 0,"expiryTime":r["expiry_time"] or 0,"lastOnline":r["last_online"] or None,"enabled":bool(r["enable"]),"syncedAt":now} for r in rows}
os.makedirs(os.path.dirname(target),exist_ok=True)
fd,temp=tempfile.mkstemp(prefix="panel-stats-",dir=os.path.dirname(target),text=True)
with os.fdopen(fd,"w",encoding="utf-8") as out: json.dump(result,out,separators=(",",":"))
os.chmod(temp,0o640); os.replace(temp,target)
