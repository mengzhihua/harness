# Stream bash

`bash` pipes stdout through `onStdout` while the command runs. TUI `item/delta` `{ append: true, source: bash }` shows the tail. Docker uses the same callback; remote still buffers.
