import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import App from "./App.jsx";
import { BACKUP_KEY, LEGACY_KEY, PRERESTORE_KEY, QUARANTINE_KEY, STORAGE_KEY, normalizeState } from "./lib/storage.js";

function seed(tasks, areaNotes = {}) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeState({ areaNotes, tasks })));
}

/** The card for one area, found by its heading. */
function card(label) {
  return screen.getByRole("heading", { name: new RegExp(label, "i"), level: 2 }).closest("section");
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("My View", () => {
  it("shows a card for every area, including the new Work and Inbox", () => {
    seed([]);
    render(<App />);

    for (const label of ["Inbox", "School", "Work", "Reading", "Family", "Faith", "Home"]) {
      expect(screen.getByRole("heading", { name: new RegExp(label, "i"), level: 2 })).toBeInTheDocument();
    }
  });

  it("adds a task to the area whose card it was typed into", async () => {
    const user = userEvent.setup();
    seed([]);
    render(<App />);

    await user.click(within(card("Work")).getByRole("button", { name: /add item/i }));
    await user.type(within(card("Work")).getByLabelText(/new work task/i), "Call AB re: scheduling");
    await user.click(within(card("Work")).getByRole("button", { name: /^add$/i }));

    expect(within(card("Work")).getByText("Call AB re: scheduling")).toBeInTheDocument();
    expect(within(card("Home")).queryByText("Call AB re: scheduling")).not.toBeInTheDocument();
  });

  it("persists a new task to storage", async () => {
    const user = userEvent.setup();
    seed([]);
    render(<App />);

    await user.click(within(card("Home")).getByRole("button", { name: /add item/i }));
    await user.type(within(card("Home")).getByLabelText(/new home task/i), "Air filters");
    await user.click(within(card("Home")).getByRole("button", { name: /^add$/i }));

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(saved.tasks.map((t) => t.title)).toContain("Air filters");
  });

  it("marks a task complete and writes the change through", async () => {
    const user = userEvent.setup();
    seed([{ id: "h2", title: "Air filters", area: "home" }]);
    render(<App />);

    await user.click(screen.getByRole("button", { name: /mark "air filters" complete/i }));

    expect(screen.getByRole("button", { name: /mark "air filters" as not done/i })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).tasks[0].status).toBe("done");
  });

  it("shows an empty state for an area with nothing in it", () => {
    seed([]);
    render(<App />);
    expect(within(card("Faith")).getByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it("flags overdue work in any area, not only School", () => {
    seed([
      { id: "w1", title: "Overdue work item", area: "work", dueDate: "2020-01-01" },
      { id: "s1", title: "Overdue school item", area: "school", dueDate: "2020-01-01" },
    ]);
    render(<App />);

    expect(within(card("Work")).getByText(/1 overdue/i)).toBeInTheDocument();
    expect(within(card("School")).getByText(/1 overdue/i)).toBeInTheDocument();
  });
});

describe("Inbox triage", () => {
  it("explains what Inbox is for when it is empty", () => {
    seed([]);
    render(<App />);
    expect(within(card("Inbox")).getByText(/inbox is clear/i)).toBeInTheDocument();
  });

  it("recategorizes a capture into another area", async () => {
    const user = userEvent.setup();
    seed([{ id: "i1", title: "Air filters", area: "inbox", source: "pong-voice" }]);
    render(<App />);

    await user.selectOptions(screen.getByLabelText(/move .*air filters.* to an area/i), "home");

    expect(within(card("Home")).getByText("Air filters")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)).tasks[0].area).toBe("home");
  });

  it("offers the move control only on Inbox rows", () => {
    seed([
      { id: "i1", title: "Unsorted thought", area: "inbox" },
      { id: "h1", title: "Filed already", area: "home" },
    ]);
    render(<App />);

    expect(screen.getByLabelText(/move .*unsorted thought.* to an area/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/move .*filed already.* to an area/i)).not.toBeInTheDocument();
  });

  it("labels where a capture came from", () => {
    seed([{ id: "i1", title: "Voice capture", area: "inbox", source: "pong-voice" }]);
    render(<App />);
    expect(within(card("Inbox")).getByText("Pong")).toBeInTheDocument();
  });
});

describe("shared and private items", () => {
  it("distinguishes shared Family and Home items from private ones", () => {
    seed([
      { id: "f1", title: "Shared errand", area: "family", visibility: "shared" },
      { id: "f2", title: "Private thought", area: "family", visibility: "private" },
    ]);
    render(<App />);

    const family = within(card("Family"));
    expect(family.getByText("Shared errand").closest("button")).toHaveTextContent("shared");
    expect(family.getByText("Private thought").closest("button")).toHaveTextContent("private");
  });

  it("shows no sharing chip in areas Abigail cannot reach", () => {
    seed([{ id: "w1", title: "Client MR review", area: "work" }]);
    render(<App />);
    expect(within(card("Work")).getByText("Client MR review").closest("button")).not.toHaveTextContent(/shared|private/i);
  });
});

describe("Accountability View", () => {
  const BOARD = [
    { id: "s1", title: "UMPI 311 paper", area: "school", priority: "!!", dueDate: "2020-01-01" },
    { id: "s2", title: "Upcoming quiz prep", area: "school", priority: "!", dueDate: "2999-01-01" },
    { id: "w1", title: "Confidential client matter", area: "work" },
    { id: "f1", title: "Family errand", area: "family" },
    { id: "fa1", title: "Private prayer note", area: "faith" },
    { id: "i1", title: "Unsorted capture", area: "inbox" },
    { id: "r1", title: "Reading notes", area: "reading" },
    { id: "h1", title: "Home repair", area: "home" },
  ];

  async function openAccountability() {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: /accountability view/i }));
    return user;
  }

  it("shows the School summary: progress, priorities, deadlines and overdue", async () => {
    seed(BOARD, { school: "Grinding on the paper." });
    await openAccountability();

    expect(screen.getByRole("heading", { name: /school/i })).toBeInTheDocument();
    expect(screen.getByText(/grinding on the paper/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^overdue$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /priority this week/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /upcoming deadlines/i })).toBeInTheDocument();
  });

  it("exposes no area other than School", async () => {
    seed(BOARD);
    await openAccountability();

    for (const hidden of [
      "Confidential client matter",
      "Family errand",
      "Private prayer note",
      "Unsorted capture",
      "Reading notes",
      "Home repair",
    ]) {
      expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    }
    for (const label of ["Work", "Family", "Faith", "Inbox", "Reading", "Home"]) {
      expect(screen.queryByRole("heading", { name: new RegExp(`^${label}$`, "i") })).not.toBeInTheDocument();
    }
  });

  it("leaks no status notes from other areas", async () => {
    seed(BOARD, { work: "WORK NOTE LEAK", faith: "FAITH NOTE LEAK", home: "HOME NOTE LEAK" });
    await openAccountability();

    expect(screen.queryByText(/WORK NOTE LEAK/)).not.toBeInTheDocument();
    expect(screen.queryByText(/FAITH NOTE LEAK/)).not.toBeInTheDocument();
    expect(screen.queryByText(/HOME NOTE LEAK/)).not.toBeInTheDocument();
  });

  it("hides private task notes on the school items it does show", async () => {
    seed([{ id: "s1", title: "UMPI 311 paper", area: "school", priority: "!!", notes: "PRIVATE SCHOOL NOTE" }]);
    await openAccountability();

    expect(screen.getByText(/UMPI 311 paper/)).toBeInTheDocument();
    expect(screen.queryByText(/PRIVATE SCHOOL NOTE/)).not.toBeInTheDocument();
  });

  it("summarises rather than lists: an unprioritised, undated task is counted but not named", async () => {
    seed([{ id: "s1", title: "Quiet background task", area: "school" }]);
    await openAccountability();

    expect(screen.queryByText(/Quiet background task/)).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("cannot mutate anything: no checkboxes, edit, add, delete or backup controls", async () => {
    seed(BOARD);
    await openAccountability();

    const buttons = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") || b.textContent);
    const mutating = buttons.filter((label) =>
      /mark|edit|add|delete|save|move|export|restore|cancel/i.test(label ?? ""),
    );

    expect(mutating).toEqual([]);
    expect(screen.queryAllByRole("textbox")).toEqual([]);
    expect(screen.queryAllByRole("combobox")).toEqual([]);
  });

  it("leaves storage untouched while it is open", async () => {
    seed(BOARD);
    render(<App />);
    const before = localStorage.getItem(STORAGE_KEY);

    await userEvent.setup().click(screen.getByRole("button", { name: /accountability view/i }));

    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
  });

  it("handles an empty School board", async () => {
    seed([{ id: "h1", title: "Home repair", area: "home" }]);
    await openAccountability();
    expect(screen.getByText(/no schoolwork on the board yet/i)).toBeInTheDocument();
  });
});

describe("keyboard accessibility", () => {
  it("exposes the task title as a focusable button rather than a click-only span", async () => {
    const user = userEvent.setup();
    seed([{ id: "h1", title: "Air filters", area: "home" }]);
    render(<App />);

    const title = screen.getByRole("button", { name: /edit "air filters"/i });
    title.focus();
    expect(title).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(screen.getByDisplayValue("Air filters")).toBeInTheDocument();
  });

  it("lets the status note be opened from the keyboard", async () => {
    const user = userEvent.setup();
    seed([], { home: "Nothing urgent." });
    render(<App />);

    const note = within(card("Home")).getByRole("button", { name: /nothing urgent/i });
    note.focus();
    await user.keyboard("{Enter}");

    expect(within(card("Home")).getByLabelText(/home status note/i)).toHaveValue("Nothing urgent.");
  });

  it("closes the edit form on Escape", async () => {
    const user = userEvent.setup();
    seed([{ id: "h1", title: "Air filters", area: "home" }]);
    render(<App />);

    await user.click(screen.getByRole("button", { name: /edit "air filters"/i }));
    expect(screen.getByDisplayValue("Air filters")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByDisplayValue("Air filters")).not.toBeInTheDocument();
  });
});

describe("migration and error states", () => {
  it("tells the user when their tasks were rescued from session storage", () => {
    sessionStorage.setItem(
      "fon_dashboard",
      JSON.stringify({ home: { status: "", items: [{ id: "h1", text: "Rescued task", done: false }] } }),
    );
    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent(/moved from temporary session storage/i);
    expect(screen.getByText("Rescued task")).toBeInTheDocument();
  });

  it("surfaces unreadable saved data instead of failing silently", () => {
    localStorage.setItem(STORAGE_KEY, "{ corrupt");
    render(<App />);

    expect(screen.getByRole("heading", { name: /could not be read/i })).toBeInTheDocument();
  });
});

// ─── H1 ───────────────────────────────────────────────────────────────────────

describe("unreadable saved data is never overwritten (H1)", () => {
  const CORRUPT = '{"tasks":[{"id":"a","title":"Real task"';

  beforeEach(() => {
    localStorage.setItem(STORAGE_KEY, CORRUPT);
  });

  it("shows a recovery screen rather than pretending the seed board is yours", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /could not be read/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /^school$/i, level: 2 })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add item/i })).not.toBeInTheDocument();
  });

  it("hides the view switcher, so no path leads to a writable board", () => {
    render(<App />);
    expect(screen.queryByRole("button", { name: /accountability view/i })).not.toBeInTheDocument();
  });

  it("leaves the stored bytes untouched on load", () => {
    render(<App />);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(CORRUPT);
  });

  it("offers the raw data for download before anything is discarded", () => {
    render(<App />);
    expect(screen.getByRole("button", { name: /download raw data/i })).toBeInTheDocument();
  });

  it("requires an explicit second confirmation before discarding", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^discard and start fresh$/i }));
    expect(localStorage.getItem(STORAGE_KEY)).toBe(CORRUPT);

    expect(screen.getByRole("button", { name: /yes, discard and start fresh/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("can be backed out of at the confirmation step", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^discard and start fresh$/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(screen.queryByRole("button", { name: /yes, discard/i })).not.toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(CORRUPT);
  });

  it("quarantines the original and restores a writable board once confirmed", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /^discard and start fresh$/i }));
    await user.click(screen.getByRole("button", { name: /yes, discard and start fresh/i }));

    const quarantined = Object.keys(localStorage).filter((k) => k.startsWith(QUARANTINE_KEY));
    expect(quarantined).toHaveLength(1);
    expect(localStorage.getItem(quarantined[0])).toBe(CORRUPT);

    expect(screen.getByRole("heading", { name: /^school$/i, level: 2 })).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).not.toBe(CORRUPT);
  });
});

// ─── M1 ───────────────────────────────────────────────────────────────────────

describe("multiple tabs (M1)", () => {
  it("adopts a board written by another tab instead of overwriting it", async () => {
    seed([{ title: "Tab A original", area: "home" }]);
    render(<App />);
    expect(screen.getByText("Tab A original")).toBeInTheDocument();

    // Another tab saves a different board, then notifies this one.
    const fromOtherTab = normalizeState({ tasks: [{ title: "Written by tab B", area: "home" }] });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fromOtherTab));
    act(() => {
      globalThis.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });

    await waitFor(() => expect(screen.getByText("Written by tab B")).toBeInTheDocument());
    expect(screen.queryByText("Tab A original")).not.toBeInTheDocument();
  });

  it("does not lose the other tab's work on the next edit", async () => {
    const user = userEvent.setup();
    seed([{ title: "Tab A original", area: "home" }]);
    render(<App />);

    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(normalizeState({ tasks: [{ title: "Written by tab B", area: "home" }] })),
    );
    act(() => {
      globalThis.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
    });
    await waitFor(() => expect(screen.getByText("Written by tab B")).toBeInTheDocument());

    await user.click(within(card("Home")).getByRole("button", { name: /add item/i }));
    await user.type(within(card("Home")).getByLabelText(/new home task/i), "Added after sync");
    await user.click(within(card("Home")).getByRole("button", { name: /^add$/i }));

    const titles = JSON.parse(localStorage.getItem(STORAGE_KEY)).tasks.map((t) => t.title);
    expect(titles).toContain("Written by tab B");
    expect(titles).toContain("Added after sync");
  });

  it("ignores storage events for unrelated keys", () => {
    seed([{ title: "Unchanged", area: "home" }]);
    render(<App />);

    act(() => {
      globalThis.dispatchEvent(new StorageEvent("storage", { key: "something_else" }));
    });

    expect(screen.getByText("Unchanged")).toBeInTheDocument();
  });

  it("warns when a legacy board coexists with the migrated one", () => {
    seed([{ title: "Current board", area: "home" }]);
    sessionStorage.setItem(
      LEGACY_KEY,
      JSON.stringify({ home: { status: "", items: [{ id: "h1", text: "Legacy task", done: false }] } }),
    );

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent(/older session-storage board was also found/i);
    expect(localStorage.getItem(BACKUP_KEY)).toBeTruthy();
    expect(screen.queryByText("Legacy task")).not.toBeInTheDocument();
  });
});

// ─── M2 ───────────────────────────────────────────────────────────────────────

describe("iPhone safe area (M2)", () => {
  it("applies the safe-area shell class to the app root", () => {
    seed([]);
    const { container } = render(<App />);
    expect(container.querySelector(".app-shell")).not.toBeNull();
  });
});

// ─── M3 ───────────────────────────────────────────────────────────────────────

describe("safe restore and delete (M3)", () => {
  it("makes the delete control visible without hover, for touch devices", () => {
    seed([{ title: "Air filters", area: "home" }]);
    render(<App />);

    const remove = screen.getByRole("button", { name: /delete "air filters"/i });
    expect(remove.className).toContain("opacity-60");
    expect(remove.className).toContain("md:opacity-0");
  });

  it("offers undo after a delete and puts the task back in place", async () => {
    const user = userEvent.setup();
    seed([
      { title: "First", area: "home" },
      { title: "Air filters", area: "home" },
      { title: "Last", area: "home" },
    ]);
    render(<App />);

    await user.click(screen.getByRole("button", { name: /delete "air filters"/i }));
    expect(screen.queryByText("Air filters")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/deleted .*air filters/i);

    await user.click(screen.getByRole("button", { name: /^undo$/i }));

    expect(screen.getByText("Air filters")).toBeInTheDocument();
    const titles = JSON.parse(localStorage.getItem(STORAGE_KEY)).tasks.map((t) => t.title);
    expect(titles).toEqual(["First", "Air filters", "Last"]);
  });

  it("asks before replacing the board and reports both counts", async () => {
    const user = userEvent.setup();
    seed([{ title: "Current one", area: "home" }]);
    render(<App />);

    const backup = JSON.stringify({
      app: "fon-os",
      version: 2,
      tasks: [
        { title: "From backup A", area: "home" },
        { title: "From backup B", area: "work" },
      ],
    });
    await user.upload(
      document.querySelector('input[type="file"]'),
      new File([backup], "backup.json", { type: "application/json" }),
    );

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/replaces all 1 tasks/i);
    expect(dialog).toHaveTextContent(/2 tasks in the backup/i);
    // Nothing applied yet.
    expect(screen.getByText("Current one")).toBeInTheDocument();
  });

  it("leaves the board alone when the restore is cancelled", async () => {
    const user = userEvent.setup();
    seed([{ title: "Current one", area: "home" }]);
    render(<App />);
    const before = localStorage.getItem(STORAGE_KEY);

    await user.upload(
      document.querySelector('input[type="file"]'),
      new File([JSON.stringify({ tasks: [{ title: "From backup", area: "home" }] })], "b.json", {
        type: "application/json",
      }),
    );
    await user.click(await screen.findByRole("button", { name: /cancel/i }));

    expect(screen.getByText("Current one")).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
  });

  it("saves a pre-restore backup before applying the file", async () => {
    const user = userEvent.setup();
    seed([{ title: "About to be replaced", area: "home" }]);
    render(<App />);

    await user.upload(
      document.querySelector('input[type="file"]'),
      new File([JSON.stringify({ tasks: [{ title: "From backup", area: "home" }] })], "b.json", {
        type: "application/json",
      }),
    );
    await user.click(await screen.findByRole("button", { name: /replace board/i }));

    expect(screen.getByText("From backup")).toBeInTheDocument();
    const preRestore = JSON.parse(localStorage.getItem(PRERESTORE_KEY));
    expect(preRestore.tasks.map((t) => t.title)).toEqual(["About to be replaced"]);
  });

  it("rejects a file that is not a backup without prompting to replace anything", async () => {
    const user = userEvent.setup();
    seed([{ title: "Current one", area: "home" }]);
    render(<App />);

    await user.upload(
      document.querySelector('input[type="file"]'),
      new File(["not json at all"], "b.json", { type: "application/json" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/not valid JSON/i);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("Current one")).toBeInTheDocument();
  });
});

// ─── M4 ───────────────────────────────────────────────────────────────────────

describe("export on iOS Safari (M4)", () => {
  it("attaches the link to the document and defers revoking the object URL", async () => {
    const user = userEvent.setup();
    seed([{ title: "Air filters", area: "home" }]);
    render(<App />);

    const createObjectURL = vi.fn(() => "blob:fake-url");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let attached = false;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function spy() {
        attached = document.body.contains(this) && this.download.startsWith("fon-os-backup-");
      });

    try {
      await user.click(screen.getByRole("button", { name: /export backup/i }));

      expect(createObjectURL).toHaveBeenCalled();
      expect(attached).toBe(true);
      // Revoking synchronously is what cancels the download on iOS.
      expect(revokeObjectURL).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
    } finally {
      vi.useRealTimers();
      clickSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
