"""Shortly: create a short code for a URL, then redirect to it."""

from fastapi import FastAPI, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.store import LinkStore

app = FastAPI(title="Shortly")
store = LinkStore()


class CreateLink(BaseModel):
    url: str


class LinkOut(BaseModel):
    code: str
    url: str
    short_url: str


@app.post("/links", status_code=201)
def create_link(body: CreateLink) -> LinkOut:
    link = store.create(body.url)
    return LinkOut(code=link.code, url=link.url, short_url=f"/{link.code}")


@app.get("/{code}")
def follow(code: str) -> RedirectResponse:
    link = store.get(code)
    if link is None:
        raise HTTPException(status_code=404, detail="Unknown link")
    return RedirectResponse(link.url, status_code=307)
