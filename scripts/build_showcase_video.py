"""Author the beta.15 educational video from reviewed claims and actual CLI evidence.

Maintainer build-time deps on Windows: Pillow, pywin32 (SAPI) and imageio-ffmpeg.
This is an edited explainer, not an uncut terminal recording or a live AWS
session. The resulting H.264/AAC MP4 has spoken narration and on-screen captions.
No external media, paid voice APIs or music. Do not add this script to the
runtime npm distribution.
"""
from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from functools import lru_cache
from io import BytesIO
import wave, math, tempfile, subprocess, json, shutil, re, sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs/assets/demos"
OUT.mkdir(parents=True, exist_ok=True)
WIDTH, HEIGHT, FPS = 1152, 648, 12
BG = (9, 17, 29)
INK = (238, 247, 255)
MUTED = (168, 187, 204)
MINT = (90, 227, 184)
ORANGE = (255, 192, 126)
RED = (255, 134, 134)
MONO = Path("C:/Windows/Fonts/consola.ttf")
SEGOE = Path("C:/Windows/Fonts/segoeui.ttf")
SEGOEB = Path("C:/Windows/Fonts/seguisb.ttf")

SCENES = [
 {"title":"From bug report to proof", "tag":"WHAT DOES THE MCP ACTUALLY DO?",
  "narration":"An AI coding agent shouldn't just say a pull request looks good. It should help reproduce a bug, verify a change, and show evidence.",
  "caption":"Reproduce the failure  ·  Verify the fix  ·  Review the evidence","kind":"intro"},
 {"title":"Try it before installing Docker", "tag":"A REAL OFFLINE CLI CHECK",
  "narration":"Start with Node.js and Git. Run the offline try command. On our Windows test machine it verified seven architecture files, with zero Docker or AWS calls.",
  "caption":"7 architecture artifacts verified  ·  0 Docker calls  ·  0 AWS calls","kind":"try"},
 {"title":"One order. Two events. A bug.", "tag":"SIGNED EMULATOR / SAMPLE APPLICATION",
  "narration":"Now use local Docker for real emulator API tests. This sample order handler sends two fulfillment events for one retried order. The reviewed fix sends one.",
  "caption":"Sample app: 2 SQS messages before  →  1 message after","kind":"duplicate"},
 {"title":"A failure between services", "tag":"SYNTHETIC FAULT / REAL EMULATED STATE",
  "narration":"What happens when DynamoDB saves an order but the S3 receipt upload times out? A fragile retry loses the event. Pending-state recovery restores it.",
  "caption":"DynamoDB persisted  ·  S3 receipt failed  ·  Recovery publishes 1 event","kind":"partial"},
 {"title":"Bring your own trusted fix", "tag":"EXPLICIT LOCAL CLI ONLY",
  "narration":"You can compare two trusted Python handlers you own. Each runs in a separate isolated lab. The report checks the bug, the fix, source hashes, and cleanup.",
  "caption":"Two trusted Python handlers  ·  Two isolated labs  ·  Reviewable evidence","kind":"byoa"},
 {"title":"See risky changes before merge", "tag":"READ-ONLY SOURCE REVIEW",
  "narration":"Before approving infrastructure changes, Architecture Review can flag a DynamoDB partition key change. That's a source-level warning, not an AWS change set.",
  "caption":"Partition key: orderId  →  orderRef  ·  Flag for human review","kind":"review"},
 {"title":"Connect a local coding assistant", "tag":"MCP OVER LOCAL STDIO",
  "narration":"Generate a local MCP configuration for your coding assistant. Then ask it to run a reviewed failure test and explain the evidence, not to guess.",
  "caption":"Generate MCP config  ·  Connect editor  ·  Ask for the assertions","kind":"agent"},
 {"title":"Make green checks mean something", "tag":"CI-VERIFIED RELEASE / beta.15",
  "narration":"These reviewed scenarios passed GitHub CI with signed AWS Emulator version one point zero point four nine one. Local success does not prove AWS production parity or IAM enforcement. Your feedback helps.",
  "caption":"Hosted CI passed  ·  AWS Emulator 1.0.491  ·  NOT AWS production parity","kind":"proof"},
]

@lru_cache(maxsize=24)
def font(size, bold=False, mono=False):
    file = MONO if mono else SEGOEB if bold else SEGOE
    return ImageFont.truetype(str(file), size)

def txt(draw, at, value, size=23, color=INK, bold=False, mono=False):
    draw.text(at, str(value), font=font(size,bold,mono), fill=color)

def card(draw, box, fill=(22,38,54), outline=(59,88,105), radius=18, width=2):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)

def wrap_words(draw, value, max_width, size=24, bold=False):
    words=value.split()
    lines=[]; current=""
    for word in words:
        candidate=(current+" "+word).strip()
        if draw.textbbox((0,0),candidate,font=font(size,bold))[2] > max_width and current:
            lines.append(current); current=word
        else: current=candidate
    if current:lines.append(current)
    return lines

def line_text(draw, value, x, y, max_width, size=22, color=INK, bold=False, linegap=9):
    lines=wrap_words(draw,value,max_width,size,bold)
    for line in lines:
        txt(draw,(x,y),line,size,color,bold)
        y+=size+linegap
    return y

def pill(draw,x,y,label,color=MINT):
    w=int(draw.textbbox((0,0),label,font=font(17,True,True))[2])+40
    card(draw,(x,y,x+w,y+39),(24,56,54),(49,106,97),13,1)
    txt(draw,(x+19,y+9),label,17,color,True,True)

def render_scene(scene,index,progress):
    # Purpose-built vector-style explainer: not a fabricated terminal recording.
    im=Image.new('RGB',(WIDTH,HEIGHT),BG)
    d=ImageDraw.Draw(im)
    for y in range(HEIGHT):
        z=y/HEIGHT
        d.line((0,y,WIDTH,y),fill=(int(9+7*(1-z)),int(17+12*(1-z)),int(29+12*(1-z))))
    for x in range(45,WIDTH,50):
        for y in range(48,HEIGHT,50):
            d.ellipse((x,y,x+1,y+1),fill=(40,61,76))
    d.line((68,73,1083,73),fill=(58,85,98),width=2)
    card(d,(70,33,116,66),(21,59,55),(75,154,132),8,1)
    txt(d,(79,40),"B11",20,MINT,True)
    txt(d,(132,43),"AWS EMULATOR MCP",20,INK,True)
    txt(d,(936,43),f"{index+1:02d} / {len(SCENES):02d}",21,MUTED,True,True)
    pill(d,71,91,scene['tag'])
    shift=int(13*(1-min(progress*3,1)))
    txt(d,(70+shift,143),scene['title'],47,INK,True)
    # Stage-specific diagrams represent labeled examples or measured CI assertions.
    top,bottom=253,503
    if scene['kind']=='intro':
        for n,(title,sub) in enumerate([('REPRODUCE','What failed?'),('VERIFY','What changed?'),('EVIDENCE','What was checked?')]):
            x=72+n*345
            card(d,(x,top,x+315,bottom))
            txt(d,(x+25,top+27),f"0{n+1}",28,MINT,True,True)
            txt(d,(x+25,top+91),title,29,INK,True)
            line_text(d,sub,x+25,top+150,260,21,MUTED)
            if n<2:txt(d,(x+321,top+107),"›",38,MINT,True)
    elif scene['kind']=='try':
        card(d,(72,top,1080,bottom),(12,27,40))
        txt(d,(97,top+21),"> node bin/aws-emulator-mcp.mjs try --json",22,MINT,False,True)
        for j,(name,value) in enumerate([('"passed":','true'),('"artifactCount":','7'),('"syntheticContractSteps":','14'),('"dockerUsed":','false'),('"cloudCallsMade":','false')]):
            yy=top+74+j*34
            txt(d,(114,yy),name,21,MUTED,False,True)
            txt(d,(470,yy),value,24,MINT,True,True)
        txt(d,(770,top+103),"NO DOCKER",26,INK,True)
        txt(d,(770,top+146),"NO CLOUD CALLS",23,INK,True)
        txt(d,(770,top+190),"Windows CLI output",17,MUTED)
    elif scene['kind']=='duplicate':
        for x,title,count,tone in [(72,'BUGGY VERSION','2 messages',RED),(595,'REVIEWED FIX','1 message',MINT)]:
            card(d,(x,top,x+485,bottom))
            txt(d,(x+25,top+28),title,22,MUTED,True,True)
            txt(d,(x+25,top+82),count,52,tone,True)
            txt(d,(x+25,top+156),"same logical order retried",19,INK)
            txt(d,(x+25,top+204),"DynamoDB  ·  S3  ·  SQS",19,MUTED,False,True)
        txt(d,(558,top+98),"→",40,MINT,True)
    elif scene['kind']=='partial':
        for x,title,sub,color in [(72,'DynamoDB','order saved',MINT),(420,'S3','receipt timeout',ORANGE),(768,'SQS','event pending',MUTED)]:
            card(d,(x,top,x+313,top+145))
            txt(d,(x+20,top+21),title,27,INK,True)
            txt(d,(x+20,top+75),sub,22,color,True)
        txt(d,(390,top+54),"→",29,MINT,True);txt(d,(738,top+54),"→",29,MINT,True)
        card(d,(72,top+170,1080,bottom),(18,55,49),(60,144,105),14)
        txt(d,(94,top+198),"PENDING-STATE RETRY",24,MINT,True)
        txt(d,(94,top+229),"Receipt restored  ·  one fulfillment event published",20,INK)
    elif scene['kind']=='byoa':
        for x,title,mark,color,sub in [(72,'buggy.py','BUG REPRODUCED',RED,'2 accepted / 2 messages'),(595,'fixed.py','FIX VERIFIED',MINT,'1 accepted / 1 message')]:
            card(d,(x,top,x+485,bottom))
            txt(d,(x+23,top+24),title,26,INK,True,True)
            txt(d,(x+23,top+91),mark,24,color,True)
            txt(d,(x+23,top+143),sub,21,MUTED)
            txt(d,(x+23,top+199),"SHA-256 + cleanup checks",20,INK,False,True)
    elif scene['kind']=='review':
        card(d,(72,top,1080,bottom))
        txt(d,(102,top+26),"DynamoDB table partition key",25,INK,True)
        txt(d,(105,top+102),"orderId",38,MUTED,True,True)
        txt(d,(330,top+103),"→",40,MINT,True)
        txt(d,(421,top+102),"orderRef",38,ORANGE,True,True)
        card(d,(730,top+70,1048,top+166),(70,49,35),(130,90,54),11)
        txt(d,(749,top+86),"HUMAN REVIEW",20,ORANGE,True)
        txt(d,(749,top+119),"potentially breaking",17,INK)
        txt(d,(102,top+200),"Source blueprint comparison — no AWS deployment",20,MUTED)
    elif scene['kind']=='agent':
        card(d,(72,top,1080,bottom),(12,27,40))
        txt(d,(98,top+30),"> node bin/aws-emulator-mcp.mjs config copilot",21,MINT,False,True)
        txt(d,(104,top+88),'"aws-emulator-local": {',24,MUTED,False,True)
        txt(d,(136,top+132),'"type": "stdio",',23,INK,False,True)
        txt(d,(136,top+176),'"args": [".../aws-emulator-mcp.mjs", "mcp"]',20,INK,False,True)
        txt(d,(104,top+215),'}',23,MUTED,False,True)
    else:
        for j,(label,value) in enumerate([('WINDOWS + LINUX','PASS'),('OFFICIAL MCP SDK CLIENTS','PASS'),('SIGNED AWS EMULATOR','1.0.491')]):
            y=top+j*85;card(d,(72,y,1080,y+70))
            txt(d,(100,y+18),label,24,INK,True)
            txt(d,(832,y+18),value,24,MINT,True,True)
    card(d,(69,546,1084,610),(14,36,47),(59,89,105),12,1)
    line_text(d,scene['caption'],90,563,957,20,INK,True,5)
    d.rectangle((70,625,1080,629),fill=(35,55,66))
    d.rectangle((70,625,70+int(1010*min(progress,1)),629),fill=MINT)
    txt(d,(73,631),"Edited explainer · real CLI / CI evidence linked · not a live terminal recording",12,MUTED)
    return im

def make_audio(folder):
    import win32com.client
    speaker=win32com.client.Dispatch("SAPI.SpVoice")
    voices=speaker.GetVoices()
    speaker.Voice=voices.Item(1) if voices.Count>1 else voices.Item(0)
    speaker.Rate=1
    waves=[];duration=[]
    for i,scene in enumerate(SCENES):
        file=folder / ("voice-%02d.wav"%i)
        output=win32com.client.Dispatch("SAPI.SpFileStream")
        output.Open(str(file.resolve()),3,False)
        speaker.AudioOutputStream=output
        speaker.Speak(scene["narration"])
        output.Close()
        with wave.open(str(file),"rb") as w:
            fmt=(w.getnchannels(),w.getsampwidth(),w.getframerate())
            if i==0: standard=fmt
            assert fmt==standard,(fmt,standard)
            data=w.readframes(w.getnframes())
            waves.append(data)
            duration.append(len(data)//(fmt[0]*fmt[1]))
    rate=standard[2]
    pause=int(rate*.7)
    totalframes=0
    with wave.open(str(folder/"narration.wav"),"wb") as w:
        w.setnchannels(standard[0]);w.setsampwidth(standard[1]);w.setframerate(rate)
        for raw,n in zip(waves,duration):
            w.writeframes(raw)
            w.writeframes(b"\x00"*pause*standard[0]*standard[1])
            totalframes+=n+pause
    return [n/rate+.7 for n in duration],folder/"narration.wav",totalframes/rate

def encode_video(durations,voice_file):
    import imageio_ffmpeg
    ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    target=OUT/"proof-first-beta15.mp4"
    cmd=[ffmpeg,"-y","-loglevel","error",
         "-f","rawvideo","-pix_fmt","rgb24","-s",str(WIDTH)+"x"+str(HEIGHT),
         "-r",str(FPS),"-i","pipe:0","-i",str(voice_file),
         "-c:v","libx264","-preset","ultrafast","-crf","25",
         "-pix_fmt","yuv420p","-c:a","aac","-b:a","112k",
         "-movflags","+faststart","-shortest",str(target)]
    process=subprocess.Popen(cmd,stdin=subprocess.PIPE,stderr=subprocess.PIPE)
    frames=0
    try:
        for idx,(scene,dur) in enumerate(zip(SCENES,durations)):
            count=round(dur*FPS)
            print("RENDER_SCENE",idx+1,scene["kind"],"frames",count,flush=True)
            base=render_scene(scene,idx,0.9)
            for i in range(count):
                im=base.copy()
                d=ImageDraw.Draw(im)
                d.rectangle((70,625,70+int(1010*(i+1)/count),629),fill=MINT)
                # Small scene-change fade; the content is explanatory, not a screen recording.
                if i<3 or i>count-4:
                    alpha=min(1,(i+1)/4,(count-i)/4)
                    if alpha<1:
                        im=Image.blend(Image.new("RGB",(WIDTH,HEIGHT),BG),im,alpha)
                process.stdin.write(im.tobytes())
                frames+=1
        process.stdin.close()
        error=process.stderr.read().decode("utf8","replace")
        rc=process.wait(timeout=45)
        if rc!=0:raise RuntimeError("ffmpeg exit "+str(rc)+": "+error[-1000:])
    finally:
        if process.poll() is None:process.kill()
    if not target.exists() or target.stat().st_size<150000:raise RuntimeError("Video too small or missing")
    render_scene(SCENES[0],0,.6).save(OUT/"proof-first-beta15-poster.jpg",quality=89,optimize=True)
    selected=[render_scene(SCENES[i],i,1).resize((576,324)) for i in (0,1,2,3,5,7)]
    selected[0].save(OUT/"proof-first-beta15-preview.gif",save_all=True,
                     append_images=selected[1:],duration=750,loop=0,optimize=True)
    print("VIDEO_READY",target,target.stat().st_size,"bytes",frames,"frames",flush=True)
    return target

def transcript(durations,total):
    lines=["# AWS Emulator MCP beta.15 narrated demo", "",
           "**Format:** edited explanatory video with Windows SAPI narration and scene captions.",
           "**Evidence:** beta.15 offline CLI output, GitHub hosted CI run [44102711476](https://github.com/B11-Health/aws-emulator-mcp/actions/runs/44102711476), and reviewed example source.",
           "**Important:** not an uncut recording or an AWS compatibility certification.",""]
    t=0
    for i,(scene,dur) in enumerate(zip(SCENES,durations)):
        lines.extend(["## Scene "+str(i+1)+" · "+scene["title"]+" ("+str(round(t,1))+"s)",
                      "Narration: "+scene["narration"],"Caption: "+scene["caption"],""])
        t+=dur
    lines.extend(["**Total runtime:** approximately "+str(round(total))+" seconds.",
                  "No AWS account, external speech provider or copyrighted music was used to make this explainer.",
                  "","**Reproduce commands and limitations:** [Demo studio](index.html), [Onboarding](ONBOARDING.md), [Failure Lab](FAILURE_LAB.md).",""])
    (ROOT/"docs/SHOWCASE_TRANSCRIPT.md").write_text("\n".join(lines),encoding="utf8")
    def stamp(t):
        millis=round(t*1000)
        return f"{millis//3600000:02d}:{millis//60000%60:02d}:{millis//1000%60:02d}.{millis%1000:03d}"
    cues=["WEBVTT",""]
    elapsed=0
    for scene,dur in zip(SCENES,durations):
        words=scene["narration"].split()
        chunks=3 if len(words)>33 else 2
        for j in range(chunks):
            start=elapsed+j*dur/chunks
            end=elapsed+(j+1)*dur/chunks
            text=" ".join(words[round(j*len(words)/chunks):round((j+1)*len(words)/chunks)])
            cues.extend([stamp(start)+" --> "+stamp(end),text,""])
        elapsed+=dur
    (OUT/"proof-first-beta15.vtt").write_text("\n".join(cues),encoding="utf8")

def make_short_clips(video, durations):
    """Short standalone clips from the fully narrated source, never staged output."""
    import imageio_ffmpeg
    ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
    variants=[
      ("quickstart",1,2),
      ("reliability",2,4),
      ("source-review",4,6),
      ("connect-agent",6,7),
    ]
    for name,start,end in variants:
        offset=sum(durations[:start])
        length=sum(durations[start:end])
        out=OUT/("beta15-"+name+"-demo.mp4")
        cmd=[ffmpeg,"-y","-loglevel","error","-ss",str(offset),
             "-i",str(video),"-t",str(length),"-c:v","libx264",
             "-preset","ultrafast","-crf","27","-pix_fmt","yuv420p",
             "-c:a","aac","-b:a","96k","-movflags","+faststart",str(out)]
        result=subprocess.run(cmd,capture_output=True,text=True,timeout=90)
        if result.returncode!=0:raise RuntimeError(name+": "+result.stderr[-500:])
        if out.stat().st_size<30000:raise RuntimeError("Short clip too small")
        render_scene(SCENES[start],start,.9).save(
            OUT/("beta15-"+name+"-poster.jpg"),quality=88,optimize=True)
        print("SHORT_CLIP_READY",out.name,out.stat().st_size,flush=True)

def main():
    with tempfile.TemporaryDirectory(prefix="aws-mcp-voice-") as temp:
        durations,audio,total=make_audio(Path(temp))
        print("VOICE_DURATION_SEC",round(total,2),flush=True)
        target=encode_video(durations,audio)
        make_short_clips(target,durations)
        transcript(durations,total)
    print("COMPLETE",target,flush=True)

if __name__=="__main__":main()
