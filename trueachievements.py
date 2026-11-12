"""Optional public TA metadata. Xbox progress remains the source of truth."""
import json
import math
import re
import time
import unicodedata
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, HTTPRedirectHandler, HTTPCookieProcessor, build_opener
from urllib.parse import urljoin, urlsplit

from achievement_language import UNIFIDECK_TITLE_PREFIX
from ta_bridge import ORIGIN, safe_url

MAX_BYTES = 4 * 1024 * 1024
TTL = 24 * 60 * 60
RETRY = 15 * 60
CATALOG = Path(__file__).with_name("ta_flags.json")
if not CATALOG.exists():
    CATALOG = Path(__file__).parent / "src/ta_flags.json"
FLAGS = json.loads(CATALOG.read_text())
FLAG_IDS = {flag["id"] for flag in FLAGS}


def title_link(title_id):
    if not isinstance(title_id, str) or not re.fullmatch(r"[0-9]{1,10}", title_id):
        raise ValueError("Invalid Xbox title ID")
    return f"{ORIGIN}/deeplink/{title_id}"


class Redirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not safe_url(newurl):
            raise ValueError("Unexpected TA redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_page(url, cookies=None, user_agent=None):
    if not safe_url(url):
        raise ValueError("Unexpected TA URL")
    request = Request(url, headers={"User-Agent": user_agent or "NexusAchievements/0.2 (+https://github.com/dante2130/decky-nexus-achievements)",
                                    "Accept-Language": "en"})
    handlers = [Redirects()]
    if cookies is not None:
        handlers.append(HTTPCookieProcessor(cookies))
    with build_opener(*handlers).open(request, timeout=10) as response:
        data = response.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise ValueError("TA response too large")
        if not safe_url(response.url):
            raise ValueError("Unexpected TA URL")
        return data.decode("utf-8", errors="replace")


def normalized(name):
    # Keep words and punctuation distinctions; only normalize case/spacing/quotes.
    return " ".join(unicodedata.normalize("NFKC", name).casefold().replace("’", "'").split())


class Node:
    def __init__(self, tag="", attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def text(self):
        return "".join(child.text() if isinstance(child, Node) else child for child in self.children)

    def nodes(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.nodes()


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        # HTML permits omitted closing </li> tags.
        if tag == "li" and self.stack[-1].tag == "li":
            self.stack.pop()
        node = Node(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def achievement_link(node):
    href = urljoin(ORIGIN, node.attrs.get("href") or "")
    if node.tag == "a" and safe_url(href) and re.fullmatch(r"/a[0-9]+/[^/]+-achievement", urlsplit(href).path):
        return href.split("?")[0].split("#")[0]
    return None


def parse_page(html):
    page = Page()
    page.feed(html)
    rows = {}
    for container in page.root.nodes():
        classes = (container.attrs.get("class") or "").lower().split()
        if container.tag != "li" and not any(c in {"achievement", "ach-panel", "achievement-panel"} for c in classes):
            continue
        nodes = list(container.nodes())
        links = {achievement_link(n) for n in nodes} - {None}
        if len(links) != 1:
            continue
        url = next(iter(links))
        names = [n.text().strip() for n in nodes if achievement_link(n) == url and n.text().strip()]
        if not names:
            continue
        found = set()
        for node in nodes:
            for css_class in (node.attrs.get("class") or "").split():
                mask = re.fullmatch(r"flg-([0-9a-fA-F]{1,8})", css_class)
                if mask:
                    bits = int(mask[1], 16)
                    found.update(flag["id"] for flag in FLAGS if bits & (1 << flag["bit"]))
            # Also support explicit flag labels, without reading guide prose.
            for attr in ("title", "alt", "aria-label", "data-original-title"):
                label = (node.attrs.get(attr) or "").strip()
                for flag in FLAGS:
                    if label == flag["label"] or label.startswith(flag["label"] + " - "):
                        found.add(flag["id"])
        found.update(rows.get(url, {}).get("flags", []))
        flags = [flag["id"] for flag in FLAGS if flag["id"] in found]
        rows[url] = {"name": names[0], "url": url, "flags": flags, "missable": "missable" in flags}
    if not rows:
        raise ValueError("TA achievement list unavailable")
    return list(rows.values())


def match_rows(achievements, rows):
    by_name = {}
    for row in rows:
        by_name.setdefault(normalized(row["name"]), []).append(row)
    local_names = {}
    for item in achievements:
        key = normalized(item.get("name", ""))
        local_names[key] = local_names.get(key, 0) + 1
    matched = {}
    for item in achievements:
        key = normalized(item.get("name", ""))
        candidates = by_name.get(key, [])
        if key and local_names[key] == 1 and len(candidates) == 1:
            row = candidates[0]
            matched[item["id"]] = {"url": row["url"], "flags": row["flags"], "missable": "missable" in row["flags"]}
    return matched


def valid_cache(cache, title_id):
    if not isinstance(cache, dict) or cache.get("titleId") != title_id or cache.get("schema") != 2 or not isinstance(cache.get("rows"), list):
        return False
    stamp = cache.get("updatedAt")
    if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not math.isfinite(stamp):
        return False
    return all(isinstance(row, dict) and isinstance(row.get("name"), str)
               and isinstance(row.get("url"), str) and safe_url(row["url"])
               and re.fullmatch(r"/a[0-9]+/[^/]+-achievement", urlsplit(row["url"]).path)
               and isinstance(row.get("flags"), list) and all(isinstance(flag, str) and flag in FLAG_IDS for flag in row["flags"])
               and isinstance(row.get("missable"), bool) for row in cache["rows"])


class TrueAchievements:
    def __init__(self, directory: Path, session=None):
        self.directory = directory
        self.session = session
        self.memory = {}
        self.attempts = {}
        self.refresh_after = 0

    def get(self, detail):
        title_id = detail.get("titleId", "")
        link = title_link(title_id.removeprefix(UNIFIDECK_TITLE_PREFIX))
        now = time.time()
        cache = self.memory.get(title_id)
        if cache is None:
            try:
                cache = json.loads((self.directory / f"{title_id}.json").read_text())
                if not valid_cache(cache, title_id):
                    cache = None
            except (OSError, ValueError):
                cache = None
        failed = False
        if (not cache or now - cache.get("updatedAt", 0) >= TTL or cache.get("updatedAt", 0) < self.refresh_after) and now - self.attempts.get(title_id, 0) >= RETRY:
            if len(self.attempts) >= 200:
                self.attempts.pop(next(iter(self.attempts)))
            self.attempts[title_id] = now
            try:
                rows = parse_page(self.session.fetch(link) if self.session else fetch_page(link))
                # A redirect to a generic page must not attach unrelated metadata.
                if not match_rows(detail.get("achievements", []), rows):
                    raise ValueError("No matching TA achievements")
                cache = {"schema": 2, "titleId": title_id, "updatedAt": now, "rows": rows}
                self.directory.mkdir(parents=True, exist_ok=True)
                path = self.directory / f"{title_id}.json"
                temporary = path.with_suffix(".tmp")
                temporary.write_text(json.dumps(cache))
                temporary.replace(path)
            except Exception:
                failed = True
        if cache:
            if len(self.memory) >= 200:
                self.memory.pop(next(iter(self.memory)))
            self.memory[title_id] = cache
        return {"url": link, "status": "stale" if cache and (failed or now - cache["updatedAt"] >= TTL) else "ready" if cache else "unavailable",
                "updatedAt": cache["updatedAt"] if cache else None,
                "achievements": match_rows(detail.get("achievements", []), cache["rows"]) if cache else {}}
