"""Crea deploy.zip con separadores '/' (Compress-Archive de PowerShell usa '\\' y rompe el despliegue en Linux).
Uso: python make-zip.py <carpeta_origen> <archivo.zip>"""
import os, sys, zipfile

src, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
if os.path.exists(out):
    os.remove(out)
n = 0
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for base, dirs, files in os.walk(src):
        dirs.sort()
        for f in sorted(files):
            full = os.path.join(base, f)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            z.write(full, rel)
            n += 1
print(f"{out}: {n} archivos, {os.path.getsize(out) / 1048576:.1f} MB")
