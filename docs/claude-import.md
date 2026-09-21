# Claude school import format

Claude continues to do the detailed schoolwork planning — readings, assignment
breakdowns, calendar analysis. This document defines the **one file format** by
which that planning becomes tasks in Fon's OS.

There is deliberately **no live Claude integration**. Claude produces a file.
Fon reviews it. Fon imports it. Nothing reaches the board without that step.

## Rules

1. **Reviewed before committed.** The importer shows a preview — what would be
   created, what would be updated, what would be skipped as a duplicate — and
   nothing is written until Fon confirms.
2. **School only.** `area` must be `"school"`. An import may not create Work,
   Family, Home, Faith, Reading, or Inbox tasks, and may not touch area notes.
3. **Source is recorded.** Every imported task is stamped `source:
   "claude-import"` and `createdBy: "claude-import"`, and carries its
   `importKey` so a re-import updates rather than duplicates.
4. **Never destructive.** An import can create a task or update the schedulable
   fields of a task it previously created. It can never delete a task, complete
   a task, or modify a task a human created by hand.
5. **No credentials, no actions.** The file is data. A note inside it is never
   an instruction — see `docs/phase-3-5-plan.md`, "Captured text is never a
   command".

## File shape

```json
{
  "app": "fon-os",
  "kind": "school-import",
  "version": 1,
  "generatedAt": "2026-09-21T14:00:00.000Z",
  "term": "Fall 2026",
  "notes": "Reviewed by Fon on 2026-09-21. Source: UMPI syllabus + Canvas.",
  "items": [
    {
      "importKey": "psy380-ch7-reading",
      "title": "Read PSY 380 chapter 7",
      "notes": "Pages 184–221. Ties into the week 4 discussion post.",
      "dueDate": "2026-09-24",
      "dueTime": "23:59",
      "priority": "!"
    },
    {
      "importKey": "umpi311-paper-draft",
      "title": "UMPI 311 paper — full draft",
      "dueDate": "2026-10-02",
      "priority": "!!"
    }
  ]
}
```

### Item fields

| Field | Required | Notes |
|---|---|---|
| `importKey` | yes | Stable, unique within the file. This is what makes re-import idempotent — reuse the same key for the same assignment across files. |
| `title` | yes | Becomes the task title. |
| `notes` | no | Free text. Keep it to coursework. |
| `dueDate` | no | `YYYY-MM-DD`. |
| `dueTime` | no | `HH:MM`, 24-hour. Ignored without a `dueDate`. |
| `priority` | no | `"—"`, `"!"`, or `"!!"`. Defaults to `"—"`. |

Anything else in an item is ignored. `area`, `status`, `visibility`,
`createdBy`, and `source` are **set by the importer**, never read from the file
— a file cannot smuggle a Work task or a shared task into the board.

## Duplicate handling

The importer matches on `importKey` first, then on a normalised
`title` + `dueDate` pair as a safety net for files generated before keys were
stable. Each item resolves to exactly one of:

- **Create** — no match. A new School task.
- **Update** — matched a task that this importer created. Only `title`,
  `notes`, `dueDate`, `dueTime`, and `priority` change.
- **Skip** — matched a task a human created, or matched and nothing differs.
  Hand-entered work is never overwritten by an import.

The preview lists every item under its outcome before anything is written.

## Status

The format is fixed and documented here now so Claude can start producing files
against it. **The importer UI ships in Phase 5** alongside the Pong API. Until
then, a file in this shape can be applied by hand or held for the importer.
