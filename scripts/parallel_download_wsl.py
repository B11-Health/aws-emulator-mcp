#!/usr/bin/env python3
"""Resume the official AWS Emulator package using parallel verified HTTP ranges."""
import concurrent.futures
import json
import os
import pathlib
import re
import shutil
import sys
import time
import urllib.request

BASE = pathlib.Path.home() / ".local/share/aws-emulator-mcp"
TARGET = BASE / "aws-emulator.deb"
PARTDIR = BASE / "parts"
STATE = PARTDIR / "state.json"
URL = "https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator_amd64.deb"
TOTAL = 170_938_884
N = 12
DEADLINE = time.monotonic() + 35

def init():
    PARTDIR.mkdir(parents=True, exist_ok=True)
    if STATE.exists():
        return json.loads(STATE.read_text())
    prefix = TARGET.stat().st_size if TARGET.exists() else 0
    if prefix >= TOTAL:
        return {"prefix": TOTAL, "ranges": []}
    ranges = []
    for i in range(N):
        a = prefix + ((TOTAL-prefix)*i)//N
        b = prefix + ((TOTAL-prefix)*(i+1))//N-1
        ranges.append([a,b])
    cfg={"prefix":prefix,"ranges":ranges}
    STATE.write_text(json.dumps(cfg))
    return cfg

def worker(args):
    i,a,b = args
    dest=PARTDIR/f"part-{i:02d}"
    length=b-a+1
    if not length: return (i,0,None)
    sofar=dest.stat().st_size if dest.exists() else 0
    if sofar>=length: return (i,length,None)
    if time.monotonic()>DEADLINE: return (i,sofar,None)
    req=urllib.request.Request(URL,headers={"Range":f"bytes={a+sofar}-{b}","User-Agent":"aws-emulator-mcp-local-installer/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            content_range = response.headers.get("Content-Range","")
            if response.status != 206 or not content_range.startswith(f"bytes {a+sofar}-{b}/"):
                return (i,sofar,f"unexpected HTTP {response.status} {content_range}")
            with dest.open("ab") as f:
                while time.monotonic()<DEADLINE:
                    chunk=response.read(min(128*1024,length-sofar))
                    if not chunk: break
                    f.write(chunk)
                    sofar+=len(chunk)
                    if sofar>=length: break
        return (i,sofar,None)
    except Exception as e:
        return (i,sofar,str(e)[:140])

def main():
    cfg=init()
    if not cfg["ranges"]:
        print("download_complete",TARGET.stat().st_size);return 0
    tasks=[(i,*r) for i,r in enumerate(cfg["ranges"])]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(worker,tasks))
    got=cfg["prefix"]+sum((PARTDIR/f"part-{i:02d}").stat().st_size if (PARTDIR/f"part-{i:02d}").exists() else 0 for i in range(len(tasks)))
    print(json.dumps({"got":got,"total":TOTAL,"percent":round(100*got/TOTAL,2),"errors":[[i,e] for i,_,e in results if e]},indent=2))
    if got<TOTAL:return 1
    merged=BASE/"aws-emulator.complete.deb"
    with merged.open("wb") as out:
        with TARGET.open("rb") as original:
            shutil.copyfileobj(original,out,1024*1024)
        for i in range(len(tasks)):
            with (PARTDIR/f"part-{i:02d}").open("rb") as part:
                shutil.copyfileobj(part,out,1024*1024)
    if merged.stat().st_size!=TOTAL: raise RuntimeError("size mismatch")
    os.replace(merged,TARGET)
    print("complete_verified_size",TARGET.stat().st_size)
    return 0

if __name__=="__main__": sys.exit(main())
