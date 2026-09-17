# 学习对照：Spring 注入理念

**本文只是学习笔记，不进入实现，不引入 Spring 框架，也不把 Spring 术语写进运行时 API。**

看过 Spring 之后，我们只带走几条理念，用来检验组合内核有没有写歪。真正落地的模型仍是 **Cordis 式 Context / Service / isolate**，见 [技术方案](./tech-proposal.md) 已确认决策。

## 理念（带走的）

1. **别自己 new 依赖。** 工具不要写死 `new LocalShell()`，只声明需要「能跑命令的能力」。换 Docker 时改装配，不改工具。
2. **依赖要写在脸上。** 需要什么就列出来，缺了启动失败。不要从全局偷偷拿。
3. **单例和「每一任务一份」不是一回事。** 模型客户端可以进程里一份；persistent shell 必须每个会话一份。
4. **卸载要能拆干净。** 挂上的工具、hook、子进程，会话结束要逆序撤掉。
5. **横切别写进每个工具。** 审批、记轨迹、截断，打在「执行」这一刀上，而不是每个 bash 实现复制一遍。
6. **环和半成品不要在运行时才爆。** 两个插件互相硬依赖，开工前就应失败。

## 刻意不带走的

- Spring 容器、注解、Bean 生命周期状态机、三级缓存
- `ApplicationContext` / `BeanPostProcessor` / `@Autowired` 等词进入代码或协议
- 为对齐 Spring 再实现一套 Java 式 DI

Cordis 已经覆盖：provide / inject、可逆 effect、isolate、waterfall。Spring 用来确认这些选择站得住，不是第二套内核。
