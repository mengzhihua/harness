# Fusion Lead and Sidekick may use different models

`fusion/run` with `leadModel` and `sidekickModel` starts two sessions. They must not share transcripts. The parent traj `fusion` event records both model ids. This is not a hot-path model switch.
