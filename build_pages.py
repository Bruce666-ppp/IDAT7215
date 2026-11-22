"""Export the bundled PawthFinder demo for GitHub Pages."""
import argparse
import json
from pathlib import Path
from shutil import copytree
from tempfile import TemporaryDirectory

from flask import render_template

from app import create_app
from core import BASE


def build(output):
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
            index = render_template("index.html", pages_preview=True)
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
    args = parser.parse_args()
    build(args.output)
