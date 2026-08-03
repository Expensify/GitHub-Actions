---
ruleId: GEN-04
title: Commenting “Why”
---

#### [GEN-04] Commenting “Why”
- **Condition**: Comments should explain *why* the code exists, not what it does.
- ❌ `// loop through users`
- ✅ `// we only include active users to avoid reprocessing deactivated ones`
- **Condition**: Write comments in plain, simple language that reads well and sounds natural when read out loud. Avoid phrasing that reads as AI-generated noise.
- **Condition**: Never use em dashes or en dashes in comments.
- ❌ `// Set a specific domain AM — this exercises the domainAccountManagerID == accountID branch`
- ✅ `// Set a specific domain AM to go through the domainAccountManagerID == accountID branch`
- **Condition**: Avoid redundant parenthetical clarifications.
- ❌ `// When the assigned guide (who is not a policy admin) comments, then it succeeds`
- ✅ `// The assigned guide isn't a policy admin, but the comment still succeeds`
- **Condition**: Avoid clunky hyphenated compound modifiers.
- ❌ `// the not-yet-validated user-supplied bank-account number`
- ✅ `// the bank account number the user supplied, before validation`
- **Condition**: Never use "->" in comments. Write out the relationship in words.
- ❌ `// peek -> process transition`
- ✅ `// the transition from peek to process`
- **Condition**: Avoid semicolons. Use separate sentences instead.
- ❌ `// retry once; the endpoint is flaky`
- ✅ `// retry once because the endpoint is flaky`
- **Condition**: Put comments on their own line above the code they describe, never trailing at the end of a line.
- ❌ `doThing(); // cache the result`
- ✅ `// cache the result` on its own line, directly above `doThing();`
