import asyncio, certifi, json, subprocess, os, hashlib
certifi.where = lambda: '/root/.ccr/ca-bundle.crt'
import edge_tts
from script import SCENES
VOICE = os.environ.get('VOICE', 'zh-HK-HiuMaanNeural')
os.makedirs('audio', exist_ok=True)
async def main():
    out = []
    for si, (title, beats) in enumerate(SCENES):
        for bi, (say, scr) in enumerate(beats):
            h = hashlib.md5((VOICE + say).encode()).hexdigest()[:10]
            f = f'audio/{h}.mp3'
            if not os.path.exists(f) or os.path.getsize(f) == 0:
                for t in range(3):
                    try: await edge_tts.Communicate(say, VOICE, rate='+0%').save(f); break
                    except Exception as e: print('retry', e)
            d = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]))
            out.append({'s': si, 'b': bi, 'f': f, 'dur': d})
    json.dump(out, open('audio/index.json', 'w'), indent=1)
    print(sum(x['dur'] for x in out))
asyncio.run(main())
