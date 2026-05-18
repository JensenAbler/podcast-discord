
The system prompt lives in `podcast-generator.js`, in the `buildSystemPrompt()` method starting at **line 457**. It's the long block of strings beginning `'You are:'` and ending with the closing `].join('\n');`.

You'll work from your main repo, **not** the worktree we've been deploying from. So all paths below are relative to `C:\Users\Jensen\code\podcast-discord`.

### Step 1 — Get your local main up to date

Open a terminal in `C:\Users\Jensen\code\podcast-discord`.

```
git checkout main
git pull origin main
```

This pulls the latest commits we deployed today (`4d4c317` should be the current tip). If you have local edits to your scratchpad `Jensen's system prompt mods.md`, git will leave those alone — they're not committed.

### Step 2 — Make a feature branch

A branch is a parallel copy of the code where your changes don't affect `main` until you choose to merge them.

```
git checkout -b prompt/clearer-curiosity
```

The branch name is just a label; pick whatever describes the change. Convention is to use a slash-separated prefix (`prompt/...`, `fix/...`, `feat/...`).

### Step 3 — Edit `podcast-generator.js`

Open the file in your editor. Jump to **line 457** (`buildSystemPrompt()`). The body is a JS array of strings joined by newlines — each string is a line of the prompt. Edit, add, or remove strings as needed. Keep them as quoted strings inside the array; commas between them.

If you have draft text in `Jensen's system prompt mods.md`, paste it in here, breaking it into lines.

### Step 4 — Run tests

```
npm test
```

You should see `Tests complete: 26 passed, 0 failed`. If anything fails, the output will tell you which test and why — usually a syntax slip from the edit. Fix and re-run before continuing.

### Step 5 — Commit on your branch

```
git status                           # see what changed
git diff podcast-generator.js        # eyeball the diff
git add podcast-generator.js
git commit -m "Tighten system prompt curiosity guidance"
```

The commit message should be a short imperative sentence. It's the title that shows up in the PR.

### Step 6 — Push the branch to GitHub

```
git push -u origin prompt/clearer-curiosity
```

The `-u` flag tells git to remember this branch tracks the remote branch of the same name, so future `git push` (without args) just works.

### Step 7 — Open the PR on GitHub

After the push, git's output usually includes a link like:

```
remote: Create a pull request for 'prompt/clearer-curiosity' on GitHub by visiting:
remote:      https://github.com/JensenAbler/podcast-discord/pull/new/prompt/clearer-curiosity
```

Open that URL. You'll land on a form:

- **Title** — pre-filled from your commit message; edit if needed
- **Description** — optional. A sentence on _why_ you're changing the prompt is helpful for future-you when reviewing the merge log
- Click **Create pull request**

### Step 8 — Review your own diff

On the PR page, click the **Files changed** tab. This shows your edits as red/green lines. Read through them — the PR is your "are you sure?" checkpoint. If something looks off, you can:

- Edit locally, `git add`/`git commit`/`git push` again — the PR auto-updates
- Or click **Close pull request** at the bottom to abandon

### Step 9 — Merge the PR

When you're happy:

- Click the green **Merge pull request** button
- Pick **Squash and merge** (combines your commits into one tidy commit on main) or **Create a merge commit** (preserves branch history). Squash is cleaner for solo work
- Confirm

GitHub now has the change on `main`.

### Step 10 — Update your local main and clean up

```
git checkout main
git pull origin main
git branch -d prompt/clearer-curiosity         # delete the local branch
git push origin --delete prompt/clearer-curiosity  # delete the remote branch (optional but tidy)
```

### Step 11 — Deploy to alpha

Same dance as we've been doing:

```
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "cd /opt/podcast-discord && git pull --ff-only origin main && git rev-parse --short HEAD"
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "/root/clawd/restart-clawcast-discord-bot-new.sh"
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "tail -n 40 /tmp/clawcast-discord-bot-new.log"
```

The new prompt takes effect from the next bot turn.

---

### Optional shortcut: skip the PR for solo changes

The PR is a habit-builder, not a requirement. If you're confident in the change and just want to ship:

```
# from main, with edits already made
git add podcast-generator.js
git commit -m "Tighten system prompt curiosity guidance"
git push origin main
```

Then go to Step 11. You lose the diff-review checkpoint but save 5 clicks. Use PRs when the change is non-trivial or you want it documented.

---

## Task B: Toggle the adaptive grace period

This is **env-only** on alpha — no code change, no PR. Three modes:

### Mode 1: Adaptive (dynamic ladder, original behavior)

Removes the env var entirely. Grace scales 50–750ms based on speech length.

```
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "sed -i '/^CONVERSATION_BUFFER_GRACE_PERIOD_MS=/d' /opt/podcast-discord/.env && /root/clawd/restart-clawcast-discord-bot-new.sh"
```

### Mode 2: Fixed value (whatever number you pick)

Replaces the env var with a fixed millisecond value. This implicitly disables the dynamic ladder.

```
# 50ms (current)
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "sed -i 's/^CONVERSATION_BUFFER_GRACE_PERIOD_MS=.*/CONVERSATION_BUFFER_GRACE_PERIOD_MS=50/' /opt/podcast-discord/.env && /root/clawd/restart-clawcast-discord-bot-new.sh"

# 150ms
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "sed -i 's/^CONVERSATION_BUFFER_GRACE_PERIOD_MS=.*/CONVERSATION_BUFFER_GRACE_PERIOD_MS=150/' /opt/podcast-discord/.env && /root/clawd/restart-clawcast-discord-bot-new.sh"
```

If the var isn't currently in `.env` and you want to add it (rather than replace), append it carefully — make sure the file already ends with a newline (`.env` did NOT earlier today, which mangled an adjacent var; it does now). Safe form:

```
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "printf '\nCONVERSATION_BUFFER_GRACE_PERIOD_MS=150\n' >> /opt/podcast-discord/.env && /root/clawd/restart-clawcast-discord-bot-new.sh"
```

The leading `\n` in `printf` is the safety net.

### Mode 3: Explicit on/off (overrides whatever gracePeriod is set)

```
# Force adaptive ON regardless of gracePeriod
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "printf 'CONVERSATION_BUFFER_DYNAMIC_GRACE=true\n' >> /opt/podcast-discord/.env && /root/clawd/restart-clawcast-discord-bot-new.sh"

# Force adaptive OFF
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "printf 'CONVERSATION_BUFFER_DYNAMIC_GRACE=false\n' >> /opt/podcast-discord/.env && /root/clawd/restart-clawcast-discord-bot-new.sh"
```

### Verify what's active

```
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "grep -E '^CONVERSATION_BUFFER_' /opt/podcast-discord/.env"
```

After any episode, you can confirm what the bot actually used:

```
ssh -i ~/.ssh/alphaclawd root@31.97.135.128 "grep 'Starting grace period' /tmp/clawcast-discord-bot-new.log | tail -10"
```

You'll see lines like `Starting grace period after ASR completion (50ms)` — that's the value the bot is actually applying.

---

## Quick reference card

|What you want|Where|How|
|---|---|---|
|Change system prompt|`podcast-generator.js` line 457, `buildSystemPrompt()`|PR workflow (Steps 1–11)|
|Fix grace at 50ms|`/opt/podcast-discord/.env` on alpha|sed replace + restart|
|Back to adaptive|same|sed delete the line + restart|
|Different fixed value|same|sed replace with new number + restart|

If anything goes sideways after a grace toggle, the safety net is `cp /opt/podcast-discord/.env.bak.pre-grace /opt/podcast-discord/.env && /root/clawd/restart-clawcast-discord-bot-new.sh`.