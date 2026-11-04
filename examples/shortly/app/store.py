"""In-memory storage for short links."""

import secrets
from dataclasses import dataclass, field


@dataclass
class Link:
    code: str
    url: str


@dataclass
class LinkStore:
    links: dict[str, Link] = field(default_factory=dict)

    def create(self, url: str) -> Link:
        code = secrets.token_urlsafe(5)
        while code in self.links:
            code = secrets.token_urlsafe(5)
        link = Link(code=code, url=url)
        self.links[code] = link
        return link

    def get(self, code: str) -> Link | None:
        return self.links.get(code)
