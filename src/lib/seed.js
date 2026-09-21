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

// Ids are literal v4 UUIDs so a fresh board is already compatible with the
// Phase 3 Supabase `tasks.id uuid` column, with no rewrite on first save.
export const SEED_TASKS = [
  { id: "30c10a5c-0969-4093-bde2-a0c0dee98e6b", title: "Expand UMPI 311 draft by 1–2 pages with integrated source quotes", area: "school", priority: "!!", dueDate: "2026-06-20" },
  { id: "de27f4c9-0ba4-496a-93d8-0ead13e95e73", title: "Review lecture notes before next quiz", area: "school", priority: "!" },
  { id: "594e4876-610c-41e8-a851-d5edb7b43883", title: "Read Getting to Maybe", area: "school", priority: "—" },
  { id: "53ba5095-54a7-43a7-b87b-2e103025bad0", title: "Identify 2 pre-law electives for next term", area: "school", priority: "—" },

  { id: "496ba3da-e791-4d96-9b97-414c12070ae7", title: "Current chapter notes", area: "reading", priority: "!" },
  { id: "fcb1c669-67d4-477f-91c7-684bb3a7ac4e", title: "Key quotes to remember", area: "reading", priority: "—" },
  { id: "f3b76b93-de46-4c3f-b2d7-fa7a90b3c9bd", title: "Apply one idea this week", area: "reading", priority: "!" },

  { id: "a6ed99f3-d860-4260-8c6e-2602072176b2", title: "One-on-one time with Santiago", area: "family", priority: "!" },
  { id: "c121d642-a417-430a-b2b6-ef77809acd4b", title: "Check in with Abigail on her week", area: "family", priority: "!" },
  { id: "ffcca13b-4921-40e2-911c-82446cac7679", title: "Plan family reset or trip", area: "family", priority: "—" },
  { id: "b753bbe5-894d-4c36-b6f6-76cef8812739", title: "Build financial margin for law school transition", area: "family", priority: "—" },

  { id: "a7356d0a-8266-4b28-ada6-aba193f3723a", title: "Complete this week's personal Bible study", area: "faith", priority: "!" },
  { id: "e73cfae9-dc61-42b5-88f4-5e96201d113a", title: "Catch up on Patreon Bible study session", area: "faith", priority: "!" },
  { id: "4411594c-0e6a-425c-af10-c4629845ff11", title: "Work through apologetics reading", area: "faith", priority: "—" },

  { id: "6c983248-9561-450a-a8f7-d0713024de74", title: "Fix back porch light", area: "home", priority: "—" },
  { id: "962ec793-91d1-4215-8f3f-2d0cbe2f07b3", title: "Buy: air filter replacements", area: "home", priority: "—" },
  { id: "9f787803-2ec4-4d86-b438-a32e7e6877dc", title: "Buy: Santiago's new shoes", area: "home", priority: "!" },
  { id: "0fee43a6-b5a8-4f94-ab9f-e898bc685247", title: "Deep clean garage", area: "home", priority: "—" },
];
