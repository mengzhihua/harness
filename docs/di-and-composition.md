# Spring 注入理念 → `@harness/spring`

Cordis（Context / Service / isolate）仍是组合内核。P19 把 Spring 的术语和约束做成适配层 `@harness/spring`，**不 vendor Java Spring**。

## 落地的

1. **别自己 new 依赖。** `BeanDefinition.factory` 从 Context 取能力。
2. **依赖写在脸上。** `inject: ["tools", "fs"]`；缺了 `refresh()` 失败。
3. **singleton vs isolate。** `scope: "singleton" | "isolate"`。
4. **卸载干净。** `destroy` 钩子挂上 Context.effect，close 逆序撤。
5. **环在开工前爆。** `a → b → a` 在 `refresh()` 抛 `circular bean dependency`。

## 仍不带走的

- Java Spring JAR、注解处理器、三级缓存
- 替换 Cordis 内核

`boot()` 在 isolate 上挂 `ctx.spring`，并注册 `aci` bean（inject tools/fs/subprocess）。
