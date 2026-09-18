# Follow-up queue while a turn is running

Start a turn that inspects the repo. While it is still running, type a follow-up: don't touch USER_WIP.md.

The input stays available. The follow-up is queued (inbox), shown as `queued`, and consumed at the next step — not a new session. The trajectory must contain a `steer` event.
