// ─── SEED ─────────────────────────────────────────────────────────────────────
//
// The starting board, carried over verbatim from the original dashboard so a
// fresh browser looks exactly like it always did. Work and Inbox start empty.

export const SEED_AREA_NOTES = {
  inbox: "Unsorted captures land here.",
  school: "Grinding on UMPI 311 paper this week.",
  work: "Client work. Initials and reference numbers only.",
  reading: "Currently reading — notes and takeaways.",
  family: "Focused on presence this week — Santiago and Abigail.",
  faith: "Consistent with morning Bible study this week.",
  home: "Nothing urgent. A few deferred projects on the list.",
};

export const SEED_TASKS = [
  { id: "s1", title: "Expand UMPI 311 draft by 1–2 pages with integrated source quotes", area: "school", priority: "!!", dueDate: "2026-06-20" },
  { id: "s2", title: "Review lecture notes before next quiz", area: "school", priority: "!" },
  { id: "s3", title: "Read Getting to Maybe", area: "school", priority: "—" },
  { id: "s4", title: "Identify 2 pre-law electives for next term", area: "school", priority: "—" },

  { id: "rd1", title: "Current chapter notes", area: "reading", priority: "!" },
  { id: "rd2", title: "Key quotes to remember", area: "reading", priority: "—" },
  { id: "rd3", title: "Apply one idea this week", area: "reading", priority: "!" },

  { id: "f1", title: "One-on-one time with Santiago", area: "family", priority: "!" },
  { id: "f2", title: "Check in with Abigail on her week", area: "family", priority: "!" },
  { id: "f3", title: "Plan family reset or trip", area: "family", priority: "—" },
  { id: "f4", title: "Build financial margin for law school transition", area: "family", priority: "—" },

  { id: "r1", title: "Complete this week's personal Bible study", area: "faith", priority: "!" },
  { id: "r2", title: "Catch up on Patreon Bible study session", area: "faith", priority: "!" },
  { id: "r3", title: "Work through apologetics reading", area: "faith", priority: "—" },

  { id: "h1", title: "Fix back porch light", area: "home", priority: "—" },
  { id: "h2", title: "Buy: air filter replacements", area: "home", priority: "—" },
  { id: "h3", title: "Buy: Santiago's new shoes", area: "home", priority: "!" },
  { id: "h4", title: "Deep clean garage", area: "home", priority: "—" },
];
