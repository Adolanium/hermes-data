"""Read or write the one file the person just picked in a system dialog.

The Data page opens the dialog through the Desktop SDK (``ctx.os.pickOpenPath`` and
``pickSavePath``) and sends the chosen path to this backend through ``ctx.rest``, which is where
the SDK says a picked path belongs. The calls are narrow on purpose: import reads CSV, text and
JSON tables and Excel workbooks up to a size cap, export writes a report (HTML or Markdown), a
chart (SVG) or the table (CSV), and none of them touches Hermes' own home folder.

An Excel workbook is a zip of XML files, so it is read with the standard library alone: no
spreadsheet package, no macros run, no formulas evaluated (a formula cell gives the value Excel
last saved for it).

Every function returns ``{"ok": True, ...}`` or ``{"ok": False, "error": "..."}`` and never raises,
so the page can show the reason as it is.
"""

from __future__ import annotations

import datetime
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree

READ_SUFFIXES = (".csv", ".tsv", ".txt", ".json")
TABLE_SUFFIXES = (".xlsx",)
MAX_TABLE_BYTES = 8 * 1024 * 1024
MAX_PART_BYTES = 96 * 1024 * 1024
MAX_SHARED_STRINGS = 400_000
MAX_ROWS = 5001
MAX_COLUMNS = 40
MAX_CELL = 160
WRITE_SUFFIXES = (".html", ".md", ".svg", ".csv")
MAX_READ_BYTES = 4 * 1024 * 1024
MAX_WRITE_BYTES = 16 * 1024 * 1024
_BINARY_SAMPLE = 4096


class _Refused(Exception):
    pass


def _protected(home: Path | None) -> list[Path]:
    """Hermes' home folder, and the root above it when the home is a profile."""
    if home is None:
        return []
    roots = [home.resolve()]
    if roots[0].parent.name == "profiles":
        roots.append(roots[0].parent.parent)
    return roots


def _checked(raw, suffixes: tuple[str, ...], verb: str, home: Path | None) -> Path:
    if not isinstance(raw, str) or not raw.strip() or "\x00" in raw:
        raise _Refused("No file was picked.")
    path = Path(raw)
    if not path.is_absolute():
        raise _Refused("Data needs the full path of the picked file.")
    resolved = path.resolve()
    kinds = ", ".join(suffixes)
    if path.suffix.lower() not in suffixes or resolved.suffix.lower() not in suffixes:
        raise _Refused(f"Data only {verb} {kinds} files.")
    for root in _protected(home):
        if resolved == root or root in resolved.parents:
            raise _Refused(f"Data never {verb} files inside the Hermes home folder.")
    return resolved


def _problem(error: OSError) -> str:
    return error.strerror or error.__class__.__name__


def read_text(raw, home: Path | None = None) -> dict:
    """The text of a picked file. A file over the cap comes back ``truncated`` with no text, so half
    a table is never analysed by mistake."""
    try:
        path = _checked(raw, READ_SUFFIXES, "reads", home)
        if not path.is_file():
            raise _Refused("That file is not there any more.")
        size = path.stat().st_size
        if size > MAX_READ_BYTES:
            return {"ok": True, "path": raw, "name": path.name, "text": "", "truncated": True, "binary": False, "bytes": size}
        data = path.read_bytes()
    except _Refused as refused:
        return {"ok": False, "error": str(refused)}
    except OSError as error:
        return {"ok": False, "error": f"Hermes could not read that file: {_problem(error)}."}
    if b"\x00" in data[:_BINARY_SAMPLE]:
        return {"ok": True, "path": raw, "name": path.name, "text": "", "truncated": False, "binary": True, "bytes": len(data)}
    return {
        "ok": True,
        "path": raw,
        "name": path.name,
        "text": data.decode("utf-8-sig", errors="replace"),
        "truncated": False,
        "binary": False,
        "bytes": len(data),
    }


def write_text(raw, text, home: Path | None = None) -> dict:
    """Write an export to the path the person named in the save dialog."""
    try:
        path = _checked(raw, WRITE_SUFFIXES, "writes", home)
        if not isinstance(text, str):
            raise _Refused("There was nothing to write.")
        data = text.encode("utf-8", errors="replace")
        if len(data) > MAX_WRITE_BYTES:
            raise _Refused("That export is too large to write.")
        if path.is_dir():
            raise _Refused("That path is a folder, not a file.")
        if not path.parent.is_dir():
            raise _Refused("That folder does not exist.")
        path.write_bytes(data)
    except _Refused as refused:
        return {"ok": False, "error": str(refused)}
    except OSError as error:
        return {"ok": False, "error": f"Hermes could not write that file: {_problem(error)}."}
    return {"ok": True, "path": raw, "bytes": len(data)}


# --- Excel workbooks ------------------------------------------------------------------------------

_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"
_DATE_FORMATS = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))
_CURRENCY = "$\u00a3\u20ac\u00a5\u20b9"
_REF = re.compile(r"^([A-Z]{1,3})(\d+)$")


def _part(archive: zipfile.ZipFile, name: str) -> bytes:
    """One file out of the workbook, refused when it is too big or carries a DTD."""
    try:
        info = archive.getinfo(name)
    except KeyError:
        raise _Refused("That workbook is missing a part Data needs. Save it again as .xlsx and retry.") from None
    if info.file_size > MAX_PART_BYTES:
        raise _Refused("That workbook is too large to read.")
    data = archive.read(info)
    if b"<!DOCTYPE" in data[:4096] or b"<!ENTITY" in data[:4096]:
        raise _Refused("That workbook has a kind of XML Data does not read.")
    return data


def _format_kind(code: str) -> str:
    """What a number format shows: a date, money, a percentage, or a plain number."""
    plain = re.sub(r'"[^"]*"|\\.', "", code)
    tagged = re.search(r"\[\$([^\-\]]+)", code)
    symbol = tagged.group(1)[:3] if tagged else next((ch for ch in re.sub(r"\[[^\]]*\]", "", code) if ch in _CURRENCY), "")
    bare = re.sub(r"\[[^\]]*\]", "", plain).lower()
    if bare.strip() in ("", "general", "@"):
        return "number"
    if any(ch in bare for ch in "dy") or ("m" in bare and any(ch in bare for ch in "hs:")) or bare.strip("m/-. ") == "":
        return "date"
    if any(ch in bare for ch in "hs") and "#" not in bare and "0" not in bare:
        return "date"
    if "%" in bare:
        return "percent"
    return f"money{symbol}" if symbol else "number"


def _styles(archive: zipfile.ZipFile) -> list[str]:
    """The kind of each cell style, by its index."""
    if "xl/styles.xml" not in archive.namelist():
        return []
    root = ElementTree.fromstring(_part(archive, "xl/styles.xml"))
    custom = {}
    for fmt in root.iter(f"{_MAIN}numFmt"):
        try:
            custom[int(fmt.get("numFmtId", "-1"))] = fmt.get("formatCode", "")
        except ValueError:
            continue
    kinds = []
    cell_xfs = root.find(f"{_MAIN}cellXfs")
    for xf in cell_xfs if cell_xfs is not None else []:
        try:
            fmt_id = int(xf.get("numFmtId", "0"))
        except ValueError:
            fmt_id = 0
        if fmt_id in custom:
            kinds.append(_format_kind(custom[fmt_id]))
        elif fmt_id in _DATE_FORMATS:
            kinds.append("date")
        elif fmt_id in (9, 10):
            kinds.append("percent")
        elif fmt_id in (5, 6, 7, 8, 42, 44):
            kinds.append("money$")
        else:
            kinds.append("number")
    return kinds


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    out = []
    for _event, node in ElementTree.iterparse(_open_part(archive, "xl/sharedStrings.xml")):
        if node.tag == f"{_MAIN}si":
            out.append("".join(t.text or "" for t in node.iter(f"{_MAIN}t") if _not_phonetic(node, t)))
            node.clear()
            if len(out) > MAX_SHARED_STRINGS:
                raise _Refused("That workbook has too much text to read.")
    return out


def _not_phonetic(si, text_node) -> bool:
    """Skip the phonetic guide runs some workbooks carry beside the real text."""
    for run in si.iter(f"{_MAIN}rPh"):
        if text_node in list(run.iter(f"{_MAIN}t")):
            return False
    return True


def _open_part(archive: zipfile.ZipFile, name: str):
    info = archive.getinfo(name)
    if info.file_size > MAX_PART_BYTES:
        raise _Refused("That workbook is too large to read.")
    with archive.open(info) as probe:
        head = probe.read(4096)
    if b"<!DOCTYPE" in head or b"<!ENTITY" in head:
        raise _Refused("That workbook has a kind of XML Data does not read.")
    return archive.open(info)


def _sheets(archive: zipfile.ZipFile) -> tuple[list[tuple[str, str]], bool]:
    """Each visible sheet's name and the file it lives in, and whether dates count from 1904."""
    book = ElementTree.fromstring(_part(archive, "xl/workbook.xml"))
    rels = ElementTree.fromstring(_part(archive, "xl/_rels/workbook.xml.rels"))
    targets = {rel.get("Id"): rel.get("Target", "") for rel in rels.iter(f"{_PKG}Relationship")}
    props = book.find(f"{_MAIN}workbookPr")
    late = props is not None and props.get("date1904") in ("1", "true")
    out = []
    for sheet in book.iter(f"{_MAIN}sheet"):
        target = targets.get(sheet.get(f"{_REL}id"), "")
        if not target or sheet.get("state") in ("hidden", "veryHidden"):
            continue
        path = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join("xl", target))
        if path in archive.namelist() and "worksheets" in path:
            out.append((sheet.get("name") or f"Sheet {len(out) + 1}", path))
    return out, late


def _column(ref: str) -> int:
    match = _REF.match(ref or "")
    if not match:
        return -1
    index = 0
    for letter in match.group(1):
        index = index * 26 + ord(letter) - 64
    return index - 1


def _value(text: str, kind: str, late: bool):
    """A stored number as the page should see it: a date, money, a percentage or a number."""
    try:
        number = float(text)
    except ValueError:
        return text[:MAX_CELL]
    if kind == "date":
        if number < 1:
            seconds = round(number * 86400)
            return f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}"
        try:
            day = datetime.date(1904, 1, 1) if late else datetime.date(1899, 12, 30)
            return (day + datetime.timedelta(days=int(number))).isoformat()
        except OverflowError:
            return text[:MAX_CELL]
    if kind == "percent":
        return f"{round(number * 100, 4):g}%"
    if kind.startswith("money"):
        return f"{'-' if number < 0 else ''}{kind[5:]}{abs(number):.2f}"
    return int(number) if number.is_integer() and abs(number) < 1e15 else number


def _rows(archive: zipfile.ZipFile, path: str, strings: list[str], kinds: list[str], late: bool) -> tuple[list[list], bool]:
    rows: list[list] = []
    truncated = False
    for _event, node in ElementTree.iterparse(_open_part(archive, path)):
        if node.tag != f"{_MAIN}row":
            continue
        cells: list = []
        position = 0
        for cell in node.iter(f"{_MAIN}c"):
            at = _column(cell.get("r", ""))
            at = position if at < 0 else at
            position = at + 1
            if at >= MAX_COLUMNS:
                continue
            kind = cell.get("t", "n")
            raw = cell.find(f"{_MAIN}v")
            text = raw.text if raw is not None and raw.text is not None else ""
            if kind == "s":
                try:
                    value = strings[int(text)][:MAX_CELL]
                except (ValueError, IndexError):
                    value = ""
            elif kind == "inlineStr":
                value = "".join(t.text or "" for t in cell.iter(f"{_MAIN}t"))[:MAX_CELL]
            elif kind == "b":
                value = "true" if text == "1" else "false"
            elif kind in ("str", "e"):
                value = "" if kind == "e" else text[:MAX_CELL]
            elif text == "":
                value = ""
            else:
                try:
                    style = kinds[int(cell.get("s", "0"))]
                except (ValueError, IndexError):
                    style = "number"
                value = _value(text, style, late)
            if value != "":
                cells.extend([""] * (at - len(cells)))
                cells.append(value)
        node.clear()
        if cells:
            if len(rows) >= MAX_ROWS:
                truncated = True
                break
            rows.append(cells)
    width = max((len(row) for row in rows), default=0)
    return [row + [""] * (width - len(row)) for row in rows], truncated


def read_table(raw, sheet=None, home: Path | None = None) -> dict:
    """The rows of one sheet of a picked Excel workbook, and the names of its sheets."""
    try:
        path = _checked(raw, TABLE_SUFFIXES, "reads", home)
        if not path.is_file():
            raise _Refused("That file is not there any more.")
        if path.stat().st_size > MAX_TABLE_BYTES:
            raise _Refused("That workbook is over 8 MB. Save a smaller cut of it and try again.")
        try:
            with zipfile.ZipFile(path) as archive:
                sheets, late = _sheets(archive)
                if not sheets:
                    raise _Refused("That workbook has no sheet Data can read.")
                names = [name for name, _path in sheets]
                wanted = sheet if isinstance(sheet, str) and sheet in names else names[0]
                rows, truncated = _rows(archive, dict(sheets)[wanted], _shared_strings(archive), _styles(archive), late)
        except (zipfile.BadZipFile, ElementTree.ParseError, KeyError):
            raise _Refused("That file is not an Excel workbook Data can read. Old .xls files need saving as .xlsx first.") from None
    except _Refused as refused:
        return {"ok": False, "error": str(refused)}
    except OSError as error:
        return {"ok": False, "error": f"Hermes could not read that file: {_problem(error)}."}
    return {"ok": True, "path": raw, "name": path.name, "sheets": names, "sheet": wanted, "rows": rows, "truncated": truncated}
