# Spring beans

The isolate has a Spring `ApplicationContext` (`ctx.spring`) that autowires `tools` / `fs` / `subprocess`. Circular bean inject must fail at refresh, not at first tool call.
