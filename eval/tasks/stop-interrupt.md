# Stop in-flight work

While a turn is running, `/stop` must cancel inference, kill the current command, and finish with an interrupted Done Report. A follow-up on the same thread is a steer, not a new session.
