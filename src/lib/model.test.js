import { describe, expect, it } from "vitest";

import {
  applyPatch,
  byUrgency,
  createTask,
  formatDue,
  isOverdue,
  moveTask,
  normalizeTask,
  pct,
  toggleDone,
  uid,
} from "./model.js";

describe("normalizeTask", () => {
  it("carries a legacy v1 item across to the new shape", () => {
    const task = normalizeTask({ id: "s1", text: "Read chapter 4", done: true, priority: "!", dueDate: "2026-01-02", area: "school" });

    expect(task).toMatchObject({
      id: "s1",
      title: "Read chapter 4",
      status: "done",
      priority: "!",
      dueDate: "2026-01-02",
      area: "school",
    });
    expect(task.completedAt).not.toBeNull();
  });

  it("files an unknown or missing area into Inbox instead of dropping the task", () => {
    expect(normalizeTask({ title: "a", area: "nonsense" }).area).toBe("inbox");
    expect(normalizeTask({ title: "b" }).area).toBe("inbox");
  });

  it("rejects malformed priorities, dates and times", () => {
    const task = normalizeTask({ title: "x", priority: "!!!", dueDate: "tomorrow", dueTime: "25:00" });
    expect(task.priority).toBe("—");
    expect(task.dueDate).toBe("");
    expect(task.dueTime).toBe("");
  });

  it("drops a due time that has no due date to hang from", () => {
    expect(normalizeTask({ title: "x", dueTime: "09:30" }).dueTime).toBe("");
    expect(normalizeTask({ title: "x", dueDate: "2026-03-01", dueTime: "09:30" }).dueTime).toBe("09:30");
  });

  it("always assigns a non-empty id", () => {
    expect(normalizeTask({ title: "x", id: "" }).id).toBeTruthy();
  });

  it("falls back to a placeholder title rather than an empty task", () => {
    expect(normalizeTask({}).title).toBe("Untitled");
  });
});

describe("sharing invariant", () => {
  it("defaults Family and Home to shared", () => {
    expect(createTask({ title: "x", area: "family" }).visibility).toBe("shared");
    expect(createTask({ title: "x", area: "home" }).visibility).toBe("shared");
  });

  it("refuses to mark a task shared outside Family and Home", () => {
    for (const area of ["school", "work", "faith", "reading", "inbox"]) {
      expect(createTask({ title: "x", area, visibility: "shared" }).visibility).toBe("private");
    }
  });

  it("cannot be bypassed by a patch", () => {
    const task = createTask({ title: "Client MR file review", area: "work" });
    expect(applyPatch(task, { visibility: "shared" }).visibility).toBe("private");
  });

  it("cannot be bypassed by a hand-edited import", () => {
    expect(normalizeTask({ title: "x", area: "work", visibility: "shared" }).visibility).toBe("private");
  });
});

describe("applyPatch", () => {
  it("updates the allowed fields", () => {
    const task = createTask({ title: "old", area: "school" });
    const next = applyPatch(task, { title: "new", priority: "!!", notes: "context" });

    expect(next.title).toBe("new");
    expect(next.priority).toBe("!!");
    expect(next.notes).toBe("context");
  });

  it("ignores attempts to rewrite provenance", () => {
    const task = createTask({ title: "x", area: "school", source: "manual", createdBy: "fon" });
    const next = applyPatch(task, {
      id: "hijacked",
      createdAt: "1999-01-01T00:00:00.000Z",
      createdBy: "abigail",
      source: "pong-voice",
      completedAt: "1999-01-01T00:00:00.000Z",
    });

    expect(next.id).toBe(task.id);
    expect(next.createdAt).toBe(task.createdAt);
    expect(next.createdBy).toBe("fon");
    expect(next.source).toBe("manual");
    expect(next.completedAt).toBeNull();
  });

  it("stamps completedAt on completion and clears it on reopen", () => {
    const task = createTask({ title: "x", area: "home" });
    expect(task.completedAt).toBeNull();

    const done = toggleDone(task);
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();

    const reopened = toggleDone(done);
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeNull();
  });

  it("keeps the original completedAt when editing an already-done task", () => {
    const done = toggleDone(createTask({ title: "x", area: "home" }));
    expect(applyPatch(done, { title: "renamed" }).completedAt).toBe(done.completedAt);
  });
});

describe("moveTask", () => {
  it("adopts the destination default when triaging out of Inbox", () => {
    const captured = createTask({ title: "Air filters", area: "inbox" });
    expect(moveTask(captured, "home")).toMatchObject({ area: "home", visibility: "shared" });
  });

  it("never widens sharing for a task that was already filed", () => {
    const priv = createTask({ title: "Private reflection", area: "faith" });
    expect(moveTask(priv, "family")).toMatchObject({ area: "family", visibility: "private" });
  });

  it("forces a shared task private when moved somewhere Abigail cannot reach", () => {
    const shared = createTask({ title: "Groceries", area: "home" });
    expect(shared.visibility).toBe("shared");
    expect(moveTask(shared, "work")).toMatchObject({ area: "work", visibility: "private" });
  });

  it("ignores an unknown destination", () => {
    const task = createTask({ title: "x", area: "inbox" });
    expect(moveTask(task, "nowhere")).toBe(task);
  });
});

describe("isOverdue", () => {
  const now = new Date("2026-03-10T12:00:00");

  it("treats a bare due date as due at end of day", () => {
    expect(isOverdue(createTask({ title: "x", area: "school", dueDate: "2026-03-10" }), now)).toBe(false);
    expect(isOverdue(createTask({ title: "x", area: "school", dueDate: "2026-03-09" }), now)).toBe(true);
  });

  it("respects a due time", () => {
    expect(isOverdue(createTask({ title: "x", area: "work", dueDate: "2026-03-10", dueTime: "09:00" }), now)).toBe(true);
    expect(isOverdue(createTask({ title: "x", area: "work", dueDate: "2026-03-10", dueTime: "17:00" }), now)).toBe(false);
  });

  it("applies to every area, not just School", () => {
    for (const area of ["school", "work", "home", "family", "faith", "reading", "inbox"]) {
      expect(isOverdue(createTask({ title: "x", area, dueDate: "2020-01-01" }), now)).toBe(true);
    }
  });

  it("never flags a completed or undated task", () => {
    expect(isOverdue(toggleDone(createTask({ title: "x", area: "school", dueDate: "2020-01-01" })), now)).toBe(false);
    expect(isOverdue(createTask({ title: "x", area: "school" }), now)).toBe(false);
  });
});

describe("pct", () => {
  it("is 0 for an empty area", () => {
    expect(pct([])).toBe(0);
  });

  it("counts completed against active tasks", () => {
    const tasks = [
      toggleDone(createTask({ title: "a", area: "home" })),
      createTask({ title: "b", area: "home" }),
    ];
    expect(pct(tasks)).toBe(50);
  });

  it("excludes archived tasks from the denominator", () => {
    const tasks = [
      toggleDone(createTask({ title: "a", area: "home" })),
      createTask({ title: "b", area: "home", status: "archived" }),
    ];
    expect(pct(tasks)).toBe(100);
  });
});

describe("byUrgency", () => {
  it("puts overdue first, then priority, then the nearest due date", () => {
    const now = new Date("2026-03-10T12:00:00");
    const overdue = createTask({ title: "overdue", area: "school", dueDate: "2026-03-01" });
    const high = createTask({ title: "high", area: "school", priority: "!!" });
    const soon = createTask({ title: "soon", area: "school", dueDate: "2026-03-11" });
    const later = createTask({ title: "later", area: "school", dueDate: "2026-04-01" });

    const sorted = [later, high, soon, overdue].sort(byUrgency(now)).map((t) => t.title);
    expect(sorted).toEqual(["overdue", "high", "soon", "later"]);
  });
});

describe("formatDue", () => {
  it("is empty without a date, and appends the time when present", () => {
    expect(formatDue(createTask({ title: "x", area: "home" }))).toBe("");
    expect(formatDue(createTask({ title: "x", area: "home", dueDate: "2026-03-10" }))).toBe("Mar 10");
    expect(formatDue(createTask({ title: "x", area: "home", dueDate: "2026-03-10", dueTime: "09:30" }))).toContain("Mar 10 · ");
  });
});

describe("uid", () => {
  it("does not collide across a large batch", () => {
    const ids = new Set(Array.from({ length: 2000 }, uid));
    expect(ids.size).toBe(2000);
  });
});
