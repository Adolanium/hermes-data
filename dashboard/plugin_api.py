"""Backend for the Data page in Hermes Desktop, mounted at ``/api/plugins/data/``.

The page writes a copy of each report here while chat access is on, so the agent's data_*
tools can read it, and it collects what the agent sent (new reports, proposed changes) from the
inbox. Files live under ``<hermes home>/plugin-data/data/`` (see store.py).

Import and export also come through here: the page shows the system dialog, then asks this
backend to read or write the one file the person picked (see picked.py).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from fastapi import APIRouter, Body

PLUGIN_DIR = Path(__file__).resolve().parent.parent


def _load(name: str, filename: str):
    module = sys.modules.get(name)
    if module is None:
        spec = importlib.util.spec_from_file_location(name, PLUGIN_DIR / filename)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


def _store():
    return _load("hermes_data_store", "store.py")


def _picked():
    return _load("hermes_data_picked", "picked.py")


router = APIRouter()


@router.get("/inbox")
def inbox() -> dict:
    return {"entries": _store().Inbox().list()}


@router.post("/inbox/{entry_id}/ack")
def ack(entry_id: str) -> dict:
    return {"removed": _store().Inbox().ack(entry_id)}


@router.post("/sharing")
def sharing(body: dict = Body(...)) -> dict:
    reports = _store().Reports()
    reports.set_sharing(bool(body.get("on")))
    return reports.sharing()


@router.put("/reports/{report_id}")
def put_report(report_id: str, body: dict = Body(...)) -> dict:
    reports = _store().Reports()
    if not reports.sharing()["on"] or str(body.get("id")) != report_id:
        return {"stored": False}
    return {"stored": reports.put(body)}


@router.delete("/reports/{report_id}")
def delete_report(report_id: str) -> dict:
    return {"removed": _store().Reports().remove(report_id)}


@router.post("/reports/prune")
def prune(body: dict = Body(...)) -> dict:
    keep = body.get("keep") if isinstance(body.get("keep"), list) else []
    return {"removed": _store().Reports().prune([str(k) for k in keep])}


@router.post("/picked-file/read")
def read_picked_file(body: dict = Body(...)) -> dict:
    return _picked().read_text(body.get("path"), _store().hermes_home())


@router.post("/picked-file/table")
def read_picked_table(body: dict = Body(...)) -> dict:
    return _picked().read_table(body.get("path"), body.get("sheet"), _store().hermes_home())


@router.post("/picked-file/write")
def write_picked_file(body: dict = Body(...)) -> dict:
    return _picked().write_text(body.get("path"), body.get("text"), _store().hermes_home())
