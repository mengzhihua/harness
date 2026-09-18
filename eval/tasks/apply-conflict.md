# Apply conflict abort

`/apply` merges the agent branch into the user tree. On conflict it runs `git merge --abort`, reports the conflicted paths, and leaves the user tree without unmerged paths.
