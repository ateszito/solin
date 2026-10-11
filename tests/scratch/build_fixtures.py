"""Build QA fixtures: a valid 11 MB JPEG-ish file and a non-image text file."""
with open("/tmp/qa_fixtures/big.jpg", "wb") as f:
    f.write(b"\xff\xd8\xff\xe0" + b"\x00" * (11 * 1024 * 1024))
with open("/tmp/qa_fixtures/notes.txt", "w") as f:
    f.write("hello, I am a plain text file, definitely not an image\n")
import os
for n in ("big.jpg", "notes.txt"):
    p = os.path.join("/tmp/qa_fixtures", n)
    print(n, os.path.getsize(p), "bytes")
