import sys
sys.path.insert(0, "backend")
import os
os.environ.setdefault("SOLIN_ENV", "unknown")
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, field_validator
from typing import Union

app = FastAPI()

class M(BaseModel):
    available_amount: Union[int, float, str]
    @field_validator("available_amount", mode="before")
    @classmethod
    def v(cls, val):
        if isinstance(val, str):
            try:
                float(val.replace(",", "."))
            except ValueError:
                raise HTTPException(status_code=400, detail={"error": "not a number"})
        return val

@app.post("/t")
def t(m: M):
    return {"ok": True}

c = TestClient(app, raise_server_exceptions=False)  # don't swallow HTTPEx as exception
for payload in ("abc", 42, "-3", "850", "1.5", None, [1], True):
    r = c.post("/t", json={"available_amount": payload})
    print(f"  {payload!r:>8} -> HTTP {r.status_code}  {r.text[:80]}")
