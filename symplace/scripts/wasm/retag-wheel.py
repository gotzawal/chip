"""휠의 ABI 태그를 Pyodide 0.27 이 기대하는 이름으로 바꾼다.

pyodide-build 0.39 는 새 표기(pyemscripten_2024_0_wasm32)로 포장하는데
Pyodide 0.27.8 의 micropip 은 옛 표기(emscripten_3_1_58_wasm32)만 받는다.
    ValueError: Wheel was built with Emscripten vpyemscripten.2024.0
                but Pyodide was built with Emscripten v3.1.58

안의 .so 는 0.27.8 xbuildenv 로 빌드한 것이라 ABI 자체는 맞다. 표기만 바꾼다.
(ABI 가 실제로 다르면 import 에서 걸리므로, 이름만 고치고 넘어가는 눈속임은 아니다)

사용법:  python3 retag-wheel.py <휠파일> <새태그>
    예:  python3 retag-wheel.py dist/x.whl emscripten_3_1_58_wasm32
"""
import io
import os
import shutil
import sys
import zipfile

src = sys.argv[1]
newabi = sys.argv[2] if len(sys.argv) > 2 else "emscripten_3_1_58_wasm32"

name = os.path.basename(src)
parts = name[:-4].split("-")          # name-ver-py-abi-plat
if len(parts) < 5:
    print("휠 이름을 못 읽겠다: %s" % name)
    sys.exit(1)
parts[-1] = newabi
out = os.path.join(os.path.dirname(src), "-".join(parts) + ".whl")

tmp = src + ".unpack"
shutil.rmtree(tmp, ignore_errors=True)
with zipfile.ZipFile(src) as z:
    z.extractall(tmp)

# WHEEL 파일의 Tag: 줄도 같이 고쳐야 한다
changed = 0
for root, _, files in os.walk(tmp):
    for f in files:
        if f != "WHEEL":
            continue
        p = os.path.join(root, f)
        s = io.open(p, encoding="utf8").read()
        lines = []
        for ln in s.splitlines():
            if ln.startswith("Tag:"):
                tag = ln.split(":", 1)[1].strip().split("-")
                tag[-1] = newabi
                ln = "Tag: " + "-".join(tag)
                changed += 1
            lines.append(ln)
        io.open(p, "w", encoding="utf8").write("\n".join(lines) + "\n")

if not changed:
    print("경고: WHEEL 의 Tag: 를 못 찾았다")

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(tmp):
        for f in files:
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, tmp))
shutil.rmtree(tmp, ignore_errors=True)
print("  %s -> %s (%d KB)" % (name, os.path.basename(out), os.path.getsize(out) // 1024))
