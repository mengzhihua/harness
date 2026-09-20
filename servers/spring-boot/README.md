# Harness Spring Boot server

`java -jar harness-server-<version>.jar` starts an HTTP JSON-RPC server (default `:8080`).
The JAR depends on Spring Boot via Maven; it does **not** vendor Spring Framework source.

```bash
java -jar harness-server-*.jar
curl http://127.0.0.1:8080/health
curl -s -X POST http://127.0.0.1:8080/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"runtime/doctor","params":{}}'
```

`PORT` and `HARNESS_BIND` override listen address. The JAR extracts a bundled native `harness` (or `node dist/harness.cjs`) and talks to `harness serve` on stdio.
