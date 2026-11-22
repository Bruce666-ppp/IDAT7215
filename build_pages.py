"""Export the bundled PawthFinder demo for GitHub Pages."""
import argparse
import json
import os
from ipaddress import ip_address
from pathlib import Path
from shutil import copytree
from tempfile import TemporaryDirectory
from urllib.parse import urlsplit

from flask import render_template

from app import create_app
from core import BASE


def published_app_url(value):
    if not value.strip():
        return ''
    url=urlsplit(value.strip())
    try:
        ip=ip_address(url.hostname)
    except ValueError:
        ip=None
    if (url.scheme!='https' or not url.hostname or '.' not in url.hostname
            or url.hostname.endswith(('.local','.github.io')) or (ip is not None and not ip.is_global)
            or url.username is not None or url.password is not None
            or url.path not in ('','/') or url.query or url.fragment):
        raise ValueError('PAWTH_APP_URL must be a public HTTPS application origin, such as https://your-service.onrender.com')
    return url.geturl().rstrip('/')+'/'


def build(output, app_url=''):
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Choose an empty output directory: {output}")
    snapshots = {
        "info.json": "/api/info",
        "model.json": "/api/model",
        "community/posts.json": "/api/community/posts",
        "ratings-example.csv": "/api/training/template",
    }
    with TemporaryDirectory(prefix="pawthfinder-pages-") as directory:
        app = create_app(Path(directory) / "pages.sqlite3")
        with app.test_request_context():
            index = render_template("index.html", pages_preview=True,
                                    hosted_app_url=published_app_url(app_url),allow_training=False)
        with app.test_client() as client:
            files = {}
            for name, route in snapshots.items():
                response = client.get(route)
                if response.status_code != 200:
                    raise RuntimeError(f"Could not export {route}: {response.status_code}")
                files[name] = response.data
            feed = json.loads(files["community/posts.json"])
            if feed["next_before"] or any(not post["demo"] for post in feed["items"]):
                raise RuntimeError("The Pages snapshot must contain only the bundled demo posts.")
            feed["author"] = "社区演示"
            files["community/posts.json"] = json.dumps(feed, ensure_ascii=False).encode("utf-8")
    output.mkdir(parents=True, exist_ok=True)
    copytree(BASE / "static", output / "static")
    (output / "index.html").write_text(index, encoding="utf-8")
    (output / ".nojekyll").touch()
    for name, content in files.items():
        target = output / "snapshot" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("_site"))
    parser.add_argument("--app-url", default=os.environ.get("PAWTH_APP_URL", ""))
    args = parser.parse_args()
    build(args.output,args.app_url)
