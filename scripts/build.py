#!/usr/bin/env python3
"""Build an offline HTML and an allowlisted source package using stdlib only.

Existing artifacts are immutable: matching files are reused; changed output
requires a new --version. No source, reference, test, or user data is removed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import re
import sys
import tempfile
from pathlib import Path


SOURCE_ROOT = Path(__file__).resolve().parents[1]
ALLOWLIST = (
    "index.html",
    "README.md",
    "src/styles.css",
    "src/engine.js",
    "src/exports.js",
    "src/reference-art.js",
    "src/layers.js",
    "src/skin.js",
    "src/app.js",
    "assets/inkbox-original.png",
    "assets/Kalam-Bold.ttf",
    "assets/OFL.txt",
    "scripts/build.py",
)
SCRIPT_ORDER = ("engine.js", "layers.js", "exports.js", "reference-art.js", "skin.js", "app.js")


def project_root() -> Path | None:
    for directory in SOURCE_ROOT.parents:
        if re.fullmatch(r"project\d+-[^/]+", directory.name):
            if (directory / "README.md").is_file() and (directory / "05-交付物").is_dir():
                return directory
    return None


def within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def read_sources() -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for relative in ALLOWLIST:
        target = SOURCE_ROOT / relative
        if not target.is_file() or target.is_symlink():
            raise ValueError(f"缺少普通源码文件，或文件为链接：{relative}")
        files[relative] = target.read_bytes()
    return files


def inline_html(files: dict[str, bytes]) -> bytes:
    html = files["index.html"].decode("utf-8")
    css = files["src/styles.css"].decode("utf-8")
    css_tag = '<link rel="stylesheet" href="src/styles.css">'
    if html.count(css_tag) != 1:
        raise ValueError("index.html必须且只能包含一个预期的src/styles.css引用。")
    if re.search(r"</style", css, re.IGNORECASE):
        raise ValueError("CSS包含不能直接内嵌的</style文本，请先核查。")
    script_tags = [f'<script src="src/{name}"></script>' for name in SCRIPT_ORDER]
    positions = [html.find(tag) for tag in script_tags]
    if any(html.count(tag) != 1 for tag in script_tags) or positions != sorted(positions):
        raise ValueError("脚本入口必须按" + "、".join(SCRIPT_ORDER) + "顺序各出现一次。")
    html = html.replace(css_tag, "<style>\n" + css + "\n</style>")
    for name, tag in zip(SCRIPT_ORDER, script_tags):
        js = files[f"src/{name}"].decode("utf-8")
        if re.search(r"</script", js, re.IGNORECASE):
            raise ValueError(f"{name}包含不能直接内嵌的</script文本，请先核查。")
        html = html.replace(tag, f"<!-- src/{name} -->\n<script>\n{js}\n</script>")
    # The original illustration and hand-lettered font travel inside the offline file.
    for filename, mime in (("inkbox-original.png", "image/png"), ("Kalam-Bold.ttf", "font/ttf")):
        uri = "data:" + mime + ";base64," + base64.b64encode(files["assets/" + filename]).decode("ascii")
        html = html.replace("../assets/" + filename, uri)
        html = html.replace("assets/" + filename, uri)
    html += "\n<!-- Embedded font license (Kalam Bold):\n" + files["assets/OFL.txt"].decode("utf-8").replace("--", "—") + "\n-->\n"
    if re.search(r"<script\b[^>]*\bsrc\s*=|<link\b[^>]*\brel=[\"']stylesheet", html, re.IGNORECASE):
        raise ValueError("内嵌后仍存在外部脚本或样式引用。")
    return html.encode("utf-8")


def package_matches(target: Path, files: dict[str, bytes]) -> bool:
    if not target.is_dir() or target.is_symlink():
        return False
    existing = {p.relative_to(target).as_posix() for p in target.rglob("*") if p.is_file() or p.is_symlink()}
    if existing != set(files):
        return False
    return all(not (target / name).is_symlink() and (target / name).read_bytes() == data
               for name, data in files.items())


def main() -> int:
    parser = argparse.ArgumentParser(description="内嵌本地资源，生成离线Demo和仅含维护源码的包。")
    parser.add_argument("--version", default="v05", help="交付版本，例如v05；不同内容不覆盖旧版本。")
    parser.add_argument("--output-dir", type=Path, help="输出目录；在Hahahali项目中必须位于本项目内。")
    parser.add_argument("--check", action="store_true", help="只检查源码与内嵌结果，不写入任何文件。")
    args = parser.parse_args()
    if not re.fullmatch(r"v\d{2,}", args.version):
        parser.error("版本号需为v加至少两位数字，例如v01。")
    root = project_root()
    output_root = (args.output_dir or (root / "05-交付物" if root else SOURCE_ROOT / "dist")).resolve()
    if root and not within(output_root, root.resolve()):
        parser.error("输出目录必须位于当前project项目目录内。")
    files = read_sources()
    bundle = inline_html(files)
    digest = hashlib.sha256(bundle).hexdigest()
    bundle_target = output_root / f"涂个动静-Demo-{args.version}.html"
    package_target = output_root / f"live-doodle-demo-{args.version}"
    if args.check:
        print(f"检查通过：{len(files)}个源码文件；离线HTML {len(bundle):,}字节。")
        print(f"SHA-256：{digest}")
        print(f"预定输出：{bundle_target}")
        print(f"预定源码包：{package_target}")
        return 0
    if bundle_target.exists() and (not bundle_target.is_file() or bundle_target.is_symlink() or bundle_target.read_bytes() != bundle):
        raise ValueError(f"已有不同内容，已停止且未覆盖：{bundle_target.name}。请使用新--version。")
    if package_target.exists() and not package_matches(package_target, files):
        raise ValueError(f"已有不同维护包，已停止且未覆盖：{package_target.name}。请使用新--version。")
    output_root.mkdir(parents=True, exist_ok=True)
    # Staging stays within the selected project-owned output directory.
    with tempfile.TemporaryDirectory(prefix=".live-doodle-build-", dir=output_root) as temp_name:
        staging = Path(temp_name)
        staged_package = staging / package_target.name
        staged_package.mkdir()
        for relative, data in files.items():
            destination = staged_package / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        if not package_target.exists():
            staged_package.rename(package_target)
        if not bundle_target.exists():
            with bundle_target.open("xb") as output:
                output.write(bundle)
    if bundle_target.read_bytes() != bundle or not package_matches(package_target, files):
        raise ValueError("构建后校验不一致，请保留现场并核查。")
    print(f"离线Demo：{bundle_target}")
    print(f"维护源码：{package_target}")
    print(f"SHA-256：{digest}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, UnicodeError, ValueError) as error:
        print(f"构建失败：{error}", file=sys.stderr)
        raise SystemExit(1)
