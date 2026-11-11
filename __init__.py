"""Data: drop in a table and Hermes finds the story, chart by chart.

The Desktop page (desktop/plugin.js) is the report. This package lets the agent work with it from
any chat:

- ``data_list`` / ``data_read``: read the person's reports (the page shares a copy while chat
  access is on; it starts off, and the person turns it on under Settings > Chats can read my
  reports);
- ``data_propose``: send charts to a report. They wait on the page until the person accepts or
  skips each one, and the page works out every number itself from the person's rows;
- ``data_create``: open a new report from a table gathered in the chat;
- the ``data:reports`` skill: how to work with a person's data without overstepping.
"""

from __future__ import annotations

from pathlib import Path

_SKILL = Path(__file__).resolve().parent / "skills" / "reports" / "SKILL.md"


def register(ctx):
    from .tools import register_tools

    register_tools(ctx)
    ctx.register_skill(
        "reports",
        _SKILL,
        description="Work with the person's Hermes Data reports from a chat: read a report and its table, "
                    "answer questions about the numbers, start a new report from a table you gathered, and "
                    "propose charts for them to review.",
    )
